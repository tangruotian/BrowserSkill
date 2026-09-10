//! Versioned, constrained pipeline requests. Read and mutation methods have separate interrupt gates.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PipelineParams {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    pub request: serde_json::Value,
}
