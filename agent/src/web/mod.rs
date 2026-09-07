//! HTTP surface served via Tower service (NOT axum route handlers).
//!
//! axum route handlers don't work on cross-compiled Windows. This uses the Tower
//! layer directly — the same layer MCP's StreamableHttpService sits on.
//!
//! Routes:
//!   GET  /                   → minimal status page (no token needed)
//!   GET  /panel, /panel/     → Apple-style terminal panel (token entered in
//!                              the browser, saved to localStorage; no server
//!                              token injection since 1.0.5 — back via
//!                              loopback / gateway-proxy secret / one-time
//!                              panel grant ?grant=, redeemed at the gateway)
//!   GET  /api/events         → SSE event stream
//!   GET  /api/events/poll    → poll events (?after=N)
//!   GET  /api/events/term    → SSE terminal byte stream (TermOutput JSON frames)
//!   GET  /api/status         → system status
//!   GET  /api/spec           → plugin spec
//!   GET  /api/plugins/status → plugin status (playwright-mcp running state)
//!   POST /api/plugins/playwright/start|stop → start/stop playwright-mcp
//!   POST /api/tools/{name}   → generic tool dispatch via PluginRegistry
//!   /mcp (via TokenGate)     → rmcp streamable HTTP server

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tower::Service;

use crate::plugins::memory::store::MemoryLimits;
use crate::state::AppState;
use vale_agent_core::EventBus;
mod panel;
mod sse;

pub use panel::WebPanel;
pub(crate) use panel::{
    panel_content_type, panel_token_response, plausible_grant, redeem_panel_grant, serve_panel_file,
};
pub(crate) use sse::{sse_stream, sse_term_stream, SseConnectionGuard};

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
    "code{background:#ffefe5;color:#d9480f;padding:1px 6px;border-radius:5px;font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:12px}",
    "</style></head>",
    "<body><div class=\"card\"><span class=\"mark\">V</span><h1>vale-agent</h1>",
    "<p>MCP endpoint: <code>/mcp</code></p>",
    "<p>Tool API: <code>/api/tools/{name}</code></p>",
    "<p>Status: <code>/api/status</code></p>",
    "<p>Version: ",
    env!("CARGO_PKG_VERSION"),
    "</p></div></body></html>",
);

/// Build a response with a fallback that can't panic — the builder only fails
/// on invalid status/header constants, which ours never are.
pub(super) fn built_response(
    status: StatusCode,
    content_type: &'static str,
    body: Body,
) -> Response {
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
pub(super) fn query_param<'a>(query: Option<&'a str>, key: &str) -> Option<&'a str> {
    query?.split('&').find_map(|pair| {
        pair.strip_prefix(key)
            .and_then(|rest| rest.strip_prefix('='))
    })
}

/// Host header value without its `:port` suffix (trimmed) — shared by the
/// token-injection host allowlist and the loopback check below (the same
/// trim + strip-:port dance was duplicated at both sites).
pub(super) fn host_no_port(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(|h| h.trim().split(':').next().unwrap_or(h.trim())) // strip :port
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
    // Write-through (audit A4): the token comes from the LIVE snapshot, not
    // a boot-time copy — a token rotated via config mutations is visible
    // immediately, without a restart.
    let cfg = state.config_snapshot();
    let Some(ref token) = cfg.server.device_token else {
        // Fail CLOSED: bootstrap guarantees a token on every serving boot
        // (generates + persists fresh installs, recovers quarantined ones,
        // exits when randomness is unavailable) — a missing token here can
        // only come from a hand-built Config, which must never serve
        // unauthenticated RCE routes to the network.
        return Err(Box::new(built_response(
            StatusCode::UNAUTHORIZED,
            "application/json",
            Body::from(r#"{"ok":false,"error":"unauthorized"}"#),
        )));
    };
    let from_header = req
        .headers()
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
    a.len() == b.len()
        && a.iter()
            .zip(b.iter())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

// ── Token gate for the MCP route ─────────────────────────────

/// Wraps any Tower service with the same bearer-token check as the API.
/// The MCP endpoint is as sensitive as the API (it drives terminals), so it
/// is never reachable without the token. rmcp has no server-side auth hook,
/// so the check happens here.
///
/// Round-366: reads the token from the LIVE config snapshot per request —
/// like check_auth above — instead of a boot-time clone. The token is
/// minted pre-serve and no production path rotates it today, but a clone
/// would silently split /api vs /mcp auth the day one does (stale-accept
/// the old token on /mcp while rejecting the new one).
#[derive(Clone)]
pub struct TokenGate<S> {
    inner: S,
    state: Arc<AppState>,
}

impl<S> TokenGate<S> {
    pub fn new(inner: S, state: Arc<AppState>) -> Self {
        Self { inner, state }
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
        // Live snapshot (see struct docs): a runtime token rotation takes
        // effect on /mcp immediately, exactly like /api/*. Fail closed when
        // no token is configured, mirroring check_auth above.
        let token = self.state.config_snapshot().server.device_token;
        let Some(token) = token else {
            return Box::pin(async { Ok(unauthorized_mcp_response()) });
        };
        let authorized = req
            .headers()
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

pub(super) async fn handle_request(req: Request<Body>, state: Arc<AppState>) -> Response {
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
        if let Err(resp) = check_auth(&req, &state) {
            return *resp;
        }
        // stage-n SSE audit LOW: bound concurrent SSE connections so a flood
        // of viewers can't exhaust tasks/memory. Reserve a slot; if full, 503.
        let _guard = match SseConnectionGuard::acquire() {
            Some(g) => g,
            None => {
                return built_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "text/plain",
                    Body::from("too many SSE viewers (max 64)"),
                )
            }
        };
        return sse_stream(state).await;
    }

    // SSE terminal byte stream — streamed TermOutput JSON frames.
    if method == Method::GET && path == "/api/events/term" {
        if let Err(resp) = check_auth(&req, &state) {
            return *resp;
        }
        let _guard = match SseConnectionGuard::acquire() {
            Some(g) => g,
            None => {
                return built_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "text/plain",
                    Body::from("too many SSE viewers (max 64)"),
                )
            }
        };
        return sse_term_stream(state).await;
    }

    // round-152: AI browser evidence stream — list + fetch screenshots from
    // the pwout dir (browser_run_script & playwright scripts drop screenshots
    // here). The panel polls pwshots and shows new PNGs as the AI works,
    // so a human can see what the AI did without any live frame stream.
    if method == Method::GET
        && (path == "/api/browser/pwshots"
            || path == "/api/browser/pwshot"
            || path == "/api/browser/actions")
    {
        if let Err(resp) = check_auth(&req, &state) {
            return *resp;
        }
        // Surface audit D#2 (one-browser round): the READ side resolved
        // current_exe()'s parent while the WRITE side (playwright tools)
        // uses the registry install_dir() — the exact 1.2.219 /api/sessions
        // blindness pattern. Same source of truth now.
        let pwout = crate::paths::install_dir().join("pwout");
        // P2: AI-action timeline — the JSONL written by browser_run_script
        // (one line per execution). Return newest-first, capped at 50.
        if path == "/api/browser/actions" {
            let mut actions: Vec<serde_json::Value> = Vec::new();
            if let Ok(contents) = std::fs::read_to_string(pwout.join("actions.jsonl")) {
                for line in contents.lines().rev().take(50) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        actions.push(v);
                    }
                }
            }
            return built_response(
                StatusCode::OK,
                "application/json",
                Body::from(serde_json::json!({"actions": actions}).to_string()),
            );
        }
        if path == "/api/browser/pwshots" {
            let mut shots: Vec<serde_json::Value> = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&pwout) {
                for e in rd.filter_map(|e| e.ok()) {
                    let name = e.file_name().to_string_lossy().to_string();
                    if !name.ends_with(".png") {
                        continue;
                    }
                    let meta = e.metadata().ok();
                    let mtime_ms = meta
                        .as_ref()
                        .and_then(|m| m.modified().ok())
                        .map(|t| {
                            t.duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis())
                                .unwrap_or(0)
                        })
                        .unwrap_or(0);
                    shots.push(serde_json::json!({
                        "name": name,
                        "mtime_ms": mtime_ms,
                        "size": meta.map(|m| m.len()).unwrap_or(0),
                    }));
                }
            }
            shots.sort_by(|a, b| b["mtime_ms"].as_u64().cmp(&a["mtime_ms"].as_u64()));
            shots.truncate(40);
            return built_response(
                StatusCode::OK,
                "application/json",
                Body::from(serde_json::json!({"shots": shots}).to_string()),
            );
        }
        // /api/browser/pwshot?name=xxx — serve one screenshot (basename only)
        let name = query_param(req.uri().query(), "name").unwrap_or("");
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
            return built_response(
                StatusCode::BAD_REQUEST,
                "text/plain",
                Body::from("bad name"),
            );
        }
        return match std::fs::read(pwout.join(name)) {
            Ok(bytes) => {
                let mut resp = built_response(StatusCode::OK, "image/png", Body::from(bytes));
                resp.headers_mut().insert(
                    axum::http::HeaderName::from_static("cache-control"),
                    axum::http::HeaderValue::from_static("no-store"),
                );
                resp
            }
            Err(_) => built_response(
                StatusCode::NOT_FOUND,
                "text/plain",
                Body::from("no such shot"),
            ),
        };
    }

    // round-137 Plan C: interactive-browser WebSocket relay. MUST sit before
    // Terminal panel + desktop shell (static SPA, public like the status page
    // — it shows no data until the user enters the device token). Assets are
    // embedded at compile time from resources/panel/. /desktop/ is the
    // vale-desktop-electron (Electron) full-screen shell; the SPA switches on
    // the path.
    //
    // SECURITY (2026-08-12): the panel previously embedded the device token as
    // window.__PANEL_TOKEN__ for zero-config access. With CORS * on every
    // response, any third-party page could fetch /panel/ and read the token.
    // The token is no longer injected — the user enters it once in the panel
    // (saved to localStorage) instead.
    if method == Method::GET
        && (path == "/panel" || path == "/panel/" || path == "/desktop" || path == "/desktop/")
    {
        // Write-through (audit A4): one snapshot of the LIVE config for the
        // whole injection decision (proxy_secret + device_token below).
        let cfg = state.config_snapshot();
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
        let secret = cfg.server.proxy_secret.as_deref().unwrap_or("");
        // round-104: an EMPTY/absent configured secret must never match — the
        // old gate accepted an empty header when the secret was "" (quarantine
        // recovery / pre-secret boot), which is exactly the fail-open RCE.
        let via_proxy = !secret.is_empty()
            && req
                .headers()
                .get("x-vale-auth")
                .and_then(|v| v.to_str().ok())
                // Constant-time compare (timing-safe for a 64-hex secret).
                .map(|v| timing_safe_eq(v.as_bytes(), secret.as_bytes()))
                .unwrap_or(false);
        if let Some(ref token) = cfg.server.device_token {
            // EXACT host allowlist. A substring/prefix match here was
            // bypassable — e.g. Host: evil-agent.saisi.online.evil.com matches
            // .contains("agent.saisi.online") and the token is handed to the
            // attacker's page. Only the device's own single-level subdomain
            // (dN.agent.saisi.online — a multi-level attacker subdomain like
            // evil.agent.saisi.online is REJECTED), the apex, or loopback.
            // NOTE: d1.agent.saisi.online has THREE dots — an earlier
            // "count() == 2" check made the subdomain branch unsatisfiable and
            // silently killed token injection for real devices (round-19).
            let host_ok = host_no_port(req.headers())
                .map(|host| {
                    host == "127.0.0.1"
                        || host == "localhost"
                        || host == "agent.saisi.online"
                        || (host.ends_with(".agent.saisi.online")
                            && host.matches('.').count() == 3
                            && host
                                .split('.')
                                .next()
                                .map(|d| d.starts_with("d"))
                                .unwrap_or(false))
                })
                .unwrap_or(false);
            // round-102: token injection only via the gateway proxy OR
            // loopback — a public direct request must NOT receive the token.
            let loopback = host_no_port(req.headers())
                .map(|host| host == "127.0.0.1" || host == "localhost")
                .unwrap_or(false);
            if host_ok && (via_proxy || loopback) {
                return panel_token_response(token);
            }
            // One-time panel grant (gateway-issued; the fix the console's
            // openPanel ?token= flow was waiting for): the console mints a
            // 120s single-use grant bound to THIS device and opens
            // /panel/?grant=<code> directly at the device origin — the
            // permanent token never rides in a URL. The grant is redeemed
            // here (Bearer = our own device token) and on success the panel
            // is served with the token injected — EXACTLY the response shape
            // of the authorized injection path above. Panel paths only (the
            // desktop shell never receives grants).
            let panel_path = path == "/panel" || path == "/panel/";
            let grant = query_param(req.uri().query(), "grant").unwrap_or("").trim();
            if panel_path && plausible_grant(grant) {
                // Pure-local device (no console binding): ?grant= is simply
                // invalid — fall through to the plain panel, the same
                // readable state a bad/absent token gets.
                if let Some(base) = cfg
                    .platform
                    .console_url
                    .as_deref()
                    .map(str::trim)
                    .filter(|u| !u.is_empty())
                {
                    if redeem_panel_grant(base, token, grant).await {
                        return panel_token_response(token);
                    }
                }
                // Redeem failed (network down, expired/consumed/wrong-device
                // grant, gateway 4xx): fall through to the plain panel below.
                // No injection on a maybe — a grant is a claim, not a proof.
            }
        }
        return resp;
    }
    if method == Method::GET && (path.starts_with("/panel/") || path.starts_with("/desktop/")) {
        // Strip any ?v=… cache-buster before whitelist matching.
        let prefix_len = if path.starts_with("/desktop/") {
            "/desktop/".len()
        } else {
            "/panel/".len()
        };
        let file = path[prefix_len..].split('?').next().unwrap_or("");
        return serve_panel_file(file, panel_content_type(file));
    }

    // GET non-API — minimal status page: public (no token needed)
    if method == Method::GET && !path.starts_with("/api") && path != "/mcp" {
        let mut resp = built_response(
            StatusCode::OK,
            "text/html; charset=utf-8",
            Body::from(STATUS_PAGE),
        );
        resp.headers_mut().insert(
            axum::http::HeaderName::from_static("cache-control"),
            axum::http::HeaderValue::from_static("no-cache"),
        );
        return resp;
    }

    // Auth gate for all the /mcp + /api/* routes that follow
    if needs_auth {
        if let Err(resp) = check_auth(&req, &state) {
            return *resp;
        }
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
                (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "payload_too_large",
                    "request body exceeds 1 MB limit",
                )
            } else {
                (
                    StatusCode::BAD_REQUEST,
                    "body_read_error",
                    "failed to read request body",
                )
            };
            return built_response(
                status,
                "application/json",
                Body::from(
                    serde_json::json!({
                        "ok": false,
                        "error": msg,
                        "code": code,
                    })
                    .to_string(),
                ),
            );
        }
    };
    let body_str = String::from_utf8_lossy(&body_bytes).to_string();

    let result: serde_json::Value = match (method.as_str(), path.as_str()) {
        ("GET", "/api/spec") => api_spec(&state),
        ("GET", "/api/status") => api_status(&state).await,
        // Audit trail: session list (round-56) + per-session events
        // (round-68) — bodies in api_sessions_list / api_session_events.
        ("GET", "/api/sessions") => api_sessions_list(),
        ("GET", p) if p.starts_with("/api/sessions/") && p.len() > "/api/sessions/".len() => {
            match api_session_events(p) {
                Ok(v) => v,
                Err(resp) => return *resp,
            }
        }
        // vale-update.log reader (tray promise) — body in api_logs.
        ("GET", "/api/logs") => api_logs(),
        ("GET", "/api/events/poll") => {
            let after: u64 = query_param(query_str.as_deref(), "after")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            api_events_poll(&state, after)
        }

        // Settings read/write (round-69) — bodies in
        // api_settings_get / api_settings_put.
        ("GET", "/api/settings") => api_settings_get(&state).await,
        ("PUT", "/api/settings") => match api_settings_put(&state, &body_str) {
            Ok(v) => v,
            Err(resp) => return *resp,
        },

        // Gateway connect (Settings page card) — body in api_gateway_connect.
        ("POST", "/api/gateway/connect") => match api_gateway_connect(&state, &body_str).await {
            Ok(v) => v,
            Err(resp) => return *resp,
        },

        // ---- Plugin management (round-admin-ui): playwright-mcp process
        // ---- control for the panel's plugins page. Auth: all /api/* POSTs
        // and /api GETs pass the gate above.
        ("GET", "/api/plugins/status") => api_plugins_status(&state).await,
        ("POST", "/api/plugins/playwright/start") => match api_playwright_start(&state).await {
            Ok(v) => v,
            Err(resp) => return *resp,
        },
        ("POST", "/api/plugins/playwright/stop") => match api_playwright_stop(&state).await {
            Ok(v) => v,
            Err(resp) => return *resp,
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
        None => {
            return serde_json::json!({"ok": false, "error": format!("unknown tool: {tool_name}"), "code": "invalid_params"})
        }
    };
    let params: serde_json::Value = if body.is_empty() {
        serde_json::json!({})
    } else {
        match serde_json::from_str(body) {
            Ok(v) => v,
            Err(e) => {
                return serde_json::json!({"ok": false, "error": format!("invalid JSON body: {e}"), "code": "invalid_params"})
            }
        }
    };
    match tool.handler.call(params).await {
        Ok(result) => serde_json::json!({"ok": true, "result": result}),
        Err(e) => serde_json::json!({"ok": false, "error": e.to_string(), "code": e.code()}),
    }
}

// ── API endpoint handlers ────────────────────────────────────
// Bodies extracted from handle_request's route match so dispatch stays
// auth + routing only. Same contract as before the extraction: a returned
// serde_json::Value is served as `axum::Json(...).into_response()`; an Err
// short-circuits handle_request with the already-built response (status +
// headers preserved verbatim). The Err is boxed like check_auth's — Response
// is large and clippy::result_large_err fires on a plain Result err variant.

/// GET /api/sessions — audit trail: session list with terminal state
/// (round-56). The logger lives in the terminal plugin's private field —
/// read the same directory directly (cheap: one file per session).
fn api_sessions_list() -> serde_json::Value {
    // HIGH(audit round): the WRITER (terminal plugin) logs to
    // paths::data_dir()/sessions — on registry-first installs the
    // exe dir is NOT the data dir (d1: D:\Vale vs C:\ProgramData\
    // Vale), and these endpoints scanned an empty dir: the audit
    // panel was permanently blind. Read the same dir; also honors
    // the "zero current_exe() guessing outside paths.rs" rule.
    let dir = crate::paths::sessions_dir();
    let logger = crate::session_log::SessionLogger::new(dir);
    let list: serde_json::Value = logger
        .list_sessions()
        .iter()
        .map(|(sid, state)| serde_json::json!({ "id": sid, "state": state }))
        .collect();
    serde_json::json!({ "ok": true, "sessions": list })
}

/// GET /api/sessions/{sid} — full audit events for one session (round-68):
/// events_of() existed for /api/sessions but no endpoint called it — the
/// durable audit corpus was write-only, unqueryable by the panel or MCP.
/// This reads the session's jsonl (permanent, survives agent restarts).
fn api_session_events(p: &str) -> Result<serde_json::Value, Box<Response>> {
    // round-87: the old literal "/api/sessions/{sid}" arm never
    // matched a real session id (exact-string match) — the audit
    // endpoint 404'd for every session. Guard-arm route.
    let sid = p
        .strip_prefix("/api/sessions/")
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
        return Err(Box::new(built_response(
            StatusCode::BAD_REQUEST,
            "application/json",
            Body::from(r#"{"ok":false,"error":"invalid session id"}"#),
        )));
    }
    // HIGH(audit round): the WRITER (terminal plugin) logs to
    // paths::data_dir()/sessions — on registry-first installs the
    // exe dir is NOT the data dir (d1: D:\Vale vs C:\ProgramData\
    // Vale), and these endpoints scanned an empty dir: the audit
    // panel was permanently blind. Read the same dir; also honors
    // the "zero current_exe() guessing outside paths.rs" rule.
    let dir = crate::paths::sessions_dir();
    let logger = crate::session_log::SessionLogger::new(dir);
    let events = logger.events_of(&sid);
    Ok(serde_json::json!({ "ok": true, "id": sid, "events": events }))
}

/// GET /api/logs — read the tray's vale-update.log (promised by the tray's
/// doc comment but never implemented) — lets a remote client see auto-update
/// failures instead of asking the user to open files.
fn api_logs() -> serde_json::Value {
    // Zero current_exe() guessing outside paths.rs — exe_dir() is the
    // same resolution, centralized.
    let dir = crate::paths::exe_dir();
    let log = dir.join("vale-update.log");
    let text = std::fs::read_to_string(&log).unwrap_or_else(|_| String::new());
    serde_json::json!({"ok": true, "log": text.chars().rev().take(64 * 1024).collect::<String>().chars().rev().collect::<String>()})
}

/// GET /api/settings — read the runtime-configurable values (round-69).
/// buffer_mb is the per-session output buffer cap — the panel's settings
/// writes it here; it takes effect for NEW output (existing buffers keep
/// their size), persists to config.yaml, survives restarts.
async fn api_settings_get(state: &AppState) -> serde_json::Value {
    // Write-through (audit A4): console_url comes from the LIVE snapshot —
    // the same source the PUT handler persists through update_config (the
    // old disk re-read here was a second source of truth that could
    // disagree with memory).
    let console_url = state.config_snapshot().platform.console_url;
    // Tunnel state: tunnel.yml present + cloudflared running? Lets the
    // Settings page show the persisted state after a refresh (the
    // Gateway card must not blank out once connected).
    let install_dir = crate::paths::install_dir();
    let tunnel_configured = install_dir.join("tunnel.yml").exists();
    // Blocking-subprocess audit: tasklist is a synchronous child
    // process — run it on the blocking pool so the polled-every-15s
    // /api/status sibling handler never stalls the async runtime
    // workers. On non-Windows (dev/CI) tasklist doesn't exist and
    // this degrades to false, as before.
    let tunnel_running = tokio::task::spawn_blocking(|| {
        std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq cloudflared.exe"])
            .output()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .to_lowercase()
                    .contains("cloudflared")
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false);
    // Round-358: live memory capacity (Settings page Memory card edits it
    // via PUT below; bytes reported in MiB for the UI).
    let mem = state.memory.limits();
    serde_json::json!({
        "ok": true,
        "buffer_mb": state.terminal_buf_bytes.load(std::sync::atomic::Ordering::Relaxed) / (1024 * 1024),
        "console_url": console_url,
        "tunnel_configured": tunnel_configured,
        "tunnel_running": tunnel_running,
        "memory_max_entries": mem.max_entries,
        "memory_max_bytes_mb": mem.max_bytes / (1024 * 1024),
        "memory_retention_days": mem.retention_days,
    })
}

/// PUT /api/settings — write the runtime-configurable values (round-69).
/// Write-through (audit A4): changes land in the LIVE config AND config.yaml
/// in one update_config step. Err carries the ready-made error response,
/// byte-identical to the pre-extraction early return (including its
/// HTTP-200 Json shape).
fn api_settings_put(state: &AppState, body: &str) -> Result<serde_json::Value, Box<Response>> {
    let v: serde_json::Value =
        match serde_json::from_str(body) {
            Ok(v) => v,
            Err(e) => return Err(Box::new(
                axum::Json(serde_json::json!({
                    "ok": false, "error": format!("invalid JSON: {e}"), "code": "invalid_params",
                }))
                .into_response(),
            )),
        };
    // stage-n (settings audit): a PUT may legitimately carry ONLY ONE
    // of the keys — the old code reset buffer_mb to 8 whenever it was
    // ABSENT (a console-only save silently clobbered a user's 64).
    // Missing key = leave unchanged; empty console_url string =
    // explicit clear (unchanged semantics).
    let mb = v
        .get("buffer_mb")
        .and_then(|b| b.as_u64())
        .map(|x| (x as usize).clamp(1, 64));
    if let Some(mb) = mb {
        state
            .terminal_buf_bytes
            .store(mb * 1024 * 1024, std::sync::atomic::Ordering::Relaxed);
    }
    let console_url = v.get("console_url").map(|val| {
        val.as_str()
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
    });
    // Round-358: memory capacity (Settings page Memory card). Same
    // missing-key convention: absent = unchanged. Entries/bytes clamp to
    // >= 1 (0 would evict everything); retention accepts a positive day
    // count, while null/""/0 CLEARS it back to keep-forever.
    let mem_entries = v
        .get("memory_max_entries")
        .and_then(|b| b.as_u64())
        .map(|x| (x as usize).max(1));
    let mem_bytes = v
        .get("memory_max_bytes_mb")
        .and_then(|b| b.as_u64())
        .map(|x| (x as usize).max(1) * 1024 * 1024);
    let mem_retention: Option<Option<u64>> = v.get("memory_retention_days").map(|val| {
        val.as_u64().filter(|&n| n > 0).or_else(|| {
            val.as_str()
                .and_then(|s| s.trim().parse::<u64>().ok().filter(|&n| n > 0))
        })
    });
    let mem_changed = mem_entries.is_some() || mem_bytes.is_some() || mem_retention.is_some();
    // Write-through (audit A4): merge onto the CURRENT in-process snapshot
    // and persist via update_config — the runtime buffer cap, the in-process
    // config and config.yaml all move together (the old code rewrote the
    // file from a disk re-read and left state.config stale until restart).
    // Best-effort persist (as before): a read-only install dir must not fail
    // the PUT — the runtime value already took effect. With no config_path
    // (dev invocations), update_config still updates memory and writes
    // nothing.
    if mb.is_some() || console_url.is_some() || mem_changed {
        let mut cfg = state.config_snapshot();
        if let Some(mb) = mb {
            cfg.terminal.buffer_mb = mb as u32;
        }
        if let Some(url) = console_url {
            cfg.platform.console_url = url;
        }
        if mem_changed {
            // Live-first: retune the running store (enforces immediately),
            // then persist the same values so a restart agrees.
            let cur = state.memory.limits();
            let new = MemoryLimits {
                max_entries: mem_entries.unwrap_or(cur.max_entries),
                max_bytes: mem_bytes.unwrap_or(cur.max_bytes),
                retention_days: mem_retention.unwrap_or(cur.retention_days),
            };
            state.memory.set_limits(new);
            cfg.memory.max_entries = Some(new.max_entries);
            cfg.memory.max_bytes = Some(new.max_bytes);
            cfg.memory.retention_days = new.retention_days;
        }
        let _ = state.update_config(cfg, true);
    }
    let mem = state.memory.limits();
    Ok(
        serde_json::json!({ "ok": true, "buffer_mb": mb.unwrap_or_else(|| {
            state.terminal_buf_bytes.load(std::sync::atomic::Ordering::Relaxed) / (1024 * 1024)
        }),
            "memory_max_entries": mem.max_entries,
            "memory_max_bytes_mb": mem.max_bytes / (1024 * 1024),
            "memory_retention_days": mem.retention_days,
        }),
    )
}

/// POST /api/gateway/connect (Settings page card): persist console_url, then
/// register the device with the gateway (reg-key exchange) and optionally
/// provision the free cloudflared tunnel. Returns per-step results so the
/// page can show what happened.
async fn api_gateway_connect(
    state: &AppState,
    body: &str,
) -> Result<serde_json::Value, Box<Response>> {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => {
            return Err(Box::new(built_response(
                StatusCode::BAD_REQUEST,
                "application/json",
                Body::from(
                    serde_json::json!({
                        "ok": false, "error": "invalid JSON", "code": "invalid_params",
                    })
                    .to_string(),
                ),
            )))
        }
    };
    let console_url = v
        .get("console_url")
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let reg_key = v
        .get("reg_key")
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let want_tunnel = v.get("tunnel").and_then(|t| t.as_bool()).unwrap_or(false);
    // 1. Persist console_url — write-through (audit A4): merge onto the
    //    CURRENT in-process snapshot and persist via update_config so memory
    //    and config.yaml move together in one step. The HIGH(audit)
    //    device_token-survival invariant holds by construction: the snapshot
    //    always carries the boot device_token (fail-closed auth depends on
    //    it), so the persisted file can NEVER lose it — the old
    //    reload-from-disk-with-stale-fallback could rewrite the file from a
    //    STALE snapshot on a transient load failure.
    //    Only touch console_url when the request actually speaks to it:
    //    absent = keep binding, "" = clear (the partial-PUT semantics
    //    audit flagged — a reg-key-only request used to silently
    //    unbind the gateway).
    //    Best-effort persist (matches the old `let _ =`); with no
    //    config_path (dev/tests) update_config still updates memory and
    //    writes nothing.
    let mut cfg = state.config_snapshot();
    if let Some(val) = v.get("console_url") {
        cfg.platform.console_url = val
            .as_str()
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty());
    }
    let _ = state.update_config(cfg, true);
    // 2. If a reg key was given, exchange it at the gateway for the
    //    Cloudflare API token (the gateway's saved credential) — this
    //    registers the device AND enables tunnel provisioning.
    let mut registered = false;
    let mut cf_token = String::new();
    if let (Some(url), Some(key)) = (console_url.as_deref(), reg_key.as_deref()) {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build();
        if let Ok(client) = client {
            let r = client
                .post(format!(
                    "{}/api/install/tunnel-token",
                    url.trim_end_matches('/')
                ))
                .header("content-type", "application/json")
                // MED(audit round): a key containing \" or , used to
                // corrupt/inject fields in the hand-built JSON body.
                .body(serde_json::json!({ "key": key }).to_string())
                .send()
                .await;
            if let Ok(resp) = r {
                if let Ok(j) = resp.json::<serde_json::Value>().await {
                    if let Some(t) = j.get("apiToken").and_then(|x| x.as_str()) {
                        cf_token = t.to_string();
                        registered = true;
                    }
                }
            }
        }
    }
    // 3. Optional tunnel: write tunnel.yml + spawn cloudflared with
    //    the token (free tier). Best-effort; report the outcome. The
    //    ingress follows the configured bind port (custom ports 502
    //    otherwise).
    let mut tunnel_status = "skipped".to_string();
    if want_tunnel && !cf_token.is_empty() {
        let port = state.config_snapshot().server.port;
        tunnel_status = crate::tunnel::provision_tunnel(&cf_token, port).await;
    } else if want_tunnel {
        tunnel_status = "no cf token (register first or set CLOUDFLARE_API_TOKEN)".to_string();
    }
    Ok(serde_json::json!({
        "ok": true,
        "registered": registered,
        "console_url": console_url,
        "tunnel": tunnel_status,
    }))
}

/// GET /api/plugins/status — plugin management (round-admin-ui): the panel's
/// plugins page polls the playwright-mcp running state here.
async fn api_plugins_status(state: &AppState) -> serde_json::Value {
    let mut obj = serde_json::json!({ "ok": true, "playwright": state.playwright.status().await });
    // P2-4: same boxed manifest as /api/status (advisory, omitted when absent).
    if let Some(boxed) = boxed_versions() {
        obj["boxed_versions"] = boxed;
    }
    obj
}

/// POST /api/plugins/playwright/start — playwright-mcp process control for
/// the panel's plugins page.
async fn api_playwright_start(state: &AppState) -> Result<serde_json::Value, Box<Response>> {
    match state.playwright.start().await {
        Ok(v) => {
            // {ok:true, ...v} — merge the manager payload at top level
            let mut obj = v.as_object().cloned().unwrap_or_default();
            obj.insert("ok".into(), serde_json::json!(true));
            Ok(serde_json::Value::Object(obj))
        }
        // Dev builds have no bundled node.exe — fail loudly with the
        // path hint instead of pretending the process started.
        Err(e) => Err(Box::new(built_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "application/json",
            Body::from(serde_json::json!({ "ok": false, "error": e.to_string() }).to_string()),
        ))),
    }
}

/// POST /api/plugins/playwright/stop — playwright-mcp process control for
/// the panel's plugins page.
async fn api_playwright_stop(state: &AppState) -> Result<serde_json::Value, Box<Response>> {
    match state.playwright.stop().await {
        Ok(v) => {
            let mut obj = v.as_object().cloned().unwrap_or_default();
            obj.insert("ok".into(), serde_json::json!(true));
            Ok(serde_json::Value::Object(obj))
        }
        Err(e) => Err(Box::new(built_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "application/json",
            Body::from(serde_json::json!({ "ok": false, "error": e.to_string() }).to_string()),
        ))),
    }
}

// ── SSE event stream ─────────────────────────────────────────

/// stage-n SSE audit LOW: bound concurrent SSE connections so a flood of
/// viewers can't exhaust tasks/memory. 64 slots shared across /api/events
/// and /api/events/term; each slot is a permit that releases on drop.
/// P2-4: read the boxed-component version manifest (`vale setup`/`vale update`
/// write `<install>/boxed-versions.json`). Returns None when absent or
/// unparseable — advisory only, never fail-closed.
fn boxed_versions() -> Option<serde_json::Value> {
    let text =
        std::fs::read_to_string(crate::paths::install_dir().join("boxed-versions.json")).ok()?;
    serde_json::from_str(&text).ok()
}

async fn api_status(state: &AppState) -> serde_json::Value {
    let serial = state.serial_pool.list_open_ports();
    // stage-n: health diagnostics — uptime (a low value right after an
    // update/crash is a red flag) and the live terminal session count
    // (leaked sessions show up here without needing terminal_history).
    let uptime_secs = state.started_at.elapsed().as_secs();
    let live_sessions = state.terminal_mgr.term_list().await.len();
    // stage-n: device vitals (Windows: CPU delta + memory; other hosts
    // return None → fields are omitted, endpoint shape stays additive).
    let vitals = crate::metrics::sample();
    let mut out = serde_json::json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "port": state.config_snapshot().server.port,
        "uptime_secs": uptime_secs,
        "live_sessions": live_sessions,
        "serial_ports": serial,
    });
    // round-304: report the npm RELEASE version (written by the swap
    // scripts, agent_update + vale.js) alongside the Cargo protocol
    // version — /api/status consumers otherwise see 1.0.145 forever
    // while the device runs 1.2.x. Omitted when absent (fresh installs).
    if let Ok(rel) = std::fs::read_to_string(crate::paths::install_dir().join(".vale-release")) {
        let rel = rel.trim();
        if !rel.is_empty() {
            out["release"] = serde_json::json!(rel);
        }
    }
    // P2-4: echo the boxed-component version manifest (written by
    // `vale setup` / `vale update` next to the install dir). Omitted when
    // absent (older installs); the file is advisory, never fail-closed.
    if let Some(boxed) = boxed_versions() {
        out["boxed_versions"] = boxed;
    }
    if let Some(cpu) = vitals.cpu_pct {
        out["cpu_pct"] = serde_json::json!(cpu);
    }
    if let Some(mem) = vitals.mem_pct {
        out["mem_pct"] = serde_json::json!(mem);
    }
    if let Some(mb) = vitals.mem_total_mb {
        out["mem_total_mb"] = serde_json::json!(mb);
    }
    // round-103: expose the proxy secret (token-authenticated endpoint) so
    // the console can store it at registration and present X-Vale-Auth when
    // proxying /panel/ — the agent injects the panel token only for
    // requests carrying the matching secret.
    // Write-through (audit A4): read the LIVE snapshot, not the boot copy.
    let cfg = state.config_snapshot();
    if let Some(sec) = cfg.server.proxy_secret.as_deref() {
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
    let plugins: Vec<serde_json::Value> = state
        .plugin_registry
        .plugins
        .iter()
        .map(|p| {
            let nav = p.nav_item();
            let tools: Vec<serde_json::Value> = state
                .plugin_registry
                .plugin_tools(p.name())
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "name": t.name,
                        "description": t.description,
                        "schema": t.input_schema,
                    })
                })
                .collect();
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
        })
        .collect();

    serde_json::json!({"ok": true, "plugins": plugins})
}
#[cfg(test)]
mod tests {
    use super::panel::{apply_bundle_hash, panel_bundle_hash};
    use super::*;
    use crate::state::AppState;
    use axum::http::Request;
    use vale_agent_core::Config;

    const TEST_TOKEN: &str = "test-token";

    fn state() -> Arc<AppState> {
        // Fail-closed auth (round-3xx): the default test state carries a
        // token like production always does — tests exercise the gated
        // paths, and the 401 cases build their own tokenless/mismatched
        // configs explicitly.
        let mut cfg = Config::default();
        cfg.server.device_token = Some(TEST_TOKEN.into());
        Arc::new(AppState::new(cfg))
    }

    fn req(method: &str, path: &str) -> Request<Body> {
        req_with_token(method, path, TEST_TOKEN)
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
        let mut b = Request::builder()
            .method("GET")
            .uri(path)
            .header(axum::http::header::HOST, host);
        if via_proxy {
            b = b.header("x-vale-proxy", "1");
        }
        b.body(Body::empty()).unwrap()
    }
    fn req_with_host_secret(path: &str, host: &str) -> Request<Body> {
        Request::builder()
            .method("GET")
            .uri(path)
            .header(axum::http::header::HOST, host)
            .header(
                "x-vale-auth",
                "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            )
            .body(Body::empty())
            .unwrap()
    }
    fn req_with_host_secret_wrong(path: &str, host: &str) -> Request<Body> {
        Request::builder()
            .method("GET")
            .uri(path)
            .header(axum::http::header::HOST, host)
            .header(
                "x-vale-auth",
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            )
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn panel_token_injection_host_gate() {
        let mut cfg = Config::default();
        cfg.server.device_token =
            Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".into());
        cfg.server.proxy_secret =
            Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".into());
        let st = Arc::new(AppState::new(cfg));
        // The device's own subdomain MUST inject when the request carries
        // the gateway's shared secret (X-Vale-Auth, round-103 — a spoofable
        // marker header was replaced with a constant-time secret check).
        let ok = handle_request(
            req_with_host_secret("/panel/", "d1.agent.saisi.online"),
            st.clone(),
        )
        .await;
        let body = axum::body::to_bytes(ok.into_body(), 1 << 20).await.unwrap();
        assert!(
            String::from_utf8_lossy(&body).contains("window.__PANEL_TOKEN__"),
            "device host with secret must inject"
        );

        // Direct (no secret) on the device host MUST NOT inject — an
        // attacker hitting the enumerable public hostname gets no token.
        let direct = handle_request(
            req_with_host("/panel/", "d1.agent.saisi.online"),
            st.clone(),
        )
        .await;
        let bd = axum::body::to_bytes(direct.into_body(), 1 << 20)
            .await
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&bd).contains("window.__PANEL_TOKEN__"),
            "direct device access must NOT inject (RCE)"
        );

        // A spoofed WRONG secret must not inject either.
        let wrong = handle_request(
            req_with_host_secret_wrong("/panel/", "d1.agent.saisi.online"),
            st.clone(),
        )
        .await;
        let bw = axum::body::to_bytes(wrong.into_body(), 1 << 20)
            .await
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&bw).contains("window.__PANEL_TOKEN__"),
            "wrong secret must NOT inject"
        );

        // Apex with secret + loopback inject.
        let apex = handle_request(
            req_with_host_secret("/panel/", "agent.saisi.online"),
            st.clone(),
        )
        .await;
        let ba = axum::body::to_bytes(apex.into_body(), 1 << 20)
            .await
            .unwrap();
        assert!(
            String::from_utf8_lossy(&ba).contains("window.__PANEL_TOKEN__"),
            "apex with secret must inject"
        );
        for h in ["127.0.0.1:18080", "localhost"] {
            let r = handle_request(req_with_host("/panel/", h), st.clone()).await;
            let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
            assert!(
                String::from_utf8_lossy(&b).contains("window.__PANEL_TOKEN__"),
                "{h} must inject"
            );
        }

        // Multi-level attacker subdomain + suffix-spoof MUST NOT inject.
        for h in [
            "evil.agent.saisi.online",
            "agent.saisi.online.evil.com",
            "evil.com",
            "d1.agent.saisi.online.evil.com",
        ] {
            let r = handle_request(req_with_host("/panel/", h), st.clone()).await;
            let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
            assert!(
                !String::from_utf8_lossy(&b).contains("window.__PANEL_TOKEN__"),
                "{h} must NOT inject"
            );
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
        assert!(
            html.contains("\\u003c/script\\u003e"),
            "must escape </script>: {html}"
        );
    }

    #[tokio::test]
    async fn desktop_route_serves_spa_and_injects_token() {
        // /desktop/ (vale-desktop shell) serves the same SPA and gets the
        // loopback token injection exactly like /panel/.
        let mut cfg = Config::default();
        cfg.server.device_token = Some("test-token-123".into());
        let st = Arc::new(AppState::new(cfg));
        let r = handle_request(req_with_host("/desktop/", "127.0.0.1:18080"), st.clone()).await;
        assert_eq!(
            r.status(),
            StatusCode::OK,
            "desktop route must serve the SPA"
        );
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        let html = String::from_utf8_lossy(&b);
        assert!(html.contains("id=\"root\""), "desktop SPA html: {html}");
        assert!(
            html.contains("__PANEL_TOKEN__"),
            "loopback token injection on /desktop/: {html}"
        );
        // Static asset route: /desktop/panel.js serves the bundle.
        let r = handle_request(req_with_host("/desktop/panel.js", "127.0.0.1:18080"), st).await;
        assert_eq!(r.status(), StatusCode::OK, "desktop panel.js must serve");
    }

    // ── Panel bundle cache key (content hash, not crate version) ──────
    //
    // Cloudflare overrides no-cache with a 4h Browser-Cache-TTL for .js/.css:
    // the `?v=` on the bundle URLs is the ONLY thing that retires the old
    // panel after an update, so both serve paths (plain + token-injected)
    // must stamp the SAME content hash.

    #[test]
    fn bundle_hash_is_content_key_not_crate_version() {
        // The cache key must move with panel rebuilds, not with the Cargo
        // version (frozen at 1.0.x while the npm release rides 1.2.x — the
        // old `?v=<crate-version>` never changed between releases).
        let h = panel_bundle_hash();
        assert_eq!(h.len(), 16, "FNV-1a-64 hex: {h}");
        assert!(
            h.chars().all(|c| c.is_ascii_hexdigit()),
            "lowercase hex: {h}"
        );
        assert_ne!(h, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn apply_bundle_hash_stamps_once_and_spares_vendor() {
        let html = r#"<link rel="stylesheet" href="vendor/xterm.css"><link rel="stylesheet" href="panel.css"><script type="module" src="panel.js"></script>"#;
        let out = apply_bundle_hash(html);
        let h = panel_bundle_hash();
        assert!(out.contains(&format!("panel.css?v={h}")));
        assert!(out.contains(&format!("panel.js?v={h}")));
        assert!(
            out.contains("vendor/xterm.css"),
            "vendor link untouched: {out}"
        );
        assert!(!out.contains("xterm.css?v="), "no vendor stamp: {out}");
        assert_eq!(
            out.matches("?v=").count(),
            2,
            "exactly one stamp per bundle"
        );
    }

    #[tokio::test]
    async fn panel_plain_and_token_paths_carry_content_hash() {
        let mut cfg = Config::default();
        cfg.server.device_token = Some(TEST_TOKEN.into());
        let st = Arc::new(AppState::new(cfg));
        let h = panel_bundle_hash();
        // Plain panel (non-allowlisted host, no grant → no injection).
        let r = handle_request(req_with_host("/panel/", "d1.example.com:18080"), st.clone()).await;
        assert_eq!(r.status(), StatusCode::OK);
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        let html = String::from_utf8_lossy(&b);
        assert!(
            html.contains(&format!("panel.js?v={h}")),
            "plain panel stamps js: {html}"
        );
        assert!(
            html.contains(&format!("panel.css?v={h}")),
            "plain panel stamps css: {html}"
        );
        // Token-injected panel (loopback) — same cache key shape + token.
        let r = handle_request(req_with_host("/panel/", "127.0.0.1:18080"), st).await;
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        let html = String::from_utf8_lossy(&b);
        assert!(html.contains("__PANEL_TOKEN__"));
        assert!(
            html.contains(&format!("panel.js?v={h}")),
            "token panel stamps js: {html}"
        );
        assert!(
            html.contains(&format!("panel.css?v={h}")),
            "token panel stamps css: {html}"
        );
    }

    // ── One-time panel grants (?grant=) ──────────────────────────────────
    //
    // The redeem arm is exercised against a local TCP listener speaking just
    // enough HTTP for the reqwest POST — no real gateway, no external
    // network. Hosts are deliberately NON-allowlisted and non-loopback: on
    // those hosts the ONLY way the token may be injected is a successful
    // grant redemption, which makes the assertions unambiguous.

    const GRANT: &str = "0123456789abcdef0123456789abcdef";

    /// One-shot redeem stub: accepts ONE connection, captures the raw request
    /// bytes, answers `<status_line>` + `<body>` and returns the captured
    /// request via the JoinHandle. Aborting the handle (dropping it) closes
    /// the listener — used to prove NO call was made.
    async fn spawn_redeem_stub(
        status_line: &'static str,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            // Read until the content-length declared by the request is
            // satisfied (headers + JSON body may arrive split); bounded by a
            // per-read timeout so a malformed client can't hang the test.
            let mut data: Vec<u8> = Vec::new();
            loop {
                let mut buf = [0u8; 2048];
                let n = match tokio::time::timeout(
                    std::time::Duration::from_millis(500),
                    sock.read(&mut buf),
                )
                .await
                {
                    Ok(Ok(n)) => n,
                    _ => 0,
                };
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&buf[..n]);
                if let Ok(text) = std::str::from_utf8(&data) {
                    if let Some(i) = text.find("\r\n\r\n") {
                        let len: usize = text[..i]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse().ok())
                            })
                            .unwrap_or(0);
                        if text[i + 4..].len() >= len {
                            break;
                        }
                    }
                }
            }
            let captured = String::from_utf8_lossy(&data).to_string();
            let resp = format!(
                "{status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
            captured
        });
        (format!("http://{addr}"), handle)
    }

    #[tokio::test]
    async fn panel_grant_redeem_success_injects_token() {
        let mut cfg = Config::default();
        cfg.server.device_token = Some(TEST_TOKEN.into());
        let (base, handle) = spawn_redeem_stub("HTTP/1.1 200 OK", "{\"ok\":true}").await;
        cfg.platform.console_url = Some(base);
        let st = Arc::new(AppState::new(cfg));
        // Non-allowlisted, non-loopback host: injection ONLY via the grant.
        let r = handle_request(
            req_with_host(&format!("/panel/?grant={GRANT}"), "d1.example.com:18080"),
            st,
        )
        .await;
        assert_eq!(r.status(), StatusCode::OK);
        // Same response shape as the authorized injection path: no-store.
        assert_eq!(
            r.headers()
                .get("cache-control")
                .and_then(|v| v.to_str().ok()),
            Some("no-store"),
            "grant-served panel must be no-store"
        );
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        let html = String::from_utf8_lossy(&b);
        assert!(
            html.contains("__PANEL_TOKEN__"),
            "successful redeem must inject: {html}"
        );
        // The redeem call carried OUR bearer token + the grant code, and the
        // grant value must not leak beyond the redeem body itself.
        let captured = handle.await.unwrap();
        assert!(
            captured.contains("POST /api/devices/panel-grant/redeem"),
            "captured: {captured}"
        );
        assert!(
            captured.contains(&format!("authorization: Bearer {}", TEST_TOKEN)),
            "captured: {captured}"
        );
        assert!(captured.contains(GRANT), "captured: {captured}");
    }

    #[tokio::test]
    async fn panel_grant_redeem_failure_serves_plain_panel() {
        let mut cfg = Config::default();
        cfg.server.device_token = Some(TEST_TOKEN.into());
        let (base, handle) =
            spawn_redeem_stub("HTTP/1.1 404 Not Found", "{\"type\":\"error\"}").await;
        cfg.platform.console_url = Some(base);
        let st = Arc::new(AppState::new(cfg));
        let r = handle_request(
            req_with_host(&format!("/panel/?grant={GRANT}"), "d1.example.com:18080"),
            st,
        )
        .await;
        assert_eq!(
            r.status(),
            StatusCode::OK,
            "the panel page itself still serves"
        );
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        assert!(
            !String::from_utf8_lossy(&b).contains("__PANEL_TOKEN__"),
            "a failed redeem must NOT inject (bad-grant = bad-token behavior)"
        );
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn panel_grant_without_console_url_falls_back_to_plain_panel() {
        // Pure-local device: no console binding → nothing to redeem with, so
        // ?grant= is simply invalid (existing bad-token behavior) and NO
        // network call is possible (no stub exists to answer one).
        let mut cfg = Config::default();
        cfg.server.device_token = Some(TEST_TOKEN.into());
        let st = Arc::new(AppState::new(cfg));
        let r = handle_request(
            req_with_host(&format!("/panel/?grant={GRANT}"), "d1.example.com:18080"),
            st,
        )
        .await;
        assert_eq!(r.status(), StatusCode::OK);
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        assert!(!String::from_utf8_lossy(&b).contains("__PANEL_TOKEN__"));
    }

    #[tokio::test]
    async fn panel_grant_malformed_code_never_redeems() {
        // The stub answers ok:true to ANYTHING — if the shape check let a
        // malformed grant through, redemption would "succeed" and the token
        // would be injected onto a non-allowlisted host. No injection + no
        // captured request proves the check gates the network call.
        let mut cfg = Config::default();
        cfg.server.device_token = Some(TEST_TOKEN.into());
        let (base, handle) = spawn_redeem_stub("HTTP/1.1 200 OK", "{\"ok\":true}").await;
        cfg.platform.console_url = Some(base);
        let st = Arc::new(AppState::new(cfg));
        let r = handle_request(
            req_with_host("/panel/?grant=not-a-hex-code!", "d1.example.com:18080"),
            st,
        )
        .await;
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        assert!(!String::from_utf8_lossy(&b).contains("__PANEL_TOKEN__"));
        let waited = tokio::time::timeout(std::time::Duration::from_millis(300), handle).await;
        assert!(
            waited.is_err(),
            "no redeem request may be made for a malformed grant"
        );
    }

    #[test]
    fn plausible_grant_shape() {
        assert!(
            plausible_grant(&"a".repeat(32)),
            "gateway-minted shape (32 hex)"
        );
        assert!(plausible_grant(&"a".repeat(16)), "floor accepted");
        assert!(
            plausible_grant("ABCDEF0123456789ABCDEF0123456789"),
            "uppercase hex ok"
        );
        assert!(!plausible_grant(""), "empty rejected");
        assert!(!plausible_grant("abcdefgh"), "too short rejected");
        assert!(!plausible_grant(&"g".repeat(32)), "non-hex rejected");
        assert!(!plausible_grant(&"a".repeat(129)), "over-long rejected");
    }

    #[test]
    fn panel_grant_query_extraction() {
        // Position-independent + ignore surrounding params (the shared
        // query_param helper; grant must not be confused with lookalikes).
        assert_eq!(
            query_param(Some(&format!("grant={GRANT}")), "grant"),
            Some(GRANT)
        );
        assert_eq!(
            query_param(Some(&format!("x=1&grant={GRANT}")), "grant"),
            Some(GRANT)
        );
        assert_eq!(
            query_param(Some("xgrants=1"), "grant"),
            None,
            "prefix must not match"
        );
        assert_eq!(
            query_param(Some("grants=1"), "grant"),
            None,
            "longer key must not match"
        );
        assert_eq!(query_param(None, "grant"), None);
    }

    async fn json_body(resp: Response) -> serde_json::Value {
        let body = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn spec_lists_terminal_plugin() {
        let resp = handle_request(req("GET", "/api/spec"), state()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        // terminal + update + mcp-client + design + playwright + memory + system
        assert_eq!(v["plugins"].as_array().unwrap().len(), 7);
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
            req_with_token("POST", "/api/tools/terminal_list", TEST_TOKEN),
            state(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn unknown_tool_reports_error() {
        let resp = handle_request(
            req_with_token("POST", "/api/tools/does_not_exist", TEST_TOKEN),
            state(),
        )
        .await;
        let v = json_body(resp).await;
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("unknown tool"));
        assert_eq!(v["code"], "invalid_params");
    }

    #[tokio::test]
    async fn plugins_status_requires_auth() {
        // /api/plugins/* is inside the same auth gate as every other /api/*
        let mut cfg = Config::default();
        cfg.server.device_token = Some("sekret".into());
        let st = Arc::new(AppState::new(cfg));
        let resp = handle_request(req("GET", "/api/plugins/status"), st).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn plugins_status_reports_stopped() {
        let resp = handle_request(req("GET", "/api/plugins/status"), state()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["ok"], true);
        assert_eq!(v["playwright"]["running"], false);
    }

    #[tokio::test]
    async fn plugins_playwright_start_missing_bundle_errors() {
        // Dev builds carry no bundled node.exe under install_dir/playwright/
        // — start must fail loudly (500) with the path hint, not pretend
        // success. The failure happens before any spawn, so no network wait.
        let resp = handle_request(req("POST", "/api/plugins/playwright/start"), state()).await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let v = json_body(resp).await;
        assert_eq!(v["ok"], false);
        let err = v["error"].as_str().unwrap_or_default();
        assert!(
            err.contains("node.exe"),
            "error must name the missing node.exe: {err}"
        );
        assert!(
            err.contains("playwright"),
            "error must point at the playwright bundle: {err}"
        );
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
        let body = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .unwrap();
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

        st.event_bus
            .emit_term_output(serde_json::json!({"session_id": "term-0", "data": [104, 105]}));

        // Read just the first frame — the SSE stream never closes, so the whole
        // body can't be drained with to_bytes.
        let mut body = resp.into_body();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), body.frame())
            .await
            .expect("SSE frame within timeout")
            .expect("stream produced a frame")
            .expect("frame ok");
        let bytes = frame.into_data().expect("data frame");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("term-0"),
            "SSE frame missing session id: {text}"
        );
        assert!(text.starts_with("data: "));
    }

    // ── Settings + Gateway-card endpoints (persist paths) ────────────────
    //
    // Offline coverage for GET/PUT /api/settings and the POST
    // /api/gateway/connect persist-only arm. The reg-key exchange and the
    // tunnel provisioning arms need the network and are deliberately NOT
    // tested here.

    const CFG_URL: &str = "https://gw.example";

    /// A config with a device_token and no console binding.
    /// Write-through era: the device_token in the FILE must equal the token
    /// the harness authenticates with — in production AppState::new is
    /// seeded from the very config.yaml at config_path (run_server:
    /// load_config(argv[1])), so the harness mirrors that exactly.
    const CFG_YAML_TOKEN_ONLY: &str = "server:\n  device_token: test-token\nterminal:\n  buffer_mb: 8\nplatform:\n  console_url: null\n";
    /// A config with a device_token, a bound console_url and buffer_mb 8.
    const CFG_YAML_TOKEN_AND_URL: &str = "server:\n  device_token: test-token\nterminal:\n  buffer_mb: 8\nplatform:\n  console_url: https://gw.example\n";

    /// State whose config_path points at a per-test tempdir config.yaml —
    /// mirrors main.rs (persist to the ACTUALLY-LOADED path). The in-memory
    /// snapshot IS the file's config, exactly like the production boot
    /// (AppState::new(load_config(argv[1]))). No global state: every test
    /// owns its directory and removes it.
    fn state_with_cfg(tag: &str, yaml: &str) -> (Arc<AppState>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("vale-web-cfg-{}-{tag}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let cfg_path = dir.join("config.yaml");
        std::fs::write(&cfg_path, yaml).unwrap();
        let st = Arc::new(AppState::new(Config::load(&cfg_path).unwrap()));
        *st.config_path.lock().unwrap_or_else(|p| p.into_inner()) = Some(cfg_path.clone());
        (st, cfg_path)
    }

    fn req_with_json(method: &str, path: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(path)
            .header("Authorization", format!("Bearer {TEST_TOKEN}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn settings_get_shape() {
        let (st, cfg_path) = state_with_cfg("get-shape", CFG_YAML_TOKEN_ONLY);
        let resp = handle_request(req("GET", "/api/settings"), st).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["ok"], true);
        assert!(v["buffer_mb"].is_u64(), "buffer_mb must be a number: {v}");
        assert!(
            v["tunnel_configured"].is_boolean(),
            "tunnel_configured shape: {v}"
        );
        assert!(
            v["tunnel_running"].is_boolean(),
            "tunnel_running shape: {v}"
        );
        assert!(
            v["console_url"].is_null(),
            "unbound config must read back null: {v}"
        );
        let _ = std::fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    #[tokio::test]
    async fn settings_put_persists_and_preserves_token() {
        let (st, cfg_path) = state_with_cfg("put-token", CFG_YAML_TOKEN_ONLY);
        let resp = handle_request(
            req_with_json("PUT", "/api/settings", r#"{"buffer_mb": 32}"#),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["ok"], true);
        assert_eq!(v["buffer_mb"].as_u64(), Some(32));
        // The runtime cap took effect immediately (panel hint: applies to NEW
        // output), and the file now carries 8 → 32.
        assert_eq!(
            st.terminal_buf_bytes
                .load(std::sync::atomic::Ordering::Relaxed),
            32 * 1024 * 1024
        );
        let cfg = Config::load(&cfg_path).unwrap();
        assert_eq!(
            cfg.terminal.buffer_mb, 32,
            "PUT must persist to config.yaml"
        );
        // HIGH(audit): a settings write must NEVER drop the device_token —
        // a token-less rewrite makes the next boot mint a NEW token and 401
        // every client (the recorded rotation incident).
        assert_eq!(
            cfg.server.device_token.as_deref(),
            Some(TEST_TOKEN),
            "device_token must survive PUT /api/settings"
        );
        let _ = std::fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    #[tokio::test]
    async fn settings_put_partial_leaves_omitted_keys() {
        let (st, cfg_path) = state_with_cfg("put-partial", CFG_YAML_TOKEN_AND_URL);
        // 1. buffer-only PUT: the bound console_url must survive.
        let resp = handle_request(
            req_with_json("PUT", "/api/settings", r#"{"buffer_mb": 16}"#),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let cfg = Config::load(&cfg_path).unwrap();
        assert_eq!(cfg.terminal.buffer_mb, 16);
        assert_eq!(
            cfg.platform.console_url.as_deref(),
            Some(CFG_URL),
            "buffer-only PUT must not clear console_url"
        );
        // 2. console_url-only PUT: buffer_mb stays 16 (the stage-n settings
        //    audit: the old code reset an ABSENT buffer_mb to 8).
        let resp = handle_request(
            req_with_json(
                "PUT",
                "/api/settings",
                r#"{"console_url": "https://other.example"}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let cfg = Config::load(&cfg_path).unwrap();
        assert_eq!(
            cfg.platform.console_url.as_deref(),
            Some("https://other.example")
        );
        assert_eq!(
            cfg.terminal.buffer_mb, 16,
            "console_url-only PUT must not reset buffer_mb"
        );
        assert_eq!(cfg.server.device_token.as_deref(), Some(TEST_TOKEN));
        let _ = std::fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    #[tokio::test]
    async fn settings_put_visible_in_memory_and_file() {
        // Audit A4 write-through: a PUT must be visible IN-PROCESS (the live
        // snapshot, no disk reload, no restart — the old state.config was a
        // frozen boot snapshot) AND land in config.yaml. Both sources move
        // together; neither can drift.
        let (st, cfg_path) = state_with_cfg("put-memory", CFG_YAML_TOKEN_ONLY);
        let resp = handle_request(
            req_with_json(
                "PUT",
                "/api/settings",
                r#"{"buffer_mb": 32, "console_url": "https://mem.example"}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        // 1. In-memory visibility: config_snapshot() reflects the change
        //    WITHOUT touching the disk (this assert reads only the RwLock).
        let snap = st.config_snapshot();
        assert_eq!(
            snap.terminal.buffer_mb, 32,
            "in-memory buffer_mb must update"
        );
        assert_eq!(
            snap.platform.console_url.as_deref(),
            Some("https://mem.example"),
            "in-memory console_url must update"
        );
        assert_eq!(
            snap.server.device_token.as_deref(),
            Some(TEST_TOKEN),
            "device_token survives in memory too"
        );
        // 2. The file was written (persist=true) with the same values.
        let disk = Config::load(&cfg_path).unwrap();
        assert_eq!(
            disk.terminal.buffer_mb, 32,
            "persist=true must write config.yaml"
        );
        assert_eq!(
            disk.platform.console_url.as_deref(),
            Some("https://mem.example")
        );
        let _ = std::fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    #[tokio::test]
    async fn settings_memory_roundtrip_live_and_persisted() {
        // Round-358: memory capacity joins GET/PUT /api/settings. This test
        // is the SOLE writer of memory limits in the suite, so its
        // GET-defaults asserts cannot race with another test.
        let (st, cfg_path) = state_with_cfg("put-memlim", CFG_YAML_TOKEN_ONLY);
        // Defaults first (GET shape carries the memory fields).
        let resp = handle_request(req("GET", "/api/settings"), st.clone()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["memory_max_entries"].as_u64(), Some(10_000));
        assert_eq!(v["memory_max_bytes_mb"].as_u64(), Some(64));
        assert!(
            v["memory_retention_days"].is_null(),
            "default retention is keep-forever: {v}"
        );
        // PUT: live limits retune immediately + persist to config.yaml.
        let resp = handle_request(
            req_with_json(
                "PUT",
                "/api/settings",
                r#"{"memory_max_entries": 50, "memory_max_bytes_mb": 16, "memory_retention_days": 30}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["memory_max_entries"].as_u64(), Some(50));
        assert_eq!(v["memory_max_bytes_mb"].as_u64(), Some(16));
        assert_eq!(v["memory_retention_days"].as_u64(), Some(30));
        let live = st.memory.limits();
        assert_eq!(live.max_entries, 50);
        assert_eq!(live.max_bytes, 16 * 1024 * 1024);
        assert_eq!(live.retention_days, Some(30));
        let disk = Config::load(&cfg_path).unwrap();
        assert_eq!(disk.memory.max_entries, Some(50));
        assert_eq!(disk.memory.max_bytes, Some(16 * 1024 * 1024));
        assert_eq!(disk.memory.retention_days, Some(30));
        assert_eq!(disk.server.device_token.as_deref(), Some(TEST_TOKEN));
        // Clear retention back to keep-forever with 0; other keys untouched.
        let resp = handle_request(
            req_with_json("PUT", "/api/settings", r#"{"memory_retention_days": 0}"#),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(st.memory.limits().retention_days, None);
        assert_eq!(
            st.memory.limits().max_entries,
            50,
            "retention-only PUT must not reset entries"
        );
        // Restore shared defaults — AppState::new shares the default memory
        // dir across web tests; a lowered cap must not leak into others.
        let resp = handle_request(
            req_with_json(
                "PUT",
                "/api/settings",
                r#"{"memory_max_entries": 10000, "memory_max_bytes_mb": 64}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let live = st.memory.limits();
        assert_eq!(
            (live.max_entries, live.max_bytes),
            (10_000, 64 * 1024 * 1024)
        );
        let _ = std::fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    #[tokio::test]
    async fn gateway_connect_persist_only_arm() {
        // No reg_key → the config is persisted and the reg-key exchange +
        // tunnel provisioning are SKIPPED (no outbound HTTP on this arm).
        let (st, cfg_path) = state_with_cfg("gw-persist", CFG_YAML_TOKEN_ONLY);
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/gateway/connect",
                r#"{"console_url": "https://conn.example"}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["ok"], true);
        assert_eq!(v["registered"], false, "no reg_key → no registration");
        assert_eq!(v["tunnel"], "skipped");
        assert_eq!(v["console_url"], "https://conn.example");
        // Write-through (audit A4): the binding is ALSO visible in-process —
        // no restart, no disk reload.
        assert_eq!(
            st.config_snapshot().platform.console_url.as_deref(),
            Some("https://conn.example"),
            "gateway connect must update the in-memory config too"
        );
        let cfg = Config::load(&cfg_path).unwrap();
        assert_eq!(
            cfg.platform.console_url.as_deref(),
            Some("https://conn.example"),
            "connect must persist the binding"
        );
        assert_eq!(
            cfg.server.device_token.as_deref(),
            Some(TEST_TOKEN),
            "device_token must survive the gateway-card write too"
        );
        let _ = std::fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    #[tokio::test]
    async fn gateway_connect_reg_key_only_keeps_binding() {
        // reg_key WITHOUT console_url: absent = keep the existing binding
        // (the partial-PUT audit flagged a reg-key-only request silently
        // UNBINDING the gateway). With no console_url the reg-key exchange
        // has nowhere to POST, so this arm stays offline.
        let (st, cfg_path) = state_with_cfg("gw-regkey", CFG_YAML_TOKEN_AND_URL);
        let resp = handle_request(
            req_with_json("POST", "/api/gateway/connect", r#"{"reg_key": "some-key"}"#),
            st,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["ok"], true);
        assert_eq!(v["registered"], false);
        assert!(
            v["console_url"].is_null(),
            "reg-key-only request reports no binding change: {v}"
        );
        let cfg = Config::load(&cfg_path).unwrap();
        assert_eq!(
            cfg.platform.console_url.as_deref(),
            Some(CFG_URL),
            "reg-key-only request must keep the existing binding"
        );
        let _ = std::fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    #[tokio::test]
    async fn token_rotation_takes_effect_on_api_and_mcp_gate() {
        // Round-366 regression: TokenGate held a BOOT-time token clone while
        // /api/* read the live snapshot, so a runtime rotation stale-accepted
        // the old token on /mcp and rejected the new one. Both gates must
        // read the live snapshot per request.
        use std::convert::Infallible;
        use std::pin::Pin;
        use std::task::{Context, Poll};

        struct OkSvc;
        impl Service<Request<Body>> for OkSvc {
            type Response = axum::http::Response<McpBoxBody>;
            type Error = Infallible;
            type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Infallible>> + Send>>;
            fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
                Poll::Ready(Ok(()))
            }
            fn call(&mut self, _req: Request<Body>) -> Self::Future {
                Box::pin(async {
                    Ok(axum::http::Response::new(
                        http_body_util::combinators::BoxBody::new(http_body_util::Full::new(
                            bytes::Bytes::from_static(b"ok"),
                        )),
                    ))
                })
            }
        }

        let st = state();
        assert!(check_auth(&req("GET", "/api/status"), &st).is_ok());
        let mut gate = TokenGate::new(OkSvc, st.clone());
        let res = Service::call(&mut gate, req_with_token("POST", "/mcp", TEST_TOKEN))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let mut cfg = st.config_snapshot();
        cfg.server.device_token = Some("rotated-token".into());
        st.update_config(cfg, false).unwrap();

        // /api/* path: old rejected, new accepted.
        assert!(check_auth(&req_with_token("GET", "/api/status", TEST_TOKEN), &st).is_err());
        assert!(check_auth(&req_with_token("GET", "/api/status", "rotated-token"), &st).is_ok());
        // /mcp path: old rejected, new reaches the inner service.
        let res = Service::call(&mut gate, req_with_token("POST", "/mcp", TEST_TOKEN))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let res = Service::call(&mut gate, req_with_token("POST", "/mcp", "rotated-token"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
}
