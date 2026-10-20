//! 部署控制面：检查扩展更新，不创建会话，也不等待现有任务完成。

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// CLI → daemon 的统一升级请求。省略 browser 时更新当前所有已连接浏览器；
/// min_version 是部署包要求的最低扩展版本，而不是 CLI/Agent 的版本号。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExtensionUpdateParams {
    pub browser: Option<String>,
    pub min_version: Option<String>,
    pub timeout_ms: u32,
}

impl ExtensionUpdateParams {
    /// 在任何派发之前检查参数，避免非法请求也触发不可撤销的扩展重载。
    pub fn validate(&self) -> Result<(), String> {
        if !(100..=600_000).contains(&self.timeout_ms) {
            return Err("timeout_ms must be between 100 and 600000".into());
        }
        if let Some(version) = &self.min_version {
            chrome_version(version)?;
        }
        Ok(())
    }
}

/// 单浏览器结论。ok 只表示已核验运行版本或检查确认无需更新；
/// 已发出检查、下载完成、断开旧连接都不能单独算成功。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExtensionUpdateEntry {
    pub instance_id: String,
    pub previous_version: String,
    pub current_version: Option<String>,
    pub ok: bool,
    pub status: String,
    pub message: String,
}

/// 部分失败也保留其余浏览器的结果，供统一发布系统判断整体退出码。
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ExtensionUpdateResult {
    pub ok: bool,
    pub browsers: Vec<ExtensionUpdateEntry>,
}

/// Chrome manifest 支持 1～4 段数字，不能用 semver 的三段/预发布比较替代。
/// 补零后按数值比较；拒绝空段、前导零和超出 Chrome 范围的段。
pub fn chrome_version(value: &str) -> Result<[u16; 4], String> {
    let mut parts = [0; 4];
    let segments: Vec<_> = value.split('.').collect();
    if segments.is_empty() || segments.len() > 4 {
        return Err(format!("invalid Chrome extension version: {value}"));
    }
    for (index, segment) in segments.iter().enumerate() {
        if segment.is_empty()
            || !segment.bytes().all(|byte| byte.is_ascii_digit())
            || (segment.len() > 1 && segment.starts_with('0'))
        {
            return Err(format!("invalid Chrome extension version: {value}"));
        }
        parts[index] = segment
            .parse()
            .map_err(|_| format!("invalid version: {value}"))?;
    }
    if parts == [0; 4] {
        return Err("Chrome extension version must be greater than zero".into());
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 防止 0.3.10 被字符串比较判定为小于 0.3.9，并兼容四段 Chrome 版本。
    #[test]
    fn compares_numeric_chrome_versions() {
        assert!(chrome_version("0.3.10").unwrap() > chrome_version("0.3.9").unwrap());
        assert_eq!(
            chrome_version("1.2").unwrap(),
            chrome_version("1.2.0.0").unwrap()
        );
        for invalid in ["", "0", "1.02", "1.2.3.4.5", "1.2-beta", "1.65536", "1..2"] {
            assert!(chrome_version(invalid).is_err(), "{invalid}");
        }
    }
}
