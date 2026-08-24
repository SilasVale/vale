//! round-137 实测定理（d1 真机探针，2026-08-25）：
//! playwright-mcp 0.0.79 的 Streamable HTTP 会话在每次 tools/call 响应完成
//! 后约 4 秒被无条件回收（"Session not found"）。客户端侧保活手段全部证伪：
//!
//! - tools/list 心跳：探测本身不续命（+3s 探测成功、+5s 仍死），且窗口只有
//!   ~4s，任何轮询间隔都赢不了；
//! - 单条长连接静默保持：与会话无关，keep-alive socket 上照样死；
//! - 标准 GET /mcp SSE 事件流：服务器主动关流（status 200）并杀会话。
//!
//! 因此客户端唯一正确的形态：放弃保活，接受"每次调用都可能撞上死会话"，
//! 撞上就自愈——重握手 + 用 last_url 把页面导航回去（恢复上下文），再重试
//! 原调用。last_url 从 browser_navigate 参数与任意响应文本里的
//! "Page URL:" 行双向跟踪，跨会话保持浏览器画面连续。
//!
//! 会话状态就是 base_url + mcp-session-id + 自增 id + last_url，无后台任务。

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
    /// round-137：该会话约在每次 tools/call 完成后 ~4s 被服务端回收，这里
    /// 的缓存值随时可能失效；所有请求路径都必须处理 404 自愈。
    session_id: Option<String>,
    /// 最近一次已知的页面地址 —— 自愈重握手后用它把新会话的当前标签页
    /// 导航回去（否则新会话落在新空白页上，browser 会话永远"看不到画面"）。
    /// 来源：browser_navigate 的 url 参数 + 任意工具响应文本的 "Page URL:"
    /// 行（点击/表单跳转不经过 navigate 也能跟上）。
    last_url: Option<String>,
    next_id: AtomicU64,
    http: reqwest::Client,
}
static SESSION: Mutex<Option<McpSession>> = Mutex::const_new(None);

/// 带时间戳的诊断日志（round-132 引入的 mcp_diag.log，round-137 加时间戳
/// 与 [heal]/[restore] 标记——之前无时间戳，无法和真机探针对时）。
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
    // round-132 诊断：记录每次 MCP 往返的方法/id/所用会话/状态（round-137
    // 起带毫秒时间戳）。
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

/// 判断一次失败是否为"会话已被服务端回收"（round-137：每次 tools/call 完成
/// 后 ~4s 必然发生，属常态而非异常）。
fn is_session_gone(msg: &str) -> bool {
    msg.contains("Session not found") || msg.contains("HTTP 404")
}

/// 自愈：丢弃失效的 mcp-session-id → 重握手 → 用 last_url 把新会话的当前
/// 标签页导航回已知页面。没有 last_url（从未成功导航过）就只重握手——
/// 新会话落在新空白页上，这与浏览器刚启动时的初始状态一致，是诚实的。
async fn heal_and_restore(sess: &mut McpSession) -> Result<(), DeviceError> {
    // 旧会话头必须清掉：带着失效的 mcp-session-id 去 initialize，服务器
    // 直接 404 而不是下发新会话（round-134 实测）。
    sess.session_id = None;
    diag_log("[heal] re-handshaking after session recycle");
    handshake(sess).await?;
    if let Some(url) = sess.last_url.clone() {
        let id = sess.next_id.fetch_add(1, Ordering::Relaxed);
        diag_log(&format!("[restore] navigating back to {url}"));
        // 恢复导航失败不致命：原调用照常重试（大不了落在空白页，总比
        // 直接报错好）。超时给足——冷页面可能慢。
        let _ = rpc_ref(sess, Some(id), "tools/call", json!({
            "name": "browser_navigate",
            "arguments": { "url": url },
        }), 60).await;
    }
    Ok(())
}

/// 从工具响应文本里提取 "- Page URL: <url>" 行，更新 last_url —— 点击、
/// 表单提交、前端路由跳转都不经过 browser_navigate，只有从响应里跟才能
/// 让恢复点始终贴近用户真实所在的页面。
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
            // round-137: 会话随时可能已被回收（~4s TTL），list 同样要自愈。
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

            // round-137 根因适配：playwright-mcp 0.0.79 的会话在每次
            // tools/call 完成后 ~4 秒被无条件回收（真机探针证实：心跳、
            // 长连接、GET 事件流全部救不了）。所以 404 不是异常而是常态：
            // 撞上就自愈——重握手 + 导航回 last_url 恢复页面上下文，再重试
            // 原调用。恢复导航在原调用之前执行，因此本次调用的响应仍然是
            // 原工具自己的结果（round-134 的"导航结果污染响应"问题靠这个
            // 顺序保证，而不是靠不做恢复）。
            //
            // round-131: 180s —— 首次导航含浏览器冷启动，60s 会误超时。
            let call_body = || json!({
                "name": tool,
                "arguments": args,
            });
            let id = sess.next_id.fetch_add(1, Ordering::Relaxed);
            let call = rpc_ref(sess, Some(id), "tools/call", call_body(), 180).await;
            let mut result = match call {
                Err(DeviceError::Internal { message }) if is_session_gone(&message) => {
                    heal_and_restore(sess).await?;
                    // 若这次仍 404 则如实报错。
                    let retry_id = sess.next_id.fetch_add(1, Ordering::Relaxed);
                    rpc_ref(sess, Some(retry_id), "tools/call", call_body(), 180).await?
                }
                r => r?,
            };

            // round-137: 页面跟踪 —— browser_navigate 的参数是权威来源；
            // 其他工具（点击/表单/路由跳转）从响应文本的 "Page URL:" 行
            // 跟踪。last_url 是下次自愈时的恢复点。
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
