//! 生产 IPC 路由 + 模拟扩展连接：保护统一升级结果、并发与不可重试边界。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use bsk::daemon::browsers::{
    BrowserClient, BrowserId, BrowserSink, Liveness, Pending, next_browser_generation,
};
use bsk::daemon::ipc::{DaemonStatus, full_handler};
use bsk::daemon::sessions::{Session, SessionId};
use bsk::daemon::{DaemonConfig, DaemonState};
use bsk_protocol::extension::ExtensionUpdateResult;
use bsk_protocol::{ErrorCode, Frame, Method, ResponseBody, ResponseFrame, RpcError};
use serde_json::{Value, json};
use tokio::sync::mpsc;

fn state() -> Arc<DaemonState> {
    Arc::new(DaemonState::new(DaemonConfig::new(0)))
}

fn browser(
    state: &DaemonState,
    id: &str,
    version: &str,
) -> (Arc<BrowserClient>, mpsc::UnboundedReceiver<Frame>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let client = Arc::new(BrowserClient {
        id: BrowserId(id.into()),
        browser_name: "Chrome".into(),
        browser_version: "131".into(),
        extension_version: version.into(),
        extension_protocol_version: "1.3".into(),
        label: id.into(),
        sink: BrowserSink { tx },
        pending: Mutex::new(Pending::default()),
        generation: next_browser_generation(),
        connected_at_ms: 0,
        version_skew: false,
        liveness: Liveness::default(),
    });
    state.browsers.insert(Arc::clone(&client));
    (client, rx)
}

async fn call(state: Arc<DaemonState>, min_version: Option<&str>, timeout_ms: u32) -> ResponseBody {
    let handler = full_handler(
        DaemonStatus {
            started_at: Instant::now(),
            ws_port: 0,
            sock_path: PathBuf::new(),
            daemon_version: "0.3.3",
            protocol_version: "1.3",
        },
        state,
    );
    handler(
        "upgrade".into(),
        Method::ExtensionUpdate,
        json!({ "browser": null, "min_version": min_version, "timeout_ms": timeout_ms }),
    )
    .await
}

fn result(body: ResponseBody) -> ExtensionUpdateResult {
    match body {
        ResponseBody::Ok(value) => serde_json::from_value(value).unwrap(),
        other => panic!("unexpected {other:?}"),
    }
}

async fn reply(
    client: Arc<BrowserClient>,
    rx: &mut mpsc::UnboundedReceiver<Frame>,
    body: ResponseBody,
) {
    let Frame::Request(request) = rx.recv().await.unwrap() else {
        panic!("expected request")
    };
    assert_eq!(request.method, Method::ExtensionUpdate);
    assert_eq!(request.params, Some(json!({})));
    client.pending.lock().unwrap().resolve(ResponseFrame {
        id: request.id,
        body,
    });
}

/// 有活跃 session 也必须立即收到控制消息，不能排到业务队列末尾。
#[tokio::test]
async fn updates_busy_browser_and_verifies_new_generation() {
    let state = state();
    let (client, mut rx) = browser(&state, "busy", "0.3.5");
    state.sessions.insert(Session {
        id: SessionId("task".into()),
        browser_id: client.id.clone(),
        interaction: None,
        agent_window_id: None,
        attached_tab_id: Some(1),
        fallback_created: false,
        created_at_ms: 0,
    });
    let task = tokio::spawn(call(Arc::clone(&state), Some("0.3.6"), 1000));
    reply(
        client,
        &mut rx,
        ResponseBody::Ok(json!({"status":"update_available", "version":"0.3.6"})),
    )
    .await;
    let (_new, _rx) = browser(&state, "busy", "0.3.6");
    let result = result(task.await.unwrap());
    assert!(result.ok);
    assert_eq!(result.browsers[0].status, "updated");
    assert_eq!(result.browsers[0].current_version.as_deref(), Some("0.3.6"));
}

/// Chrome 可先触发更新事件并关闭旧连接，丢失检查回执仍可由新版握手证明成功。
#[tokio::test]
async fn accepts_verified_newer_connection_without_old_reply() {
    let state = state();
    let (_old, mut rx) = browser(&state, "a", "0.3.5");
    let task = tokio::spawn(call(Arc::clone(&state), Some("0.3.6"), 1000));
    rx.recv().await.unwrap();
    let (_new, _rx) = browser(&state, "a", "0.3.6");
    assert!(result(task.await.unwrap()).ok);
}

/// 下载可用不代表已经加载；相同版本重连也不能伪装为升级成功。
#[tokio::test]
async fn same_version_reconnect_is_not_success() {
    let state = state();
    let (client, mut rx) = browser(&state, "a", "0.3.5");
    let task = tokio::spawn(call(Arc::clone(&state), Some("0.3.6"), 150));
    reply(
        client,
        &mut rx,
        ResponseBody::Ok(json!({"status":"update_available", "version":"0.3.6"})),
    )
    .await;
    let (_new, _rx) = browser(&state, "a", "0.3.5");
    let result = result(task.await.unwrap());
    assert!(!result.ok);
    assert_eq!(result.browsers[0].status, "timeout");
}

#[tokio::test]
async fn reports_no_update_throttling_and_missing_minimum_without_false_success() {
    for (status, minimum, ok, expected) in [
        ("no_update", "0.3.5", true, "no_update"),
        ("no_update", "0.3.6", false, "version_too_old"),
        ("throttled", "0.3.5", false, "throttled"),
    ] {
        let state = state();
        let (client, mut rx) = browser(&state, "a", "0.3.5");
        let task = tokio::spawn(call(Arc::clone(&state), Some(minimum), 1000));
        reply(client, &mut rx, ResponseBody::Ok(json!({"status": status}))).await;
        let result = result(task.await.unwrap());
        assert_eq!(result.ok, ok);
        assert_eq!(result.browsers[0].status, expected);
    }
}

/// 单个旧扩展不能阻塞其他浏览器；总体失败必须保留成功目标的核验结果。
#[tokio::test]
async fn broadcasts_concurrently_and_preserves_partial_failure() {
    let state = state();
    let (old, mut old_rx) = browser(&state, "old", "0.3.4");
    let (ready, mut ready_rx) = browser(&state, "ready", "0.3.5");
    let task = tokio::spawn(call(Arc::clone(&state), Some("0.3.5"), 1000));
    reply(
        ready,
        &mut ready_rx,
        ResponseBody::Ok(json!({"status":"no_update"})),
    )
    .await;
    reply(
        old,
        &mut old_rx,
        ResponseBody::Err(RpcError {
            code: ErrorCode::UnknownMethod,
            message: "legacy extension".into(),
            data: None,
        }),
    )
    .await;
    let result = result(task.await.unwrap());
    assert!(!result.ok);
    assert_eq!(result.browsers.len(), 2);
    assert_eq!(result.browsers[0].status, "unsupported");
    assert!(result.browsers[1].ok);
}

#[tokio::test]
async fn rejects_offline_and_invalid_inputs_before_dispatch() {
    let offline = call(state(), None, 100).await;
    assert!(matches!(
        offline,
        ResponseBody::Err(RpcError {
            code: ErrorCode::NoBrowserConnected,
            ..
        })
    ));
    let state = state();
    let (_client, mut rx) = browser(&state, "a", "0.3.5");
    for (version, timeout) in [(Some("1.02"), 100), (None, 0), (None, 600_001)] {
        assert!(matches!(
            call(Arc::clone(&state), version, timeout).await,
            ResponseBody::Err(RpcError {
                code: ErrorCode::InvalidParams,
                ..
            })
        ));
        assert!(rx.try_recv().is_err());
    }
}

/// CLI 参数/JSON/非零退出码也由真实子进程覆盖；不连接用户 daemon。
#[test]
fn cli_exposes_admin_command_and_validates_before_autostart() {
    use std::process::Command;
    let help = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .args(["extension", "update", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("--min-version"));
    let home = tempfile::tempdir().unwrap();
    let invalid = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .args(["extension", "update", "--timeout", "0s", "--json"])
        .env("BSK_HOME", home.path())
        .env("BSK_AUTO_START", "0")
        .output()
        .unwrap();
    assert!(!invalid.status.success());
    let error: Value = serde_json::from_slice(&invalid.stdout).unwrap();
    assert!(error.to_string().contains("timeout"));
    assert!(!home.path().join("daemon.json").exists());
}

/// 新增方法始终属于部署控制面，不受用户暂停浏览器输入的门禁影响。
#[test]
fn control_method_roundtrips_without_interrupt_gate() {
    let method: Method = serde_json::from_str("\"extension.update\"").unwrap();
    assert_eq!(method, Method::ExtensionUpdate);
    assert!(!method.requires_interrupt_gate());
    assert_eq!(
        serde_json::to_value(method).unwrap(),
        json!("extension.update")
    );
}
