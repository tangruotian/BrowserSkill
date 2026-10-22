//! Both `record start` and `record stop` can receive the same completed trace.
//! Serialize only their session teardown, never the blocking capture/await RPC.
//! The second process must verify absence rather than interpret `Stopping` as
//! successful cleanup. Keep the lock inode: unlinking it breaks cross-process locking.

use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::Context;
use fs2::FileExt;
use serde::Deserialize;

use crate::cli::business_rpc;
use crate::cli::error::CliError;
use crate::cli::session::{StopReply, stop_session};
use crate::daemon::paths;
use bsk_protocol::{ErrorCode, Method};

const CLEANUP_WAIT: Duration = Duration::from_secs(60);

struct CleanupLock(File);

impl Drop for CleanupLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

fn lock() -> Result<CleanupLock, CliError> {
    paths::ensure_bsk_home()?;
    let path = paths::record_session_path()?.with_extension("cleanup.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .context("open recording cleanup lock")?;
    let deadline = Instant::now() + CLEANUP_WAIT;
    loop {
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => return Ok(CleanupLock(file)),
            // fs2 uses ERROR_LOCK_VIOLATION on Windows, whose ErrorKind is not
            // WouldBlock. Compare the library's platform-specific contention code.
            Err(err)
                if err.raw_os_error() == fs2::lock_contended_error().raw_os_error()
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(err) => {
                return Err(CliError::Local(anyhow::Error::new(err).context(
                    "recording cleanup lock unavailable; recording state retained for retry",
                )));
            }
        }
    }
}

#[derive(Deserialize)]
struct SessionList {
    sessions: Vec<SessionIdentity>,
}

#[derive(Deserialize)]
struct SessionIdentity {
    session_id: String,
}

/// Only a valid daemon reply proves absence; transport and malformed replies
/// remain errors. Never infer success from a missing local record-session file.
fn absent(sock: PathBuf, session_id: &str) -> Result<bool, CliError> {
    let reply: SessionList = business_rpc::call::<(), _>(
        sock,
        "record-cleanup-check",
        Method::SessionList,
        None,
        Duration::from_secs(5),
    )?;
    Ok(!reply
        .sessions
        .iter()
        .any(|session| session.session_id == session_id))
}

/// A successful transport response can contain failed tab returns. Do not
/// clear ownership or render `window_closed: true` until the named session is
/// explicitly stopped, with no cleanup failures hidden in the result body.
fn validate_reply(reply: &StopReply, session_id: &str) -> Result<(), CliError> {
    if reply.stopped.iter().any(|id| id == session_id)
        && reply.failed.is_empty()
        && reply.return_failures.is_empty()
    {
        return Ok(());
    }
    Err(CliError::Local(anyhow::anyhow!(
        "recording session cleanup not confirmed for {session_id}; state retained for retry"
    )))
}

pub(super) fn close(sock: PathBuf, session_id: &str) -> Result<(), CliError> {
    let _lock = lock()?;
    if absent(sock.clone(), session_id)? {
        return Ok(());
    }
    match stop_session(sock.clone(), session_id) {
        Ok(reply) => validate_reply(&reply, session_id),
        Err(err) if matches!(err.code(), Some(ErrorCode::Timeout | ErrorCode::NotFound)) => {
            // An older CLI or another exact-session closer may not use our lock.
            // Wait for verified removal, but never retry capture or suppress a
            // real timeout while the session is still present.
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if absent(sock.clone(), session_id)? {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(err);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Transport success is not equivalent to returning browser control.
    #[test]
    fn validates_the_exact_session_and_rejects_partial_cleanup() {
        let reply = |value| serde_json::from_value::<StopReply>(value).unwrap();
        assert!(validate_reply(&reply(serde_json::json!({"stopped":["ours"]})), "ours").is_ok());
        for value in [
            serde_json::json!({"stopped":["other"]}),
            serde_json::json!({"stopped":[], "failed":[{"session_id":"ours","code":"cdp_failed","message":"return failed"}]}),
        ] {
            assert!(validate_reply(&reply(value), "ours").is_err());
        }
    }
}
