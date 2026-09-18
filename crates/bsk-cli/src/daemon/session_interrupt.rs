//! Per-session "pending interrupt" message.
//!
//! Holds a single-use marker per `SessionId` indicating that the
//! user has clicked the agent-window mask's stop button. The next
//! browser-input-dispatching `tool.*` call for that session is rejected
//! with `ErrorCode::UserAborted`; passive reads and session-lifecycle
//! RPCs pass through transparently and do not consume the marker.
//!
//! The marker is single-use and has no expiry: it sits in the
//! registry until consumed by an input-dispatching call, explicitly acknowledged
//! with the observed token for a new user request, or until the session is torn down.
//! This lets the user's interrupt survive an LLM
//! thinking phase of arbitrary length — the v1 time-window
//! mechanism dropped interrupts whenever the LLM took longer to
//! respond than the window allowed.
//!
//! Independent of `SessionRegistry` because the signal is a
//! transient runtime control state, not a session lifecycle
//! attribute.

use std::collections::HashMap;
use std::sync::Mutex;

use super::sessions::SessionId;

#[derive(Default)]
pub struct SessionInterruptRegistry {
    inner: Mutex<HashMap<SessionId, String>>,
}

impl std::fmt::Debug for SessionInterruptRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let len = self.inner.lock().map(|g| g.len()).unwrap_or(0);
        f.debug_struct("SessionInterruptRegistry")
            .field("len", &len)
            .finish()
    }
}

impl SessionInterruptRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 每次停止都生成新的标识，重复事件仍只保留一项。不能复用旧标识：用户在确认
    /// 旧中断期间再次停止时，旧请求必须无法清掉这次新中断。标识不含业务信息。
    pub fn mark(&self, sid: &SessionId) {
        let mut guard = self.inner.lock().expect("session_interrupt poisoned");
        guard.insert(sid.clone(), uuid::Uuid::new_v4().to_string());
    }

    /// Whether `sid` currently has a pending interrupt marker.
    pub fn is_pending(&self, sid: &SessionId) -> bool {
        let guard = self.inner.lock().expect("session_interrupt poisoned");
        guard.contains_key(sid)
    }

    /// Probe + consume. If `sid` has a pending interrupt, remove it
    /// and return `true`. Otherwise return `false` without
    /// modifying the registry.
    ///
    /// Single-use semantics: once consumed by one call, subsequent
    /// `try_consume` calls for the same session return `false`
    /// until the session is marked again.
    pub fn try_consume(&self, sid: &SessionId) -> bool {
        let mut guard = self.inner.lock().expect("session_interrupt poisoned");
        guard.remove(sid).is_some()
    }

    /// 只读快照，不消耗标记；普通状态读取不能替用户恢复执行。
    pub fn pending_token(&self, sid: &SessionId) -> Option<String> {
        self.inner
            .lock()
            .expect("session_interrupt poisoned")
            .get(sid)
            .cloned()
    }

    /// 在同一锁内比较并确认旧标记。调用方必须携带新执行指令开始时读到的标识；
    /// `None` 也参与比较，确保原本无中断时新发生的停止不会被启动流程吞掉。
    /// 返回 false 表示快照之后状态变化，保留当前标记并要求调用方停止本次启动。
    pub fn acknowledge(&self, sid: &SessionId, expected: Option<&str>) -> bool {
        let mut guard = self.inner.lock().expect("session_interrupt poisoned");
        if guard.get(sid).map(String::as_str) != expected {
            return false;
        }
        guard.remove(sid);
        true
    }

    /// Drop any pending entry for `sid`. **Every** session-teardown
    /// path MUST call this so a session torn down while a signal
    /// was hot does not leak the entry into the registry
    /// indefinitely. Current call sites:
    ///
    /// * `stop_session` (session.stop RPC)
    /// * `forget_session` (extension closed the agent window)
    /// * `purge_browser` cascade (browser disconnect — see
    ///   `daemon/ws.rs`)
    ///
    /// If a future code path adds a fourth teardown route, add the
    /// `drop_session` call there too — there is no static check
    /// enforcing this.
    pub fn drop_session(&self, sid: &SessionId) {
        let mut guard = self.inner.lock().expect("session_interrupt poisoned");
        guard.remove(sid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sid(s: &str) -> SessionId {
        SessionId(s.to_string())
    }

    /// 两阶段确认必须只清理旧中断，并在无标记快照和再次停止的竞争中保留新标记。
    #[test]
    fn acknowledgement_preserves_new_interrupts() {
        let reg = SessionInterruptRegistry::new();
        let a = sid("A");
        assert!(reg.acknowledge(&a, None));
        reg.mark(&a);
        let old = reg.pending_token(&a).unwrap();
        assert!(!reg.acknowledge(&a, None));
        reg.mark(&a);
        let new = reg.pending_token(&a).unwrap();
        assert_ne!(old, new);
        assert!(!reg.acknowledge(&a, Some(&old)));
        assert_eq!(reg.pending_token(&a), Some(new.clone()));
        reg.mark(&sid("B"));
        assert!(reg.acknowledge(&a, Some(&new)));
        assert!(!reg.is_pending(&a));
        assert!(reg.is_pending(&sid("B")));
        reg.mark(&a);
        assert!(reg.try_consume(&a));
    }

    #[test]
    fn new_registry_is_empty() {
        let reg = SessionInterruptRegistry::new();
        assert!(reg.inner.lock().unwrap().is_empty());
    }

    #[test]
    fn mark_inserts_an_entry() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        assert!(reg.inner.lock().unwrap().contains_key(&sid("A")));
    }

    #[test]
    fn repeated_marks_keep_one_entry_per_session() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.mark(&sid("A"));
        assert_eq!(reg.inner.lock().unwrap().len(), 1);
    }

    #[test]
    fn mark_distinguishes_sessions() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.mark(&sid("B"));
        assert_eq!(reg.inner.lock().unwrap().len(), 2);
    }

    #[test]
    fn is_pending_reflects_mark_without_consuming() {
        let reg = SessionInterruptRegistry::new();
        assert!(!reg.is_pending(&sid("A")));
        reg.mark(&sid("A"));
        assert!(reg.is_pending(&sid("A")));
        assert!(reg.try_consume(&sid("A")));
        assert!(!reg.is_pending(&sid("A")));
    }

    #[test]
    fn try_consume_on_unmarked_session_returns_false() {
        let reg = SessionInterruptRegistry::new();
        assert!(!reg.try_consume(&sid("ghost")));
        assert!(reg.inner.lock().unwrap().is_empty());
    }

    #[test]
    fn try_consume_after_mark_returns_true_and_removes() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        assert!(reg.try_consume(&sid("A")));
        assert!(!reg.inner.lock().unwrap().contains_key(&sid("A")));
    }

    #[test]
    fn try_consume_is_single_use() {
        // Two consecutive consumes: only the first wins.
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        assert!(reg.try_consume(&sid("A")));
        assert!(!reg.try_consume(&sid("A")));
    }

    #[test]
    fn try_consume_does_not_affect_other_sessions() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.mark(&sid("B"));
        assert!(reg.try_consume(&sid("A")));
        assert!(reg.inner.lock().unwrap().contains_key(&sid("B")));
    }

    #[test]
    fn drop_session_clears_pending_entry() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.drop_session(&sid("A"));
        assert!(!reg.inner.lock().unwrap().contains_key(&sid("A")));
    }

    #[test]
    fn drop_session_on_unknown_session_is_noop() {
        let reg = SessionInterruptRegistry::new();
        reg.drop_session(&sid("ghost"));
        assert!(reg.inner.lock().unwrap().is_empty());
    }

    #[test]
    fn drop_session_does_not_affect_other_sessions() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.mark(&sid("B"));
        reg.drop_session(&sid("A"));
        assert!(!reg.inner.lock().unwrap().contains_key(&sid("A")));
        assert!(reg.inner.lock().unwrap().contains_key(&sid("B")));
    }

    #[test]
    fn drop_session_after_mark_makes_subsequent_try_consume_return_false() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.drop_session(&sid("A"));
        assert!(!reg.try_consume(&sid("A")));
    }
}
