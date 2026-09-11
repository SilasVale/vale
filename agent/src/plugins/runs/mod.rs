//! Runs Plugin — RUN identity for the AI's work on this device.
//!
//! Tools: `run_begin`, `run_end`.
//!
//! A "run" is ONE AI execution: the boundary a caller draws around a piece of
//! work so its terminal commands and its browser actions can be told apart from
//! another AI's, and from the same AI's later work. The device cannot derive
//! that boundary — possession of the token identifies the DEVICE, not the
//! caller (`web/panel.rs`), `clientInfo` is a software constant, and the
//! console gateway implements no MCP session id — so the caller DECLARES it and
//! the device MINTS an id for it. See [`crate::runs`] for the record format and
//! for the rule that governs the whole feature: a `run_id` is a LABEL, NEVER A
//! CREDENTIAL.
//!
//! Why these are MCP TOOLS rather than an HTTP route (the way the session goal
//! is a control route): the caller IS the AI, and the AI's only channel to this
//! device is MCP. A route would be unreachable from the console.
//!
//! Stateless — the log lives in `DataDir\runs\runs.jsonl`, resolved through
//! [`crate::paths::runs_dir`], and each call is self-contained.

pub mod tools;

use vale_agent_core::{Plugin, ToolDef};

/// Plugin struct — stateless; tools capture no shared state.
pub struct RunsPlugin;

impl Plugin for RunsPlugin {
    fn name(&self) -> &'static str {
        "runs"
    }
    fn display_name(&self) -> &'static str {
        "Runs"
    }
    fn description(&self) -> &'static str {
        "Run identity — declare the boundaries of one AI execution so its work can be grouped and told apart from another's"
    }
    fn tools(&self) -> Vec<ToolDef> {
        tools::build()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tool surface is exactly these two, and the plugin is registered
    /// under the name the panel and the gateway contract will look for. A
    /// silent third tool (or a rename) has to fail here rather than drift.
    #[test]
    fn exposes_exactly_run_begin_and_run_end() {
        let names: Vec<String> = RunsPlugin.tools().iter().map(|t| t.name.clone()).collect();
        assert_eq!(names, vec!["run_begin", "run_end"]);
        assert_eq!(RunsPlugin.name(), "runs");
    }
}
