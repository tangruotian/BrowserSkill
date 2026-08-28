//! Session-scoped tools (`tool.session_*`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ErrorCode;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    #[default]
    AgentWindow,
    CurrentTab,
}

impl SessionMode {
    fn is_agent_window(&self) -> bool {
        *self == Self::AgentWindow
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStartParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_instance_id: Option<String>,
    /// Optional Agent Window outer width in CSS pixels (100..=7680).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Optional Agent Window outer height in CSS pixels (100..=7680).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Whether the new Agent Window should take focus. Omitted means the
    /// extension's default (`true`) for compatibility with older clients.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    /// Session target selection. The default keeps the isolated Agent Window
    /// behaviour; `current_tab` binds the last-focused window's active tab.
    #[serde(default, skip_serializing_if = "SessionMode::is_agent_window")]
    pub mode: SessionMode,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStartResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_window_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attached_tab_id: Option<i64>,
    #[serde(default)]
    pub fallback_created: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStopParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ReturnFailure {
    pub tab_id: i64,
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStopResult {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub returned_tab_ids: Vec<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub return_failures: Vec<ReturnFailure>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_start_focus_is_optional_and_round_trips_false() {
        let defaulted: SessionStartParams = serde_json::from_value(json!({
            "session_id": "aa11"
        }))
        .unwrap();
        assert_eq!(defaulted.focused, None);
        assert_eq!(defaulted.mode, SessionMode::AgentWindow);

        let background: SessionStartParams = serde_json::from_value(json!({
            "session_id": "aa11",
            "focused": false
        }))
        .unwrap();
        assert_eq!(background.focused, Some(false));
        assert_eq!(serde_json::to_value(background).unwrap()["focused"], false);
    }

    #[test]
    fn session_start_current_tab_mode_round_trips() {
        let params: SessionStartParams = serde_json::from_value(json!({
            "session_id": "aa11",
            "mode": "current_tab"
        }))
        .unwrap();
        assert_eq!(params.mode, SessionMode::CurrentTab);
        assert_eq!(serde_json::to_value(params).unwrap()["mode"], "current_tab");
    }

    #[test]
    fn session_start_result_reports_current_tab_fallback() {
        let result: SessionStartResult = serde_json::from_value(json!({
            "attached_tab_id": 88,
            "fallback_created": true
        }))
        .unwrap();
        assert_eq!(result.agent_window_id, None);
        assert_eq!(result.attached_tab_id, Some(88));
        assert!(result.fallback_created);
        let encoded = serde_json::to_value(result).unwrap();
        assert_eq!(encoded["attached_tab_id"], 88);
        assert_eq!(encoded["fallback_created"], true);
    }

    #[test]
    fn session_stop_result_round_trips_auto_return_payload() {
        let result: SessionStopResult = serde_json::from_value(json!({
            "returned_tab_ids": [7, 8],
            "return_failures": [
                { "tab_id": 9, "code": "cdp_failed", "message": "move failed" }
            ]
        }))
        .unwrap();

        assert_eq!(result.returned_tab_ids, vec![7, 8]);
        assert_eq!(result.return_failures[0].tab_id, 9);
        assert_eq!(result.return_failures[0].code, ErrorCode::CdpFailed);
        let encoded = serde_json::to_value(result).unwrap();
        assert_eq!(encoded["returned_tab_ids"], json!([7, 8]));
        assert_eq!(encoded["return_failures"][0]["code"], "cdp_failed");
    }
}
