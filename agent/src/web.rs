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
use vale_agent_core::{Config, EventBus};

/// Minimal self-contained status page — the panel SPA is retired, but the
/// device URL should still answer something readable in a browser. Apple-style
/// light, matching the rest of the Vale surface (2026-08-12).
const STATUS_PAGE: &str = concat!(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>vale-agent</title>",
    "<style>body{background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,'SF Pro Text','PingFang SC','Segoe UI',sans-serif;margin:0;display:flex;justify-content:center;padding:12vh 24px}",
    ".card{background:rgba(255,255,255,.72);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border:1px solid rgba(0,0,0,.08);border-radius:20px;box-shadow:0 12px 32px rgba(0,0,0,.12);padding:32px;max-width:480px;width:100%}",
    ".mark{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:10px;background:#1d1d1f;color:#fff;font-weight:700;font-size:22px}",
    "h1{font-size:22px;margin:14px 0 4px;font-weight:650;letter-spacing:-.01em}",
    "p{color:#6e6e73;font-size:13px;margin:4px 0}",
    "code{background:#e7f5f2;color:#0b7a6e;padding:1px 6px;border-radius:5px;font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:12px}",
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
    // round-116: constant-time compare — the device token is the ONLY gate
    // between an unauthenticated network caller and SYSTEM-level device
    // control; a short-circuiting == leaks the match position via timing
    // (low practical value at 64 hex chars, but the proxy-secret compare in
    // this same file already sets the precedent).
    if from_header.is_some_and(|h| timing_safe_eq(h.as_bytes(), token.as_bytes())) {
        return Ok(());
    }
    Err(Box::new(built_response(
        StatusCode::UNAUTHORIZED,
        "application/json",
        Body::from(r#"{"ok":false,"error":"unauthorized"}"#),
    )))
}

/// Constant-time byte compare — the device token is compared at every
/// /api/* gate; a short-circuiting == leaks the match position via timing
/// (round-116; the proxy-secret check below already used this shape).
fn timing_safe_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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
            .is_some_and(|h| timing_safe_eq(h.as_bytes(), token.as_bytes()));
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

    // Auth decision extracted synchronously (before the Send boundary).
    // NOTE: no CORS preflight handler — the panel is same-origin (never
    // preflights); cross-origin calls must NOT be allowed, and the gateway
    // proxy adds its own ACAO when required. (The old handler advertised
    // ACAO:null that real responses never granted — dead + misleading.)
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
        // Zero-config token injection: embed the device token as a script
        // fragment before </head>. round-102/103: injection requires the
        // gateway proxy's SHARED SECRET (X-Vale-Auth) — a plain marker
        // header was client-spoofable end-to-end (any curl could set it and
        // read the token; the leaked token grants /api/tools RCE). The
        // secret is generated at agent bootstrap and read by the console;
        // the gateway proxy sends it only for authenticated (admin session
        // or plugin link) requests. Localhost/loopback keeps working for
        // on-device use.
        let secret = state.config.server.proxy_secret.as_deref().unwrap_or("");
        // round-104: an EMPTY/absent configured secret must never match — the
        // old gate accepted an empty header when the secret was "" (quarantine
        // recovery / pre-secret boot), which is exactly the fail-open RCE.
        let via_proxy = !secret.is_empty()
            && req
                .headers()
                .get("x-vale-auth")
                .and_then(|v| v.to_str().ok())
                .map(|v| {
                    // Constant-time compare (timing-safe for a 64-hex secret).
                    let a = v.as_bytes();
                    let b = secret.as_bytes();
                    a.len() == b.len() && a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
                })
                .unwrap_or(false);
        if let Some(ref token) = state.config.server.device_token {
            // EXACT host allowlist. A substring/prefix match here was
            // bypassable — e.g. Host: evil-agent.saisi.online.evil.com matches
            // .contains("agent.saisi.online") and the token is handed to the
            // attacker's page. Only the device's own single-level subdomain
            // (dN.agent.saisi.online — a multi-level attacker subdomain like
            // evil.agent.saisi.online is REJECTED), the apex, or loopback.
            // NOTE: d1.agent.saisi.online has THREE dots — an earlier
            // "count() == 2" check made the subdomain branch unsatisfiable and
            // silently killed token injection for real devices (round-19).
            let host_ok = req
                .headers()
                .get(axum::http::header::HOST)
                .and_then(|h| h.to_str().ok())
                .map(|h| {
                    let h = h.trim();
                    let host = h.split(':').next().unwrap_or(h); // strip :port
                    host == "127.0.0.1" || host == "localhost"
                        || host == "agent.saisi.online"
                        || (host.ends_with(".agent.saisi.online")
                            && host.matches('.').count() == 3
                            && host.split('.').next().map(|d| d.starts_with("d")).unwrap_or(false))
                })
                .unwrap_or(false);
            // round-102: token injection only via the gateway proxy OR
            // loopback — a public direct request must NOT receive the token.
            let loopback = req
                .headers()
                .get(axum::http::header::HOST)
                .and_then(|h| h.to_str().ok())
                .map(|h| {
                    let host = h.trim().split(':').next().unwrap_or(h.trim());
                    host == "127.0.0.1" || host == "localhost"
                })
                .unwrap_or(false);
            if host_ok && (via_proxy || loopback) {
                // serde_json escapes quotes but NOT < > (no escape_html
                // feature), so a non-hex token containing </script> could
                // break out of the script element and run attacker JS on the
                // device origin. Escape < > manually.
                let escaped = serde_json::to_string(token)
                    .unwrap_or_else(|_| "\"\"".into())
                    .replace('<', "\\u003c")
                    .replace('>', "\\u003e");
                let inject = format!("<script>window.__PANEL_TOKEN__={escaped};</script>");
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

    // Read body for API requests. >1MB must FAIL LOUDLY, not degrade to an
    // empty body — the old unwrap_or_default() turned an oversized
    // terminal_execute/write into a "successful" call that ran NOTHING
    // (silent data loss; round-59). The gateway's ok/data.ok double-check
    // turns this 413 into a stable error code downstream.
    let body_bytes = match axum::body::to_bytes(req.into_body(), 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            // Distinguish a genuine size violation from a transport error
            // (client dropped mid-body) — both were lumped into 413 +
            // "exceeds limit", lying about a disconnect (round-60).
            // axum::Error is a boxed error; walk the source chain for the
            // LengthLimitError marker (its Display is "length limit exceeded").
            let mut too_large = false;
            let mut src: Option<&(dyn std::error::Error + 'static)> = Some(&e);
            while let Some(s) = src {
                if s.to_string().contains("length limit") {
                    too_large = true;
                    break;
                }
                src = s.source();
            }
            let (status, code, msg) = if too_large {
                (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large", "request body exceeds 1 MB limit")
            } else {
                (StatusCode::BAD_REQUEST, "body_read_error", "failed to read request body")
            };
            return built_response(
                status,
                "application/json",
                Body::from(serde_json::json!({
                    "ok": false,
                    "error": msg,
                    "code": code,
                }).to_string()),
            );
        }
    };
    let body_str = String::from_utf8_lossy(&body_bytes).to_string();

    let result: serde_json::Value = match (method.as_str(), path.as_str()) {
        ("GET", "/api/spec") => api_spec(&state),
        ("GET", "/api/status") => api_status(&state).await,
        // Audit trail: session list with terminal state (round-56). The
        // logger lives in the terminal plugin's private field — read the
        // same directory directly (cheap: one file per session).
        ("GET", "/api/sessions") => {
            let dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                .unwrap_or_default()
                .join("sessions");
            let logger = crate::session_log::SessionLogger::new(dir);
            let list: serde_json::Value = logger.list_sessions().iter().map(|(sid, state)| {
                serde_json::json!({ "id": sid, "state": state })
            }).collect();
            serde_json::json!({ "ok": true, "sessions": list })
        },
        // Full audit events for one session (round-68): events_of() existed
        // for /api/sessions but no endpoint called it — the durable audit
        // corpus was write-only, unqueryable by the panel or MCP. This reads
        // the session's jsonl (permanent, survives agent restarts).
        ("GET", p) if p.starts_with("/api/sessions/") && p.len() > "/api/sessions/".len() => {
            // round-87: the old literal "/api/sessions/{sid}" arm never
            // matched a real session id (exact-string match) — the audit
            // endpoint 404'd for every session. Guard-arm route.
            let sid = p.strip_prefix("/api/sessions/")
                .and_then(|s| s.split('/').next())
                .unwrap_or("")
                .to_string();
            // round-116: the sid flows into a FILE PATH (events_of →
            // {dir}/{sid}.jsonl). The forward-slash split alone let a
            // backslash (0x5C, accepted in the request-target by the http
            // crate) traverse on Windows: /api/sessions/..%5C..%5Cfoo read
            // {dir}/../../foo.jsonl. Restrict to the session-id charset —
            // session ids are hex (sid per-boot unique), so anything else is
            // not a valid session anyway.
            if !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return built_response(StatusCode::BAD_REQUEST, "application/json", Body::from(r#"{"ok":false,"error":"invalid session id"}"#));
            }
            let dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                .unwrap_or_default()
                .join("sessions");
            let logger = crate::session_log::SessionLogger::new(dir);
            let events = logger.events_of(&sid);
            serde_json::json!({ "ok": true, "id": sid, "events": events })
        },
        // Read the tray's vale-update.log (promised by the tray's doc comment
        // but never implemented) — lets a remote client see auto-update
        // failures instead of asking the user to open files.
        ("GET", "/api/logs") => {
            let dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                .unwrap_or_default();
            let log = dir.join("vale-update.log");
            let text = std::fs::read_to_string(&log).unwrap_or_else(|_| String::new());
            serde_json::json!({"ok": true, "log": text.chars().rev().take(64 * 1024).collect::<String>().chars().rev().collect::<String>()})
        }
        ("GET", "/api/events/poll") => {
            let after: u64 = query_param(query_str.as_deref(), "after")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            api_events_poll(&state, after)
        },

        // Settings: read / write the runtime-configurable values (round-69).
        // buffer_mb is the per-session output buffer cap — the panel's
        // settings writes it here; it takes effect for NEW output (existing
        // buffers keep their size), persists to config.yaml, survives restarts.
        ("GET", "/api/settings") => {
            serde_json::json!({
                "ok": true,
                "buffer_mb": state.terminal_buf_bytes.load(std::sync::atomic::Ordering::Relaxed) / (1024 * 1024),
            })
        }
        ("PUT", "/api/settings") => {
            let v: serde_json::Value = match serde_json::from_str(&body_str) {
                Ok(v) => v,
                Err(e) => return axum::Json(serde_json::json!({
                    "ok": false, "error": format!("invalid JSON: {e}"), "code": "invalid_params",
                })).into_response(),
            };
            let Some(mb) = v.get("buffer_mb").and_then(|b| b.as_u64()) else {
                return axum::Json(serde_json::json!({
                    "ok": false, "error": "buffer_mb required", "code": "invalid_params",
                })).into_response();
            };
            let mb = mb.clamp(1, 64) as usize;
            state.terminal_buf_bytes.store(mb * 1024 * 1024, std::sync::atomic::Ordering::Relaxed);
            // Persist to the ACTUALLY-LOADED config path (round-101: the old
            // hardcoded exe_dir/config.yaml silently reverted on restart for
            // dev/custom invocations — main.rs sets state.config_path from
            // argv[1]). Atomic write, same as bootstrap. Best-effort: a
            // read-only install dir must not fail the PUT — the runtime
            // value already took effect.
            let cfg_path = state.config_path.lock().unwrap_or_else(|p| p.into_inner()).clone().unwrap_or_else(|| {
                std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                    .unwrap_or_default()
                    .join("config.yaml")
            });
            if let Ok(mut cfg) = Config::load(&cfg_path) {
                cfg.terminal.buffer_mb = mb as u32;
                if let Ok(yaml) = serde_yaml::to_string(&cfg) {
                    let _ = crate::bootstrap::atomic_write(&cfg_path, yaml.as_bytes());
                }
            }
            serde_json::json!({ "ok": true, "buffer_mb": mb })
        }

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
        None => return serde_json::json!({"ok": false, "error": format!("unknown tool: {tool_name}"), "code": "invalid_params"}),
    };
    let params: serde_json::Value = if body.is_empty() {
        serde_json::json!({})
    } else {
        match serde_json::from_str(body) {
            Ok(v) => v,
            Err(e) => return serde_json::json!({"ok": false, "error": format!("invalid JSON body: {e}"), "code": "invalid_params"}),
        }
    };
    match tool.handler.call(params).await {
        Ok(result) => serde_json::json!({"ok": true, "result": result}),
        Err(e) => serde_json::json!({"ok": false, "error": e.to_string(), "code": e.code()}),
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
            // Heartbeat: an idle stream emitted zero bytes while declaring
            // keep-alive, so a silently-dropped connection was never detected
            // and a reconnect missed every event during the outage. Send a
            // comment frame every 30s of silence — it keeps the socket alive
            // AND makes the client's read loop detect a dead connection.
            // The mpsc is bounded (128); a client that stopped reading fills
            // it and tx.send blocks FOREVER (leak: the task + broadcast
            // subscription survive a silently-dead client). Bound each send
            // at 5s — a full channel means the client is gone.
            let send_bounded = async |bytes: Bytes| {
                tokio::time::timeout(std::time::Duration::from_secs(5), tx.send(Ok(bytes))).await
                    .map(|r| r.is_err())
                    .unwrap_or(true)
            };
            match tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv()).await {
                Ok(Ok(item)) => {
                    if send_bounded(Bytes::from(encode(&item))).await { break; }
                }
                Ok(Err(RecvError::Lagged(n))) => {
                    // Client gone: stop like the Ok branch, or this task keeps
                    // the broadcast subscription and a failing send forever.
                    if send_bounded(Bytes::from(lagged(n))).await { break; }
                }
                Ok(Err(RecvError::Closed)) => break,
                Err(_) => {
                    // 30s of silence — heartbeat.
                    if send_bounded(Bytes::from(": ping\n\n")).await { break; }
                }
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
    // SeqEvent serializes as {"seq":n,"event":{...}}. The `v` field is a
    // protocol version anchor (round-54): clients ignore unknown fields, so
    // this is purely a diagnostic marker — a future agent/client that needs
    // to detect version drift can do so instead of silently mis-parsing.
    let encode = |event: &vale_agent_core::events::SeqEvent| {
        let mut obj = serde_json::to_value(event).unwrap_or_default();
        if let Some(o) = obj.as_object_mut() { o.insert("v".into(), serde_json::json!(1)); }
        format!("data: {}\n\n", obj)
    };
    // Plain data frame so EventSource.onmessage fires; the client responds by
    // polling once from its last seq to catch up.
    let lagged = |n: u64| format!("data: {{\"v\":1,\"lagged\":{n}}}\n\n");
    sse_response(rx, encode, lagged).await
}

/// SSE stream of raw terminal output (TermOutput JSON frames).
async fn sse_term_stream(state: Arc<AppState>) -> Response {
    use tokio::sync::broadcast::error::RecvError;
    use tokio::sync::mpsc;
    let mut rx = state.event_bus.subscribe_term_output();
    // {"v":1,"session_id":"term-0","data":[104,101,...]} — the v field is a
    // protocol version anchor (round-54), same semantics as /api/events.
    let encode = |output: &serde_json::Value| {
        let mut obj = output.clone();
        if let Some(o) = obj.as_object_mut() { o.insert("v".into(), serde_json::json!(1)); }
        format!("data: {}\n\n", serde_json::to_string(&obj).unwrap_or_default())
    };
    // Loss-tolerant stream; a lagged frame is ignored client-side (it has no
    // session_id). Keep the connection alive.
    let lagged = |_n: u64| "data: {\"v\":1,\"lagged\":true}\n\n".to_string();

    let (tx, mpsc_rx) = mpsc::channel::<Result<Bytes, Infallible>>(128);
    tokio::spawn(async move {
        // Dead-client detection only — NO session keepalive here. The panel's
        // 30s terminal_select heartbeat (panel.js) already touches every live
        // session it watches; touching ALL sessions from the SSE tick
        // disabled the idle sweeper for the whole device while ANY tab was
        // open (round-49: an orphaned MCP ssh to prod was never reaped while
        // a panel tab sat open) and stamped every last_output equal, breaking
        // the eviction tiebreak. The 60s ping below only keeps the
        // connection alive (a closed tab → send fails → loop breaks).
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            let send_bounded = async |bytes: Bytes| {
                tokio::time::timeout(std::time::Duration::from_secs(5), tx.send(Ok(bytes))).await
                    .map(|r| r.is_err())
                    .unwrap_or(true)
            };
            tokio::select! {
                _ = tick.tick() => {
                    // Heartbeat byte — dead-client detection depends on a
                    // send failing (the 5s bounded send into the full mpsc).
                    if send_bounded(Bytes::from(": ping\n\n")).await { break; }
                }
                msg = rx.recv() => {
                    match msg {
                        Ok(item) => {
                            if send_bounded(Bytes::from(encode(&item))).await { break; }
                        }
                        Err(RecvError::Lagged(n)) => {
                            if send_bounded(Bytes::from(lagged(n))).await { break; }
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
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

// ── Status ────────────────────────────────────────────────────

async fn api_status(state: &AppState) -> serde_json::Value {
    let serial = state.serial_pool.list_open_ports();
    let mut out = serde_json::json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "serial_ports": serial,
    });
    // round-103: expose the proxy secret (token-authenticated endpoint) so
    // the console can store it at registration and present X-Vale-Auth when
    // proxying /panel/ — the agent injects the panel token only for
    // requests carrying the matching secret.
    if let Some(sec) = state.config.server.proxy_secret.as_deref() {
        out["proxy_secret"] = serde_json::json!(sec);
    }
    out
}

// ── Event polling ───────────────────────────────────────────

fn api_events_poll(state: &AppState, after: u64) -> serde_json::Value {
    // Atomic snapshot: events + first/last seq under ONE lock — three
    // separate calls could see different snapshots and skip an event forever.
    let (events, first_seq, last_seq) = state.event_bus.poll_after(after);
    serde_json::json!({"ok": true, "events": events, "first_seq": first_seq, "last_seq": last_seq, "epoch": state.event_bus.epoch()})
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

    fn req_with_host(path: &str, host: &str) -> Request<Body> {
        // round-102: token injection requires the gateway-proxy marker (or
        // loopback) — the inject cases set it, the must-NOT-inject cases
        // (direct public access) don't.
        req_with_host_proxy(path, host, false)
    }
    fn req_with_host_proxy(path: &str, host: &str, via_proxy: bool) -> Request<Body> {
        let mut b = Request::builder().method("GET").uri(path).header(axum::http::header::HOST, host);
        if via_proxy { b = b.header("x-vale-proxy", "1"); }
        b.body(Body::empty()).unwrap()
    }
    fn req_with_host_secret(path: &str, host: &str) -> Request<Body> {
        Request::builder()
            .method("GET")
            .uri(path)
            .header(axum::http::header::HOST, host)
            .header("x-vale-auth", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
            .body(Body::empty())
            .unwrap()
    }
    fn req_with_host_secret_wrong(path: &str, host: &str) -> Request<Body> {
        Request::builder()
            .method("GET")
            .uri(path)
            .header(axum::http::header::HOST, host)
            .header("x-vale-auth", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn panel_token_injection_host_gate() {
        let mut cfg = Config::default();
        cfg.server.device_token = Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".into());
        cfg.server.proxy_secret = Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".into());
        let st = Arc::new(AppState::new(cfg));
        // The device's own subdomain MUST inject when the request carries
        // the gateway's shared secret (X-Vale-Auth, round-103 — a spoofable
        // marker header was replaced with a constant-time secret check).
        let ok = handle_request(req_with_host_secret("/panel/", "d1.agent.saisi.online"), st.clone()).await;
        let body = axum::body::to_bytes(ok.into_body(), 1 << 20).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("window.__PANEL_TOKEN__"), "device host with secret must inject");

        // Direct (no secret) on the device host MUST NOT inject — an
        // attacker hitting the enumerable public hostname gets no token.
        let direct = handle_request(req_with_host("/panel/", "d1.agent.saisi.online"), st.clone()).await;
        let bd = axum::body::to_bytes(direct.into_body(), 1 << 20).await.unwrap();
        assert!(!String::from_utf8_lossy(&bd).contains("window.__PANEL_TOKEN__"), "direct device access must NOT inject (RCE)");

        // A spoofed WRONG secret must not inject either.
        let wrong = handle_request(req_with_host_secret_wrong("/panel/", "d1.agent.saisi.online"), st.clone()).await;
        let bw = axum::body::to_bytes(wrong.into_body(), 1 << 20).await.unwrap();
        assert!(!String::from_utf8_lossy(&bw).contains("window.__PANEL_TOKEN__"), "wrong secret must NOT inject");

        // Apex with secret + loopback inject.
        let apex = handle_request(req_with_host_secret("/panel/", "agent.saisi.online"), st.clone()).await;
        let ba = axum::body::to_bytes(apex.into_body(), 1 << 20).await.unwrap();
        assert!(String::from_utf8_lossy(&ba).contains("window.__PANEL_TOKEN__"), "apex with secret must inject");
        for h in ["127.0.0.1:18080", "localhost"] {
            let r = handle_request(req_with_host("/panel/", h), st.clone()).await;
            let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
            assert!(String::from_utf8_lossy(&b).contains("window.__PANEL_TOKEN__"), "{h} must inject");
        }

        // Multi-level attacker subdomain + suffix-spoof MUST NOT inject.
        for h in ["evil.agent.saisi.online", "agent.saisi.online.evil.com", "evil.com", "d1.agent.saisi.online.evil.com"] {
            let r = handle_request(req_with_host("/panel/", h), st.clone()).await;
            let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
            assert!(!String::from_utf8_lossy(&b).contains("window.__PANEL_TOKEN__"), "{h} must NOT inject");
        }
    }

    #[tokio::test]
    async fn panel_token_injection_escapes_script_close() {
        // A non-hex token containing </script> must be escaped, not raw.
        let mut cfg = Config::default();
        cfg.server.device_token = Some("abc</script><script>alert(1)</script>xyz".into());
        let st = Arc::new(AppState::new(cfg));
        let r = handle_request(req_with_host("/panel/", "127.0.0.1:18080"), st).await;
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        let html = String::from_utf8_lossy(&b);
        assert!(html.contains("\\u003c/script\\u003e"), "must escape </script>: {html}");
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
        // terminal + update + mcp-client + design + playwright plugins
        assert_eq!(v["plugins"].as_array().unwrap().len(), 5);
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
        assert_eq!(v["code"], "invalid_params");
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
