//! HTTP surface served via Tower service (NOT axum route handlers).
//!
//! axum route handlers don't work on cross-compiled Windows. This uses the Tower
//! layer directly — the same layer MCP's StreamableHttpService sits on.
//!
//! Routes:
//!   GET  /                   → minimal status page (no panel assets)
//!   GET  /api/events         → SSE event stream
//!   GET  /api/events/poll    → poll events (?after=N)
//!   GET  /api/events/term    → SSE terminal byte stream (TermOutput JSON frames)
//!   GET  /api/status         → system status
//!   GET  /api/spec           → plugin spec
//!   POST /api/tools/{name}   → generic tool dispatch via PluginRegistry
//!   /mcp (via TokenGate)     → rmcp streamable HTTP server

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::sync::mpsc;
use tower::Service;

use crate::state::AppState;
use vale_command_core::EventBus;

/// Minimal self-contained status page — the panel SPA is retired, but the
/// device URL should still answer something readable in a browser.
const STATUS_PAGE: &str = concat!(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>vale-command</title></head>",
    "<body style=\"font-family:monospace;margin:2rem\"><h1>vale-command</h1>",
    "<p>MCP endpoint: <code>/mcp</code></p>",
    "<p>Tool API: <code>/api/tools/{name}</code></p>",
    "<p>Status: <code>/api/status</code></p>",
    "<p>Version: ",
    env!("CARGO_PKG_VERSION"),
    "</p></body></html>",
);

// ── Terminal panel static assets (embedded, public) ──────────

/// Serve a file from the embedded panel assets. Whitelist by name — no path
/// traversal, no directory listing.
fn serve_panel_file(file: &str, content_type: &'static str) -> Response {
    const HTML: &str = include_str!("../resources/panel/index.html");
    const JS: &str = include_str!("../resources/panel/panel.js");
    const CSS: &str = include_str!("../resources/panel/panel.css");
    const XTERM_JS: &str = include_str!("../resources/panel/vendor/xterm.min.js");
    const XTERM_CSS: &str = include_str!("../resources/panel/vendor/xterm.css");
    const FIT_JS: &str = include_str!("../resources/panel/vendor/xterm-addon-fit.min.js");
    let body: &str = match file {
        "index.html" => HTML,
        "panel.js" => JS,
        "panel.css" => CSS,
        "vendor/xterm.min.js" => XTERM_JS,
        "vendor/xterm.css" => XTERM_CSS,
        "vendor/xterm-addon-fit.min.js" => FIT_JS,
        _ => return built_response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", Body::from("not found")),
    };
    let mut resp = built_response(StatusCode::OK, content_type, Body::from(body));
    resp.headers_mut().insert(
        axum::http::HeaderName::from_static("cache-control"),
        axum::http::HeaderValue::from_static("no-cache"),
    );
    resp
}

fn panel_content_type(file: &str) -> &'static str {
    if file.ends_with(".js") { "text/javascript; charset=utf-8" }
    else if file.ends_with(".css") { "text/css; charset=utf-8" }
    else { "text/html; charset=utf-8" }
}

// ── Tower Service ────────────────────────────────────────────

#[derive(Clone)]
pub struct WebPanel {
    state: Arc<AppState>,
}

impl WebPanel {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }
}

impl Service<Request<Body>> for WebPanel {
    type Response = Response;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Response, Infallible>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, req: Request<Body>) -> Self::Future {
        let state = self.state.clone();
        Box::pin(async move {
            let mut resp = handle_request(req, state).await;
            resp.headers_mut().insert(
                axum::http::HeaderName::from_static("access-control-allow-origin"),
                axum::http::HeaderValue::from_static("*"),
            );
            Ok(resp)
        })
    }
}

// ── Response helpers ───────────────────────────────────────

/// Build a response with a fallback that can't panic — the builder only fails
/// on invalid status/header constants, which ours never are.
fn built_response(status: StatusCode, content_type: &'static str, body: Body) -> Response {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .body(body)
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

// ── Auth helper ────────────────────────────────────────────

/// Check Bearer token or ?token= query param. Static (non-async) so it
/// can be called before the Send boundary. The error is boxed — Response is
/// large and only ever handled at the top of handle_request.
fn check_auth(req: &Request<Body>, state: &AppState) -> Result<(), Box<Response>> {
    let Some(ref token) = state.config.server.device_token else {
        return Ok(()); // no auth configured
    };
    // Check Authorization header first, then ?token= query param (for SSE)
    let from_header = req.headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let from_query = req.uri().query()
        .and_then(|q| q.strip_prefix("token="))
        .map(|t| t.split('&').next().unwrap_or(t));
    if from_header == Some(token.as_str()) || from_query == Some(token.as_str()) {
        return Ok(());
    }
    Err(Box::new(built_response(
        StatusCode::UNAUTHORIZED,
        "application/json",
        Body::from(r#"{"ok":false,"error":"unauthorized"}"#),
    )))
}

// ── Token gate for the MCP route ─────────────────────────────

/// Wraps any Tower service with the same bearer-token check as the API.
/// The MCP endpoint is as sensitive as the API (it drives terminals), so it
/// must not be reachable without the token when one is configured. rmcp has
/// no server-side auth hook, so the check happens here.
#[derive(Clone)]
pub struct TokenGate<S> {
    inner: S,
    token: Option<String>,
}

impl<S> TokenGate<S> {
    pub fn new(inner: S, token: Option<String>) -> Self {
        Self { inner, token }
    }
}

/// The response shape rmcp's StreamableHttpService produces — its body error
/// type is `Infallible`, which differs from axum's `BoxBody` error, so the
/// rejection response is built in the same shape here.
type McpBoxBody = http_body_util::combinators::BoxBody<bytes::Bytes, Infallible>;

fn unauthorized_mcp_response() -> axum::http::Response<McpBoxBody> {
    let body = http_body_util::Full::new(bytes::Bytes::from_static(
        br#"{"ok":false,"error":"unauthorized"}"#,
    ));
    axum::http::Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header("Content-Type", "application/json")
        .body(http_body_util::combinators::BoxBody::new(body))
        .unwrap_or_else(|_| {
            axum::http::Response::new(http_body_util::combinators::BoxBody::new(
                http_body_util::Full::new(bytes::Bytes::new()),
            ))
        })
}

impl<S, ReqBody> Service<Request<ReqBody>> for TokenGate<S>
where
    S: Service<Request<ReqBody>, Response = axum::http::Response<McpBoxBody>, Error = Infallible>,
    S::Future: Send + 'static,
{
    type Response = axum::http::Response<McpBoxBody>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Infallible>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<ReqBody>) -> Self::Future {
        let Some(token) = self.token.clone() else {
            return Box::pin(self.inner.call(req));
        };
        let authorized = req.headers()
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            == Some(token.as_str());
        if !authorized {
            return Box::pin(async { Ok(unauthorized_mcp_response()) });
        }
        Box::pin(self.inner.call(req))
    }
}

// ── Request handler ──────────────────────────────────────────

async fn handle_request(req: Request<Body>, state: Arc<AppState>) -> Response {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    // Handle CORS preflight
    if method == Method::OPTIONS {
        let mut resp = built_response(StatusCode::OK, "", Body::empty());
        resp.headers_mut().insert(
            axum::http::HeaderName::from_static("access-control-allow-origin"),
            axum::http::HeaderValue::from_static("*"),
        );
        resp.headers_mut().insert(
            axum::http::HeaderName::from_static("access-control-allow-methods"),
            axum::http::HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        resp.headers_mut().insert(
            axum::http::HeaderName::from_static("access-control-allow-headers"),
            axum::http::HeaderValue::from_static("Content-Type"),
        );
        return resp;
    }

    // Auth decision extracted synchronously (before the Send boundary).
    let needs_auth = method != Method::GET || path.starts_with("/api") || path == "/mcp";

    // SSE event stream — streaming, handled before body parsing
    if method == Method::GET && path == "/api/events" {
        if let Err(resp) = check_auth(&req, &state) { return *resp; }
        return sse_stream(state).await;
    }

    // SSE terminal byte stream — streamed TermOutput JSON frames.
    if method == Method::GET && path == "/api/events/term" {
        if let Err(resp) = check_auth(&req, &state) { return *resp; }
        return sse_term_stream(state).await;
    }

    // Terminal panel (static page, public like the status page — it shows no
    // data until the user enters the device token in the browser). Assets are
    // embedded at compile time from resources/panel/.
    if method == Method::GET && (path == "/panel" || path == "/panel/") {
        return serve_panel_file("index.html", "text/html; charset=utf-8");
    }
    if method == Method::GET && path.starts_with("/panel/") {
        let file = &path["/panel/".len()..];
        return serve_panel_file(file, panel_content_type(file));
    }

    // GET non-API — minimal status page: public (no token needed)
    if method == Method::GET && !path.starts_with("/api") && path != "/mcp" {
        let mut resp = built_response(StatusCode::OK, "text/html; charset=utf-8", Body::from(STATUS_PAGE));
        resp.headers_mut().insert(
            axum::http::HeaderName::from_static("cache-control"),
            axum::http::HeaderValue::from_static("no-cache"),
        );
        return resp;
    }

    // Auth gate for all the /mcp + /api/* routes that follow
    if needs_auth {
        if let Err(resp) = check_auth(&req, &state) { return *resp; }
    }

    // Extract query params before consuming body
    let query_str = req.uri().query().map(|q| q.to_string());

    // Read body for API requests
    let body_bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024)
        .await
        .unwrap_or_default();
    let body_str = String::from_utf8_lossy(&body_bytes).to_string();

    let result: serde_json::Value = match (method.as_str(), path.as_str()) {
        ("GET", "/api/spec") => api_spec(&state),
        ("GET", "/api/status") => api_status(&state).await,
        ("GET", "/api/events/poll") => {
            let after: u64 = query_str.as_deref()
                .and_then(|q| q.strip_prefix("after="))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            api_events_poll(&state, after)
        },

        // Generic tool dispatch: POST /api/tools/{name}
        ("POST", p) if p.starts_with("/api/tools/") => {
            let tool_name = p.strip_prefix("/api/tools/").unwrap_or("");
            api_call_tool(&state, tool_name, &body_str).await
        }

        _ => serde_json::json!({"ok": false, "error": "not found"}),
    };

    axum::Json(result).into_response()
}

// ── Generic tool dispatch ────────────────────────────────────

async fn api_call_tool(state: &AppState, tool_name: &str, body: &str) -> serde_json::Value {
    let tool = match state.plugin_registry.find_tool(tool_name) {
        Some(t) => t,
        None => return serde_json::json!({"ok": false, "error": format!("unknown tool: {tool_name}")}),
    };
    let params: serde_json::Value = if body.is_empty() {
        serde_json::json!({})
    } else {
        match serde_json::from_str(body) {
            Ok(v) => v,
            Err(e) => return serde_json::json!({"ok": false, "error": format!("invalid JSON body: {e}")}),
        }
    };
    match tool.handler.call(params).await {
        Ok(result) => serde_json::json!({"ok": true, "result": result}),
        Err(e) => serde_json::json!({"ok": false, "error": e.to_string()}),
    }
}

// ── SSE event stream ─────────────────────────────────────────

/// Adapter: tokio mpsc::Receiver → futures::Stream for axum Body::from_stream
struct MpscStream {
    rx: mpsc::Receiver<Result<Bytes, Infallible>>,
}

impl futures::stream::Stream for MpscStream {
    type Item = Result<Bytes, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

async fn sse_stream(state: Arc<AppState>) -> Response {
    let mut broadcast_rx = state.event_bus.subscribe();
    let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(128);

    tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            match broadcast_rx.recv().await {
                Ok(event) => {
                    // SeqEvent serializes as {"seq":n,"event":{...}}
                    let json = serde_json::to_string(&event).unwrap_or_default();
                    let sse = format!("data: {json}\n\n");
                    if tx.send(Ok(Bytes::from(sse))).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    // Plain data frame so EventSource.onmessage fires; the client
                    // responds by polling once from its last seq to catch up.
                    let msg = format!("data: {{\"lagged\":{n}}}\n\n");
                    let _ = tx.send(Ok(Bytes::from(msg))).await;
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    let body = Body::from_stream(MpscStream { rx });

    let mut resp = built_response(StatusCode::OK, "text/event-stream", body);
    resp.headers_mut().insert(
        axum::http::HeaderName::from_static("cache-control"),
        axum::http::HeaderValue::from_static("no-cache"),
    );
    resp.headers_mut().insert(
        axum::http::HeaderName::from_static("connection"),
        axum::http::HeaderValue::from_static("keep-alive"),
    );
    resp
}

/// SSE stream of raw terminal output (TermOutput JSON frames).
async fn sse_term_stream(state: Arc<AppState>) -> Response {
    let mut term_rx = state.event_bus.subscribe_term_output();
    let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(128);

    tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            match term_rx.recv().await {
                Ok(output) => {
                    // {"session_id":"term-0","data":[104,101,...]}
                    let json = serde_json::to_string(&output).unwrap_or_default();
                    if tx.send(Ok(Bytes::from(format!("data: {json}\n\n")))).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    // Loss-tolerant stream; a lagged frame is ignored client-side
                    // (it has no session_id). Keep the connection alive.
                    let _ = tx.send(Ok(Bytes::from("data: {\"lagged\":true}\n\n"))).await;
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    let body = Body::from_stream(MpscStream { rx });

    let mut resp = built_response(StatusCode::OK, "text/event-stream", body);
    resp.headers_mut().insert(
        axum::http::HeaderName::from_static("cache-control"),
        axum::http::HeaderValue::from_static("no-cache"),
    );
    resp.headers_mut().insert(
        axum::http::HeaderName::from_static("connection"),
        axum::http::HeaderValue::from_static("keep-alive"),
    );
    resp
}

// ── Status ────────────────────────────────────────────────────

async fn api_status(state: &AppState) -> serde_json::Value {
    let serial = state.serial_pool.list_open_ports();
    serde_json::json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "serial_ports": serial,
    })
}

// ── Event polling ───────────────────────────────────────────

fn api_events_poll(state: &AppState, after: u64) -> serde_json::Value {
    let events = state.event_bus.recent(after);
    serde_json::json!({"ok": true, "events": events})
}

// ── Plugin Spec ───────────────────────────────────────────────

fn api_spec(state: &AppState) -> serde_json::Value {
    let plugins: Vec<serde_json::Value> = state.plugin_registry.plugins.iter().map(|p| {
        let nav = p.nav_item();
        let tools: Vec<serde_json::Value> = state.plugin_registry.plugin_tools(p.name()).iter().map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": t.description,
                "schema": t.input_schema,
            })
        }).collect();
        let mut obj = serde_json::json!({
            "name": p.name(),
            "displayName": p.display_name(),
            "description": p.description(),
            "tools": tools,
        });
        if let Some(n) = nav {
            obj["navItem"] = serde_json::json!({
                "id": n.id,
                "icon": n.icon,
                "label": n.label,
                "html": n.html_snippet,
            });
        }
        obj
    }).collect();

    serde_json::json!({"ok": true, "plugins": plugins})
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use vale_command_core::Config;
    use axum::http::Request;

    fn state() -> Arc<AppState> {
        Arc::new(AppState::new(Config::default()))
    }

    fn req(method: &str, path: &str) -> Request<Body> {
        Request::builder().method(method).uri(path).body(Body::empty()).unwrap()
    }

    fn req_with_token(method: &str, path: &str, token: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(path)
            .header("Authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    }

    async fn json_body(resp: Response) -> serde_json::Value {
        let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn spec_lists_terminal_plugin() {
        let resp = handle_request(req("GET", "/api/spec"), state()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["plugins"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn status_ok() {
        let resp = handle_request(req("GET", "/api/status"), state()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn tool_dispatch_headless() {
        // terminal_list through the registry → headless stub → empty array
        let resp = handle_request(
            req_with_token("POST", "/api/tools/terminal_list", ""),
            state(),
        ).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn unknown_tool_reports_error() {
        let resp = handle_request(
            req_with_token("POST", "/api/tools/does_not_exist", ""),
            state(),
        ).await;
        let v = json_body(resp).await;
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("unknown tool"));
    }

    #[tokio::test]
    async fn auth_401_without_token() {
        let mut cfg = Config::default();
        cfg.server.device_token = Some("sekret".into());
        let st = Arc::new(AppState::new(cfg));
        let resp = handle_request(req("GET", "/api/status"), st).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn auth_ok_with_bearer_token() {
        let mut cfg = Config::default();
        cfg.server.device_token = Some("sekret".into());
        let st = Arc::new(AppState::new(cfg));
        let resp = handle_request(req_with_token("GET", "/api/status", "sekret"), st).await;
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn status_page_is_public() {
        // The root page needs no token — it carries no data beyond the version.
        let resp = handle_request(req("GET", "/"), state()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("vale-command"));
    }

    #[tokio::test]
    async fn term_sse_requires_auth() {
        let mut cfg = Config::default();
        cfg.server.device_token = Some("sekret".into());
        let st = Arc::new(AppState::new(cfg));
        let resp = handle_request(req("GET", "/api/events/term"), st).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn term_sse_streams_output() {
        use http_body_util::BodyExt;
        let st = state();
        let resp = handle_request(req("GET", "/api/events/term"), st.clone()).await;
        assert_eq!(resp.status(), StatusCode::OK);

        st.event_bus.emit_term_output(
            serde_json::json!({"session_id": "term-0", "data": [104, 105]}),
        );

        // Read just the first frame — the SSE stream never closes, so the whole
        // body can't be drained with to_bytes.
        let mut body = resp.into_body();
        let frame = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            body.frame(),
        )
        .await
        .expect("SSE frame within timeout")
        .expect("stream produced a frame")
        .expect("frame ok");
        let bytes = frame.into_data().expect("data frame");
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("term-0"), "SSE frame missing session id: {text}");
        assert!(text.starts_with("data: "));
    }
}
