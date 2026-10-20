//! `bsk extension update`：通过现有 daemon 统一检查并应用扩展更新。
//! 这是管理员命令；发出后即使 CLI 退出也不能撤销 Chrome 已接受的升级。

use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::extension::{ExtensionUpdateParams, ExtensionUpdateResult};
use clap::{Args, Subcommand};

use super::error::{CliError, Format};

#[derive(Debug, Subcommand)]
pub enum ExtensionCmd {
    /// Check and immediately apply extension updates, interrupting active tasks.
    Update(ExtensionUpdateArgs),
}

#[derive(Debug, Args)]
pub struct ExtensionUpdateArgs {
    /// Update all currently connected browsers (the default).
    #[arg(long, conflicts_with = "browser")]
    pub all: bool,
    /// Restrict the operation to this browser instance id or label.
    #[arg(long)]
    pub browser: Option<String>,
    /// Fail unless the running extension reaches at least this Chrome version.
    #[arg(long)]
    pub min_version: Option<String>,
    /// Total browser-connect/check/reconnect deadline; never an idle-task wait.
    #[arg(long, default_value = "120s", value_parser = super::daemon::parse_duration)]
    pub timeout: Duration,
}

/// 不调用上游 `bsk update`，不升级 CLI 自身。成功必须来自 daemon 的逐浏览器核验；
/// 任一浏览器失败时仍输出全部结果并返回非零，不能把部分成功包装为整体升级成功。
pub fn dispatch(command: ExtensionCmd, format: Format) -> Result<(), CliError> {
    let ExtensionCmd::Update(args) = command;
    let params = ExtensionUpdateParams {
        browser: args.browser,
        min_version: args.min_version,
        timeout_ms: u32::try_from(args.timeout.as_millis())
            .context("extension update timeout is too large")?,
    };
    params.validate().map_err(anyhow::Error::msg)?;
    let info = super::ensure_daemon::ensure_daemon()?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build extension update runtime")?;
    let result: ExtensionUpdateResult = rt.block_on(async {
        let mut client = crate::ipc_client::IpcClient::connect(info.sock_path).await?;
        client
            .call(
                "extension-update",
                Method::ExtensionUpdate,
                Some(params),
                args.timeout + Duration::from_secs(5),
            )
            .await?
            .map_err(CliError::from_rpc)
    })?;
    match format {
        Format::Json => println!(
            "{}",
            serde_json::to_string_pretty(&result).map_err(anyhow::Error::from)?
        ),
        Format::Human => {
            for browser in &result.browsers {
                println!(
                    "{}: {} ({} -> {}) {}",
                    browser.instance_id,
                    browser.status,
                    browser.previous_version,
                    browser.current_version.as_deref().unwrap_or("unknown"),
                    browser.message
                );
            }
        }
    }
    if result.ok {
        Ok(())
    } else {
        Err(CliError::RenderedExit { exit_code: 1 })
    }
}
