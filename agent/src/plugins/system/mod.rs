//! System Plugin — device-local OS tools for AI agents.
//!
//! Tools: system_file_list, system_file_read, system_file_write,
//!        system_file_download, system_file_upload, system_process_list,
//!        system_process_kill, system_net_test.
//!
//! These fill the gap between terminal sessions (interactive shells) and
//! the rest of the MCP toolset: one-shot, structured, non-interactive OS
//! operations (file browsing/editing, process management, network probing)
//! without spawning a shell.
//!
//! Stateless by design — every call is a self-contained action. Paths are
//! resolved on THIS device (the agent host), NOT through a terminal session.

pub mod tools;

use vale_agent_core::{Plugin, ToolDef};

/// Plugin struct — stateless; tools capture no shared state.
pub struct SystemPlugin;

impl Plugin for SystemPlugin {
    fn name(&self) -> &'static str {
        "system"
    }
    fn display_name(&self) -> &'static str {
        "System"
    }
    fn description(&self) -> &'static str {
        "Device-local OS tools for AI agents (system_file_list/read/write, system_process_list/kill, system_net_test)"
    }
    fn tools(&self) -> Vec<ToolDef> {
        tools::build()
    }
}
