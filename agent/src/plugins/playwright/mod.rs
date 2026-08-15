//! Playwright Plugin — browser automation MCP service management.
//!
//! Unlike the other plugins, Playwright exposes NO MCP tools: the process is
//! managed over the admin HTTP surface (/api/plugins/playwright/start|stop,
//! round-admin-ui), while tool calls go through the mcp_client plugin
//! (mcp_client_connect at 127.0.0.1:9229/mcp).

pub mod manager;

use vale_agent_core::{Plugin, ToolDef};

/// Plugin struct — thin facade over the shared `Arc<PlaywrightManager>`
/// (the same Arc lives in AppState, so /api/plugins/status and the HTTP
/// routes see one state machine).
pub struct PlaywrightPlugin {
    pub manager: std::sync::Arc<manager::PlaywrightManager>,
}

impl PlaywrightPlugin {
    pub fn new(manager: std::sync::Arc<manager::PlaywrightManager>) -> Self {
        Self { manager }
    }
}

impl Plugin for PlaywrightPlugin {
    fn name(&self) -> &'static str {
        "playwright"
    }
    fn display_name(&self) -> &'static str {
        "Playwright"
    }
    fn description(&self) -> &'static str {
        "playwright-mcp browser automation"
    }
    fn tools(&self) -> Vec<ToolDef> {
        vec![] // 工具经 /api/plugins/* HTTP 路由,不走 MCP
    }
}
