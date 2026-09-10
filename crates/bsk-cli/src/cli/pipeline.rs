use crate::cli::{
    TOOL_IPC_TIMEOUT, business_rpc,
    ensure_daemon::ensure_daemon,
    error::{CliError, Format},
};
use anyhow::Context;
use bsk_protocol::{Method, tools::PipelineParams};
use clap::Args;

#[derive(Debug, Clone, Args)]
pub struct PipelineArgs {
    /// Versioned JSON request; arbitrary scripts are not accepted by the extension.
    pub request: String,
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub read: bool,
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,
}
pub fn dispatch(args: PipelineArgs, _format: Format) -> Result<(), CliError> {
    if args.request.len() > 65536 {
        return Err(CliError::Local(anyhow::anyhow!(
            "pipeline request exceeds 64 KiB"
        )));
    }
    let request: serde_json::Value =
        serde_json::from_str(&args.request).context("invalid pipeline JSON")?;
    let info = ensure_daemon().context("ensure daemon")?;
    let reply: serde_json::Value = business_rpc::call(
        info.sock_path,
        "pipeline",
        if args.read {
            Method::ToolPipelineRead
        } else {
            Method::ToolPipelineStep
        },
        Some(PipelineParams {
            session_id: args.session,
            tab_id: args.tab_id,
            request,
        }),
        TOOL_IPC_TIMEOUT,
    )?;
    println!(
        "{}",
        serde_json::to_string(&reply).context("pipeline response")?
    );
    Ok(())
}
