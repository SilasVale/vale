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
/// round-132: 不要给这个服务器开 GET /mcp 事件流——实测它会终止整个会话
/// （第一次调用成功、第二次即 404 Session not found）。会话保活靠的是
/// 低频 tools/list 心跳（spawn_heartbeat）+ 404 时自愈握手。
struct McpSession {
    url: String,
    /// Streamable HTTP 的会话标识 —— initialize 响应头下发，后续请求必带。
    session_id: Option<String>,
    /// 最后一次 browser_navigate 的 URL —— 会话被服务端回收后重连时，
    /// 自动导航回这个地址，恢复页面状态（否则每次自愈都回到空白页）。
    last_url: Option<String>,
    next_id: AtomicU64,
    http: reqwest::Client,
    /// 心跳任务中止句柄（disconnect/重建时中止）。
    heartbeat_abort: Option<tokio::task::AbortHandle>,
}
static SESSION: Mutex<Option<McpSession>> = Mutex::const_new(None);

/// 活动保活心跳：实测该服务器在客户端闲置 ~30s 后即回收会话（第二次
/// 调用 404 Session not found），而快速连续调用则一直存活。每 6 秒一次
/// 零副作用的 tools/list 探测即可保活；探测失败说明会话已死，停止心跳，
/// 交由调用层的 404 自愈逻辑重建。
fn spawn_heartbeat(sess: &mut McpSession) {
    if let Some(h) = sess.heartbeat_abort.take() {
        h.abort();
    }
    let Some(sid) = sess.session_id.clone() else { return };
    let http = sess.http.clone();
    let url = sess.url.clone();
    let handle = tokio::spawn(async move {
        for n in 1u64..=600u64 {
            tokio::time::sleep(Duration::from_secs(6)).await;
            let body = json!({
                "jsonrpc": "2.0",
                "id": 9000 + n,
                "method": "tools/list",
                "params": {}
            });
            let r = http
                .post(&url)
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .header("mcp-session-id", &sid)
                .timeout(Duration::from_secs(10))
                .json(&body)
                .send()
                .await;
            match r {
                Ok(resp) if resp.status().is_success() => continue,
                _ => break, // 会话已失效——停心跳，等调用层自愈重建
            }
        }
    });
    sess.heartbeat_abort = Some(handle.abort_handle());
}

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
    // round-132 诊断：记录每次 MCP 往返的方法/id/所用会话/状态。
    {
        let sid_used = sess.session_id.clone().unwrap_or_default();
        let _ = std::fs::OpenOptions::new().create(true).append(true)
            .open("D:\\vale-agent\\mcp_diag.log")
            .and_then(|mut f| {
                use std::io::Write;
                writeln!(f, "[rpc] method={method} id={id:?} sid={sid_used} http={} body_head={:?}",
                    status.as_u16(), &text[..text.len().min(80)])
            });
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
                last_url: None,
                next_id: AtomicU64::new(1),
                http: reqwest::Client::new(),
                heartbeat_abort: None,
            };

            // initialize：响应头下发 mcp-session-id；initialized 通知：无 id。
            let server = handshake(&mut sess).await?;

            let tools = list_tools_ref(&mut sess).await?;

            {
                let mut guard = SESSION.lock().await;
                match guard.as_ref() {
                    // 并发的同 URL connect 抢先完成——复用现有会话，
                    // 丢弃本副本直接返回。
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

/// 握手：initialize（拿会话 id）+ initialized 通知。返回服务器信息。
async fn handshake(sess: &mut McpSession) -> Result<Value, DeviceError> {
    let init_id = sess.next_id.fetch_add(1, Ordering::Relaxed);
    let resp = rpc_ref(sess, Some(init_id), "initialize", json!({
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "vale-agent", "version": "1"}
    }), 30).await?;
    rpc_ref(sess, None, "notifications/initialized", Value::Null, 10).await?;
    spawn_heartbeat(sess);
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

            // round-132 根因适配：实测 playwright-mcp 0.0.79 的 MCP 会话是
            // "一次有效调用"语义——首次 tools/call 的响应流关闭后会话即被
            // 服务端回收（第二次调用 404 Session not found）。但只有会话是
            // 一次性的：Chromium 实例持久（无 --isolated，持久 profile），
            // 新会话的第一次 tools/call 直接落在当前标签页上。
            //
            // round-134 修正：旧自愈在 404 后用"导航回 last_url"消耗新会话，
            // 并把导航结果当作本次调用的答案返回——browser_take_screenshot
            // 永远执行不到，面板浏览器预览因此永远拿不到截图。现在改为
            // 重握手后直接重试原调用，无需任何恢复导航。

            // round-131: 180s —— 首次导航含浏览器冷启动，60s 会误超时。
            let id = sess.next_id.fetch_add(1, Ordering::Relaxed);
            let call = rpc_ref(sess, Some(id), "tools/call", json!({
                "name": tool,
                "arguments": args,
            }), 180).await;
            let mut result = match call {
                Err(DeviceError::Internal { message }) if
                    message.contains("Session not found") || message.contains("HTTP 404") =>
                {
                    // 旧会话头必须清掉：带着失效的 mcp-session-id 去
                    // initialize，服务器直接 404 而不是下发新会话。
                    sess.session_id = None;
                    handshake(sess).await?;
                    // 新会话的第一次调用 = 原调用本身（浏览器/标签页持久，
                    // 无需恢复导航）。若这次仍 404 则如实报错。
                    let retry_id = sess.next_id.fetch_add(1, Ordering::Relaxed);
                    rpc_ref(sess, Some(retry_id), "tools/call", json!({
                        "name": tool,
                        "arguments": args,
                    }), 180).await?
                }
                r => r?,
            };

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
                if let Some(h) = s.heartbeat_abort {
                    h.abort();
                }
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
