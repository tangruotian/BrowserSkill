//! 页面 SDK / WebMCP 的窄入口。固定程序经现有 tool.evaluate 派发，兼容原来的 daemon 和扩展。
//! JSON 输入先在本机校验，发现令牌绑定实际会话和页面。退出码 0=成功返回，1=明确失败，
//! 2=可能已派发而结果未知。任何错误均不自动重试；超时/取消不能保证已提交的业务回滚。
use super::{
    business_rpc,
    ensure_daemon::ensure_daemon,
    error::{CliError, Format},
};
use anyhow::{Context, bail};
use bsk_protocol::{
    Method,
    tools::{EvaluateParams, EvaluateResult},
};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::{fs::File, io::Read, path::PathBuf, time::Duration};

const BRIDGE: &str = include_str!("webmcp_bridge.js");
const INPUT_LIMIT: usize = 65_536;
const OUTPUT_LIMIT: usize = 262_144;

#[derive(Debug, Clone, Args)]
pub struct WebMcpArgs {
    #[command(subcommand)]
    pub sub: WebMcpSub,
}
#[derive(Debug, Clone, Subcommand)]
pub enum WebMcpSub {
    /// Discover tools in the bound page; retain document_id and binding_id for calls.
    List(TargetArgs),
    /// Invoke one discovered page tool; never retries a submitted operation.
    Call(CallArgs),
}
#[derive(Debug, Clone, Args)]
pub struct TargetArgs {
    /// Existing BrowserSkill session (no implicit browser/session creation).
    #[arg(long)]
    pub session: String,
    /// Explicit tab owned by this session; otherwise use the session target.
    #[arg(long)]
    pub tab_id: Option<i64>,
    /// Page wait budget, 1ms..20s; bounded below the daemon's existing tool deadline.
    #[arg(long, default_value = "15s", value_parser = super::navigate::parse_timeout_ms)]
    pub timeout: u32,
}
#[derive(Debug, Clone, Args)]
pub struct CallArgs {
    /// Exact tool name returned by webmcp list.
    pub name: String,
    #[command(flatten)]
    pub target: TargetArgs,
    /// Document identity returned by webmcp list.
    #[arg(long)]
    pub document_id: String,
    /// Discovery binding returned by webmcp list; not an authorization credential.
    #[arg(long)]
    pub binding_id: String,
    /// JSON object, max 64 KiB. Prefer --input-file to avoid shell escaping.
    #[arg(long, conflicts_with = "input_file")]
    pub input: Option<String>,
    /// UTF-8 JSON object file (max 64 KiB); omitted input defaults to {}.
    #[arg(long, conflicts_with = "input")]
    pub input_file: Option<PathBuf>,
}

/// 限量读取，避免把意外的大文件加载进内存；错误文案不回显文件内容或凭据。
fn read_input(args: &CallArgs) -> anyhow::Result<Value> {
    let text = if let Some(path) = &args.input_file {
        let mut bytes = Vec::new();
        File::open(path)
            .context("cannot open input file")?
            .take((INPUT_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > INPUT_LIMIT {
            bail!("input exceeds 64 KiB");
        }
        String::from_utf8(bytes).context("input file must be UTF-8")?
    } else {
        args.input.clone().unwrap_or_else(|| "{}".into())
    };
    if text.len() > INPUT_LIMIT {
        bail!("input exceeds 64 KiB");
    }
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .context("input must be valid JSON")?;
    if !value.is_object() {
        bail!("input must be a JSON object");
    }
    Ok(value)
}

/// 测试与真实 CLI 共用序列化，用户字符串始终作为函数实参 JSON，不能改变固定源码。
pub fn expression(request: &Value) -> String {
    format!("({BRIDGE})({request})")
}
fn failure(code: &str, message: &str, dispatched: bool) -> Value {
    json!({"webmcp":true,"protocol_version":1,"ok":false,"code":code,"message":message,
        "dispatched":dispatched,"outcome":if dispatched {"unknown"} else {"not_started"}})
}

/// 输出只打印一份完整 JSON。超大/格式错误的回执不能被误判为成功；传输失败保守视为结果未知。
fn receipt(reply: EvaluateResult, is_call: bool) -> Value {
    let Some(value) = reply.value.filter(|v| {
        reply.ok && v["webmcp"] == true && v["protocol_version"] == 1 && v["ok"].is_boolean()
    }) else {
        return failure(
            "invalid_result",
            "页面未返回有效回执，请核对业务状态。",
            is_call,
        );
    };
    if value.to_string().len() > OUTPUT_LIMIT {
        return failure(
            "output_too_large",
            "结果超过 256 KiB，请缩小查询；写操作不要重试。",
            is_call,
        );
    }
    value
}
/// 0.4.2 的共享控制可能在脚本派发前拒绝请求。仅信任结构化 effect_state=none；
/// 无此证明的 IPC/执行错误仍按 unknown 处理，避免 Agent 重复提交业务写入。
/// 不回显原始错误载荷，防止页面内容或敏感字段进入通用失败回执。
fn rpc_failure(error: &CliError, is_call: bool) -> Value {
    if error
        .data()
        .is_some_and(|data| data["effect_state"] == "none")
    {
        return failure(
            "precondition_failed",
            "调用在执行前被拒绝；请 cooperate sync 检查控制状态和页面，再决定下一步。",
            false,
        );
    }
    failure(
        "transport_failed",
        "浏览器调用中断或取消；请检查连接并核对业务状态。",
        is_call,
    )
}
fn execute(args: WebMcpArgs) -> anyhow::Result<Value> {
    let (target, mut request, is_call) = match args.sub {
        WebMcpSub::List(target) => (target, json!({"action":"list"}), false),
        WebMcpSub::Call(args) => {
            let input = read_input(&args)?;
            if args.name.trim().is_empty()
                || args.document_id.trim().is_empty()
                || args.binding_id.trim().is_empty()
            {
                bail!("name, document-id and binding-id must be nonempty");
            }
            (
                args.target,
                json!({"action":"call","name":args.name,"document_id":args.document_id,"binding_id":args.binding_id,"input":input}),
                true,
            )
        }
    };
    if target.session.trim().is_empty() || !(1..=20_000).contains(&target.timeout) {
        bail!("session must be nonempty; timeout must be between 1ms and 20s");
    }
    request["session_id"] = json!(target.session);
    request["timeout_ms"] = json!(target.timeout);
    // daemon 启动失败发生在任何页面派发之前；只有调用 IPC 后的失败才需要保守报告 unknown。
    let info = ensure_daemon().context("cannot connect BrowserSkill daemon")?;
    let params = EvaluateParams {
        session_id: target.session,
        tab_id: target.tab_id,
        expression: expression(&request),
        await_promise: Some(true),
        return_by_value: Some(true),
        timeout_ms: Some(target.timeout + 2000),
    };
    let result = business_rpc::call::<_, EvaluateResult>(
        info.sock_path,
        "webmcp",
        Method::ToolEvaluate,
        Some(params),
        Duration::from_millis(u64::from(target.timeout) + 15_000),
    );
    Ok(match result {
        Ok(reply) => receipt(reply, is_call),
        Err(error) => rpc_failure(&error, is_call),
    })
}
pub fn dispatch(args: WebMcpArgs, _format: Format) -> Result<(), CliError> {
    let value =
        execute(args).unwrap_or_else(|error| failure("not_started", &error.to_string(), false));
    let code = if value["outcome"] == "unknown" {
        2
    } else if value["ok"] == true {
        0
    } else {
        1
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&value).map_err(|e| CliError::Local(e.into()))?
    );
    if code == 0 {
        Ok(())
    } else {
        Err(CliError::RenderedExit { exit_code: code })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    /// 参数边界必须在连接浏览器前拒绝；文件/inline 互斥、发现身份必填。
    #[test]
    fn parses_discovery_and_requires_binding() {
        assert!(crate::Cli::try_parse_from(["bsk", "webmcp", "list", "--session", "s"]).is_ok());
        assert!(
            crate::Cli::try_parse_from([
                "bsk",
                "webmcp",
                "call",
                "save",
                "--session",
                "s",
                "--document-id",
                "d"
            ])
            .is_err()
        );
        assert!(
            crate::Cli::try_parse_from([
                "bsk",
                "webmcp",
                "call",
                "save",
                "--session",
                "s",
                "--document-id",
                "d",
                "--binding-id",
                "b",
                "--input",
                "{}",
                "--input-file",
                "x"
            ])
            .is_err()
        );
    }
    /// JSON 根必须为对象；含引号、换行的内容保持 JSON 实参，不以拼接源码传入。
    #[test]
    fn rejects_non_object_input_and_preserves_data() {
        let mut args = CallArgs {
            name: "save".into(),
            target: TargetArgs {
                session: "s".into(),
                tab_id: None,
                timeout: 15000,
            },
            document_id: "d".into(),
            binding_id: "b".into(),
            input: Some("[]".into()),
            input_file: None,
        };
        assert!(read_input(&args).is_err());
        args.input = Some("{\"text\":\"'); throw 1;//\"}".into());
        let input = read_input(&args).unwrap();
        assert!(expression(&input).ends_with(&format!("({input})")));
        args.input = Some("x".repeat(INPUT_LIMIT + 1));
        assert!(read_input(&args).is_err());
    }
    /// 前置控制拒绝与连接断开必须可区分；不能仅凭错误文案推断业务没有执行。
    #[test]
    fn respects_explicit_no_effect_without_guessing_transport_outcome() {
        let denied = CliError::Rpc {
            code: bsk_protocol::ErrorCode::InvalidParams,
            message: "private page details".into(),
            data: Some(json!({"effect_state":"none"})),
            source: None,
        };
        let value = rpc_failure(&denied, true);
        assert_eq!(value["outcome"], "not_started");
        assert_eq!(value["dispatched"], false);
        assert!(!value.to_string().contains("private page details"));
        let disconnected = CliError::Local(anyhow::anyhow!("connection closed"));
        assert_eq!(rpc_failure(&disconnected, true)["outcome"], "unknown");
        assert_eq!(rpc_failure(&disconnected, false)["outcome"], "not_started");
    }
    /// WebMCP 复用全局控制参数，避免自己的解析层丢弃 0.4.2 的观察凭据。
    #[test]
    fn accepts_shared_control_evidence() {
        let cli = crate::Cli::try_parse_from([
            "bsk",
            "webmcp",
            "list",
            "--session",
            "s",
            "--context",
            "ctx",
            "--observation",
            "obs",
        ])
        .unwrap();
        assert_eq!(cli.flags.context.as_deref(), Some("ctx"));
        assert_eq!(cli.flags.observation.as_deref(), Some("obs"));
    }
}
