//! Full MCP-over-HTTP integration: a real server on an ephemeral port, a real
//! rmcp client. Exercises the whole dispatch path (HTTP → DeviceServer →
//! PluginRegistry → tool handler) with zero hardware.

use vale_agent::state::AppState;
use vale_agent_core::Config;
use rmcp::model::{CallToolRequestParams, CallToolResult, ContentBlock};
use rmcp::ServiceExt;
use rmcp::transport::{
    StreamableHttpClientTransport,
    streamable_http_client::StreamableHttpClientTransportConfig,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Start a headless server on an ephemeral port; returns the MCP URL.
async fn start_server(auth_token: Option<&str>) -> String {
    let mut cfg = Config::default();
    cfg.server.host = "127.0.0.1".into();
    cfg.server.port = 0; // ephemeral — bind() reports the actual port
    cfg.server.device_token = auth_token.map(|t| t.to_string());
    let state = Arc::new(AppState::new(cfg.clone()));
    let (addr, _handle) = vale_agent::mcp::bind(cfg, state, CancellationToken::new())
        .await
        .expect("bind server");
    format!("http://{addr}/mcp")
}

#[tokio::test]
async fn list_tools_via_http() {
    let url = start_server(None).await;
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url),
    );
    let client = ().serve(transport).await.expect("connect client");

    let tools = client.list_tools(None).await.expect("list_tools");
    assert_eq!(tools.tools.len(), 25, "19 terminal (incl. terminal_jobs) + agent_update + page_view + 4 mcp_client_*");
    let _ = client.cancel().await;
}

#[tokio::test]
async fn call_tool_roundtrip() {
    let url = start_server(None).await;
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url),
    );
    let client = ().serve(transport).await.expect("connect client");

    // terminal_list through the registry → headless stub → empty array
    let mut params = CallToolRequestParams::new("terminal_list");
    params.arguments = Some(serde_json::json!({}).as_object().unwrap().clone());
    let resp: CallToolResult = client.call_tool(params).await.expect("call_tool");
    let text = match resp.content.first().expect("content") {
        ContentBlock::Text(t) => t.text.clone(),
        _ => panic!("expected text content"),
    };
    assert_eq!(text, "[]");
    let _ = client.cancel().await;
}

#[tokio::test]
async fn unknown_tool_returns_error() {
    let url = start_server(None).await;
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url),
    );
    let client = ().serve(transport).await.expect("connect client");

    let params = CallToolRequestParams::new("does_not_exist");
    let err = client.call_tool(params).await.expect_err("unknown tool must fail");
    assert!(!err.to_string().is_empty());
    let _ = client.cancel().await;
}

#[tokio::test]
async fn unauthorized_without_token() {
    // Server requires a token; the client sends none → the very first request
    // (initialize) is rejected with 401, so connecting fails.
    let url = start_server(Some("sekret")).await;
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url),
    );
    let err = ().serve(transport).await.expect_err("missing token must fail");
    assert!(err.to_string().contains("401"), "unexpected error: {err}");
}

#[tokio::test]
async fn authorized_with_bearer_token() {
    // Server requires a token; the client sends the right bearer → works
    let url = start_server(Some("sekret")).await;
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url).auth_header("sekret"),
    );
    let client = ().serve(transport).await.expect("connect client");

    let params = CallToolRequestParams::new("terminal_list");
    let resp: CallToolResult = client.call_tool(params).await.expect("call_tool with token");
    let text = match resp.content.first().expect("content") {
        ContentBlock::Text(t) => t.text.clone(),
        _ => panic!("expected text content"),
    };
    assert_eq!(text, "[]");
    let _ = client.cancel().await;
}
