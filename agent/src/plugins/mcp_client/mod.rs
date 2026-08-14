//! MCP Client Plugin — bridge to a local browser MCP server (playwright-mcp
//! / chrome-devtools-mcp), DSH-style wiring.
//!
//! DeepSeek Harness connects external MCP servers through an `mcp-client`
//! plugin (`packages/mcp/mcp-client`) that registers the server's tools on the
//! agent's tool surface. Vale does the same, adapted to the device-agent
//! model: the browser MCP server (a Node process on this device) is reached
//! over Streamable HTTP at 127.0.0.1:9229/mcp; this plugin bridges to it at
//! RUNTIME (not register time) so a not-yet-started server doesn't break tool
//! discovery — the AI calls `mcp_client_connect` first, then drives the
//! browser through `mcp_client_call`.

mod tools;

use vale_agent_core::ToolDef;

/// Plugin struct — stateless; tools close over shared connection state.
pub struct McpClientPlugin;

impl McpClientPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for McpClientPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl vale_agent_core::Plugin for McpClientPlugin {
    fn name(&self) -> &'static str {
        "mcp-client"
    }
    fn display_name(&self) -> &'static str {
        "MCP Client"
    }
    fn description(&self) -> &'static str {
        "Bridge to local browser MCP servers (playwright-mcp)"
    }
    fn tools(&self) -> Vec<ToolDef> {
        vec![
            tools::mcp_client_connect(),
            tools::mcp_client_list(),
            tools::mcp_client_call(),
            tools::mcp_client_disconnect(),
        ]
    }
}
