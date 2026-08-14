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
const DEFAULT_URL: &str = "http://127.0.0.1:9229/mcp";

/// Shared remote-peer slot: set by `mcp_client_connect`, used by `call`/`list`.
static PEER: Mutex<Option<Peer<RoleClient>>> = Mutex::const_new(None);

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
         (default http://127.0.0.1:9229/mcp). Returns the number of tools exposed \
         by the server once connected.",
        json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "MCP server URL (default http://127.0.0.1:9229/mcp)"
                }
            }
        }),
        |params: Value| async move {
            let url = params.get("url").and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_URL);
            // Reuse an existing connection — connecting twice would leak a
            // second client session.
            if let Ok(guard) = PEER.try_lock() {
                if guard.is_some() {
                    return Ok(json!({ "status": "already_connected", "url": url }));
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
            // Keep the session task alive for the process lifetime.
            tokio::spawn(async move { let _ = running.waiting().await; });

            let tools = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                peer.list_all_tools(),
            )
            .await
            .map_err(|_| DeviceError::Internal { message: "list tools timed out after 30s".into() })?
            .map_err(|e| DeviceError::Internal { message: format!("list tools failed: {e}") })?;
            *PEER.lock().await = Some(peer);

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
            let guard = PEER.lock().await;
            let peer = guard.as_ref().ok_or_else(|| DeviceError::InvalidParams {
                message: "not connected — call mcp_client_connect first".into(),
            })?;
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

            let guard = PEER.lock().await;
            let peer = guard.as_ref().ok_or_else(|| DeviceError::InvalidParams {
                message: "not connected — call mcp_client_connect first".into(),
            })?;
            // round-93: browser operations can be slow (navigation, waiting),
            // but never infinite — a hung remote must not wedge this MCP
            // worker.
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(60),
                peer.call_tool(req),
            )
            .await
            .map_err(|_| DeviceError::Internal { message: format!("call {tool} timed out after 60s") })?
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
            *PEER.lock().await = None;
            Ok(json!({ "status": "disconnected" }))
        },
    )
}
