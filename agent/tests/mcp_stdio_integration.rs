//! mcp-client plugin stdio transport integration: spawn a minimal MCP stdio
//! server (node one-liner), connect via mcp_client_connect transport=stdio,
//! list + call a tool, disconnect. Verifies the NO-PORT path end to end —
//! the whole bridge runs over the child's stdin/stdout (no listening port).

use serde_json::{json, Value};

use vale_agent::state::AppState;
use vale_agent_core::Config;

/// Minimal MCP stdio server source: newline-delimited JSON-RPC over stdin/
/// stdout (the framing rmcp's JsonRpcMessageCodec uses — NOT
/// Content-Length). Answers initialize / notifications/initialized /
/// tools/list / tools/call with a single `echo` tool.
const STDIO_SERVER: &str = r#"
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
function frame(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req; try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    frame({ jsonrpc: '2.0', id: req.id, result: {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'test-stdio', version: '1' }
    }});
  } else if (req.method === 'notifications/initialized') {
    // no response
  } else if (req.method === 'tools/list') {
    frame({ jsonrpc: '2.0', id: req.id, result: { tools: [
      { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }
    ]}});
  } else if (req.method === 'tools/call') {
    const text = req.params.arguments?.text ?? '';
    frame({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: `echo:${text}` }] } });
  } else {
    frame({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'unknown ' + req.method } });
  }
});
"#;

/// Locate the node binary (test environment).
fn node_bin() -> String {
    std::env::var("NODE").unwrap_or_else(|_| {
        // fall back to the same bundled-node heuristic, then PATH
        let dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_default();
        let bundled = dir.join("playwright").join("node.exe");
        if bundled.exists() {
            bundled.to_string_lossy().to_string()
        } else {
            "node".to_string()
        }
    })
}

/// Write the stdio server source to a temp file and return its path.
fn server_script() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("vale-mcp-stdio-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let p = dir.join("stdio_server.js");
    std::fs::write(&p, STDIO_SERVER).expect("write stdio server");
    p
}

#[tokio::test]
async fn stdio_bridge_roundtrip() {
    let script = server_script();
    let state = AppState::new(Config::default());
    let connect = state
        .plugin_registry
        .plugin_tools("mcp-client")
        .iter()
        .find(|t| t.name == "mcp_client_connect")
        .expect("connect tool")
        .clone();
    let list = state
        .plugin_registry
        .plugin_tools("mcp-client")
        .iter()
        .find(|t| t.name == "mcp_client_list")
        .expect("list tool")
        .clone();
    let call = state
        .plugin_registry
        .plugin_tools("mcp-client")
        .iter()
        .find(|t| t.name == "mcp_client_call")
        .expect("call tool")
        .clone();
    let disconnect = state
        .plugin_registry
        .plugin_tools("mcp-client")
        .iter()
        .find(|t| t.name == "mcp_client_disconnect")
        .expect("disconnect tool")
        .clone();

    // Point the stdio spawn at our test server: the plugin spawns
    // bundled playwright by default, which does not exist in the test env —
    // override via env so the test exercises the REAL stdio bridge without
    // the device bundle.
    std::env::set_var("VALE_TEST_STDIO_NODE", node_bin());
    std::env::set_var("VALE_TEST_STDIO_ENTRY", script.to_string_lossy().to_string());

    let r: Value = connect
        .handler
        .call(json!({ "transport": "stdio" }))
        .await
        .expect("stdio connect");
    assert_eq!(r["status"], "connected", "stdio connect: {r}");
    assert_eq!(r["transport"], "stdio");
    let count = r["tool_count"].as_u64().expect("tool_count");
    assert_eq!(count, 1, "test server exposes one tool");

    // List mirrors the remote tool.
    let r: Value = list.handler.call(json!({})).await.expect("list");
    assert_eq!(r["tool_count"], 1);
    assert!(r["tools"].as_array().unwrap().iter().any(|t| t["name"] == "echo"));

    // Call the echo tool end-to-end over stdio.
    let r: Value = call.handler
        .call(json!({ "tool": "echo", "arguments": { "text": "hello" } }))
        .await
        .expect("call echo");
    assert!(r["ok"] == true, "echo call: {r}");
    let text = r["result"].as_str().unwrap_or("");
    assert!(text.contains("hello"), "echo result: {text}");

    // Disconnect tears down the child.
    let r: Value = disconnect.handler.call(json!({})).await.expect("disconnect");
    assert_eq!(r["status"], "disconnected");
    let err = call.handler.call(json!({ "tool": "echo" })).await.unwrap_err().to_string();
    assert!(err.contains("not connected"), "call after disconnect: {err}");

    let _ = std::fs::remove_dir_all(script.parent().unwrap());
}
