//! Tool builders for the MCP client plugin — connect/list/call/disconnect a
//! local browser MCP server over Streamable HTTP.
//!
//! Connection lifecycle is RUNTIME-driven (not register-time): the plugin is
//! stateless; `mcp_client_connect` opens a client session and caches it in a
//! process-global slot, `mcp_client_call` dispatches through it. This mirrors
//! DSH's mcp-client plugin (connect on demand, tools under a qualified
//! namespace) while keeping Vale's "tools built once at register" invariant —
//! the remote tool LIST is discovered at connect time and exposed through
//! `mcp_client_list` instead of being statically registered.
//!
//! round-132: 直接手写 Streamable HTTP 的 JSON-RPC 会话，替换 rmcp 客户端。
//! 根因：rmcp 客户端与本设备捆绑的 playwright-mcp 在 tools/call 的响应通路
//! 上失配——initialize/tools/list 往返正常（秒回），唯独 call 的响应永远等
//! 不到（连 about:blank 都 180s 超时），而同一服务器的原始 HTTP 调用实测
//! 1 秒返回。与其继续依赖黑盒库的会话行为，不如按协议规范自己驱动：
//!   POST initialize        → 200, 响应头带 mcp-session-id
//!   POST initialized 通知   → 202/200 空体
//!   POST tools/call ...    → 200, 体为 SSE("data: {...}") 或裸 JSON
//! 会话状态就是 base_url + mcp-session-id + 自增 id，无后台任务、无取消
//! 令牌、无重连循环——断开即丢弃状态。

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
    /// Streamable HTTP 的会话标识 —— initialize 响应头下发，后续请求必带。
    session_id: Option<String>,
    next_id: AtomicU64,
    http: reqwest::Client,
}
static SESSION: Mutex<Option<McpSession>> = Mutex::const_new(None);

/// 单次 JSON-RPC POST 的统一入口：处理会话头、自增 id、SSE/裸 JSON 双格式
/// 响应解析。id=None 表示通知（无响应体）。
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

/// 从响应体提取 JSON-RPC 信封。服务器可能返回：
///   * 裸 JSON（application/json）
///   * SSE 文本（"event: message\ndata: {...}\n\n"，可能多帧）
///
/// 取最后一个能解析且（带 id 时）id 匹配的信封。
fn parse_envelope(body: &str, id: Option<u64>) -> Result<Value, DeviceError> {
    let trimmed = body.trim();
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return check_envelope(v, id);
    }
    // SSE 帧：把连续的 "data:" 行拼成候选载荷逐个尝试。
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
        None if id.is_none() => Ok(Value::Null), // 通知：无响应体
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

            // 同 URL 复用现有会话；不同 URL 则丢弃旧会话重建（round-118）。
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
                next_id: AtomicU64::new(1),
                http: reqwest::Client::new(),
            };

            // initialize：响应头下发 mcp-session-id；initialized 通知：无 id。
            let server = handshake(&mut sess).await?;

            let tools = list_tools_ref(&mut sess).await?;

            {
                let mut guard = SESSION.lock().await;
                if let Some(s) = guard.as_ref() {
                    if s.url == url {
                        return Ok(json!({ "status": "already_connected", "url": url }));
                    }
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

/// `mcp_client_list` — list tools exposed by the connected browser server.
/// 握手：initialize（拿会话 id）+ initialized 通知。返回服务器信息。
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
            let tools = list_tools_ref(sess).await?;
            Ok(json!({
                "tool_count": tools.len(),
                "tools": tools.iter().map(|(n, d)| {
                    json!({"name": n, "description": d})
                }).collect::<Vec<_>>(),
            }))
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
            // round-131: 180s —— 首次导航含浏览器冷启动，60s 会误超时；
            // 且超时后远程操作仍在运行，会占住会话队列饿死后续调用。
            let id = sess.next_id.fetch_add(1, Ordering::Relaxed);
            let call = rpc_ref(sess, Some(id), "tools/call", json!({
                "name": tool,
                "arguments": args,
            }), 180).await;
            // round-132: playwright-mcp 的会话可能在两次调用之间被服务端回收
            // （404 Session not found）——自动重新握手并重试一次，调用方无感。
            let result = match call {
                Err(DeviceError::Internal { message }) if
                    message.contains("Session not found") || message.contains("HTTP 404") =>
                {
                    handshake(sess).await?;
                    let retry_id = sess.next_id.fetch_add(1, Ordering::Relaxed);
                    rpc_ref(sess, Some(retry_id), "tools/call", json!({
                        "name": tool,
                        "arguments": args,
                    }), 180).await?
                }
                r => r?,
            };

            // 与原实现一致：优先 structuredContent，否则拼接文本内容
            // （截图是 image 内容块，转成 data URI 原样透传给调用方解码）。
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
                // Streamable HTTP 的会话终止：DELETE /mcp（尽力而为）。
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
