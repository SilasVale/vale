//! Update Plugin — AI-pushed agent updates over MCP.
//!
//! Tool: `agent_update` — check the release server for a newer vale-agent and,
//! if found (or `force: true`), download + silently install it. The installer
//! kills this process and restarts it via the ValeAgent scheduled task, so the
//! tool returns "upgrading" as soon as the installer is spawned — the MCP
//! connection drops and comes back ~1 minute later on the new version.

mod tools;

use vale_agent_core::ToolDef;

/// Plugin struct — stateless; every tool closes over what it needs.
pub struct UpdatePlugin {
    /// Download-site apex; `None` = no update channel configured (saisi
    /// decouple) — `agent_update` then returns an explicit error instead of
    /// hitting a hardcoded host.
    download_url: Option<String>,
}

impl UpdatePlugin {
    pub fn new(download_url: Option<String>) -> Self {
        Self { download_url }
    }
}

impl Default for UpdatePlugin {
    fn default() -> Self {
        Self::new(None)
    }
}

impl vale_agent_core::Plugin for UpdatePlugin {
    fn name(&self) -> &'static str {
        "update"
    }
    fn display_name(&self) -> &'static str {
        "Update"
    }
    fn description(&self) -> &'static str {
        "AI-pushed vale-agent updates"
    }
    fn tools(&self) -> Vec<ToolDef> {
        vec![tools::agent_update(self.download_url.clone())]
    }
}
