//! Auto-select regression: connect-time embedded-view tab selection must send
//! a REAL JSON-RPC id on its tools/call requests.
//!
//! Device-caught: a strict Streamable-HTTP server (playwright-mcp 1.63)
//! treats an id-less tools/call as a notification and answers 202 + empty
//! body. The select path sent id=None, so every list came back "empty", the
//! heal loop chased a ghost session, and selection stayed on the SPA tab —
//! AI drove the wrong tab while the user watched the embedded view.
//!
//! The fake here mimics strictness exactly (202-empty for id-less calls) and
//! records the selected tab index; the test fails if select is never issued.
//! Runs in its own file (= own test binary = own SESSION static) so it can
//! never interleave with the bridge tests in mcp_client_integration.rs.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

use vale_agent::state::AppState;
use vale_agent_core::{Config, ToolDef};

/// Minimal strict MCP server over blocking std sockets (no extra deps).
/// Strictness: a tools/call WITHOUT an "id" gets 202 + empty body.
struct StrictFake {
    url: String,
    /// Tab index received by browser_tabs select (None = never called).
    selected: Arc<Mutex<Option<u64>>>,
}

fn read_request(stream: &mut std::net::TcpStream) -> Option<Value> {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .ok()?;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    // Headers first.
    loop {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 64 * 1024 {
            return None;
        }
    }
    let head_end = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let len = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            (k.trim().eq_ignore_ascii_case("content-length"))
                .then(|| v.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    while buf.len() < head_end + len {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    serde_json::from_slice::<Value>(&buf[head_end..]).ok()
}

fn respond(stream: &mut std::net::TcpStream, status: &str, extra: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn start_strict_server() -> StrictFake {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake mcp");
    let url = format!("http://{}/mcp", listener.local_addr().expect("addr"));
    let selected: Arc<Mutex<Option<u64>>> = Arc::new(Mutex::new(None));
    let sel = selected.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { break };
            let sel = sel.clone();
            thread::spawn(move || {
                let Some(req) = read_request(&mut s) else {
                    return;
                };
                let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
                let id = req.get("id").cloned();
                match method {
                    "initialize" => {
                        let body = json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "protocolVersion": "2025-03-26",
                                "capabilities": {},
                                "serverInfo": {"name": "strict-fake", "version": "1"},
                            },
                        })
                        .to_string();
                        respond(&mut s, "200 OK", "mcp-session-id: stub-sid\r\n", &body);
                    }
                    "tools/list" => {
                        let body = json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {"tools": [{"name": "browser_tabs", "description": "tabs"}]},
                        })
                        .to_string();
                        respond(&mut s, "200 OK", "", &body);
                    }
                    "tools/call" => {
                        // STRICT: no id = notification = 202 + empty body.
                        if id.is_none() || id == Some(Value::Null) {
                            respond(&mut s, "202 Accepted", "", "");
                            return;
                        }
                        let name = req
                            .pointer("/params/name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("");
                        let text = match name {
                            "browser_tabs" => {
                                let action = req
                                    .pointer("/params/arguments/action")
                                    .and_then(|a| a.as_str())
                                    .unwrap_or("");
                                if action == "select" {
                                    let idx = req
                                        .pointer("/params/arguments/index")
                                        .and_then(|i| i.as_u64())
                                        .unwrap_or(999);
                                    *sel.lock().unwrap() = Some(idx);
                                    "selected".to_string()
                                } else {
                                    "- 0: (current) [Vale Agent](http://127.0.0.1:18080/desktop/)\n- 1: [Example Domains](https://example.com/)".to_string()
                                }
                            }
                            _ => "ok".to_string(),
                        };
                        let body = json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {"content": [{"type": "text", "text": text}]},
                        })
                        .to_string();
                        respond(&mut s, "200 OK", "", &body);
                    }
                    _ => {
                        // notifications/initialized and anything else: 202 empty.
                        respond(&mut s, "202 Accepted", "", "");
                    }
                }
            });
        }
    });
    StrictFake { url, selected }
}

fn plugin_tool(state: &AppState, name: &str) -> Arc<ToolDef> {
    state
        .plugin_registry
        .plugin_tools("mcp-client")
        .iter()
        .find(|t| t.name == name)
        .unwrap_or_else(|| panic!("plugin tool {name} missing"))
        .clone()
}

#[tokio::test]
async fn autoselect_sends_real_ids_to_strict_server() {
    // desktop_cdp_up() gates auto-select on TCP 9333 — hold a dummy
    // listener so the gate opens (it only connects, never speaks).
    let _cdp = TcpListener::bind("127.0.0.1:9333").expect("9333 must be free in the test env");
    let fake = start_strict_server();

    let state = AppState::new(Config::default());
    let connect = plugin_tool(&state, "mcp_client_connect");
    let disconnect = plugin_tool(&state, "mcp_client_disconnect");

    let r: Value = connect
        .handler
        .call(json!({ "transport": "http", "url": fake.url }))
        .await
        .expect("connect to strict fake");
    assert_eq!(r["status"], "connected");

    // The strict server 202-empties every id-less tools/call: with the bug,
    // select never issues list/select and records nothing.
    let got = *fake.selected.lock().unwrap();
    assert_eq!(
        got,
        Some(1),
        "auto-select must select the embedded-view tab 1, got {got:?}"
    );

    let r: Value = disconnect
        .handler
        .call(json!({}))
        .await
        .expect("disconnect");
    assert_eq!(r["status"], "disconnected");
}
