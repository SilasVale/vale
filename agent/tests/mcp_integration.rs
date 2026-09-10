//! Full MCP-over-HTTP integration: a real server on an ephemeral port, a real
//! rmcp client. Exercises the whole dispatch path (HTTP → DeviceServer →
//! PluginRegistry → tool handler) with zero hardware.

use rmcp::model::{CallToolRequestParams, CallToolResult, ContentBlock};
use rmcp::transport::{
    streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
};
use rmcp::ServiceExt;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use vale_agent::state::AppState;
use vale_agent_core::Config;

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
    let url = start_server(Some("sekret")).await;
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url).auth_header("sekret"),
    );
    let client = ().serve(transport).await.expect("connect client");

    let tools = client.list_tools(None).await.expect("list_tools");
    assert_eq!(tools.tools.len(), 50, "27 terminal (incl. terminal_env + terminal_jobs + terminal_plan + terminal_sftp + terminal_forget_saved + terminal_secret_* aliases) + agent_update + page_view + 4 mcp_client_* + 2 playwright + 6 memory_* + 9 system_* (round-266 added system_file_stat, round-340 added system_file_download, round-341 added system_file_upload)");
    let _ = client.cancel().await;
}

#[tokio::test]
async fn call_tool_roundtrip() {
    let url = start_server(Some("sekret")).await;
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url).auth_header("sekret"),
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
    let url = start_server(Some("sekret")).await;
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url).auth_header("sekret"),
    );
    let client = ().serve(transport).await.expect("connect client");

    let params = CallToolRequestParams::new("does_not_exist");
    let err = client
        .call_tool(params)
        .await
        .expect_err("unknown tool must fail");
    assert!(!err.to_string().is_empty());
    let _ = client.cancel().await;
}

#[tokio::test]
async fn missing_token_config_denies_everything() {
    // Fail-closed: a server built without a device token rejects even the
    // handshake (bootstrap guarantees production always has a token, so
    // None must never mean open).
    let url = start_server(None).await;
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url),
    );
    let err = ().serve(transport).await.expect_err("tokenless server must refuse");
    assert!(err.to_string().contains("401"), "unexpected error: {err}");
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
    let resp: CallToolResult = client
        .call_tool(params)
        .await
        .expect("call_tool with token");
    let text = match resp.content.first().expect("content") {
        ContentBlock::Text(t) => t.text.clone(),
        _ => panic!("expected text content"),
    };
    assert_eq!(text, "[]");
    let _ = client.cancel().await;
}

async fn mcp_url_with(
    auth_token: &str,
    url: &str,
) -> rmcp::service::RunningService<rmcp::RoleClient, ()> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url).auth_header(auth_token),
    );
    ().serve(transport).await.expect("connect client")
}

#[tokio::test]
async fn mcp_gate_follows_runtime_token_rotation() {
    // Round-366: TokenGate used to hold a BOOT-time token clone while /api/*
    // read the live snapshot — a runtime rotation would stale-accept the old
    // token on /mcp and reject the new one. Both gates must move together.
    let mut cfg = Config::default();
    cfg.server.host = "127.0.0.1".into();
    cfg.server.port = 0;
    cfg.server.device_token = Some("old-sekret".into());
    let state = Arc::new(AppState::new(cfg.clone()));
    let (addr, _handle) = vale_agent::mcp::bind(cfg, state.clone(), CancellationToken::new())
        .await
        .expect("bind server");
    let url = format!("http://{addr}/mcp");
    // Old token works pre-rotation.
    let client = mcp_url_with("old-sekret", &url).await;
    let params = CallToolRequestParams::new("terminal_list");
    client.call_tool(params).await.expect("pre-rotation call");
    let _ = client.cancel().await;
    // Rotate at runtime (no restart, no rebind — persist=false touches
    // memory only).
    let mut next = state.config_snapshot();
    next.server.device_token = Some("new-sekret".into());
    state.update_config(next, false).expect("rotate token");
    // Old token now 401s…
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url.as_str()).auth_header("old-sekret"),
    );
    let err = ().serve(transport).await.expect_err("rotated-out token must fail");
    assert!(err.to_string().contains("401"), "unexpected error: {err}");
    // …and the new token works.
    let client = mcp_url_with("new-sekret", &url).await;
    let params = CallToolRequestParams::new("terminal_list");
    let resp: CallToolResult = client.call_tool(params).await.expect("post-rotation call");
    let text = match resp.content.first().expect("content") {
        ContentBlock::Text(t) => t.text.clone(),
        _ => panic!("expected text content"),
    };
    assert_eq!(text, "[]");
    let _ = client.cancel().await;
}
