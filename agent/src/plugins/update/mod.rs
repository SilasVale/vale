//! Update Plugin — AI-pushed agent updates over MCP.
//!
//! Tool: `agent_update` — check the release server for a newer vale-agent and,
//! if found (or `force: true`), download + silently install it. The installer
//! kills this process and restarts it via the ValeAgent scheduled task, so the
//! tool returns "upgrading" as soon as the installer is spawned — the MCP
//! connection drops and comes back ~1 minute later on the new version.

mod tools;

// The staged-leftover list, re-exported for the BOOT sweep in `winmain.rs`. That
// sweep is part of the binary crate, so it cannot reach a private module — and
// re-exporting one function is the honest way to share it, rather than making the
// whole `tools` module public to hand out a path list.
// PUB, not pub(crate): the boot sweep that consumes this lives in the BINARY
// crate (`winmain.rs`), and the binary cannot see anything the lib keeps
// crate-private. Same reason `paths`, `state` and `register` are public.
pub use tools::staged_leftovers;

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
