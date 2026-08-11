use std::net::SocketAddr;
use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo,
    Tool, ToolsCapability,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService,
    session::local::LocalSessionManager,
};
use rmcp::{ErrorData as McpError, ServerHandler};
use tokio_util::sync::CancellationToken;

use vale_agent_core::Config;
use crate::state::AppState;

#[derive(Debug, Clone)]
pub struct DeviceServer {
    state: Arc<AppState>,
}

impl DeviceServer {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }
}

impl ServerHandler for DeviceServer {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.instructions = Some(
            "Vale Command device access: Terminal (PTY/SSH/Serial) tools.".into(),
        );
        let mut caps = ServerCapabilities::default();
        let mut tools_cap = ToolsCapability::default();
        // Tool list is static — no list_changed notifications are ever sent
        tools_cap.list_changed = Some(false);
        caps.tools = Some(tools_cap);
        info.capabilities = caps;
        // Implementation is non-exhaustive — field assignment after Default
        // is the only construction form.
        #[allow(clippy::field_reassign_with_default)]
        let mut server_info = Implementation::default();
        server_info.name = "vale-agent".into();
        server_info.title = Some("Vale Agent".into());
        server_info.version = env!("CARGO_PKG_VERSION").into();
        info.server_info = server_info;
        info
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let tool_name = request.name.as_ref();
        let tool = self.state.plugin_registry.find_tool(tool_name).ok_or_else(|| {
            McpError::method_not_found::<rmcp::model::CallToolRequestMethod>()
        })?;
        let params: serde_json::Value = request.arguments
            .map(serde_json::Value::Object)
            .unwrap_or(serde_json::json!({}));
        match tool.handler.call(params).await {
            Ok(result) => {
                let mut r = CallToolResult::default();
                r.content = vec![ContentBlock::text(result.to_string())];
                Ok(r)
            }
            Err(e) => {
                let mut r = CallToolResult::default();
                r.content = vec![ContentBlock::text(e.to_string())];
                r.is_error = Some(true);
                Ok(r)
            }
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let tools: Vec<Tool> = self.state.plugin_registry.all_tools().iter()
            .map(|t| to_mcp_tool(t))
            .collect();
        Ok(ListToolsResult { tools, ..Default::default() })
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.state.plugin_registry.find_tool(name).map(|t| to_mcp_tool(&t))
    }
}

/// ToolDef → rmcp Tool conversion (shared by list_tools and get_tool).
fn to_mcp_tool(t: &vale_agent_core::ToolDef) -> Tool {
    let mut tool = Tool::default();
    tool.name = t.name.clone().into();
    tool.description = Some(t.description.clone().into());
    tool.input_schema = Arc::new(t.input_schema.as_object().cloned().unwrap_or_default());
    tool
}

pub async fn serve(config: Config, state: Arc<AppState>) -> anyhow::Result<()> {
    let ct = CancellationToken::new();
    // Wire Ctrl+C to the shutdown token so "Press Ctrl+C to stop" is true.
    let ctrl_ct = ct.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("Ctrl+C received — shutting down");
        ctrl_ct.cancel();
    });
    serve_with_token(config, state, ct).await
}

/// Bind and serve MCP+Web on the configured address with an external
/// CancellationToken. Returns the actual bound address (port 0 resolves to a
/// free port — how the integration tests get an ephemeral listener) and the
/// server task handle.
pub async fn bind(
    config: Config,
    state: Arc<AppState>,
    ct: CancellationToken,
) -> anyhow::Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
    let addr: SocketAddr = format!("{}:{}", config.server.host, config.server.port)
        .parse()
        .map_err(|e| anyhow::anyhow!("invalid server address: {e}"))?;

    let child_ct = ct.child_token();

    let service: StreamableHttpService<DeviceServer, LocalSessionManager> =
        StreamableHttpService::new(
            {
                let state = state.clone();
                move || Ok(DeviceServer::new(state.clone()))
            },
            Default::default(),
            {
                let mut cfg = StreamableHttpServerConfig::default();
                cfg.allowed_hosts.clear();
                cfg.stateful_mode = true;
                cfg.json_response = false;
                cfg.cancellation_token = child_ct;
                cfg
            },
        );

    // MCP service at /mcp (token-gated) + the web surface via fallback_service
    // (Tower layer)
    let mcp_app = axum::Router::new()
        .nest_service("/mcp", crate::web::TokenGate::new(service, config.server.device_token.clone()))
        .fallback_service(crate::web::WebPanel::new(state.clone()));
    let mcp_listener = tokio::net::TcpListener::bind(addr).await?;
    let actual = mcp_listener.local_addr()?;

    tracing::info!("Server:  http://{actual}/  (MCP: /mcp)");

    let mcp_ct = ct.clone();
    let mcp_srv = axum::serve(mcp_listener, mcp_app).with_graceful_shutdown(async move {
        mcp_ct.cancelled().await;
    });

    let mcp_handle = tokio::spawn(async move {
        if let Err(e) = mcp_srv.await { tracing::error!("Server: {e}"); }
    });

    Ok((actual, mcp_handle))
}

/// Serve MCP+Web with an external CancellationToken.
pub async fn serve_with_token(
    config: Config,
    state: Arc<AppState>,
    ct: CancellationToken,
) -> anyhow::Result<()> {
    let (_addr, handle) = bind(config, state, ct.clone()).await?;
    // Ignore stdout errors — under a Windows service there is no console and
    // println! would panic, dropping the listener.
    use std::io::Write as _;
    let _ = writeln!(std::io::stdout(), "  Server started. Press Ctrl+C to stop.");
    ct.cancelled().await;
    let _ = handle.await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use vale_agent_core::Config;

    fn server() -> DeviceServer {
        DeviceServer::new(Arc::new(AppState::new(Config::default())))
    }

    #[test]
    fn get_tool_found() {
        assert!(server().get_tool("terminal_open").is_some());
        assert!(server().get_tool("terminal_execute").is_some());
    }

    #[test]
    fn get_tool_unknown() {
        assert!(server().get_tool("does_not_exist").is_none());
    }
}