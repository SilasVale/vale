//! round-137 measured theorem (d1 real-device probe, 2026-08-25):
//! playwright-mcp 0.0.79's Streamable HTTP session is unconditionally reaped
//! ~4 s after each tools/call response completes ("Session not found"). Every
//! client-side keepalive trick was disproven:
//!
//! - tools/list heartbeat: the probe itself doesn't extend life (+3s probe
//!   succeeds, +5s still dead), and the window is only ~4s, so no poll
//!   interval can win;
//! - a single silent long-lived connection: unrelated to the session, dies on
//!   the keep-alive socket anyway;
//! - standard GET /mcp SSE event stream: the server actively closes the
//!   stream (status 200) and kills the session.
//!
//! So the only correct client shape: give up keepalive, accept that "every
//! call may hit a dead session", and self-heal when it does — re-handshake +
//! navigate the page back to last_url (restore context), then retry the
//! original call. last_url is tracked bidirectionally from the
//! browser_navigate parameter and any "Page URL:" line in response text,
//! keeping the browser picture continuous across sessions.
//!
//! Session state is just base_url + mcp-session-id + incrementing id +
//! last_url; no background tasks.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;

use vale_agent_core::{DeviceError, ToolDef};

/// The local browser MCP server endpoint (playwright-mcp --port 9229).
/// round-118: 127.0.0.1, not "localhost" — localhost resolves to [::1] first
/// on Windows, so a client could latch onto a stale instance instead of the
/// one the task actually hosts.
const DEFAULT_URL: &str = "http://127.0.0.1:9229/mcp";

/// Shared session slot: set by `mcp_client_connect`, used by call/list.
struct McpSession {
    url: String,
    /// Session identifier for Streamable HTTP — issued in the initialize
    /// response header, required on every subsequent request.
    /// round-137: the server reaps this session ~4s after each tools/call
    /// completes, so the cached value may be stale at any time; every request
    /// path must handle 404 self-healing.
    session_id: Option<String>,
    /// The most recently known page URL — after a self-heal re-handshake it
    /// is used to navigate the new session's current tab back (otherwise the
    /// new session lands on a fresh blank page and the browser session can
    /// never "see the picture").
    /// Sources: the browser_navigate url parameter + any "Page URL:" line in
    /// tool response text (clicks/form navigations that don't go through
    /// navigate are tracked too).
    last_url: Option<String>,
    next_id: AtomicU64,
    http: reqwest::Client,
}
static SESSION: Mutex<Option<McpSession>> = Mutex::const_new(None);

/// Timestamped diagnostic log (the mcp_diag.log introduced in round-132;
/// round-137 added timestamps and [heal]/[restore] markers — before that
/// there were no timestamps to align with real-device probes).
fn diag_log(line: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("D:\\vale-agent\\mcp_diag.log")
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "[{ts}] {line}")
        });
}

/// Single entry point for a JSON-RPC POST: handles the session header,
/// incrementing id, and dual-format (SSE / bare JSON) response parsing.
/// id=None means a notification (no response body).
async fn rpc_ref(
    sess: &mut McpSession,
    id: Option<u64>,
    method: &str,
    params: Value,
    timeout_secs: u64,
) -> Result<Value, DeviceError> {
    let mut envelope = json!({"jsonrpc": "2.0", "method": method});
    if let Some(i) = id {
        envelope["id"] = json!(i);
    }
    if !params.is_null() {
        envelope["params"] = params;
    }
    let mut req = sess
        .http
        .post(&sess.url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .timeout(Duration::from_secs(timeout_secs))
        .json(&envelope);
    if let Some(sid) = &sess.session_id {
        req = req.header("mcp-session-id", sid);
    }
    let resp = req.send().await.map_err(|e| {
        DeviceError::Internal { message: format!("MCP request failed: {e}") }
    })?;
    if method == "initialize" {
        if let Some(sid) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            sess.session_id = Some(sid.to_string());
        }
    }
    let status = resp.status();
    let text = resp.text().await.map_err(|e| {
        DeviceError::Internal { message: format!("MCP response read failed: {e}") }
    })?;
    // round-132 diagnostics: record the method/id/session used/status of every
    // MCP round trip (with millisecond timestamps since round-137).
    {
        let sid_used = sess.session_id.clone().unwrap_or_default();
        diag_log(&format!(
            "[rpc] method={method} id={id:?} sid={sid_used} http={} body_head={:?}",
            status.as_u16(),
            &text[..text.len().min(80)]
        ));
    }
    if !status.is_success() {
        return Err(DeviceError::Internal {
            message: format!("MCP server returned HTTP {}: {}", status.as_u16(), truncate(&text, 200)),
        });
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    parse_envelope(&text, id)
}

/// Extract the JSON-RPC envelope from the response body. The server may return:
///   * bare JSON (application/json)
///   * SSE text ("event: message\ndata: {...}\n\n", possibly multiple frames)
///
/// Take the last envelope that parses and (when an id is present) matches it.
fn parse_envelope(body: &str, id: Option<u64>) -> Result<Value, DeviceError> {
    let trimmed = body.trim();
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return check_envelope(v, id);
    }
    // SSE frames: concatenate consecutive "data:" lines into candidate
    // payloads and try each in turn.
    let mut candidates: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            cur.push_str(rest.trim());
        } else if !cur.is_empty() {
            candidates.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        candidates.push(cur);
    }
    for cand in candidates.iter().rev() {
        if let Ok(v) = serde_json::from_str::<Value>(cand) {
            if id.map(|i| v.get("id").and_then(|x| x.as_u64()) == Some(i)).unwrap_or(true) {
                return check_envelope(v, id);
            }
        }
    }
    Err(DeviceError::Internal {
        message: format!("MCP response did not contain a usable JSON-RPC message: {}", truncate(body, 200)),
    })
}

fn check_envelope(v: Value, id: Option<u64>) -> Result<Value, DeviceError> {
    if let Some(err) = v.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown MCP error");
        return Err(DeviceError::Internal { message: format!("MCP error: {msg}") });
    }
    match v.get("result") {
        Some(r) => Ok(r.clone()),
        None if id.is_none() => Ok(Value::Null), // notification: no response body
        None => Err(DeviceError::Internal { message: "MCP response missing result".into() }),
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n { s.to_string() } else { format!("{}…", &s[..n]) }
}

/// `mcp_client_connect` — open a client session to a local browser MCP server.
pub fn mcp_client_connect() -> ToolDef {
    ToolDef::new(
        "mcp_client_connect",
        "Connect this device to a local browser MCP server (playwright-mcp / \
         chrome-devtools-mcp). The server must already be running on this device \
         (default http://localhost:9229/mcp). Returns the number of tools exposed \
         by the server once connected.",
        json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "MCP server URL (default http://localhost:9229/mcp)"
                }
            }
        }),
        |params: Value| async move {
            let url = params.get("url").and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_URL)
                .to_string();

            // Same URL reuses the existing session; a different URL drops the old
            // session and rebuilds (round-118).
            {
                let guard = SESSION.lock().await;
                if let Some(s) = guard.as_ref() {
                    if s.url == url {
                        return Ok(json!({ "status": "already_connected", "url": url }));
                    }
                }
            }

            let mut sess = McpSession {
                url: url.clone(),
                session_id: None,
                last_url: None,
                next_id: AtomicU64::new(1),
                http: reqwest::Client::new(),
            };

            // initialize: the response header delivers mcp-session-id; the
            // initialized notification: no id.
            let server = handshake(&mut sess).await?;

            let tools = list_tools_ref(&mut sess).await?;

            {
                let mut guard = SESSION.lock().await;
                match guard.as_ref() {
                    // A concurrent connect for the same URL won the race — reuse its session,
                    // drop this copy and return.
                    Some(s) if s.url == url => {
                        return Ok(json!({ "status": "already_connected", "url": url }));
                    }
                    _ => {}
                }
                *guard = Some(sess);
            }

            Ok(json!({
                "status": "connected",
                "url": url,
                "server": server,
                "tool_count": tools.len(),
                "tools": tools.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
            }))
        },
    )
}

/// Judge whether a failure is "the session was reaped by the server"
/// (round-137: happens ~4s after every tools/call completes; normal, not
/// exceptional).
fn is_session_gone(msg: &str) -> bool {
    msg.contains("Session not found") || msg.contains("HTTP 404")
}

/// Self-heal: drop the stale mcp-session-id → re-handshake → use last_url to
/// navigate the new session's current tab back to the known page. Without
/// last_url (never navigated successfully) just re-handshake — the new
/// session lands on a fresh blank page, which matches the browser's initial
/// state right after launch; that is honest.
async fn heal_and_restore(sess: &mut McpSession) -> Result<(), DeviceError> {
    // The stale session header must be cleared: initialize with a dead
    // mcp-session-id makes the server return 404 instead of issuing a new
    // session (measured in round-134).
    sess.session_id = None;
    diag_log("[heal] re-handshaking after session recycle");
    handshake(sess).await?;
    if let Some(url) = sess.last_url.clone() {
        let id = sess.next_id.fetch_add(1, Ordering::Relaxed);
        diag_log(&format!("[restore] navigating back to {url}"));
        // A failed restore-navigation is not fatal: the original call retries
        // anyway (worst case it lands on a blank page, better than erroring
        // out). Generous timeout — cold pages can be slow.
        let _ = rpc_ref(sess, Some(id), "tools/call", json!({
            "name": "browser_navigate",
            "arguments": { "url": url },
        }), 60).await;
    }
    Ok(())
}

/// Extract the "- Page URL: <url>" line from tool response text and update
/// last_url — clicks, form submissions, and front-end route jumps don't go
/// through browser_navigate; only tracking it from responses keeps the
/// restore point close to the page the user is actually on.
fn track_page_url(sess: &mut McpSession, result: &Value) {
    let Ok(text) = serde_json::to_string(result) else { return };
    for marker in ["- Page URL: ", "\\n- Page URL: ", "### Page\\n- Page URL: "] {
        if let Some(pos) = text.find(marker) {
            let rest = &text[pos + marker.len()..];
            let end = rest.find(['"', '\\', '\n']).unwrap_or(rest.len());
            let url = rest[..end].trim_end_matches('\\').trim();
            if url.starts_with("http") || url.starts_with("about:") || url.starts_with("data:") {
                sess.last_url = Some(url.to_string());
                return;
            }
        }
    }
}

/// Handshake: initialize (obtain the session id) + initialized notification.
/// Returns the server info.
async fn handshake(sess: &mut McpSession) -> Result<Value, DeviceError> {
    let init_id = sess.next_id.fetch_add(1, Ordering::Relaxed);
    let resp = rpc_ref(sess, Some(init_id), "initialize", json!({
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "vale-agent", "version": "1"}
    }), 30).await?;
    rpc_ref(sess, None, "notifications/initialized", Value::Null, 10).await?;
    Ok(resp.get("serverInfo").cloned().unwrap_or(json!(null)))
}

async fn list_tools_ref(sess: &mut McpSession) -> Result<Vec<(String, String)>, DeviceError> {
    let id = sess.next_id.fetch_add(1, Ordering::Relaxed);
    let r = rpc_ref(sess, Some(id), "tools/list", json!({}), 30).await?;
    let arr = r.get("tools").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    Ok(arr.into_iter().map(|t| {
        (
            t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
            t.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string(),
        )
    }).collect())
}

/// `mcp_client_list` — list tools exposed by the connected browser server.
pub fn mcp_client_list() -> ToolDef {
    ToolDef::new(
        "mcp_client_list",
        "List the tools exposed by the connected browser MCP server (playwright-mcp: \
         browser_navigate, browser_snapshot, browser_click, ...).",
        json!({ "type": "object" }),
        |_: Value| async move {
            let mut guard = SESSION.lock().await;
            let sess = guard.as_mut().ok_or_else(|| DeviceError::InvalidParams {
                message: "not connected — call mcp_client_connect first".into(),
            })?;
            // round-137: the session may have been reaped at any time (~4s TTL);
            // list must self-heal too.
            match list_tools_ref(sess).await {
                Ok(tools) => Ok(json!({
                    "tool_count": tools.len(),
                    "tools": tools.iter().map(|(n, d)| {
                        json!({"name": n, "description": d})
                    }).collect::<Vec<_>>(),
                })),
                Err(DeviceError::Internal { message }) if is_session_gone(&message) => {
                    heal_and_restore(sess).await?;
                    let tools = list_tools_ref(sess).await?;
                    Ok(json!({
                        "tool_count": tools.len(),
                        "tools": tools.iter().map(|(n, d)| {
                            json!({"name": n, "description": d})
                        }).collect::<Vec<_>>(),
                    }))
                }
                Err(e) => Err(e),
            }
        },
    )
}

/// `mcp_client_call` — invoke a tool on the connected browser MCP server.
pub fn mcp_client_call() -> ToolDef {
    ToolDef::new(
        "mcp_client_call",
        "Call a tool on the connected browser MCP server (playwright-mcp: \
         browser_navigate with {url}, browser_click with {selector}, ...). \
         Call mcp_client_list first to see available tools.",
        json!({
            "type": "object",
            "properties": {
                "tool": {
                    "type": "string",
                    "description": "Tool name on the remote server (e.g. browser_navigate)"
                },
                "arguments": {
                    "type": "object",
                    "description": "Tool arguments (e.g. {\"url\": \"https://example.com\"})"
                }
            },
            "required": ["tool"]
        }),
        |params: Value| async move {
            let tool = params.get("tool").and_then(|v| v.as_str())
                .ok_or_else(|| DeviceError::InvalidParams { message: "missing required field: tool".into() })?
                .to_string();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

            let mut guard = SESSION.lock().await;
            let sess = guard.as_mut().ok_or_else(|| DeviceError::InvalidParams {
                message: "not connected — call mcp_client_connect first".into(),
            })?;

            // round-137 root-cause adaptation: playwright-mcp 0.0.79's session is
            // unconditionally reaped ~4s after each tools/call completes
            // (confirmed by real-device probes: heartbeat, long-lived
            // connection, and GET event stream can't save it). So 404 is the
            // norm, not an exception: when hit, self-heal — re-handshake +
            // navigate back to last_url to restore page context, then retry
            // the original call. The restore navigation runs before the
            // original call, so this call's response is still the original
            // tool's own result (round-134's "navigation result pollutes the
            // response" problem is fixed by this ordering, not by skipping
            // the restore).
            //
            // round-131: 180s — the first navigation includes a cold browser
            // start; 60s would spuriously time out.
            let call_body = || json!({
                "name": tool,
                "arguments": args,
            });
            let id = sess.next_id.fetch_add(1, Ordering::Relaxed);
            let call = rpc_ref(sess, Some(id), "tools/call", call_body(), 180).await;
            let mut result = match call {
                Err(DeviceError::Internal { message }) if is_session_gone(&message) => {
                    heal_and_restore(sess).await?;
                    // If this retry still 404s, report the error faithfully.
                    let retry_id = sess.next_id.fetch_add(1, Ordering::Relaxed);
                    rpc_ref(sess, Some(retry_id), "tools/call", call_body(), 180).await?
                }
                r => r?,
            };

            // round-137: page tracking — the browser_navigate parameter is the
            // authoritative source; other tools (click/form/route jumps) are
            // tracked from the "Page URL:" line in response text. last_url is
            // the restore point for the next self-heal.
            if tool == "browser_navigate" {
                if let Some(u) = args.get("url").and_then(|v| v.as_str()) {
                    sess.last_url = Some(u.to_string());
                }
            }
            track_page_url(sess, &result);

            // playwright-mcp 1.6x saves screenshots to %TEMP%\.playwright-mcp
            // and returns a text REFERENCE instead of inline image content.
            // The panel needs real bytes: resolve the referenced file and
            // append an image content item (base64) so BrowserPane can render
            // the live page.
            {
                let text = serde_json::to_string(&result).unwrap_or_default();
                // Locate "(<path>\.playwright-mcp\<name>.png)" without regex:
                // find the marker dir, walk back to '(' and forward to the
                // closing extension + ')'.
                let mut resolved: Option<String> = None;
                if let Some(marker) = text.find(".playwright-mcp") {
                    let bytes = text.as_bytes();
                    // back to the '(' that opens this reference
                    let open = text[..marker].rfind('(').unwrap_or(marker);
                    if let Some(dot) = text[marker..].find(".png\"")
                        .or_else(|| text[marker..].find(".jpg\""))
                        .or_else(|| text[marker..].find(".jpeg\"")) {
                        let end_rel = marker + dot + 4; // include extension
                        if end_rel < text.len() && bytes.get(end_rel) == Some(&b')') {
                            let rel = &text[open + 1..end_rel];
                            resolved = Some(rel.to_string());
                        }
                    }
                }
                if let Some(rel) = resolved {
                    let rel = rel.replace("\\\\", "\\");
                    let name = std::path::Path::new(&rel)
                        .file_name().map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
                    candidates.push(std::path::PathBuf::from(&rel));
                    if let Ok(cwd) = std::env::current_dir() { candidates.push(cwd.join(&rel)); }
                    for base in [
                        std::env::temp_dir(),
                        std::path::PathBuf::from("C:\\Users\\Administrator\\AppData\\Local\\Temp"),
                    ] {
                        candidates.push(base.join(".playwright-mcp").join(&name));
                    }
                    for cand in &candidates {
                        if let Ok(bytes) = std::fs::read(cand) {
                            use base64::Engine as _;
                            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                            // Early-return the structured shape BrowserPane
                            // parses (content[].type=image) — falling through
                            // would flatten everything into a text string.
                            if let Some(arr) = result.get_mut("content").and_then(|c| c.as_array_mut()) {
                                arr.push(json!({"type": "image", "data": b64, "mimeType": "image/png"}));
                                return Ok(json!({ "ok": true, "result": result }));
                            }
                            break;
                        }
                    }
                }
            }

            // Same as the original implementation: prefer structuredContent, otherwise
            // concatenate text content (screenshots are image content blocks;
            // converted to data URIs and passed through verbatim for the
            // caller to decode).
            if let Some(sc) = result.get("structuredContent") {
                if !sc.is_null() {
                    return Ok(json!({ "ok": true, "result": sc }));
                }
            }
            let empty = Vec::new();
            let content = result.get("content").and_then(|c| c.as_array()).unwrap_or(&empty);
            let mut texts: Vec<String> = Vec::new();
            for c in content {
                let ctype = c.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match ctype {
                    "text" => {
                        if let Some(t) = c.get("text").and_then(|t| t.as_str()) {
                            texts.push(t.to_string());
                        }
                    }
                    "image" => {
                        let mime = c.get("mimeType").and_then(|m| m.as_str()).unwrap_or("image/png");
                        if let Some(d) = c.get("data").and_then(|d| d.as_str()) {
                            texts.push(format!("data:{mime};base64,{d}"));
                        }
                    }
                    _ => {}
                }
            }
            Ok(json!({ "ok": true, "result": texts.join("\n") }))
        },
    )
}

/// `mcp_client_disconnect` — close the browser MCP session.
pub fn mcp_client_disconnect() -> ToolDef {
    ToolDef::new(
        "mcp_client_disconnect",
        "Close the browser MCP client session (frees the connection).",
        json!({ "type": "object" }),
        |_: Value| async move {
            let sess = SESSION.lock().await.take();
            if let Some(s) = sess {
                let mut req = s.http.delete(&s.url)
                    .header("content-type", "application/json")
                    .timeout(Duration::from_secs(5));
                if let Some(sid) = &s.session_id {
                    req = req.header("mcp-session-id", sid);
                }
                let _ = req.send().await;
            }
            Ok(json!({ "status": "disconnected" }))
        },
    )
}
