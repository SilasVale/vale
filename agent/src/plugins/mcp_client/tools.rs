//! Tool builders for the MCP client plugin — connect/list/call/disconnect a
//! local browser MCP server over Streamable HTTP.
//!
//! Connection lifecycle is RUNTIME-driven (not register-time): the plugin is
//! stateless; `mcp_client_connect` opens a client session and caches the
//! remote Peer in a process-global slot, `mcp_client_call` dispatches through
//! it. This mirrors DSH's mcp-client plugin (connect on demand, tools under a
//! qualified namespace) while keeping Vale's "tools built once at register"
//! invariant — the remote tool LIST is discovered at connect time and exposed
//! through `mcp_client_list` instead of being statically registered.

use serde_json::{json, Value};
use tokio::sync::Mutex;

use vale_agent_core::{DeviceError, ToolDef};
use rmcp::{
    model::{CallToolRequestParams, ClientInfo, ErrorCode},
    service::{NotificationContext, Peer, RequestContext, Service, ServiceExt, ServiceRole},
    transport::StreamableHttpClientTransport,
    ErrorData, RoleClient,
};

/// The local browser MCP server endpoint (playwright-mcp --port 9229).
const DEFAULT_URL: &str = "http://localhost:9229/mcp";

/// Shared remote-peer slot: set by `mcp_client_connect`, used by `call`/`list`.
/// Carries the session's cancel token so `disconnect` can tear the session
/// down for real (round-99: dropping the Peer alone left the connect's
/// spawned session task alive, leaking sessions on the browser server).
struct PeerSession {
    peer: Peer<RoleClient>,
    cancel: rmcp::service::RunningServiceCancellationToken,
    /// The server URL this session was opened to (round-118: already_connected
    /// used to echo the REQUESTED url without checking it matched the cached
    /// session — connecting to a different server silently kept using the old
    /// one).
    url: String,
}
static PEER: Mutex<Option<PeerSession>> = Mutex::const_new(None);

/// A minimal client-side service — we only call tools, never serve requests.
struct EmptyClientService;

impl Service<RoleClient> for EmptyClientService {
    async fn handle_request(
        &self,
        _request: <RoleClient as ServiceRole>::PeerReq,
        _context: RequestContext<RoleClient>,
    ) -> Result<<RoleClient as ServiceRole>::Resp, ErrorData> {
        // A browser MCP server never calls back into us; reject such a
        // request (there is no handler to satisfy it).
        Err(ErrorData {
            code: ErrorCode::METHOD_NOT_FOUND,
            message: "unexpected server→client request".into(),
            data: None,
        })
    }
    async fn handle_notification(
        &self,
        _notification: <RoleClient as ServiceRole>::PeerNot,
        _context: NotificationContext<RoleClient>,
    ) -> Result<(), ErrorData> {
        Ok(())
    }
    fn get_info(&self) -> <RoleClient as ServiceRole>::Info {
        ClientInfo::default()
    }
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
                .unwrap_or(DEFAULT_URL);
            // Reuse an existing connection — connecting twice would leak a
            // second client session.
            // round-118: only reuse when the cached session points at the SAME
            // url — the old check echoed the requested url back without
            // matching, so a connect to a different server silently kept using
            // the old one.
            if let Ok(guard) = PEER.try_lock() {
                if let Some(s) = guard.as_ref() {
                    if s.url == url {
                        return Ok(json!({ "status": "already_connected", "url": url }));
                    }
                    // Different server — tear down the old session and connect
                    // to the new one (the caller asked for THIS url).
                    drop(guard);
                    if let Some(s) = PEER.lock().await.take() {
                        s.cancel.cancel();
                    }
                }
            }

            // rmcp client: WorkerTransport over reqwest, served by our empty
            // client service. The RunningService must stay alive for the
            // session — drop it and the worker task dies with it.
            //
            // round-93: the serve() call MUST be bounded. rmcp's SSE retry
            // policy defaults to FixedInterval { max_times: None } — an
            // infinite 1s reconnect loop when the server is not up. A server
            // that isn't running (playwright-mcp not installed/started yet)
            // made serve() never return, wedging the MCP worker that awaited
            // this handler and cascading into API errors for every tool on
            // that connection. Fail fast with a clear "is the server running?"
            // error instead of hanging the session.
            let transport = StreamableHttpClientTransport::from_uri(url);
            let running = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                EmptyClientService.serve(transport),
            )
            .await
            .map_err(|_| DeviceError::Internal {
                message: format!(
                    "MCP connect timed out after 5s — is the browser MCP server running at {url}? \
                     (playwright-mcp / chrome-devtools-mcp)"
                ),
            })?
            .map_err(|e| DeviceError::Internal { message: format!("MCP connect failed: {e}") })?;
            let peer = running.peer().clone();
            // The session's cancel token — disconnect() cancels it to tear
            // the session down for real (round-99). The spawned waiting()
            // task keeps the session alive until then.
            let cancel = running.cancellation_token();
            // round-113: `cancel(self)` consumes the wrapper and it has no
            // Clone — take fresh wrappers (sharing the same inner token)
            // before `running` is moved into the spawn task below, one per
            // consumer: the two list-error closures and PeerSession itself.
            let cancel_list_timeout = running.cancellation_token();
            let cancel_list_err = running.cancellation_token();
            tokio::spawn(async move { let _ = running.waiting().await; });

            let tools = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                peer.list_all_tools(),
            )
            .await
            .map_err(|_| {
                // round-113: the session was opened (serve() succeeded) but
                // listing failed — cancel it or the remote session leaks
                // forever (round-99 fixed disconnect, not this path).
                cancel_list_timeout.cancel();
                DeviceError::Internal { message: "list tools timed out after 30s".into() }
            })?
            .map_err(|e| {
                cancel_list_err.cancel();
                DeviceError::Internal { message: format!("list tools failed: {e}") }
            })?;
            // round-113: re-check under the lock — a concurrent connect may
            // have won between the early check and here; last-writer-wins
            // would orphan this session's task.
            {
                let mut guard = PEER.lock().await;
                if let Some(s) = guard.as_ref() {
                    // round-118: same-url reuse only (the early check may have
                    // been raced); a different-url session is replaced below.
                    if s.url == url {
                        cancel.cancel();
                        return Ok(json!({ "status": "already_connected", "url": url }));
                    }
                }
                *guard = Some(PeerSession { peer, cancel, url: url.to_string() });
            }

            Ok(json!({
                "status": "connected",
                "url": url,
                "tool_count": tools.len(),
                "tools": tools.iter().map(|t| t.name.as_ref().to_string()).collect::<Vec<_>>(),
            }))
        },
    )
}

/// `mcp_client_list` — list tools exposed by the connected browser server.
pub fn mcp_client_list() -> ToolDef {
    ToolDef::new(
        "mcp_client_list",
        "List the tools exposed by the connected browser MCP server (playwright-mcp: \
         browser_navigate, browser_snapshot, browser_click, ...).",
        json!({ "type": "object" }),
        |_: Value| async move {
            // round-118: the lock must NOT be held across the remote call —
            // it used to serialize ALL browser-bridge traffic (call/list/
            // disconnect) behind one in-flight op for up to 60s. Clone the
            // peer under the lock and release it before the await.
            let peer = {
                let guard = PEER.lock().await;
                guard.as_ref().ok_or_else(|| DeviceError::InvalidParams {
                    message: "not connected — call mcp_client_connect first".into(),
                })?.peer.clone()
            };
            // round-93: bounded like connect — a hung remote must not wedge
            // this MCP worker.
            let tools = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                peer.list_all_tools(),
            )
            .await
            .map_err(|_| DeviceError::Internal { message: "list tools timed out after 30s".into() })?
            .map_err(|e| DeviceError::Internal { message: format!("list tools failed: {e}") })?;
            Ok(json!({
                "tool_count": tools.len(),
                "tools": tools.iter().map(|t| {
                    json!({
                        "name": t.name.as_ref(),
                        "description": t.description.as_deref().unwrap_or(""),
                    })
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
            let mut req = CallToolRequestParams::new(tool.clone());
            if let Some(obj) = args.as_object() {
                req = req.with_arguments(obj.clone());
            }

            // round-118: same as list — clone the peer under the lock, call
            // outside it (the lock used to serialize every browser op behind
            // one in-flight call for up to 60s, and blocked disconnect too).
            let peer = {
                let guard = PEER.lock().await;
                guard.as_ref().ok_or_else(|| DeviceError::InvalidParams {
                    message: "not connected — call mcp_client_connect first".into(),
                })?.peer.clone()
            };
            // round-93: browser operations can be slow (navigation, waiting),
            // but never infinite — a hung remote must not wedge this MCP
            // worker.
            // round-118: rmcp 2.2.0's call_tool macro hardcodes
            // no_options() — the remote-cancel path
            // (send_timeout_cancel_notification) is unreachable, so a
            // timed-out op keeps running on the remote and can race a retry.
            // The local timeout at least stops THIS caller from wedging; the
            // session cancel token is the only lever (disconnect uses it).
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(60),
                peer.call_tool(req),
            )
            .await
            .map_err(|_| DeviceError::Internal { message: format!("call {tool} timed out after 60s — the remote op may still be running; call mcp_client_disconnect to abort it") })?
            .map_err(|e| DeviceError::Internal { message: format!("call {tool} failed: {e}") })?;

            // Extract the text content the way MCP clients render it — a
            // screenshot comes back as image content (PNG base64) which we
            // pass through untouched for the caller to decode.
            let text = result.content.iter().filter_map(|c| match c {
                rmcp::model::ContentBlock::Text(t) => Some(t.text.clone()),
                rmcp::model::ContentBlock::Image(img) => Some(format!("data:image/{};base64,{}", img.mime_type, img.data)),
                _ => None,
            }).collect::<Vec<_>>().join("\n");
            let structured = result.structured_content.clone();
            if structured.is_some() {
                Ok(json!({ "ok": true, "result": structured }))
            } else {
                Ok(json!({ "ok": true, "result": text }))
            }
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
            // round-99: just dropping the slot left the connect's
            // tokio::spawn(running.waiting()) session task alive (the Peer
            // clone it holds kept the MCP session open) — connect/disconnect
            // cycles leaked sessions on the browser server. Cancel the
            // session's token to tear it down for real.
            let sess = PEER.lock().await.take();
            if let Some(s) = sess {
                s.cancel.cancel();
            }
            Ok(json!({ "status": "disconnected" }))
        },
    )
}
