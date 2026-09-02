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

use rmcp::service::ServiceExt;
use vale_agent_core::{DeviceError, ToolDef};

/// The local browser MCP server endpoint (playwright-mcp --port 9229).
/// round-118: 127.0.0.1, not "localhost" — localhost resolves to [::1] first
/// on Windows, so a client could latch onto a stale instance instead of the
/// one the task actually hosts.
const DEFAULT_URL: &str = "http://127.0.0.1:9229/mcp";

/// Shared session slot: set by `mcp_client_connect`, used by call/list.
/// Two transports: Streamable HTTP (legacy 9229) or stdio (no port — the
/// playwright-mcp child is spawned and driven over its stdin/stdout).
enum McpSession {
    /// Streamable HTTP transport (playwright-mcp --port 9229 / any URL).
    Http {
        url: String,
        /// Session identifier for Streamable HTTP — issued in the initialize
        /// response header, required on every subsequent request.
        /// round-137: the server reaps this session ~4s after each tools/call
        /// completes, so the cached value may be stale at any time; every
        /// request path must handle 404 self-healing.
        session_id: Option<String>,
        /// The most recently known page URL — after a self-heal re-handshake
        /// it is used to navigate the new session's current tab back
        /// (otherwise the new session lands on a fresh blank page and the
        /// browser session can never "see the picture").
        /// Sources: the browser_navigate url parameter + any "Page URL:" line
        /// in tool response text.
        last_url: Option<String>,
        next_id: AtomicU64,
        http: reqwest::Client,
    },
    /// stdio transport (no listening port): the child is spawned with piped
    /// stdin/stdout; rmcp drives the MCP framing. `client` is the connected
    /// rmcp client (RunningService), `last_url` mirrors the HTTP arm.
    Stdio {
        client: rmcp::service::RunningService<rmcp::RoleClient, ()>,
        last_url: Option<String>,
    },
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
    // plugin audit: same unbounded-append class as the deleted round-132
    // diag.log — cap generations at 1 MB.
    if let Ok(m) = std::fs::metadata(diag_path()) {
        if m.len() > 1_000_000 {
            let _ = std::fs::rename(diag_path(), diag_path().with_extension("log.old"));
        }
    }
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(diag_path())
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "[{ts}] {line}")
        });
}

/// Diagnostic log path — under the DATA dir (C1: registry DataDir, else exe
/// dir). Works on Windows AND in tests on other platforms.
fn diag_path() -> std::path::PathBuf {
    crate::paths::data_dir().join("mcp_diag.log")
}

/// Single entry point for a JSON-RPC call, dispatched by transport.
/// Http: POST to the MCP URL (session header + SSE/bare-JSON parsing).
/// Stdio: direct rmcp client call (initialize/list/call handled by rmcp).
/// id=None means a notification (no response body).
async fn rpc_ref(
    sess: &mut McpSession,
    id: Option<u64>,
    method: &str,
    params: Value,
    timeout_secs: u64,
) -> Result<Value, DeviceError> {
    match sess {
        McpSession::Http { .. } => rpc_ref_http(sess, id, method, params, timeout_secs).await,
        McpSession::Stdio { client, .. } => {
            // rmcp's RunningService handles initialize/notifications/… itself;
            // the only calls we issue on top are tools/list and tools/call.
            // Unify both result types into JSON (ListToolsResult vs
            // CallToolResult differ).
            let call: serde_json::Value = match method {
                "tools/list" => {
                    let r = client
                        .list_tools(Some(rmcp::model::PaginatedRequestParams::default()))
                        .await
                        .map_err(|e| DeviceError::Internal { message: format!("MCP list failed: {e}") })?;
                    serde_json::to_value(r).unwrap_or(Value::Null)
                }
                "tools/call" => {
                    let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                    let arguments: serde_json::Map<String, serde_json::Value> =
                        serde_json::from_value(args).unwrap_or_default();
                    let r = client
                        .call_tool(
                            rmcp::model::CallToolRequestParams::new(name).with_arguments(arguments),
                        )
                        .await
                        .map_err(|e| DeviceError::Internal { message: format!("MCP call failed: {e}") })?;
                    serde_json::to_value(r).unwrap_or(Value::Null)
                }
                _ => return Err(DeviceError::Internal { message: format!("stdio transport: unsupported method {method}") }),
            };
            Ok(call)
        }
    }
}

/// Http transport JSON-RPC POST (the pre-stdio implementation, kept for the
/// 9229 / any-URL path).
async fn rpc_ref_http(
    sess: &mut McpSession,
    id: Option<u64>,
    method: &str,
    params: Value,
    timeout_secs: u64,
) -> Result<Value, DeviceError> {
    let McpSession::Http { url, session_id, http, .. } = sess else {
        return Err(DeviceError::Internal { message: "not an http session".into() });
    };
    let mut envelope = json!({"jsonrpc": "2.0", "method": method});
    if let Some(i) = id {
        envelope["id"] = json!(i);
    }
    if !params.is_null() {
        envelope["params"] = params;
    }
    let mut req = http
        .post(&**url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .timeout(Duration::from_secs(timeout_secs))
        .json(&envelope);
    if let Some(sid) = session_id {
        req = req.header("mcp-session-id", sid.as_str());
    }
    let resp = req.send().await.map_err(|e| {
        DeviceError::Internal { message: format!("MCP request failed: {e}") }
    })?;
    if method == "initialize" {
        if let Some(sid) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *session_id = Some(sid.to_string());
        }
    }
    let status = resp.status();
    let text = resp.text().await.map_err(|e| {
        DeviceError::Internal { message: format!("MCP response read failed: {e}") }
    })?;
    // round-132 diagnostics: record the method/id/session used/status of every
    // Plugin audit: bound what a rogue server can pour into memory/echo.
    if text.len() > 16 * 1024 * 1024 {
        return Err(DeviceError::Internal { message: "MCP response exceeds 16 MiB cap".into() });
    }
    // MCP round trip (with millisecond timestamps since round-137).
    {
        let sid_used = session_id.clone().unwrap_or_default();
        diag_log(&format!(
            "[rpc] method={method} id={id:?} sid={sid_used} http={} body_head={:?}",
            status.as_u16(),
            // Plugin audit HIGH: remote-controlled bytes sliced at a raw index — a
            // non-200 body whose byte 80 split a char PANICKED the handler
            // mid-call. (SESSION is a TOKIO mutex — no poisoning; the guard
            // simply drops on unwind — but the panic still killed the tool
            // call.) Boundary-safe now.
            &text[..text.floor_char_boundary(text.len().min(80))]
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
    // char-boundary-safe (remote payloads slice here too — audit HIGH #1)
    if s.len() <= n { s.to_string() } else { format!("{}…", &s[..s.floor_char_boundary(n)]) }
}

/// `mcp_client_connect` — open a client session to a local browser MCP server.
///
/// transport:
///   * "stdio" (default): spawn the bundled playwright-mcp with NO listening
///     port — the MCP framing runs over the child's stdin/stdout (MCP stdio
///     protocol). Zero open ports on the device.
///   * "http": connect to an already-running server at `url` (default
///     http://localhost:9229/mcp) — legacy mode for external servers.
pub fn mcp_client_connect() -> ToolDef {
    ToolDef::new(
        "mcp_client_connect",
        "Connect this device to a local browser MCP server. transport='stdio' \
         (default) spawns the bundled playwright-mcp over stdin/stdout — no \
         listening port. transport='http' connects to an already-running \
         server at url (default http://localhost:9229/mcp). Returns the number \
         of tools exposed once connected.",
        json!({
            "type": "object",
            "properties": {
                "transport": {
                    "type": "string",
                    "enum": ["stdio", "http"],
                    "description": "stdio (default, spawns bundled playwright, no port) or http (existing server URL)"
                },
                "url": {
                    "type": "string",
                    "description": "MCP server URL for transport=http (default http://localhost:9229/mcp)"
                }
            }
        }),
        |params: Value| async move {
            let transport = params.get("transport").and_then(|v| v.as_str())
                .unwrap_or("stdio").to_string();
            let url = params.get("url").and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_URL)
                .to_string();

            if transport == "http" {
                return connect_http(url).await;
            }
            connect_stdio().await
        },
    )
}

/// Connect over Streamable HTTP (legacy 9229 / any URL).
async fn connect_http(url: String) -> Result<serde_json::Value, DeviceError> {
    // Plugin audit MED: connect took ANY caller URL — plain http to internal
    // hosts was an SSRF + sniffable. Policy: https anywhere; http ONLY for
    // the loopback bundled server (9229).
    let parsed = reqwest::Url::parse(&url)
        .map_err(|e| DeviceError::InvalidParams { message: format!("bad MCP url: {e}") })?;
    let loopback = matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost") | Some("::1"));
    if !(parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback)) {
        return Err(DeviceError::InvalidParams {
            message: "MCP url must be https, or http to a loopback host".into(),
        });
    }
    // Same URL reuses the existing session; a different URL drops the old
    // session and rebuilds (round-118).
    {
        let guard = SESSION.lock().await;
        if let Some(McpSession::Http { url: u, .. }) = guard.as_ref() {
            if *u == url {
                return Ok(json!({ "status": "already_connected", "url": url, "transport": "http" }));
            }
        }
    }

    let mut sess = McpSession::Http {
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
            Some(McpSession::Http { url: u, .. }) if *u == url => {
                return Ok(json!({ "status": "already_connected", "url": url, "transport": "http" }));
            }
            _ => {}
        }
        *guard = Some(sess);
    }

    Ok(json!({
        "status": "connected",
        "url": url,
        "transport": "http",
        "server": server,
        "tool_count": tools.len(),
        "tools": tools.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
    }))
}

/// Locate the playwright-mcp entry (`<install>/playwright/node_modules/
/// @playwright/mcp/cli.js`) + the node runtime (registry NodePath / system
/// node — the agent no longer bundles node.exe).
fn bundled_playwright() -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let dir = crate::paths::install_dir();
    let node = crate::paths::node_path().or_else(|| dir.join("playwright").join("node.exe").exists().then(|| dir.join("playwright").join("node.exe")))?;
    let entry = dir
        .join("playwright")
        .join("node_modules")
        .join("@playwright")
        .join("mcp")
        .join("cli.js");
    (node.exists() && entry.exists()).then_some((node, entry))
}

/// Spawn the bundled playwright-mcp over stdio (no port) and serve it as an
/// MCP client. Returns the connected session + tool list.
/// True when the bridge's chromium exposes its CDP endpoint (loopback 9223).
pub(crate) fn bridge_cdp_up() -> bool {
    std::net::TcpStream::connect_timeout(
        &"127.0.0.1:9223".parse().unwrap(),
        std::time::Duration::from_millis(300),
    )
    .is_ok()
}

/// Panel-visibility: record MCP-driven browser actions in the SAME
/// actions.jsonl browser_run_script writes, so the Evidence strip's
/// aiActive pulse and the action timeline light up for plain
/// mcp_client_call flows too (previously ONLY run_script wrote it — MCP
/// sessions looked DEAD to the panel by construction).
fn record_mcp_action(tool: &str, args: &serde_json::Value, dur_ms: u128, ok: bool) {
    if !tool.starts_with("browser_") {
        return;
    }
    let pwout = crate::paths::install_dir().join("pwout");
    let _ = std::fs::create_dir_all(&pwout);
    let summary: String = {
        let a = args
            .as_object()
            .map(|m| {
                m.iter()
                    .map(|(k, v)| {
                        format!("{}={}", k, v.as_str().unwrap_or(&v.to_string()))
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        let s = format!("{tool} {a}");
        if s.len() > 200 {
            // byte-slice at a CHAR BOUNDARY (CJK URLs would panic the naive [..200])
            let mut e = 200;
            while e > 0 && !s.is_char_boundary(e) {
                e -= 1;
            }
            format!("{}…", &s[..e])
        } else {
            s
        }
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let line = serde_json::json!({
        "ts": ts,
        "duration_ms": dur_ms,
        "exit_code": if ok { 0 } else { 1 },
        "timed_out": false,
        "script": format!("mcp: {summary}"),
        "screenshots": [],
        "stdout_tail": "",
        "stderr_tail": "",
    });
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(pwout.join("actions.jsonl"))
    {
        let _ = writeln!(f, "{line}");
    }
}

async fn spawn_stdio_server() -> Result<(McpSession, Vec<(String, String)>), DeviceError> {
    // Test override: the stdio integration test points at a minimal node MCP
    // server (no device bundle in CI). Production uses the bundled playwright.
    let (node, entry) = if let (Ok(n), Ok(e)) = (
        std::env::var("VALE_TEST_STDIO_NODE"),
        std::env::var("VALE_TEST_STDIO_ENTRY"),
    ) {
        (std::path::PathBuf::from(n), std::path::PathBuf::from(e))
    } else {
        bundled_playwright().ok_or_else(|| DeviceError::Internal {
            message: "bundled playwright not found (install_dir/playwright/) — run the installer".into(),
        })?
    };

    // stdio MCP: no --port, no --host, no --allowed-hosts — the child talks
    // over stdin/stdout only. Keep the browser/headless flags identical to
    // the HTTP mode (skipped for the test server, which is not playwright).
    let mut cmd = tokio::process::Command::new(&node);
    cmd.arg(&entry)
        .env("PLAYWRIGHT_MCP_PING_TIMEOUT_MS", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if std::env::var("VALE_TEST_STDIO_ENTRY").is_err() {
        // ONE-BROWSER FIX (user report: "AI 调用 MCP 后 browser 面板显示不
        // 正确"): the panel screencasts the BRIDGE's chromium while every
        // playwright-mcp spawn launched its OWN headless browser — AI
        // navigation could NEVER appear. The bridge now exposes CDP on
        // loopback 9223; attach there when it is up. Private-headless stays
        // as the fallback (bridge down ⇒ AI still works, panel just cannot
        // watch — strictly better than the always-split status quo).
        // Evidence land: playwright-mcp's DEFAULT output dir is relative to
        // ITS CWD (device proof: files landed in D:\Vale\playwright\TEMP,
        // while the agent's temp_dir() probe found only weeks-old files) —
        // pin it to install\pwout so screenshots appear in the Evidence
        // drawer with zero copying.
        let pwout = crate::paths::install_dir().join("pwout");
        let _ = std::fs::create_dir_all(&pwout);
        if bridge_cdp_up() {
            cmd.arg("--cdp-endpoint").arg("http://127.0.0.1:9223")
                .arg("--ignore-https-errors")
                .arg("--output-dir").arg(&pwout);
        } else {
            cmd.arg("--headless")
                .arg("--browser").arg("chromium")
                .arg("--ignore-https-errors")
                .arg("--output-dir").arg(&pwout);
        }
    }
    #[cfg(windows)]
    {
        // tokio::process::Command exposes creation_flags directly (it wraps
        // std's CommandExt) — no explicit import needed.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // rmcp stdio transport: TokioChildProcess drives the child's stdio.
    let transport = rmcp::transport::child_process::TokioChildProcess::new(
        process_wrap::tokio::CommandWrap::from(cmd),
    )
    .map_err(|e| DeviceError::Internal { message: format!("spawn playwright stdio: {e}") })?;

    let client = ()
        .serve(transport)
        .await
        .map_err(|e| DeviceError::Internal { message: format!("MCP stdio handshake failed: {e}") })?;

    let tools = client
        .list_all_tools()
        .await
        .map_err(|e| DeviceError::Internal { message: format!("MCP stdio list_tools failed: {e}") })?;
    let names: Vec<(String, String)> = tools
        .iter()
        .map(|t| (t.name.to_string(), t.description.clone().map(|c| c.to_string()).unwrap_or_default()))
        .collect();

    Ok((
        McpSession::Stdio {
            client,
            last_url: None,
        },
        names,
    ))
}

/// Connect over stdio (bundled playwright, no port).
async fn connect_stdio() -> Result<serde_json::Value, DeviceError> {
    {
        let guard = SESSION.lock().await;
        if let Some(McpSession::Stdio { .. }) = guard.as_ref() {
            return Ok(json!({ "status": "already_connected", "transport": "stdio" }));
        }
    }

    let (sess, tools) = spawn_stdio_server().await?;

    {
        let mut guard = SESSION.lock().await;
        if let Some(McpSession::Stdio { .. }) = guard.as_ref() {
            return Ok(json!({ "status": "already_connected", "transport": "stdio" }));
        }
        *guard = Some(sess);
    }

    Ok(json!({
        "status": "connected",
        "transport": "stdio",
        "tool_count": tools.len(),
        "tools": tools.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
    }))
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
    match sess {
        McpSession::Http { session_id, .. } => {
            // The stale session header must be cleared: initialize with a dead
            // mcp-session-id makes the server return 404 instead of issuing a
            // new session (measured in round-134).
            *session_id = None;
        }
        McpSession::Stdio { .. } => {
            // stdio transport has no session header; rmcp re-handshakes
            // internally on reconnect — nothing to clear.
        }
    }
    diag_log("[heal] re-handshaking after session recycle");
    handshake(sess).await?;
    let last_url = match sess {
        McpSession::Http { last_url, .. } => last_url.clone(),
        McpSession::Stdio { last_url, .. } => last_url.clone(),
    };
    if let Some(url) = last_url {
        let id = match sess {
            McpSession::Http { next_id, .. } => next_id.fetch_add(1, Ordering::Relaxed),
            McpSession::Stdio { .. } => 0,
        };
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
                match sess {
                    McpSession::Http { last_url, .. } => *last_url = Some(url.to_string()),
                    McpSession::Stdio { last_url, .. } => *last_url = Some(url.to_string()),
                }
                return;
            }
        }
    }
}

/// Handshake: initialize (obtain the session id) + initialized notification.
/// Returns the server info. (stdio: rmcp served the handshake already; this
/// is a no-op that reports the peer.)
async fn handshake(sess: &mut McpSession) -> Result<Value, DeviceError> {
    match sess {
        McpSession::Stdio { .. } => Ok(json!({"name": "playwright-mcp", "version": "stdio"})),
        McpSession::Http { next_id, .. } => {
            let init_id = next_id.fetch_add(1, Ordering::Relaxed);
            let resp = rpc_ref(sess, Some(init_id), "initialize", json!({
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "vale-agent", "version": "1"}
            }), 30).await?;
            rpc_ref(sess, None, "notifications/initialized", Value::Null, 10).await?;
            Ok(resp.get("serverInfo").cloned().unwrap_or(json!(null)))
        }
    }
}

async fn list_tools_ref(sess: &mut McpSession) -> Result<Vec<(String, String)>, DeviceError> {
    match sess {
        McpSession::Stdio { client, .. } => {
            let tools = client
                .list_tools(Default::default())
                .await
                .map_err(|e| DeviceError::Internal { message: format!("MCP stdio list failed: {e}") })?;
            Ok(tools
                .tools
                .iter()
                .map(|t| (t.name.to_string(), t.description.clone().map(|c| c.to_string()).unwrap_or_default()))
                .collect())
        }
        McpSession::Http { next_id, .. } => {
            let id = next_id.fetch_add(1, Ordering::Relaxed);
            let r = rpc_ref(sess, Some(id), "tools/list", json!({}), 30).await?;
            let arr = r.get("tools").and_then(|t| t.as_array()).cloned().unwrap_or_default();
            Ok(arr.into_iter().map(|t| {
                (
                    t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                    t.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string(),
                )
            }).collect())
        }
    }
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
            let t0 = std::time::Instant::now();
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
            let id = match sess {
                McpSession::Http { next_id, .. } => next_id.fetch_add(1, Ordering::Relaxed),
                McpSession::Stdio { .. } => 0, // rmcp manages ids internally
            };
            let call = rpc_ref(sess, Some(id), "tools/call", call_body(), 180).await;
            let mut result = match call {
                Err(DeviceError::Internal { message }) if is_session_gone(&message) => {
                    heal_and_restore(sess).await?;
                    // If this retry still 404s, report the error faithfully.
                    let retry_id = match sess {
                        McpSession::Http { next_id, .. } => next_id.fetch_add(1, Ordering::Relaxed),
                        McpSession::Stdio { .. } => 0,
                    };
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
                    match sess {
                        McpSession::Http { last_url, .. } => *last_url = Some(u.to_string()),
                        McpSession::Stdio { last_url, .. } => *last_url = Some(u.to_string()),
                    }
                }
            }
            track_page_url(sess, &result);
            // one-browser fix: the panel's action timeline now sees MCP work
            record_mcp_action(&tool, &args, t0.elapsed().as_millis(), true);

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
                    // PRE-EXISTING BUG (one-browser round): the old patterns
                    // required .png\" (quote IMMEDIATELY after the extension)
                    // and then checked the next byte == ')' — mutually
                    // exclusive, so the markdown-reference branch NEVER fired
                    // and MCP screenshots were silently unresolvable. Match
                    // the extension bare; the paren check below is the real
                    // terminator.
                    if let Some(dot) = text[marker..].find(".png")
                        .or_else(|| text[marker..].find(".jpg"))
                        .or_else(|| text[marker..].find(".jpeg")) {
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
                    // Plugin audit HIGH #2: candidate[0] was the SERVER-
                    // CONTROLLED path verbatim — a malicious/compromised MCP
                    // server answering "(C:\\secret.png") got ANY file on the
                    // SYSTEM box read + base64-exfiltrated. Containment:
                    // ONLY the basename joined under the playwright temp root
                    // (stale hardcoded Administrator profile path removed —
                    // the service's temp IS env::temp_dir()).
                    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
                    if !name.is_empty() {
                        // --output-dir pins shots under pwout; the temp path
                        // stays as the fallback for servers that ignore the
                        // flag (their CWD-relative default we cannot know).
                        candidates.push(crate::paths::install_dir().join("pwout").join(&name));
                        candidates.push(std::env::temp_dir().join(".playwright-mcp").join(&name));
                    }
                    let _ = &rel;
                    for cand in &candidates {
                        if let Ok(bytes) = std::fs::read(cand) {
                            // one-browser fix: ALSO park a copy under
                            // install\pwout so the Evidence drawer (which
                            // lists pwout/*.png) surfaces MCP screenshots —
                            // previously they lived only in %TEMP% forever.
                            if !name.is_empty() {
                                let pwout = crate::paths::install_dir().join("pwout");
                                if std::fs::create_dir_all(&pwout).is_ok() {
                                    let dst = pwout.join(format!("mcp-{name}"));
                                    if !dst.exists() {
                                        let _ = std::fs::write(&dst, &bytes);
                                    }
                                }
                            }
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
        "Close the browser MCP client session (frees the connection and the \
         spawned playwright process in stdio mode).",
        json!({ "type": "object" }),
        |_: Value| async move {
            let sess = SESSION.lock().await.take();
            if let Some(s) = sess {
                match s {
                    McpSession::Http { url, session_id, http, .. } => {
                        let mut req = http.delete(&url)
                            .header("content-type", "application/json")
                            .timeout(Duration::from_secs(5));
                        if let Some(sid) = &session_id {
                            req = req.header("mcp-session-id", sid);
                        }
                        let _ = req.send().await;
                    }
                    McpSession::Stdio { mut client, .. } => {
                        // Closing the client terminates the child (playwright)
                        // — Drop on TokioChildProcess kills the process.
                        let _ = client.close().await;
                    }
                }
            }
            Ok(json!({ "status": "disconnected" }))
        },
    )
}
