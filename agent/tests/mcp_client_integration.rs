//! mcp-client plugin integration: connect the plugin to a REAL MCP server
//! (the agent's own — a plain rmcp Streamable HTTP server, same protocol
//! shape as playwright-mcp), then list + call + disconnect through the
//! plugin's tool handlers. Exercises the whole bridge: HTTP → client session
//! → remote tools/list → tool call → result, with zero external processes.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use vale_agent::state::AppState;
use vale_agent_core::{Config, ToolDef};

/// Start a real MCP server on an ephemeral port; returns the MCP URL.
async fn start_server() -> String {
    let mut cfg = Config::default();
    cfg.server.host = "127.0.0.1".into();
    cfg.server.port = 0; // ephemeral — bind() reports the actual port
    let state = Arc::new(AppState::new(cfg.clone()));
    let (addr, _handle) = vale_agent::mcp::bind(cfg, state, CancellationToken::new())
        .await
        .expect("bind server");
    format!("http://{addr}/mcp")
}

fn plugin_tool(state: &AppState, name: &str) -> Arc<ToolDef> {
    state.plugin_registry.plugin_tools("mcp-client")
        .iter()
        .find(|t| t.name == name)
        .unwrap_or_else(|| panic!("plugin tool {name} missing"))
        .clone()
}

#[tokio::test]
async fn mcp_client_bridge_roundtrip() {
    let url = start_server().await;
    let state = AppState::new(Config::default());
    let connect = plugin_tool(&state, "mcp_client_connect");
    let list = plugin_tool(&state, "mcp_client_list");
    let call = plugin_tool(&state, "mcp_client_call");
    let disconnect = plugin_tool(&state, "mcp_client_disconnect");

    // Not connected yet: list and call must fail with a clear error.
    let err = list.handler.call(json!({})).await.unwrap_err().to_string();
    assert!(err.contains("not connected"), "list before connect: {err}");
    let err = call.handler.call(json!({ "tool": "terminal_list" })).await.unwrap_err().to_string();
    assert!(err.contains("not connected"), "call before connect: {err}");

    // Connect to the fake browser server and verify the tool list came back.
    let r: Value = connect.handler.call(json!({ "transport": "http", "url": url })).await.expect("connect");
    assert_eq!(r["status"], "connected");
    let count = r["tool_count"].as_u64().expect("tool_count");
    assert!(count >= 20, "expected the agent's full tool surface, got {count}");

    // list through the plugin mirrors the remote tools.
    let r: Value = list.handler.call(json!({})).await.expect("list");
    assert_eq!(r["tool_count"], count);
    let names = r["tools"].as_array().expect("tools");
    assert!(names.iter().any(|t| t["name"] == "terminal_list"));

    // Call a real remote tool and get its result back.
    let r: Value = call.handler
        .call(json!({ "tool": "terminal_list", "arguments": {} }))
        .await
        .expect("call terminal_list");
    assert_eq!(r["ok"], true);

    // Call with a missing tool name fails cleanly (server-side error).
    let r = call.handler.call(json!({ "tool": "no_such_tool" })).await;
    assert!(r.is_err(), "unknown tool must error, got {r:?}");

    // Reconnect while connected is a no-op (single session).
    let r: Value = connect.handler.call(json!({ "transport": "http", "url": url })).await.expect("reconnect");
    assert_eq!(r["status"], "already_connected");

    // Disconnect, then the bridge is dead again.
    let r: Value = disconnect.handler.call(json!({})).await.expect("disconnect");
    assert_eq!(r["status"], "disconnected");
    let err = call.handler.call(json!({ "tool": "terminal_list" })).await.unwrap_err().to_string();
    assert!(err.contains("not connected"), "call after disconnect: {err}");
}

#[tokio::test]
async fn connect_to_dead_server_fails_fast() {
    // round-93: connecting to a server that is NOT running used to hang
    // forever — rmcp's SSE retry defaults to FixedInterval { max_times: None }
    // (infinite 1s reconnect), so serve() never returned and the MCP worker
    // that awaited this handler wedged (every subsequent tool call queued
    // behind it → API errors). The connect must fail within the 5s budget.
    // Grab an ephemeral port that nothing listens on.
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = l.local_addr().expect("addr");
        drop(l); // closed now — nothing listens there
        format!("http://{addr}/mcp")
    };
    let state = AppState::new(Config::default());
    let connect = plugin_tool(&state, "mcp_client_connect");
    let started = std::time::Instant::now();
    let r = connect.handler.call(json!({ "transport": "http", "url": dead })).await;
    let elapsed = started.elapsed();
    assert!(r.is_err(), "connect to a dead server must error, got {r:?}");
    let msg = r.unwrap_err().to_string();
    assert!(
        msg.contains("timed out") || msg.contains("failed") || msg.contains("not running"),
        "unexpected error: {msg}"
    );
    assert!(
        elapsed.as_secs() < 30,
        "connect must fail fast (bounded), took {elapsed:?}"
    );
}
