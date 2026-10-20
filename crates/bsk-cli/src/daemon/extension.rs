//! 管理员扩展更新通道：直接派发，不经过会话队列/中断门禁/空闲检测。

use std::sync::Arc;
use std::time::Duration;

use bsk_protocol::extension::{
    ExtensionUpdateEntry, ExtensionUpdateParams, ExtensionUpdateResult, chrome_version,
};
use bsk_protocol::{ErrorCode, Method, RequestFrame, ResponseBody, RpcError};
use futures_util::future::join_all;
use serde_json::{Value, json};
use tokio::time::Instant;

use super::browsers::{BrowserClient, EXTENSION_CONNECT_WAIT};
use super::state::DaemonState;

/// 统一期限包括等待首次连接和更新后重连；所有目标并发执行，单个坏客户端不会
/// 阻止其他浏览器收到通知。仅取本次调用的连接快照，不持续升级后来加入的浏览器。
pub async fn update(state: &Arc<DaemonState>, value: Value) -> ResponseBody {
    let params: ExtensionUpdateParams = match serde_json::from_value(value) {
        Ok(params) => params,
        Err(error) => return error_body(ErrorCode::InvalidParams, error.to_string()),
    };
    if let Err(error) = params.validate() {
        return error_body(ErrorCode::InvalidParams, error);
    }
    let budget = Duration::from_millis(u64::from(params.timeout_ms));
    let deadline = Instant::now() + budget;
    state
        .browsers
        .wait_for_any_connected(budget.min(EXTENSION_CONNECT_WAIT))
        .await;
    let browsers = if let Some(selector) = params.browser.as_deref() {
        match state.browsers.select(Some(selector)) {
            Ok(browser) => vec![browser],
            Err(error) => {
                return error_body(
                    ErrorCode::NotFound,
                    format!("browser selection failed: {error:?}"),
                );
            }
        }
    } else {
        state.browsers.snapshot()
    };
    if browsers.is_empty() {
        return error_body(
            ErrorCode::NoBrowserConnected,
            "No extension connected; Chrome must be running with BrowserSkill enabled".into(),
        );
    }
    let mut results = join_all(
        browsers
            .into_iter()
            .map(|browser| update_one(state, browser, params.min_version.as_deref(), deadline)),
    )
    .await;
    results.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
    let result = ExtensionUpdateResult {
        ok: results.iter().all(|result| result.ok),
        browsers: results,
    };
    ResponseBody::Ok(serde_json::to_value(result).expect("extension update result serializes"))
}

fn error_body(code: ErrorCode, message: String) -> ResponseBody {
    ResponseBody::Err(RpcError {
        code,
        message,
        data: None,
    })
}

/// 不论超时、返回还是调用任务被丢弃，都移除旧连接的 waiter；已经发给 Chrome 的
/// 更新无法撤回，因此这里只清理响应关联，不尝试发送业务 cancel 或重载第二次。
struct PendingUpdate {
    browser: Arc<BrowserClient>,
    id: String,
}
impl Drop for PendingUpdate {
    fn drop(&mut self) {
        self.browser
            .pending
            .lock()
            .expect("browser pending poisoned")
            .cancel(&self.id);
    }
}

/// 判断最低版本使用 Chrome 四段数值；旧开发版不能被误判为满足发布要求。
fn reaches(current: &str, required: Option<&str>) -> bool {
    required.is_none_or(
        |required| match (chrome_version(current), chrome_version(required)) {
            (Ok(current), Ok(required)) => current >= required,
            _ => false,
        },
    )
}

async fn update_one(
    state: &Arc<DaemonState>,
    browser: Arc<BrowserClient>,
    min_version: Option<&str>,
    deadline: Instant,
) -> ExtensionUpdateEntry {
    let finish =
        |ok: bool, status: &str, current: Option<String>, message: String| ExtensionUpdateEntry {
            instance_id: browser.id.0.clone(),
            previous_version: browser.extension_version.clone(),
            current_version: current,
            ok,
            status: status.into(),
            message,
        };
    let id = format!("extension-update-{}", uuid::Uuid::new_v4().simple());
    let mut receiver = match browser.dispatch(RequestFrame {
        id: id.clone(),
        method: Method::ExtensionUpdate,
        params: Some(json!({})),
    }) {
        Ok(receiver) => receiver,
        Err(error) => {
            return finish(
                false,
                "failed",
                None,
                format!("Update was not dispatched: {error:?}"),
            );
        }
    };
    let _pending = PendingUpdate {
        browser: Arc::clone(&browser),
        id,
    };
    let mut receiving = true;
    let mut target: Option<String> = None;
    loop {
        // onUpdateAvailable 可在 requestUpdateCheck 回调之前重载。即使未收到回执，
        // 同一实例的新 generation + 更高版本仍是成功证据；单纯断连/同版本重连不是。
        if let Some(current) = state.browsers.get(&browser.id) {
            let newer = match (
                chrome_version(&current.extension_version),
                chrome_version(&browser.extension_version),
            ) {
                (Ok(current), Ok(previous)) => current > previous,
                _ => false,
            };
            if current.generation != browser.generation
                && newer
                && reaches(&current.extension_version, min_version)
                && reaches(&current.extension_version, target.as_deref())
            {
                return finish(
                    true,
                    "updated",
                    Some(current.extension_version.clone()),
                    "New extension connection and version verified".into(),
                );
            }
        }
        tokio::select! {
            biased;
            reply = &mut receiver, if receiving => {
                receiving = false;
                match reply {
                    Ok(frame) => match frame.body {
                        ResponseBody::Ok(value) => match value.get("status").and_then(Value::as_str) {
                            Some("update_available") => {
                                target = value.get("version").and_then(Value::as_str).map(str::to_owned);
                                if target.as_deref().is_none_or(|version| chrome_version(version).is_err()) {
                                    return finish(false, "failed", None, "Extension returned an invalid update version".into());
                                }
                            }
                            Some("no_update") => {
                                let ok = reaches(&browser.extension_version, min_version);
                                return finish(ok, if ok { "no_update" } else { "version_too_old" }, Some(browser.extension_version.clone()),
                                    if ok { "Chrome reports no update".into() } else { format!("Required extension {} not available; check publication, cache and update policy", min_version.unwrap_or_default()) });
                            }
                            Some("throttled") => return finish(false, "throttled", Some(browser.extension_version.clone()), "Chrome throttled the check; retry later, not in a tight loop".into()),
                            _ => return finish(false, "failed", None, "Invalid extension update response".into()),
                        },
                        ResponseBody::Err(error) => {
                            if error.code == ErrorCode::UnknownMethod || error.code == ErrorCode::Unsupported {
                                return finish(false, "unsupported", Some(browser.extension_version.clone()), "Extension lacks managed update support; bootstrap it once via centrally managed Chrome update/restart, not bsk update".into());
                            }
                            let reason = error.data.as_ref().and_then(|data| data.get("reason")).and_then(Value::as_str);
                            if !matches!(reason, Some("extension_reconnected" | "extension_disconnected")) {
                                return finish(false, "failed", None, error.message);
                            }
                            // 旧 socket 关闭是预期现象，但仍须等待同一实例用新版重连。
                        }
                    },
                    Err(_) => { /* 重载可能丢失响应，继续核验新连接。 */ }
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                let current = state.browsers.get(&browser.id).map(|client| client.extension_version.clone());
                return finish(false, "timeout", current, "Update dispatched but running target version was not verified before timeout; inspect state before retrying".into());
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
}
