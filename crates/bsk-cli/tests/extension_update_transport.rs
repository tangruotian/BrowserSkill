//! 真实本地 IPC + WebSocket 协议回归。使用临时端点和假扩展，不连接个人 Chrome。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::extension::{ExtensionUpdateParams, ExtensionUpdateResult};
use bsk_protocol::{Method, RequestFrame, ResponseBody, ResponseFrame};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 模拟真实扩展握手，让 daemon 经实际注册/替换/旧连接清理流程更新 generation。
async fn connect(addr: SocketAddr, version: &str) -> Ws {
    let mut request = format!("ws://{addr}/").into_client_request().unwrap();
    request.headers_mut().insert(
        "Origin",
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
            .parse()
            .unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let handshake = json!({
        "id": "handshake", "method": "system.handshake",
        "params": {
            "client": "browser-skill-extension", "version": version, "protocol_version": "1.3",
            "instance_id": "managed-test", "browser": {"name": "Chrome", "version": "131"},
            "label": "Managed test", "min_compatible_protocol": "1.0"
        }
    });
    ws.send(Message::Text(handshake.to_string())).await.unwrap();
    let Message::Text(reply) = ws.next().await.unwrap().unwrap() else {
        panic!("missing handshake")
    };
    let reply: ResponseFrame = serde_json::from_str(&reply).unwrap();
    assert!(matches!(reply.body, ResponseBody::Ok(_)), "{reply:?}");
    ws
}

async fn update(sock: PathBuf, minimum: &str) -> ExtensionUpdateResult {
    let mut client = IpcClient::connect(sock).await.unwrap();
    client
        .call(
            "update",
            Method::ExtensionUpdate,
            Some(ExtensionUpdateParams {
                browser: None,
                min_version: Some(minimum.into()),
                timeout_ms: 3000,
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap()
}

/// 请求无需 session_id，能从真实 IPC 透传到已握手扩展，结果完整返回给发布端。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_update_roundtrips_through_ipc_and_websocket() {
    let temp = tempfile::tempdir().unwrap();
    let sock = temp.path().join("managed-update.sock");
    let handle = daemon::run(DaemonConfig::new(0), Some(sock.clone()))
        .await
        .unwrap();
    let mut ws = connect(handle.ws_addr(), "0.3.5").await;
    let call = tokio::spawn(update(sock, "0.3.5"));
    let Message::Text(message) = ws.next().await.unwrap().unwrap() else {
        panic!("missing request")
    };
    let request: RequestFrame = serde_json::from_str(&message).unwrap();
    assert_eq!(request.method, Method::ExtensionUpdate);
    ws.send(Message::Text(
        serde_json::to_string(&ResponseFrame {
            id: request.id,
            body: ResponseBody::Ok(json!({"status":"no_update"})),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let result = call.await.unwrap();
    assert!(result.ok);
    assert_eq!(result.browsers[0].status, "no_update");
    ws.close(None).await.unwrap();
    handle.shutdown().await;
}

/// SW 重载中丢失旧响应且旧 socket 清理与新握手竞态时，不能错误地丢掉新连接。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reload_without_ack_is_verified_by_new_websocket_handshake() {
    let temp = tempfile::tempdir().unwrap();
    let sock = temp.path().join("managed-reload.sock");
    let handle = daemon::run(DaemonConfig::new(0), Some(sock.clone()))
        .await
        .unwrap();
    let mut old = connect(handle.ws_addr(), "0.3.5").await;
    let call = tokio::spawn(update(sock, "0.3.6"));
    let Message::Text(message) = old.next().await.unwrap().unwrap() else {
        panic!("missing request")
    };
    let request: RequestFrame = serde_json::from_str(&message).unwrap();
    assert_eq!(request.method, Method::ExtensionUpdate);
    old.close(None).await.unwrap();
    let mut new = connect(handle.ws_addr(), "0.3.6").await;
    let result = call.await.unwrap();
    assert!(result.ok, "{result:?}");
    assert_eq!(result.browsers[0].status, "updated");
    assert_eq!(result.browsers[0].current_version.as_deref(), Some("0.3.6"));
    new.close(None).await.unwrap();
    handle.shutdown().await;
}
