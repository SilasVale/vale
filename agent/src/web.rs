//! HTTP surface served via Tower service (NOT axum route handlers).
//!
//! axum route handlers don't work on cross-compiled Windows. This uses the Tower
//! layer directly — the same layer MCP's StreamableHttpService sits on.
//!
//! Routes:
//!   GET  /                   → minimal status page (no token needed)
//!   GET  /panel, /panel/     → Apple-style terminal panel (token entered in
//!                              the browser, saved to localStorage; no server
//!                              token injection since 1.0.5)
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
use vale_agent_core::EventBus;

/// Minimal self-contained status page — the panel SPA is retired, but the
/// device URL should still answer something readable in a browser. Apple-style
/// light, matching the rest of the Vale surface (2026-08-12).
const STATUS_PAGE: &str = concat!(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>vale-agent</title>",
    "<style>body{background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,'SF Pro Text','PingFang SC','Segoe UI',sans-serif;margin:0;display:flex;justify-content:center;padding:12vh 24px}",
    ".card{background:rgba(255,255,255,.72);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border:1px solid rgba(0,0,0,.08);border-radius:20px;box-shadow:0 12px 32px rgba(0,0,0,.12);padding:32px;max-width:480px;width:100%}",
    ".mark{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;background:#1d1d1f;color:#fff;font-weight:700;font-size:22px}",
    "h1{font-size:22px;margin:14px 0 4px;font-weight:650;letter-spacing:-.01em}",
    "p{color:#6e6e73;font-size:13px;margin:4px 0}",
    "code{background:#e7f5f2;color:#0b7a6e;padding:1px 6px;border-radius:6px;font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:12px}",
    "</style></head>",
    "<body><div class=\"card\"><span class=\"mark\">V</span><h1>vale-agent</h1>",
    "<p>MCP endpoint: <code>/mcp</code></p>",
    "<p>Tool API: <code>/api/tools/{name}</code></p>",
    "<p>Status: <code>/api/status</code></p>",
    "<p>Version: ",
    env!("CARGO_PKG_VERSION"),
    "</p></div></body></html>",
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
            let resp = handle_request(req, state).await;
            // NO global `Access-Control-Allow-Origin: *`. That header is what
            // let any third-party page fetch /panel/ and read the injected
            // device token (the original reason it was removed). Without it,
            // cross-origin JS cannot read panel responses at all; the panel
            // itself is same-origin and needs no CORS. MCP clients (Claude
            // Code) are not browsers and are unaffected.
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

/// Read a query parameter by name, splitting on `&` so it works regardless of
/// position (`?after=5&token=x` — the old strip_prefix("token=") only matched
/// when the param came first).
fn query_param<'a>(query: Option<&'a str>, key: &str) -> Option<&'a str> {
    query?.split('&').find_map(|pair| pair.strip_prefix(key).and_then(|rest| rest.strip_prefix('=')))
}

/// Check the Bearer token (Authorization header only). Static (non-async) so
/// it can be called before the Send boundary. The error is boxed — Response
/// is large and only ever handled at the top of handle_request.
///
/// SECURITY (2026-08-12): the ?token= query param was removed — a cross-site
/// page could send a text/plain POST with the token in the URL (no CORS
/// preflight) and bypass auth. Clients use the Authorization header (the
/// panel fetches SSE with fetch(), which sets headers; nothing used the
/// query param).
fn check_auth(req: &Request<Body>, state: &AppState) -> Result<(), Box<Response>> {
    let Some(ref token) = state.config.server.device_token else {
        return Ok(()); // no auth configured
    };
    let from_header = req.headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if from_header == Some(token.as_str()) {
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

    // Handle CORS preflight — same-origin only (no `*`): the panel fetches
    // same-origin; anything cross-origin is not supposed to call this API.
    if method == Method::OPTIONS {
        let mut resp = built_response(StatusCode::OK, "", Body::empty());
        resp.headers_mut().insert(
            axum::http::HeaderName::from_static("access-control-allow-origin"),
            axum::http::HeaderValue::from_static("null"),
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
    //
    // SECURITY (2026-08-12): the panel previously embedded the device token as
    // window.__PANEL_TOKEN__ for zero-config access. With CORS * on every
    // response, any third-party page could fetch /panel/ and read the token.
    // The token is no longer injected — the user enters it once in the panel
    // (saved to localStorage) instead.
    if method == Method::GET && (path == "/panel" || path == "/panel/") {
        let mut resp = serve_panel_file("index.html", "text/html; charset=utf-8");
        resp.headers_mut().insert(
            axum::http::HeaderName::from_static("cache-control"),
            axum::http::HeaderValue::from_static("no-store"),
        );
        // Zero-config token injection (re-enabled after the CORS * removal
        // above made it safe again): embed the device token as a script
        // fragment before </head>. Cross-origin fetch of this page now can't
        // READ the response (no ACAO header), so the token can't leak to a
        // third-party page. Host is pinned to the device's own domains.
        if let Some(ref token) = state.config.server.device_token {
            // EXACT-match host allowlist. A substring/prefix match here was
            // bypassable — e.g. Host: evil-agent.saisi.online.evil.com matches
            // .contains("agent.saisi.online") and the token is handed to the
            // attacker's page. Only the device's own domains + loopback get it.
            let host_ok = req
                .headers()
                .get(axum::http::header::HOST)
                .and_then(|h| h.to_str().ok())
                .map(|h| {
                    let h = h.trim();
                    h == "127.0.0.1" || h.starts_with("127.0.0.1:")
                        || h == "localhost" || h.starts_with("localhost:")
                        || h == "agent.saisi.online" || h.ends_with(".agent.saisi.online")
                })
                .unwrap_or(false);
            if host_ok {
                let inject = format!("<script>window.__PANEL_TOKEN__={token:?};</script>");
                let html = include_str!("../resources/panel/index.html")
                    .replacen("</head>", &format!("{inject}</head>"), 1);
                let mut resp2 = built_response(StatusCode::OK, "text/html; charset=utf-8", Body::from(html));
                resp2.headers_mut().insert(
                    axum::http::HeaderName::from_static("cache-control"),
                    axum::http::HeaderValue::from_static("no-store"),
                );
                return resp2;
            }
        }
        return resp;
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
            let after: u64 = query_param(query_str.as_deref(), "after")
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

/// Build a text/event-stream response from a broadcast receiver. The
/// `encode` closure turns a received item into a `data:` frame; `lagged`
/// provides the fallback frame when the receiver falls behind (loss-tolerant
/// stream — the client catches up by polling from its last seq).
async fn sse_response<T>(
    mut rx: tokio::sync::broadcast::Receiver<T>,
    encode: impl Fn(&T) -> String + Send + 'static,
    lagged: impl Fn(u64) -> String + Send + 'static,
) -> Response
where
    T: Clone + Send + 'static,
{
    let (tx, mpsc_rx) = mpsc::channel::<Result<Bytes, Infallible>>(128);

    tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            match rx.recv().await {
                Ok(item) => {
                    if tx.send(Ok(Bytes::from(encode(&item)))).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    // Client gone: stop like the Ok branch, or this task keeps
                    // the broadcast subscription and a failing send forever.
                    if tx.send(Ok(Bytes::from(lagged(n)))).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    let body = Body::from_stream(MpscStream { rx: mpsc_rx });

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

async fn sse_stream(state: Arc<AppState>) -> Response {
    let rx = state.event_bus.subscribe();
    // SeqEvent serializes as {"seq":n,"event":{...}}
    let encode = |event: &vale_agent_core::events::SeqEvent| format!("data: {}\n\n", serde_json::to_string(event).unwrap_or_default());
    // Plain data frame so EventSource.onmessage fires; the client responds by
    // polling once from its last seq to catch up.
    let lagged = |n: u64| format!("data: {{\"lagged\":{n}}}\n\n");
    sse_response(rx, encode, lagged).await
}

/// SSE stream of raw terminal output (TermOutput JSON frames).
async fn sse_term_stream(state: Arc<AppState>) -> Response {
    let rx = state.event_bus.subscribe_term_output();
    // {"session_id":"term-0","data":[104,101,...]}
    let encode = |output: &serde_json::Value| format!("data: {}\n\n", serde_json::to_string(output).unwrap_or_default());
    // Loss-tolerant stream; a lagged frame is ignored client-side (it has no
    // session_id). Keep the connection alive.
    let lagged = |_n: u64| "data: {\"lagged\":true}\n\n".to_string();
    sse_response(rx, encode, lagged).await
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
    // last_seq lets the panel advance its cursor even when no events match —
    // without it the panel's lastSeq stays 0 and every poll re-fetches the
    // whole ring (resurrecting closed sessions every 2s).
    serde_json::json!({"ok": true, "events": events, "last_seq": state.event_bus.last_seq()})
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
    use vale_agent_core::Config;
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
        // terminal + update plugins
        assert_eq!(v["plugins"].as_array().unwrap().len(), 2);
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
        assert!(text.contains("vale-agent"));
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
