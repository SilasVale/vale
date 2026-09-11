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
use vale_agent_core::{DeviceError, EventBus};
mod panel;
mod parse;
mod sse;

pub use panel::WebPanel;
pub(crate) use panel::{
    panel_content_type, panel_token_response, plausible_grant, redeem_panel_grant, serve_panel_file,
};
pub(crate) use sse::{acquire_sse_guard, sse_stream, sse_term_stream, SseConnectionGuard};

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
/// Stamp a cache-control header on a response. Token-bearing and panel
/// responses must never be cached — call sites used to inline the same
/// 3-line insert with no-store / no-cache values.
pub(super) fn set_cache_control(resp: &mut Response, value: &'static str) {
    resp.headers_mut().insert(
        axum::http::HeaderName::from_static("cache-control"),
        axum::http::HeaderValue::from_static(value),
    );
}

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
/// Takes the HEADERS rather than the whole request (SOLID R108): that is all
/// it reads, and it keeps the check usable from a `Send` future — a whole
/// `&Request<Body>` is neither `Send` nor `Sync`, so holding one across an
/// `await` would poison any async caller's future.
///
/// SECURITY (2026-08-12): the ?token= query param was removed — a cross-site
/// page could send a text/plain POST with the token in the URL (no CORS
/// preflight) and bypass auth. Clients use the Authorization header (the
/// panel fetches SSE with fetch(), which sets headers; nothing used the
/// query param).
fn check_auth(headers: &axum::http::HeaderMap, state: &AppState) -> Result<(), Box<Response>> {
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
    let from_header = headers
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

/// How many run boundaries `/api/operation` carries. Bounded for the same
/// reason the events are: one request must not walk an unbounded log. A reader
/// that needs older boundaries can page with `since_ms` once the runs carry a
/// stamp it can filter on.
const RUNS_IN_TIMELINE: usize = 50;

/// Evidence-feed endpoints (/api/browser/actions, pwshots, pwshot) —
/// extracted from handle_request (round-28 SRP): the READ side of the
/// AI-evidence drawer. Returns None when the path is not one of ours.
async fn handle_browser_evidence(path: &str, query: Option<&str>) -> Option<Response> {
    // Surface audit D#2 (one-browser round): the READ side resolved
    // current_exe()'s parent while the WRITE side (playwright tools)
    // uses the registry install_dir() — the exact 1.2.219 /api/sessions
    // blindness pattern. Same source of truth now.
    //
    // The feed's storage contract (actions.jsonl shape, shot listing,
    // basename guard) is owned by crate::evidence — the producers
    // (browser_run_script, the mcp-client tools) append through the same
    // module, so a shape change has exactly one place to land.
    let pwout = crate::paths::evidence_dir();
    // P2: AI-action timeline — the JSONL written by browser_run_script
    // (one line per execution). Return newest-first, capped at 50.
    if path == "/api/browser/actions" {
        let actions = crate::evidence::recent_actions(&pwout, 50);
        return Some(built_response(
            StatusCode::OK,
            "application/json",
            Body::from(serde_json::json!({"actions": actions}).to_string()),
        ));
    }
    // The device's MERGED operation timeline — terminal audit + browser actions
    // on one ordered axis. Device-level by design (see crate::operation): the
    // embedded browser has no session ownership, and an AI's "one operation"
    // crosses sessions.
    //
    // `since_ms` lets a poller ask only for what it has not seen; `limit` bounds
    // the reply. Both default, so a bare GET returns the recent timeline.
    if path == "/api/operation" {
        let since_ms = query_param(query, "since_ms")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let limit = query_param(query, "limit")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(200)
            .min(1000);
        let events = crate::operation::merged_operation(
            &crate::paths::sessions_dir(),
            &pwout,
            since_ms,
            limit,
        );
        return Some(built_response(
            StatusCode::OK,
            "application/json",
            Body::from(
                serde_json::json!({
                    "events": events,
                    // The run boundaries the events sit inside. Deliberately a
                    // SEPARATE array rather than a join: the runs log is
                    // best-effort (a device with an unwritable runs dir still
                    // records events), so an event may carry a run_id with no
                    // begin, and a run may exist with no events. Joining here
                    // would hide one of those cases inside the other. Grouping
                    // is the reader's job.
                    "runs": crate::runs::recent(&crate::paths::runs_dir(), RUNS_IN_TIMELINE),
                    "since_ms": since_ms,
                    // The newest stamp in the reply, so a poller can pass it back
                    // as `since_ms` without parsing the events itself.
                    "cursor_ms": events
                        .last()
                        .and_then(|e| e.get("ts_ms"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(since_ms),
                })
                .to_string(),
            ),
        ));
    }
    if path == "/api/browser/pwshots" {
        let shots = crate::evidence::list_shots(&pwout, 40);
        return Some(built_response(
            StatusCode::OK,
            "application/json",
            Body::from(serde_json::json!({"shots": shots}).to_string()),
        ));
    }
    // /api/browser/pwshot?name=xxx — serve one screenshot (basename only)
    let name = query_param(query, "name").unwrap_or("");
    if !crate::evidence::shot_name_is_safe(name) {
        return Some(built_response(
            StatusCode::BAD_REQUEST,
            "text/plain",
            Body::from("bad name"),
        ));
    }
    Some(match std::fs::read(pwout.join(name)) {
        Ok(bytes) => {
            let mut resp = built_response(StatusCode::OK, "image/png", Body::from(bytes));
            set_cache_control(&mut resp, "no-store");
            resp
        }
        Err(_) => built_response(
            StatusCode::NOT_FOUND,
            "text/plain",
            Body::from("no such shot"),
        ),
    })
}

/// Panel / desktop root page — served with the zero-config token-injection
/// decision (gateway proxy shared secret / loopback / one-time ?grant=
/// redemption). Extracted from handle_request (round-29 SRP).
async fn handle_panel_home(
    state: &AppState,
    path: &str,
    query: Option<&str>,
    host: Option<String>,
    auth_header: Option<String>,
) -> Response {
    // Write-through (audit A4): one snapshot of the LIVE config for the
    // whole injection decision (proxy_secret + device_token below).
    let cfg = state.config_snapshot();
    let mut resp = serve_panel_file("index.html", "text/html; charset=utf-8");
    set_cache_control(&mut resp, "no-store");
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
        && auth_header
            .as_deref()
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
        let host_ok = host
            .as_deref()
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
        let loopback = host
            .as_deref()
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
        let grant = query_param(query, "grant").unwrap_or("").trim().to_string();
        if panel_path && plausible_grant(&grant) {
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
                if redeem_panel_grant(base, token, &grant).await {
                    return panel_token_response(token);
                }
            }
            // Redeem failed (network down, expired/consumed/wrong-device
            // grant, gateway 4xx): fall through to the plain panel below.
            // No injection on a maybe — a grant is a claim, not a proof.
        }
    }
    resp
}

// ── Request handler ──────────────────────────────────────────

/// Routes decided BEFORE the API pipeline (SOLID R108).
///
/// Every request either produces a response here, or is not one of these and
/// falls through to `handle_request`'s unconditional auth gate + dispatcher.
/// That split is the point: this function is the ONE enumeration of the
/// pre-dispatch surface, which is exactly the surface that is PUBLIC — the
/// panel/desktop SPA and its assets, the static status page — plus the three
/// streaming routes (SSE ×2, browser evidence) that run their own auth
/// because they never read a body.
///
/// Two consequences worth stating, because they used to depend on statement
/// order inside a 200-line function:
///   * "anything reaching the dispatcher is authenticated" (R102) becomes a
///     property of WHICH FUNCTION a request lands in, not of where the gate
///     happens to sit;
///   * the public surface is auditable by reading this one list, and
///     `deliberately_public_routes_stay_public` pins it from the outside.
///
/// Takes the request's BORROWED PIECES rather than the request itself: a
/// `&Request<Body>` is neither `Send` nor `Sync` (http-body is not), so
/// holding one across an `await` makes this future non-`Send` and breaks the
/// Tower service it is called from. `&Method`, `&str` and `&HeaderMap` all
/// are, so the signature is `Send` by construction.
/// Authenticate, reserve an SSE viewer slot, and build the stream response —
/// the three steps `/api/events` and `/api/events/term` share.
///
/// WHY THIS EXISTS: the two branches in `route_pre_dispatch` were
/// byte-identical apart from which stream function they returned, so every
/// future change to the streaming path had to be made TWICE and could be made
/// once. There is now a single place where an SSE slot is acquired.
///
/// THE VIEWER SLOT IS PASSED TO THE STREAM, which is what makes the 64-viewer
/// cap real (SOLID R128). Until this round the guard was bound to a local and
/// dropped when the response was CONSTRUCTED, so the cap bounded only
/// microseconds of setup — measured: 70 held responses produced zero 503s.
/// Now `acquire_sse_guard()`'s value is MOVED into the streaming task, so it is
/// released when the stream ends (client disconnect, error, or the body being
/// dropped — all three close the mpsc, which the pump detects and breaks on).
///
/// This is the ONE place an SSE slot is acquired, which is why the fix was a
/// single edit here plus the two signatures it forwards to.
async fn sse_route_response<F, Fut>(
    headers: &axum::http::HeaderMap,
    state: &Arc<AppState>,
    stream: F,
) -> Response
where
    F: FnOnce(Arc<AppState>, SseConnectionGuard) -> Fut,
    Fut: std::future::Future<Output = Response>,
{
    if let Err(resp) = check_auth(headers, state) {
        return *resp;
    }
    let guard = match acquire_sse_guard() {
        Ok(g) => g,
        Err(resp) => return *resp,
    };
    // The guard is HANDED to the stream, not held here: it must survive until
    // the connection ends, and this function returns long before that does.
    stream(state.clone(), guard).await
}

async fn route_pre_dispatch(
    method: &Method,
    path: &str,
    query: Option<&str>,
    headers: &axum::http::HeaderMap,
    state: &Arc<AppState>,
) -> Option<Response> {
    // SSE event stream — streaming, handled before body parsing.
    if *method == Method::GET && path == "/api/events" {
        return Some(sse_route_response(headers, state, sse_stream).await);
    }

    // SSE terminal byte stream — streamed TermOutput JSON frames.
    if *method == Method::GET && path == "/api/events/term" {
        return Some(sse_route_response(headers, state, sse_term_stream).await);
    }

    // round-152: AI browser evidence stream — list + fetch screenshots from
    // the pwout dir (browser_run_script & playwright scripts drop screenshots
    // here). The panel polls pwshots and shows new PNGs as the AI works,
    // so a human can see what the AI did without any live frame stream.
    if *method == Method::GET
        && (path == "/api/browser/pwshots"
            || path == "/api/browser/pwshot"
            || path == "/api/browser/actions"
            // The merged operation timeline. Listed HERE so it goes through the
            // check_auth above with the rest: it carries commands, goals and
            // plans from every session, i.e. strictly MORE than the actions feed
            // it sits beside. Reaching handle_browser_evidence without this list
            // would 404; reaching it without the guard would leak the device.
            || path == "/api/operation")
    {
        if let Err(resp) = check_auth(headers, state) {
            return Some(*resp);
        }
        if let Some(resp) = handle_browser_evidence(path, query).await {
            return Some(resp);
        }
    }

    // Panel / desktop root: served with the zero-config token-injection
    // decision (gateway proxy secret / loopback / one-time grant) — extracted
    // as handle_panel_home (round-29 SRP). Assets are embedded at compile time
    // from resources/panel/; /desktop/ is the Electron full-screen shell and
    // the SPA switches on the path.
    //
    // SECURITY (2026-08-12): the panel previously embedded the device token as
    // window.__PANEL_TOKEN__ for zero-config access. With CORS * on every
    // response, any third-party page could fetch /panel/ and read the token.
    // The token is no longer injected — the user enters it once in the panel
    // (saved to localStorage) instead.
    if *method == Method::GET
        && (path == "/panel" || path == "/panel/" || path == "/desktop" || path == "/desktop/")
    {
        let host = host_no_port(headers).map(|h| h.to_string());
        let auth_header = headers
            .get("x-vale-auth")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string());
        return Some(handle_panel_home(state, path, query, host, auth_header).await);
    }
    if *method == Method::GET && (path.starts_with("/panel/") || path.starts_with("/desktop/")) {
        // Strip any ?v=… cache-buster before whitelist matching.
        let prefix_len = if path.starts_with("/desktop/") {
            "/desktop/".len()
        } else {
            "/panel/".len()
        };
        let file = path[prefix_len..].split('?').next().unwrap_or("");
        return Some(serve_panel_file(file, panel_content_type(file)));
    }

    // GET non-API — minimal status page: public (no token needed).
    if *method == Method::GET && !path.starts_with("/api") && path != "/mcp" {
        let mut resp = built_response(
            StatusCode::OK,
            "text/html; charset=utf-8",
            Body::from(STATUS_PAGE),
        );
        set_cache_control(&mut resp, "no-cache");
        return Some(resp);
    }

    None
}

pub(super) async fn handle_request(req: Request<Body>, state: Arc<AppState>) -> Response {
    // NOTE: no CORS preflight handler — the panel is same-origin (never
    // preflights); cross-origin calls must NOT be allowed, and the gateway
    // proxy adds its own ACAO when required. (The old handler advertised
    // ACAO:null that real responses never granted — dead + misleading.)
    //
    // Hoisted BEFORE the pre-dispatch call so the borrowed pieces (and the
    // `req` borrow they come from) do not straddle an await — see
    // route_pre_dispatch's note on `Send`.
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query_str = req.uri().query().map(|q| q.to_string());
    if let Some(resp) =
        route_pre_dispatch(&method, &path, query_str.as_deref(), req.headers(), &state).await
    {
        return resp;
    }

    // ── Auth gate for EVERYTHING below (SOLID R102) ──────────────
    //
    // This gate is UNCONDITIONAL on purpose. It used to be wrapped in a
    // `needs_auth` flag recomputed as `method != GET || path.starts_with(
    // "/api") || path == "/mcp"`, which classified routes a SECOND time —
    // the pre-dispatch routes above (public status page, panel/desktop SPA,
    // the three auth-checked streaming routes) already decide exactly which
    // requests are public, so the flag was provably always true here.
    //
    // A duplicated classification is a security hazard with an asymmetric
    // failure mode: if the two copies ever disagree such that a request
    // reaches this point with the flag false, the gate is SKIPPED and an
    // unauthenticated caller reaches tool dispatch (terminal_execute,
    // system_file_write → SYSTEM-level device control). Gating
    // unconditionally removes the disagreement by construction — anything
    // that falls through to the dispatcher is authenticated, full stop —
    // and the public surfaces above keep their own explicit, tested
    // behaviour. `every_dispatch_route_is_auth_gated` /
    // `deliberately_public_routes_stay_public` pin both halves.
    if let Err(resp) = check_auth(req.headers(), &state) {
        return *resp;
    }

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

    /** Route dispatch: map (method, path) -> handler result or error.
     *  Extracted from handle_request (round-91 SRP) so the main fn stays
     *  auth + body parsing + routing skeleton. */
    async fn dispatch(
        state: &AppState,
        method: &str,
        path: &str,
        body_str: &str,
        query_str: Option<&str>,
    ) -> Result<serde_json::Value, Box<Response>> {
        let result = match (method, path) {
            ("GET", "/api/spec") => api_spec(state),
            ("GET", "/api/status") => api_status(state).await,
            ("GET", "/api/sessions") => api_sessions_list(),
            ("GET", p) if p.starts_with("/api/sessions/") && p.len() > "/api/sessions/".len() => {
                match api_session_events(p) {
                    Ok(v) => v,
                    Err(resp) => return Err(Box::new(*resp)),
                }
            }
            ("GET", "/api/logs") => api_logs(),
            // Control handoff (design §D5). MUST be matched before any broader
            // /api/sessions POST arm; the `.ends_with` also keeps it from
            // swallowing a future sibling action on the same collection.
            ("POST", p) if p.starts_with("/api/sessions/") && p.ends_with("/control") => {
                let sid = session_id_from_path(p)?;
                api_session_control(state, &sid, body_str).await?
            }
            // The gate's decision. Matched before any broader arm, same as the
            // control route above.
            ("POST", p) if p.starts_with("/api/sessions/") && p.ends_with("/approval") => {
                let sid = session_id_from_path(p)?;
                api_session_approval(state, &sid, body_str).await?
            }
            ("POST", p) if p.starts_with("/api/sessions/") && p.ends_with("/grants") => {
                let sid = session_id_from_path(p)?;
                api_session_grants(state, &sid, body_str).await?
            }
            ("GET", "/api/events/poll") => {
                let after: u64 = query_param(query_str, "after")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                api_events_poll(state, after)
            }
            ("GET", "/api/settings") => api_settings_get(state).await,
            ("PUT", "/api/settings") => match api_settings_put(state, body_str) {
                Ok(v) => v,
                Err(resp) => return Err(Box::new(*resp)),
            },
            ("POST", "/api/gateway/connect") => match api_gateway_connect(state, body_str).await {
                Ok(v) => v,
                Err(resp) => return Err(Box::new(*resp)),
            },
            ("GET", "/api/plugins/status") => api_plugins_status(state).await,
            ("POST", "/api/plugins/playwright/start") => match api_playwright_start(state).await {
                Ok(v) => v,
                Err(resp) => return Err(Box::new(*resp)),
            },
            ("POST", "/api/plugins/playwright/stop") => match api_playwright_stop(state).await {
                Ok(v) => v,
                Err(resp) => return Err(Box::new(*resp)),
            },
            ("POST", p) if p.starts_with("/api/tools/") => {
                let tool_name = p.strip_prefix("/api/tools/").unwrap_or("");
                api_call_tool(state, tool_name, body_str).await
            }
            _ => serde_json::json!({"ok": false, "error": "not found"}),
        };
        Ok(result)
    }

    match dispatch(
        &state,
        method.as_str(),
        &path,
        &body_str,
        query_str.as_deref(),
    )
    .await
    {
        Ok(result) => axum::Json(result).into_response(),
        Err(resp) => *resp,
    }
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

/// Session-log reader over paths::sessions_dir().
/// HIGH(audit round): the WRITER (terminal plugin) logs to
/// paths::data_dir()/sessions — on registry-first installs the
/// exe dir is NOT the data dir (d1: D:\Vale vs C:\ProgramData\
/// Vale), and these endpoints scanned an empty dir: the audit
/// panel was permanently blind. Read the same dir; also honors
/// the "zero current_exe() guessing outside paths.rs" rule.
fn sessions_logger() -> crate::session_log::SessionLogger {
    let dir = crate::paths::sessions_dir();
    crate::session_log::SessionLogger::new(dir)
}

/// GET /api/sessions — audit trail: session list with terminal state
/// (round-56). The logger lives in the terminal plugin's private field —
/// read the same directory directly (cheap: one file per session).
fn api_sessions_list() -> serde_json::Value {
    let logger = sessions_logger();
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
    // round-87: the old literal "/api/sessions/{sid}" arm never matched a real
    // session id (exact-string match) — the audit endpoint 404'd for every
    // session. Guard-arm route; the sid charset guard now lives in
    // `session_id_from_path`, shared with the control route.
    let sid = session_id_from_path(p)?;
    let logger = sessions_logger();
    // `found` distinguishes "this session recorded nothing" from "there is no
    // readable record for it" — see `SessionLogger::events_of`. `ok` stays true
    // either way: the REQUEST succeeded.
    let rec = logger.events_of(&sid);
    Ok(serde_json::json!({
        "ok": true,
        "id": sid,
        "found": rec.found,
        // WHERE THE RECORD BEGINS. The trail is trimmed to ~2000 lines when a
        // session closes, so a long session's head is discarded by design and
        // the survivors alone cannot say so. `first_seq > 1` is that fact —
        // stated rather than left for a consumer to infer from a seq gap, and
        // about the RECORD rather than about a cause (a trim and a lost write
        // both mean "you are not seeing the beginning").
        "first_seq": rec.first_seq,
        "events": rec.events,
    }))
}

/// `POST /api/sessions/{sid}/approval` — decide the command waiting at the gate.
///
/// Body: `{"id": "<request id>", "approve": true|false}`. The `id` is required and
/// must match the live request, so a panel tab that rendered an OLD prompt cannot
/// approve a DIFFERENT command that arrived after it — the operator's "yes" is
/// always attached to the command they actually read.
///
/// `approve` is required for the same reason `holder` is on the control route: a
/// decision with no direction is not a decision, and defaulting it would mean
/// guessing whether silence meant "run it".
///
/// Nothing is logged to the audit trail here. The handoff is logged because it
/// changes WHO drives; an approval changes only whether one command runs, and
/// that command logs its own `command/start` moments later — so an extra event
/// would duplicate the record rather than complete it.
async fn api_session_approval(
    state: &AppState,
    sid: &str,
    body: &str,
) -> Result<serde_json::Value, Box<Response>> {
    let v = parse::json_body(body, |_| "invalid JSON".to_string())?;
    let id = parse::optional_trimmed_string(&v, "id")
        .ok_or_else(|| parse::invalid_params_response("id is required".to_string()))?;
    let approve = parse::optional_bool(&v, "approve").ok_or_else(|| {
        parse::invalid_params_response("approve is required (true or false)".to_string())
    })?;
    // "and remember this one". Deliberately a BOOLEAN and not a prefix: the
    // prefix is derived server-side from the command the operator was SHOWN (see
    // `term_decide_approval`), so a client cannot widen its own permissions — the
    // most it can do is ask to remember what was already on screen. Absent means
    // "no grant", the conservative default for a request that did not mention it.
    let grant = parse::optional_bool(&v, "grant").unwrap_or(false);

    // The grants in force BEFORE, so the record can name what this decision
    // newly allowed rather than repeating the whole list.
    let grants_before = state
        .terminal_mgr
        .term_approval_grants(sid)
        .await
        .unwrap_or_default();

    // Read the request BEFORE deciding it, because the decision clears it — and
    // the command is what makes the record meaningful. "approved" without the
    // command would say a yes happened without saying what to.
    let decided_command = state
        .terminal_mgr
        .term_pending_approval(sid)
        .await
        .ok()
        .flatten()
        .filter(|p| p.id == id)
        .map(|p| p.command)
        .unwrap_or_default();

    let decided = state
        .terminal_mgr
        .term_decide_approval(sid, &id, approve, grant)
        .await
        .map_err(|e| {
            // A missing session is a client error: the panel can hold a stale sid.
            parse::invalid_params_response(e.to_string())
        })?;

    // Only when a decision actually landed. `decided == false` means the request
    // had already gone — recording a yes that decided nothing would be a false
    // entry in the one log that must not contain them.
    if decided {
        sessions_logger().log_approval(
            sid,
            if approve { "approved" } else { "refused" },
            &decided_command,
        );
        // A grant is a SEPARATE fact from the approval and gets its own event:
        // "the operator said yes to this command" and "this word now runs
        // unasked" are different statements, and a reader chasing why a later
        // command did NOT prompt needs the second one. Only when a grant is
        // genuinely new — re-approving an already-allowed word is not news.
        if approve && grant {
            let after = state
                .terminal_mgr
                .term_approval_grants(sid)
                .await
                .unwrap_or_default();
            if let Some(added) = after.iter().find(|g| !grants_before.contains(g)) {
                sessions_logger().log_approval(sid, "granted", added);
            }
        }
    }

    // Report the grants now in force, so the panel renders them from the
    // decision's own response rather than waiting for its next poll — a grant the
    // operator cannot see immediately is one they cannot judge.
    let grants = state
        .terminal_mgr
        .term_approval_grants(sid)
        .await
        .unwrap_or_default();

    // PUSH on every decision, so the badge clears and the prompt disappears
    // immediately rather than at the next poll — a resolved question that stays
    // on screen is a question the operator will try to answer twice. Emitted for
    // `decided: false` too: "someone already answered" and "it expired" both
    // change what the panel should draw.
    state
        .event_bus
        .emit_term_output(serde_json::json!({ "ev": "sessions-changed" }));

    // `decided: false` is NOT an error at the HTTP level — the session exists and
    // the request was well formed, there was simply nothing waiting. The caller
    // distinguishes it, because "someone already answered" and "it timed out" are
    // both things the operator should be told rather than shown a success.
    Ok(serde_json::json!({
        "ok": true,
        "id": sid,
        "decided": decided,
        "approval_grants": grants,
    }))
}

/// `POST /api/sessions/{sid}/grants` — revoke an approval grant, or all of them.
///
/// Body: `{"grant": "<word>"}` to revoke one, or `{"all": true}` for every grant
/// on the session. A request that names NEITHER is rejected rather than treated
/// as "all": revoking everything is a consequential act that must be asked for
/// explicitly, not the default for a malformed body.
///
/// Every response carries the grants now in force, so the caller renders the
/// server's answer rather than its own guess about what a revoke did.
async fn api_session_grants(
    state: &AppState,
    sid: &str,
    body: &str,
) -> Result<serde_json::Value, Box<Response>> {
    let v = parse::json_body(body, |_| "invalid JSON".to_string())?;
    let all = parse::optional_bool(&v, "all").unwrap_or(false);
    let grant = parse::optional_trimmed_string(&v, "grant");
    if !all && grant.is_none() {
        return Err(parse::invalid_params_response(
            "provide grant (a word) or all (true)".to_string(),
        ));
    }

    // `all` wins when both are given: it is the strictly larger act, so honouring
    // the narrower one would quietly do less than the operator asked.
    let target = if all { None } else { grant.as_deref() };
    let removed = state
        .terminal_mgr
        .term_revoke_grants(sid, target)
        .await
        .map_err(|e| {
            // A missing session is a client error: the panel can hold a stale sid.
            parse::invalid_params_response(e.to_string())
        })?;
    // Taking a permission back is as much evidence as granting it. An empty
    // subject records "all", which is why `approval()` keeps "" meaningful
    // rather than dropping it.
    if removed > 0 {
        sessions_logger().log_approval(sid, "revoked", target.unwrap_or(""));
    }

    let grants = state
        .terminal_mgr
        .term_approval_grants(sid)
        .await
        .unwrap_or_default();
    Ok(serde_json::json!({ "ok": true, "id": sid, "approval_grants": grants }))
}

/// Extract and validate a session id from `/api/sessions/{sid}[...]`.
///
/// Shared by every session route. The charset guard is not cosmetic: the sid
/// flows into a FILE PATH for the audit endpoints (`events_of` →
/// `{dir}/{sid}.jsonl`), and the forward-slash split alone let a backslash
/// (0x5C, accepted in the request-target by the http crate) traverse on Windows:
/// `/api/sessions/..%5C..%5Cfoo` read `{dir}/../../foo.jsonl` (round-116).
/// Session ids are hex, so anything outside this charset is not a session.
///
/// Extracted from `api_session_events` when the control route became the second
/// consumer: a second hand-written copy of a SECURITY guard is how one of them
/// quietly loses it.
fn session_id_from_path(p: &str) -> Result<String, Box<Response>> {
    let sid = p
        .strip_prefix("/api/sessions/")
        .and_then(|s| s.split('/').next())
        .unwrap_or("")
        .to_string();
    if sid.is_empty() || !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(Box::new(built_response(
            StatusCode::BAD_REQUEST,
            "application/json",
            Body::from(r#"{"ok":false,"error":"invalid session id"}"#),
        )));
    }
    Ok(sid)
}

/// `POST /api/sessions/{sid}/control` — hand the session's keyboard to a person
/// or back to the AI (design §D5, the control plane's first piece).
///
/// The human's surface is the PANEL, so this is an HTTP route rather than an MCP
/// tool: the AI learns about a hold the moment it tries to execute (a typed
/// `human_in_control` refusal), which is the information it actually needs. It
/// does not need to poll, so no tool was added — and adding one would have meant
/// mirroring it into the gateway's MCP registry for a consumer that does not
/// exist. `terminal_list` already carries `held_by_human` for anything that does
/// want to look.
///
/// Body: `{"holder": "human" | "ai"}`. Absent/blank is rejected rather than
/// defaulted: guessing which way a malformed request wanted to move the keyboard
/// is exactly the wrong thing to be lenient about.
async fn api_session_control(
    state: &AppState,
    sid: &str,
    body: &str,
) -> Result<serde_json::Value, Box<Response>> {
    let v = parse::json_body(body, |_| "invalid JSON".to_string())?;

    // Both fields are OPTIONAL and at least one is required: this route patches
    // the session's governance, and a request that mentions neither is a client
    // bug rather than a no-op. Absent fields are left alone — never defaulted —
    // so "hand the keyboard back" cannot silently disarm the approval gate, and
    // "arm the gate" cannot silently hand the keyboard over.
    let holder = parse::optional_trimmed_string(&v, "holder");
    let approval = parse::optional_bool(&v, "approval_required");
    // The GOAL is the operator's statement of intent — the design's dispatch beat.
    // Read with the `present` distinction preserved: an ABSENT key leaves the goal
    // alone, while an empty string CLEARS it. Those are different acts and a
    // partial patch must not be able to do the second by accident.
    let goal_present = v.get("goal").is_some();
    let goal = v
        .get("goal")
        .and_then(|g| g.as_str())
        .map(|s| s.to_string());
    if holder.is_none() && approval.is_none() && !goal_present {
        return Err(parse::invalid_params_response(
            "provide holder (\"human\"|\"ai\"), approval_required (bool) and/or goal (string)"
                .to_string(),
        ));
    }
    // A non-string goal is a client bug, not a clear. Treated as absent so the
    // other fields in the same request still apply.
    if v.get("goal").is_some() && goal.is_none() {
        return Err(parse::invalid_params_response(
            "goal must be a string (empty clears it)".to_string(),
        ));
    }

    let human = match holder.as_deref() {
        None => None,
        Some("human") => Some(true),
        Some("ai") => Some(false),
        Some(other) => {
            return Err(parse::invalid_params_response(format!(
                "holder must be \"human\" or \"ai\", got {other:?}"
            )))
        }
    };

    // A missing session is a client error, not a 500: the panel can hold a stale
    // sid after the session was closed or reaped.
    let not_found = |e: DeviceError| parse::invalid_params_response(e.to_string());

    let mut held = None;
    if let Some(h) = human {
        held = Some(
            state
                .terminal_mgr
                .term_set_control(sid, h)
                .await
                .map_err(not_found)?,
        );

        // Record the handoff in the session's audit trail. Logged HERE, at the
        // point the decision is made, rather than inside the manager: the manager
        // owns the in-memory hold and must not grow a dependency on the log, while
        // this is the layer that knows a decision actually happened.
        //
        // Best-effort by design — `log_control` returns nothing, because a log
        // failure must not cost the operator the keyboard. The consequence is that
        // the record can be MISSING an event; it can never invent one.
        sessions_logger().log_control(sid, if h { "human" } else { "ai" });
    }

    let approval_required_before = state.terminal_mgr.term_approval_required(sid).await.ok();
    let mut approval_required = None;
    if let Some(req) = approval {
        let now = state
            .terminal_mgr
            .term_set_approval_required(sid, req)
            .await
            .map_err(not_found)?;
        // ARMING THE GATE IS EVIDENCE. Recorded only when the mode actually
        // CHANGED: a panel that re-sends the same value on every poll would
        // otherwise bury the one transition that matters under a wall of
        // no-ops. The trail is read by a person, and a person wants events.
        if Some(now) != approval_required_before {
            sessions_logger().log_approval(sid, if now { "armed" } else { "disarmed" }, "");
        }
        approval_required = Some(now);
    }

    let mut goal_out = None;
    if let Some(text) = goal {
        let stored = state
            .terminal_mgr
            .term_set_goal(sid, &text)
            .await
            .map_err(not_found)?;
        // Recorded in the audit trail as its own event: the live goal dies with
        // the session, but "this session was FOR x" is history. Logged AFTER the
        // store succeeded, and the CLEARED case logs an empty string rather than
        // nothing — "someone withdrew the objective" is itself a fact a reader
        // needs, and silence would leave the previous goal looking current.
        sessions_logger().log_goal(sid, stored.as_deref().unwrap_or(""));
        goal_out = Some(stored);
    }

    Ok(serde_json::json!({
        "ok": true,
        "id": sid,
        "held_by_human": held,
        "approval_required": approval_required,
        "goal": goal_out,
    }))
}

/// GET /api/logs — the device's own logs, so a remote client can see WHY the
/// agent behaved oddly without asking someone to open files (or guessing a path
/// and `cat`-ing it over a PTY).
///
/// THE PATH IS THE BUG THIS FIXES. The handler used to read
/// `exe_dir()/vale-update.log`, but layout v2 MOVES that file — along with
/// `agent.log`, `installer.log`, `install-result.txt` and `startup.log` — into
/// `DataDir\logs` (`paths.rs`'s migration list owns that move, and its test
/// pins it). So the route read a path the migration had just emptied and could
/// only ever answer `""` on a v2 device. Every writer had already followed the
/// move: the update swap script writes `{logs}\vale-update.log`, `filelog.rs`
/// rotates `agent.log` there, and `mcp_client` caps `mcp_diag.log` there.
///
/// `logs_dir()` is the single resolution point, so this reads where the writers
/// write and a future move touches one place again.
///
/// The reply carries the TAIL of each file: an operator wants the newest lines,
/// and `agent.log` is size-rotating so it is bounded but not small. `tail` cuts
/// on a char boundary with a hard byte budget (the naive `&s[len - n..]` panics
/// mid-character, which this crate has paid for three times).
fn api_logs() -> serde_json::Value {
    let dir = crate::paths::logs_dir();
    // The update log is the one this route was invented for; the other two are
    // the agent's own narration (55 `tracing::` sites land in agent.log and
    // nothing read it before) and the MCP bridge's diagnostics. Names, not
    // paths: adding a fourth is one entry here.
    let read = |name: &str| -> serde_json::Value {
        match std::fs::read_to_string(dir.join(name)) {
            Ok(text) => serde_json::json!({
                "name": name,
                "present": true,
                // 64 KiB per file: three files fit comfortably in one reply
                // while staying far below the clip budget the panel renders.
                "log": crate::text::tail(&text, 64 * 1024),
            }),
            // ABSENT, not empty: "the agent never wrote this" and "it wrote
            // nothing" are different facts and a reader must be able to tell
            // them apart — the same discipline the evidence feed follows.
            Err(_) => serde_json::json!({ "name": name, "present": false, "log": "" }),
        }
    };
    serde_json::json!({
        "ok": true,
        "dir": dir.to_string_lossy(),
        "logs": [
            read("agent.log"),
            read("vale-update.log"),
            read("mcp_diag.log"),
        ],
    })
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
    let tunnel_configured = crate::paths::tunnel_file().exists();
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
    // USAGE as well as the caps. The operator could lower a cap to below the
    // current contents — after which the device silently starts evicting the
    // OLDEST knowledge — with nothing in the UI able to show it was about to
    // happen. These two numbers come from the SAME store the cap is enforced
    // against, so the meter cannot disagree with the eviction it explains.
    //
    // Reported UNCONDITIONALLY, including at zero, because the caps are: a
    // consumer must be able to divide usage by cap without special-casing an
    // absent field. (Contrast `pending_approvals` on /api/status, which IS
    // omitted at zero — there a non-zero value is an EVENT, whereas here zero
    // is a legitimate reading.)
    let mem_entries = state.memory.len();
    let mem_bytes = state.memory.total_bytes_live();
    serde_json::json!({
        "ok": true,
        "buffer_mb": state.terminal_buf_bytes.load(std::sync::atomic::Ordering::Relaxed) / (1024 * 1024),
        "console_url": console_url,
        "tunnel_configured": tunnel_configured,
        "tunnel_running": tunnel_running,
        "memory_max_entries": mem.max_entries,
        "memory_max_bytes_mb": mem.max_bytes / (1024 * 1024),
        "memory_retention_days": mem.retention_days,
        "memory_entries": mem_entries,
        "memory_bytes": mem_bytes,
    })
}

/// PUT /api/settings — write the runtime-configurable values (round-69).
/// Write-through (audit A4): changes land in the LIVE config AND config.yaml
/// in one update_config step. Err carries the ready-made error response,
/// byte-identical to the pre-extraction early return (including its
/// HTTP-200 Json shape).
fn api_settings_put(state: &AppState, body: &str) -> Result<serde_json::Value, Box<Response>> {
    let v: serde_json::Value = parse::json_body(body, |e| format!("invalid JSON: {e}"))?;
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
    // `Option<Option<String>>`: the OUTER option is "the request speaks to
    // console_url" (absent ⇒ leave the binding alone), the inner one is the
    // value (blank ⇒ explicit clear).
    let console_url = v
        .get("console_url")
        .map(|_| parse::optional_trimmed_string(&v, "console_url"));
    /** Parse memory capacity settings from a JSON value.
     *  Returns (entries, bytes, retention, changed) where changed indicates
     *  whether any key was present (absent = leave unchanged). */
    fn parse_memory_settings(
        v: &serde_json::Value,
    ) -> (Option<usize>, Option<usize>, Option<Option<u64>>, bool) {
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
        (mem_entries, mem_bytes, mem_retention, mem_changed)
    }

    // Write-through (audit A4): merge onto the CURRENT in-process snapshot
    // and persist via update_config — the runtime buffer cap, the in-process
    // config and config.yaml all move together (the old code rewrote the
    // file from a disk re-read and left state.config stale until restart).
    // Best-effort persist (as before): a read-only install dir must not fail
    // the PUT — the runtime value already took effect. With no config_path
    // (dev invocations), update_config still updates memory and writes
    // nothing.
    let (mem_entries, mem_bytes, mem_retention, mem_changed) = parse_memory_settings(&v);

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
    // Bare wording here (no serde detail) — documented and preserved.
    let v: serde_json::Value = parse::json_body(body, |_| "invalid JSON".to_string())?;
    // ONE evaluation of the console_url rule. The reported binding and the
    // PERSISTED binding used to be computed by two independent copies of it —
    // they agreed only because both copies happened to match, so editing one
    // would have made the response disagree with what the device stored.
    // `Option<Option<String>>`: outer = "the request speaks to console_url".
    let console_url_patch = v
        .get("console_url")
        .map(|_| parse::optional_trimmed_string(&v, "console_url"));
    let console_url = console_url_patch.clone().flatten();
    let reg_key = parse::optional_trimmed_string(&v, "reg_key");
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
    if let Some(val) = console_url_patch {
        cfg.platform.console_url = val;
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
    run_playwright_op(state.playwright.start()).await
}

/// POST /api/plugins/playwright/stop — playwright-mcp process control for
/// the panel's plugins page.
async fn api_playwright_stop(state: &AppState) -> Result<serde_json::Value, Box<Response>> {
    run_playwright_op(state.playwright.stop()).await
}

/// Run a playwright manager op: {ok:true, ...payload} on success, a 500
/// JSON envelope on failure. api_playwright_start/stop used to be two
/// near-identical copies of this shape.
async fn run_playwright_op(
    op: impl std::future::Future<Output = Result<serde_json::Value, impl ToString>>,
) -> Result<serde_json::Value, Box<Response>> {
    match op.await {
        Ok(v) => {
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

// ── SSE event stream ─────────────────────────────────────────

/// stage-n SSE audit LOW: bound concurrent SSE connections so a flood of
/// viewers can't exhaust tasks/memory. 64 slots shared across /api/events
/// and /api/events/term; each slot is a permit that releases on drop.
/// P2-4: read the boxed-component version manifest (`vale setup`/`vale update`
/// write `<install>/boxed-versions.json`). Returns None when absent or
/// unparseable — advisory only, never fail-closed.
fn boxed_versions() -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(crate::paths::boxed_versions_file()).ok()?;
    serde_json::from_str(&text).ok()
}

async fn api_status(state: &AppState) -> serde_json::Value {
    let serial = state.serial_pool.list_open_ports();
    // stage-n: health diagnostics — uptime (a low value right after an
    // update/crash is a red flag) and the live terminal session count
    // (leaked sessions show up here without needing terminal_history).
    let uptime_secs = state.started_at.elapsed().as_secs();
    let live_sessions = state.terminal_mgr.term_list().await.len();
    // How many commands are WAITING on a human decision, device-wide.
    //
    // Round 14 made the approval gate answerable: a question now outlives the
    // execute that asked it, so an operator who was not watching can still
    // answer inside its TTL. But the push that announces a question
    // (`sessions-changed`) terminates in an OPEN panel's renderer — so every
    // other surface that already polls THIS endpoint (the Electron tray on its
    // 30 s health poll, the console's fleet card) could not say "a decision is
    // waiting", which is the one fact that rework exists to deliver. One count
    // here turns every existing consumer into a notification surface, with no
    // new route and no change to any other endpoint.
    //
    // Deliberately a COUNT and not the requests: the detail already rides
    // `terminal_list`, and repeating it would make this endpoint a second
    // source of truth for governance state. `term_list` is cheap (it projects
    // in-memory rows) and this endpoint is already called on a 30 s cadence.
    let pending_approvals = state
        .terminal_mgr
        .term_list()
        .await
        .iter()
        .filter(|s| s.pending_approval.is_some())
        .count();
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
    // Inserted AFTER construction when non-zero, never built as an `Option`
    // inside the `json!` — `json!` renders `None` as `"pending_approvals":
    // null`, not as an omitted key, so the field would be PRESENT on every
    // response and a consumer could not tell "nothing waiting" from "an older
    // agent that never sends this". Exactly the trap round 13 recorded for
    // `runs::clean`, caught here by this change's own test. The `release` field
    // below already used the insert-after shape for the same reason.
    if pending_approvals > 0 {
        out["pending_approvals"] = serde_json::json!(pending_approvals);
    }
    // round-304: report the npm RELEASE version (written by the swap
    // scripts, agent_update + vale.js) alongside the Cargo protocol
    // version — /api/status consumers otherwise see 1.0.145 forever
    // while the device runs 1.2.x. Omitted when absent (fresh installs).
    if let Ok(rel) = std::fs::read_to_string(crate::paths::release_marker_file()) {
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

    /// An UNAUTHENTICATED request — no Authorization header at all.
    fn req_anon(method: &str, path: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(path)
            .body(Body::empty())
            .unwrap()
    }

    /// As [`req_anon`], with a JSON body.
    ///
    /// Exists because the shape that matters for the credential rule is
    /// "a WELL-FORMED request carrying a plausible run id, and no token" — the
    /// old anonymous helper could only send an empty body, so an id could never
    /// appear in the request being refused.
    fn req_anon_with_json(method: &str, path: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
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

    #[test]
    fn spec_snapshot_pins_every_device_tool_for_the_gateway_contract() {
        // `agent/spec-tools.json` is the machine-readable face of THIS
        // registry. gateway/test/mcp-handler.test.mjs fails when a name in it
        // is neither registered on the console MCP surface nor explicitly
        // listed as not-exposed — because the old gateway contract compared
        // its registry against a hand-typed copy of ITSELF, 21 device tools
        // (the whole system_*/memory_*/mcp_client_* families) stayed invisible
        // to MCP clients with every gate green. Regenerate with:
        //   VALE_REFRESH_SPEC=1 cargo test --features terminal,keyring spec_snapshot
        //
        // PARAMETER NAMES joined the snapshot for the same reason the tool names
        // did, one drift later: the gateway advertises its OWN inputSchema for
        // every device-direct tool, so a parameter added here is invisible to a
        // console client — it cannot discover it, and a schema-validating client
        // would refuse to send it. `terminal_execute`'s `intent`/`considered`
        // shipped exactly that way and were found by reading, not by a gate.
        // Names only, no types: enough to catch a MISSING parameter (the
        // failure that matters — an unadvertised one cannot be sent), while a
        // type difference between the two sides is a separate question this
        // snapshot is not trying to answer.
        let spec = api_spec(&state());
        let mut entries: Vec<serde_json::Value> = Vec::new();
        for p in spec["plugins"].as_array().unwrap() {
            for t in p["tools"].as_array().unwrap() {
                let mut params: Vec<String> = t["schema"]["properties"]
                    .as_object()
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default();
                params.sort();
                entries.push(serde_json::json!({
                    "name": t["name"].as_str().unwrap(),
                    "plugin": p["name"].as_str().unwrap(),
                    "params": params,
                }));
            }
        }
        entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        let rendered = format!(
            "// Device MCP tool inventory (name + owning plugin + parameter names),\n\
             // generated from\n\
             // the live PluginRegistry by web::tests::spec_snapshot_pins_every_device_tool_for_the_gateway_contract.\n\
             // The gateway MCP registry contract test reads this file.\n\
             // Do not hand-edit: VALE_REFRESH_SPEC=1 cargo test spec_snapshot, then commit.\n{}\n",
            serde_json::to_string_pretty(&serde_json::Value::Array(entries)).unwrap()
        );
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/spec-tools.json");
        if std::env::var("VALE_REFRESH_SPEC").is_ok_and(|v| !v.is_empty()) {
            std::fs::write(path, &rendered).expect("write spec-tools.json");
            return;
        }
        let committed = std::fs::read_to_string(path).unwrap_or_else(|e| {
            panic!("{path} missing ({e}) — run VALE_REFRESH_SPEC=1 cargo test spec_snapshot")
        });
        assert_eq!(
            committed.trim_end(),
            rendered.trim_end(),
            "{path} is stale vs the live registry — run VALE_REFRESH_SPEC=1 cargo test spec_snapshot and commit it"
        );
    }

    #[tokio::test]
    async fn spec_lists_terminal_plugin() {
        let resp = handle_request(req("GET", "/api/spec"), state()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        // terminal + update + mcp-client + design + playwright + memory + system
        // + runs (the AI-execution identity surface, added with the run feature:
        // a plugin registered but not listed here would keep its tools out of
        // /api/spec, i.e. invisible to every client that discovers through it).
        assert_eq!(v["plugins"].as_array().unwrap().len(), 8);
    }

    #[tokio::test]
    async fn status_ok() {
        let resp = handle_request(req("GET", "/api/status"), state()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
    }

    /// `/api/status` reports a WAITING DECISION, because the push cannot reach
    /// every surface that asks.
    ///
    /// The approval rework made a question outlive the execute that asked it, so
    /// an operator who was away can still answer inside the TTL. The push that
    /// announces one (`sessions-changed`) only reaches an OPEN panel; the tray
    /// and the console fleet card poll `/api/status` instead, and could not say
    /// "a decision is waiting" — the one fact the rework exists to deliver.
    ///
    /// Two properties, and the second is the one a careless implementation gets
    /// wrong: the count APPEARS when a question is open, and it is ABSENT (not
    /// zero) when none is, so a consumer can render a badge without having to
    /// tell "nothing waiting" from "older agent that never sends this field".
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn status_reports_a_waiting_decision_and_omits_it_when_there_is_none() {
        let (st, cfg_path) = state_with_cfg("status-pending", CFG_YAML_TOKEN_ONLY);

        // Idle: the field is ABSENT, not zero.
        let v = json_body(handle_request(req("GET", "/api/status"), st.clone()).await).await;
        assert!(
            v.get("pending_approvals").is_none(),
            "with nothing waiting the field must be OMITTED, so a consumer can \
             tell 'nothing waiting' from 'an older agent that never sends it' — \
             got {v}"
        );

        // Arm a session and start a gated execute; it registers a question.
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;
        handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"approval_required":true}"#,
            ),
            st.clone(),
        )
        .await;
        let exec = {
            let (st2, sid2) = (st.clone(), sid.clone());
            tokio::spawn(async move {
                handle_request(
                    req_with_json(
                        "POST",
                        "/api/tools/terminal_execute",
                        &format!(r#"{{"session_id":"{sid2}","command":"echo status-probe"}}"#),
                    ),
                    st2,
                )
                .await
            })
        };
        // Bounded wait for the registration, not a bare check: the execute runs
        // on a spawned task and asserting immediately is a race.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if st
                    .terminal_mgr
                    .term_pending_approval(&sid)
                    .await
                    .unwrap()
                    .is_some()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the gate must register a question");

        let v = json_body(handle_request(req("GET", "/api/status"), st.clone()).await).await;
        assert_eq!(
            v["pending_approvals"].as_u64(),
            Some(1),
            "a waiting decision must be visible to every surface that polls \
             /api/status — the tray and the console fleet card cannot see the \
             panel's push: {v}"
        );

        // Answer it, so the spawned execute completes and nothing is left
        // registered for the next test in this process.
        let id = st
            .terminal_mgr
            .term_pending_approval(&sid)
            .await
            .unwrap()
            .unwrap()
            .id;
        st.terminal_mgr
            .term_decide_approval(&sid, &id, false, false)
            .await
            .unwrap();
        let _ = exec.await;

        // And it goes back to ABSENT once nothing is waiting.
        let v = json_body(handle_request(req("GET", "/api/status"), st.clone()).await).await;
        assert!(
            v.get("pending_approvals").is_none(),
            "an answered question must clear the count: {v}"
        );

        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
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
    async fn tool_error_envelope_survives_the_api_wrapper() {
        // THE DEVICE ERROR CONTRACT, pinned on the /api/tools side (SOLID
        // R101). Two failure families reach a client and this wrapper treats
        // them differently — deliberately, and now on the record:
        //
        //   typed   Err(DeviceError)         → {"ok": false, "error", "code"}
        //   in-band Ok(plugins::tool_error)  → {"ok": true,  "result": {"ok": false, "error"}}
        //
        // The in-band family is the majority of device tools (46 sites). Its
        // OUTER ok is TRUE, so the gateway's round-58 check (`data.ok ===
        // false`) does not classify it as a failure — the message survives as
        // text inside a result the model reads. That is the long-standing MCP
        // behaviour; this test exists so changing it is a visible decision
        // rather than a silent drift.
        let missing = if cfg!(windows) {
            r"C:\vale-no-such-file-r101"
        } else {
            "/vale-no-such-file-r101"
        };
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/tools/system_file_stat",
                &serde_json::json!({ "path": missing }).to_string(),
            ),
            state(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "in-band failures are HTTP 200"
        );
        let v = json_body(resp).await;
        assert_eq!(
            v["ok"], true,
            "the OUTER ok is true for the in-band family — see the doc comment"
        );
        assert!(
            v.get("code").is_none(),
            "in-band failures carry no top-level code"
        );
        assert_eq!(v["result"]["ok"], false, "the tool's own envelope is kept");
        assert!(
            v["result"]["error"]
                .as_str()
                .is_some_and(|e| e.contains("stat ")),
            "the tool's message survives verbatim: {}",
            v["result"]
        );
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
        // NO Authorization header at all (the name says what it means — this
        // test used to send req(), which carries a *wrong* token, so the
        // genuinely-missing-header case had no coverage until R102).
        let mut cfg = Config::default();
        cfg.server.device_token = Some("sekret".into());
        let st = Arc::new(AppState::new(cfg));
        let resp = handle_request(req_anon("GET", "/api/status"), st.clone()).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        // A WRONG token must fail identically (same envelope, no oracle).
        let resp = handle_request(req_with_token("GET", "/api/status", "nope"), st).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            json_body(resp).await,
            serde_json::json!({"ok": false, "error": "unauthorized"})
        );
    }

    /// STRUCTURAL PIN for the R108 seam: `route_pre_dispatch` decides whether
    /// a request is answered before the API pipeline at all.
    ///
    /// The two tests around this one pin the CONSEQUENCE (dispatch routes are
    /// gated; public routes are not). This pins the MECHANISM, so the split
    /// cannot quietly rot: a dispatcher route that starts being answered
    /// early would bypass the auth gate entirely, and a public route that
    /// stops being answered early would 401 the panel SPA.
    ///
    /// Note this calls `route_pre_dispatch` directly with NO Authorization
    /// header: the fall-through cases must be `None` *regardless* of auth,
    /// because authenticating is the caller's job, not the router's.
    #[tokio::test]
    async fn pre_dispatch_owns_exactly_the_public_surface() {
        let st = state();
        let method_of = |m: &str| Method::from_bytes(m.as_bytes()).expect("valid method");
        let headers_of = |m: &str, p: &str| req_anon(m, p).headers().clone();

        // Dispatcher routes fall THROUGH. `/api/events` and `/api/events/term`
        // are deliberately absent — they ARE pre-dispatch routes (they stream,
        // so they run their own auth instead of waiting for a body).
        for (m, p) in [
            ("GET", "/api/spec"),
            ("GET", "/api/status"),
            ("GET", "/api/sessions"),
            ("GET", "/api/sessions/some-session-id"),
            ("GET", "/api/logs"),
            ("GET", "/api/events/poll"),
            ("GET", "/api/settings"),
            ("PUT", "/api/settings"),
            ("POST", "/api/gateway/connect"),
            ("GET", "/api/plugins/status"),
            ("POST", "/api/plugins/playwright/start"),
            ("POST", "/api/plugins/playwright/stop"),
            ("POST", "/api/tools/terminal_list"),
            ("GET", "/mcp"),
            ("POST", "/mcp"),
        ] {
            assert!(
                route_pre_dispatch(&method_of(m), p, None, &headers_of(m, p), &st)
                    .await
                    .is_none(),
                "{m} {p} is answered BEFORE the auth gate — it would bypass it"
            );
        }

        // Public surfaces are answered HERE, with no token at all.
        for (m, p) in [
            ("GET", "/"),
            ("GET", "/panel"),
            ("GET", "/panel/"),
            ("GET", "/desktop"),
            ("GET", "/desktop/"),
            ("GET", "/panel/panel.js"),
            ("GET", "/desktop/panel.css"),
            ("GET", "/some-unknown-page"),
        ] {
            assert!(
                route_pre_dispatch(&method_of(m), p, None, &headers_of(m, p), &st)
                    .await
                    .is_some(),
                "{m} {p} must be answered before the gate (documented public surface)"
            );
        }

        // The evidence endpoints run their OWN auth and are pre-dispatch: they
        // must reject an anonymous caller here, not fall through.
        for p in ["/api/browser/pwshots", "/api/browser/actions"] {
            let resp = route_pre_dispatch(&method_of("GET"), p, None, &headers_of("GET", p), &st)
                .await
                .expect("evidence endpoints are answered pre-dispatch");
            assert_eq!(
                resp.status(),
                StatusCode::UNAUTHORIZED,
                "{p} must reject an anonymous caller pre-dispatch"
            );
        }
    }

    /// THE APPROVAL POSTURE IS EVIDENCE — the gap that only a REAL RUN exposed.
    ///
    /// Every unit test passed while arming the gate left no trace at all: the
    /// hold was recorded, the goal was recorded, and the single most
    /// consequential switch in the feature — the one that decides whether
    /// commands run unasked — was invisible. A reader could not tell whether a
    /// command ran because the operator approved it or because the gate was never
    /// on, which is precisely the question the evidence beat exists to answer.
    ///
    /// This drives the REAL routes in order and then reads the trail, because the
    /// defect was not in any one piece: the manager stored the mode correctly, the
    /// route returned it correctly, and only the joined-up history was missing.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn the_approval_posture_is_recorded_in_the_trail() {
        let (st, cfg_path) = state_with_cfg("approval-audit", CFG_YAML_TOKEN_ONLY);
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;

        let ctl = |body: &'static str| {
            let st = st.clone();
            let sid = sid.clone();
            async move {
                handle_request(
                    req_with_json("POST", &format!("/api/sessions/{sid}/control"), body),
                    st,
                )
                .await
            }
        };

        // Arm, then arm AGAIN — the second must not add a second event, or a
        // panel polling this route would bury the transition it exists to show.
        assert_eq!(
            ctl(r#"{"approval_required":true}"#).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            ctl(r#"{"approval_required":true}"#).await.status(),
            StatusCode::OK
        );

        // Approve a request WITH a grant, through the real routes.
        let exec = {
            let st2 = st.clone();
            let sid2 = sid.clone();
            tokio::spawn(async move {
                handle_request(
                    req_with_json(
                        "POST",
                        "/api/tools/terminal_execute",
                        &format!(r#"{{"session_id":"{sid2}","command":"echo audited"}}"#),
                    ),
                    st2,
                )
                .await
            })
        };
        let id = {
            let st3 = st.clone();
            let sid3 = sid.clone();
            tokio::time::timeout(std::time::Duration::from_secs(5), async move {
                loop {
                    if let Some(p) = st3.terminal_mgr.term_pending_approval(&sid3).await.unwrap() {
                        break p.id;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("the gate must prompt")
        };
        let resp = handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/approval"),
                &format!(r#"{{"id":"{id}","approve":true,"grant":true}}"#),
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let _ = exec.await;

        // Revoke, then disarm.
        let resp = handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/grants"),
                r#"{"all":true}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            ctl(r#"{"approval_required":false}"#).await.status(),
            StatusCode::OK
        );

        // And the trail tells the whole story, in order.
        let resp = handle_request(req("GET", &format!("/api/sessions/{sid}")), st.clone()).await;
        let events = json_body(resp).await["events"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let posture: Vec<(String, String)> = events
            .iter()
            .filter(|e| e["kind"] == "approval")
            .map(|e| {
                (
                    e["status"].as_str().unwrap_or("").to_string(),
                    e["text"].as_str().unwrap_or("").to_string(),
                )
            })
            .collect();
        assert_eq!(
            posture,
            vec![
                ("armed".to_string(), String::new()),
                // `asked` comes FIRST among the decision events, and that
                // ordering is the audit's whole value here: it records that a
                // question was PUT to a person before anything answered it.
                // Without it an unanswered or expired gate leaves no trace at
                // all, so a run that stopped because nobody was watching looks
                // identical to one that was never gated.
                ("asked".to_string(), "echo audited".to_string()),
                ("approved".to_string(), "echo audited".to_string()),
                ("granted".to_string(), "echo".to_string()),
                ("revoked".to_string(), String::new()),
                ("disarmed".to_string(), String::new()),
            ],
            "the trail must explain WHY a command ran unasked: arming, the QUESTION, \
             the decision, what it newly allowed, and taking it back. Note `armed` \
             appears ONCE despite two identical requests."
        );

        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
    }

    /// A decision that decided NOTHING is not recorded as a decision.
    ///
    /// The stale-id case: an operator clicks "run it" a moment after the request
    /// expired. The route answers honestly (`decided: false`), and the trail must
    /// not gain a yes for a command nobody authorised — a false entry in the one
    /// log that has to be trustworthy.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_decision_that_decided_nothing_leaves_no_record() {
        let (st, cfg_path) = state_with_cfg("approval-noop", CFG_YAML_TOKEN_ONLY);
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;

        let resp = handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/approval"),
                r#"{"id":"ap-does-not-exist","approve":true,"grant":true}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(json_body(resp).await["decided"], false);

        let resp = handle_request(req("GET", &format!("/api/sessions/{sid}")), st.clone()).await;
        let events = json_body(resp).await["events"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(
            !events.iter().any(|e| e["kind"] == "approval"),
            "nothing was decided, so nothing may be recorded: {:?}",
            events
                .iter()
                .filter(|e| e["kind"] == "approval")
                .collect::<Vec<_>>()
        );

        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
    }

    /// THE OPERATION TIMELINE, end to end: a terminal command and a browser
    /// action written through their REAL producers come back on ONE axis.
    ///
    /// The unit pins prove the merge function; this proves the ROUTE reaches it
    /// with the right directories and the right auth — a route with the wrong
    /// dir or the wrong guard would leave every other test green.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn the_operation_route_merges_terminal_and_browser_records() {
        let (st, cfg_path) = state_with_cfg("operation-e2e", CFG_YAML_TOKEN_ONLY);

        // A real terminal command, through the real tool surface.
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/tools/terminal_execute",
                &serde_json::json!({
                    "session_id": sid,
                    // Unique per RUN, not just per session: the sessions dir
                    // persists across runs, so a fixed probe string matches an
                    // older run's event too and the assertion below picks the
                    // wrong one (it did, on the second run).
                    "command": format!("echo operation-probe-{sid}"),
                    "intent": "the terminal half of the timeline",
                })
                .to_string(),
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // A real browser action, through the shared evidence writer.
        //
        // The dir is created FIRST, as every real producer does before writing
        // evidence. `append_action_line` is best-effort by contract — a missing
        // directory must never fail the tool call that produced the action — so
        // skipping this makes the append a silent no-op and the test would blame
        // the merge for a missing file. (It did, on the first run.)
        let ev_dir = crate::paths::evidence_dir();
        std::fs::create_dir_all(&ev_dir).unwrap();
        crate::evidence::append_action_line(
            &ev_dir,
            crate::now_millis(),
            &serde_json::json!({"script": "mcp: browser_navigate url=http://probe", "exit_code": 0}),
        );

        let resp = handle_request(req("GET", "/api/operation"), st.clone()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        let events = v["events"].as_array().cloned().unwrap_or_default();

        let sources: Vec<&str> = events.iter().filter_map(|e| e["source"].as_str()).collect();
        assert!(
            sources.contains(&"terminal") && sources.contains(&"browser"),
            "the timeline must carry BOTH feeds, got {sources:?}"
        );
        // The terminal half keeps its reasoning AND its session attribution.
        let cmd = events
            .iter()
            .find(|e| e["command"] == format!("echo operation-probe-{sid}"))
            .expect("the command is on the timeline");
        assert_eq!(cmd["intent"], "the terminal half of the timeline");
        assert_eq!(cmd["session"].as_str(), Some(sid.as_str()));
        // The browser half has no session — the browser is device-level.
        let act = events
            .iter()
            .find(|e| e["source"] == "browser")
            .expect("the browser action is on the timeline");
        assert!(act["session"].is_null());

        // Ordered by the explicit millisecond stamp, and the cursor matches the
        // newest entry so a poller can pass it straight back.
        let stamps: Vec<u64> = events.iter().filter_map(|e| e["ts_ms"].as_u64()).collect();
        let mut sorted = stamps.clone();
        sorted.sort_unstable();
        assert_eq!(stamps, sorted, "the timeline must be time-ordered");
        assert_eq!(
            v["cursor_ms"].as_u64(),
            stamps.last().copied(),
            "cursor_ms must be the newest stamp in the reply"
        );

        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
    }

    /// RUN IDENTITY, end to end through the REAL tool surface: `run_begin` mints
    /// an id, a command carries it, and `/api/operation` returns both the run
    /// record and the stamped event so a reader can group them.
    ///
    /// This is the test the whole feature exists for. The unit pins prove the
    /// log and the merge separately; only this proves the three layers agree on
    /// ONE string — and the layers are hand-mirrored (a tool schema, an audit
    /// field, an allowlist mapping), which is exactly where this repo has been
    /// bitten before: a name registered on one side and unknown on the other is
    /// silent with every other gate green.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_run_declared_through_the_tool_surface_groups_the_work_it_names() {
        let (st, cfg_path) = state_with_cfg("run-e2e", CFG_YAML_TOKEN_ONLY);

        // 1. Declare the run through the tool the AI actually calls.
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/tools/run_begin",
                &serde_json::json!({
                    "label": "provision the ONU",
                    "goal": "get it online",
                })
                .to_string(),
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["ok"], true, "run_begin answers the in-band envelope");
        let run_id = v["result"]["run_id"]
            .as_str()
            .expect("run_begin must return the minted id")
            .to_string();
        assert!(run_id.starts_with("run-"), "id shape: {run_id}");

        // 2. Do some work inside it.
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;
        let probe = format!("echo run-probe-{sid}");
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/tools/terminal_execute",
                &serde_json::json!({
                    "session_id": sid,
                    "command": probe,
                    "intent": "the work inside the run",
                    "run_id": run_id,
                })
                .to_string(),
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // 3. A command with NO run id must stay unattributed — the property that
        //    keeps the grouping honest rather than merely plausible.
        let loose = format!("echo loose-{sid}");
        handle_request(
            req_with_json(
                "POST",
                "/api/tools/terminal_execute",
                &serde_json::json!({"session_id": sid, "command": loose}).to_string(),
            ),
            st.clone(),
        )
        .await;

        // 4. Read the timeline the operator reads.
        let resp = handle_request(req("GET", "/api/operation"), st.clone()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;

        let runs = v["runs"].as_array().cloned().unwrap_or_default();
        let run = runs
            .iter()
            .find(|r| r["run_id"] == run_id.as_str() && r["kind"] == "run/begin")
            .expect("the declared run is on the timeline");
        assert_eq!(run["label"], "provision the ONU");
        assert_eq!(run["goal"], "get it online");

        let events = v["events"].as_array().cloned().unwrap_or_default();
        let mine = events
            .iter()
            .find(|e| e["command"] == probe)
            .expect("the command is on the timeline");
        assert_eq!(
            mine["run_id"].as_str(),
            Some(run_id.as_str()),
            "the command must carry the id run_begin minted — if this fails the id \
             is minted and forgotten, and no view can ever group the work"
        );

        let other = events
            .iter()
            .find(|e| e["command"] == loose)
            .expect("the unattributed command is on the timeline too");
        assert!(
            other["run_id"].is_null(),
            "a command sent without a run must NOT be absorbed into one"
        );

        // 5. Close it, and confirm the closure is visible.
        handle_request(
            req_with_json(
                "POST",
                "/api/tools/run_end",
                &serde_json::json!({"run_id": run_id, "outcome": "done"}).to_string(),
            ),
            st.clone(),
        )
        .await;
        let v = json_body(handle_request(req("GET", "/api/operation"), st.clone()).await).await;
        let runs = v["runs"].as_array().cloned().unwrap_or_default();
        assert_eq!(
            runs.iter()
                .find(|r| r["kind"] == "run/end" && r["run_id"] == run_id.as_str())
                .expect("run_end is recorded")["outcome"],
            "done"
        );

        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
    }

    /// A run id is a LABEL: presenting one grants NOTHING.
    ///
    /// The behavioural half of the rule `runs.rs` states in prose and pins by
    /// source scan. The device has one token and possession of it IS the identity
    /// (`web/panel.rs`), so an unauthenticated caller who presents a REAL,
    /// well-formed id minted by this very device must still be refused.
    #[tokio::test]
    async fn a_run_id_never_grants_access() {
        let (st, cfg_path) = state_with_cfg("run-auth", CFG_YAML_TOKEN_ONLY);

        let real = crate::runs::begin(&crate::paths::runs_dir(), Some("real"), None);
        let resp = handle_request(
            req_anon_with_json(
                "POST",
                "/api/tools/terminal_execute",
                &serde_json::json!({"command": "id", "session_id": "s1", "run_id": real})
                    .to_string(),
            ),
            st.clone(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "a run id must never stand in for the device token"
        );

        let resp = handle_request(req_anon("GET", "/api/operation"), st.clone()).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let _ = std::fs::remove_file(cfg_path);
    }

    /// The route is AUTH-GATED — it carries every session's commands, goals and
    /// plans, so an anonymous read is the whole device's activity history.
    #[tokio::test]
    async fn the_operation_route_refuses_an_anonymous_read() {
        let (st, cfg_path) = state_with_cfg("operation-auth", CFG_YAML_TOKEN_ONLY);
        let resp = handle_request(req_anon("GET", "/api/operation"), st).await;
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "the operation timeline must never be readable without a token"
        );
        let _ = std::fs::remove_file(cfg_path);
    }

    /// THE PLAN, end to end: the agent declares it through the TOOL surface, the
    /// operator's view of the session carries it, a command claims a step, and the
    /// trail records both.
    ///
    /// The plan is the AGENT's statement (a tool), the goal is the OPERATOR's (a
    /// control route) — this drives both and shows they land in different places,
    /// which is the distinction the whole feature rests on.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_declared_plan_reaches_the_session_the_trail_and_the_command() {
        let (st, cfg_path) = state_with_cfg("plan-e2e", CFG_YAML_TOKEN_ONLY);
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;

        let call = |body: serde_json::Value| {
            let st = st.clone();
            async move {
                handle_request(
                    req_with_json("POST", "/api/tools/terminal_plan", &body.to_string()),
                    st,
                )
                .await
            }
        };

        // (a) Omitted `plan` READS without changing anything.
        let resp = call(serde_json::json!({ "session_id": sid })).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            json_body(resp).await["result"]["plan"]
                .as_array()
                .map(|a| a.len()),
            Some(0)
        );

        // (b) Declaring it.
        let resp = call(serde_json::json!({
            "session_id": sid,
            "plan": ["check the ONU is online", "create VLAN 100", "save the config"],
        }))
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["result"]["plan"].as_array().map(|a| a.len()), Some(3));
        assert_eq!(v["result"]["revised"], true);

        // The operator sees it on the session, next to the goal.
        let listed = handle_request(
            req_with_token("POST", "/api/tools/terminal_list", TEST_TOKEN),
            st.clone(),
        )
        .await;
        let body = json_body(listed).await;
        let row = body["result"]
            .as_array()
            .and_then(|a| a.iter().find(|r| r["id"] == sid.as_str()))
            .cloned()
            .expect("session listed");
        assert_eq!(
            row["plan"].as_array().map(|a| a.len()),
            Some(3),
            "plan on session info"
        );

        // (c) A command CLAIMS a step, and the trail links the two.
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/tools/terminal_execute",
                &serde_json::json!({
                    "session_id": sid,
                    "command": "echo vlan 100",
                    "intent": "carry out step two",
                    "plan_step": 2,
                })
                .to_string(),
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let resp = handle_request(req("GET", &format!("/api/sessions/{sid}")), st.clone()).await;
        let events = json_body(resp).await["events"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        let plan_ev = events
            .iter()
            .find(|e| e["kind"] == "plan")
            .expect("the declaration is recorded");
        assert_eq!(
            plan_ev["status"].as_str(),
            Some("3"),
            "the step count is recorded"
        );
        assert_eq!(
            plan_ev["text"].as_str(),
            Some("1. check the ONU is online\n2. create VLAN 100\n3. save the config"),
            "the plan is recorded numbered, so a reader sees the sequence"
        );

        let start = events
            .iter()
            .find(|e| e["kind"] == "command/start" && e["command"] == "echo vlan 100")
            .expect("the command is recorded");
        assert_eq!(
            start["plan_step"].as_u64(),
            Some(2),
            "the command must say WHICH step it served — without this, 'the plan \
             was followed' is unfalsifiable"
        );

        // (d) An empty array CLEARS it, and the clear is recorded as a plan event
        // with NO text — a withdrawn plan must not read as a blank one.
        let resp = call(serde_json::json!({ "session_id": sid, "plan": [] })).await;
        assert_eq!(
            json_body(resp).await["result"]["plan"]
                .as_array()
                .map(|a| a.len()),
            Some(0)
        );

        let resp = handle_request(req("GET", &format!("/api/sessions/{sid}")), st.clone()).await;
        let events = json_body(resp).await["events"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let plans: Vec<&serde_json::Value> =
            events.iter().filter(|e| e["kind"] == "plan").collect();
        assert_eq!(plans.len(), 2, "the clear is recorded too");
        assert!(
            plans[1].get("text").is_none(),
            "a cleared plan carries no text"
        );

        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
    }

    /// THE GOAL IS THE OPERATOR'S, THE PLAN IS THE AGENT'S — they live on
    /// different surfaces, and a request cannot move one through the other.
    ///
    /// Worth pinning because it is the kind of distinction a later refactor
    /// collapses for convenience ("both are just session state, put them on the
    /// same route"), and the result would be an operator-declared plan or an
    /// agent-declared goal — either of which destroys the comparison between what
    /// was asked for and what was intended.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn the_control_route_cannot_declare_a_plan() {
        let (st, cfg_path) = state_with_cfg("plan-split", CFG_YAML_TOKEN_ONLY);
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;

        // The operator's route rejects the agent's field rather than ignoring it.
        let resp = handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"plan":["sneak a plan in"]}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::BAD_REQUEST,
            "the control route takes holder/approval_required/goal — a silently \
             ignored `plan` would look like it worked"
        );
        assert!(
            st.terminal_mgr.term_plan(&sid).await.unwrap().is_empty(),
            "and nothing may have been stored"
        );

        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
    }

    /// THE INTENT LAYER, end to end: reasoning posted to the TOOL surface comes
    /// back out of the audit trail beside the command it explains.
    ///
    /// The unit pins prove the logger stores what it is handed; the schema pin
    /// proves the parameter is advertised. Neither proves the two are CONNECTED —
    /// a handler that reads `intent` and never forwards it, or one that forwards
    /// it to the wrong field, would leave every other test green while the
    /// feature did nothing. This drives the real route.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn intent_posted_to_the_tool_surface_reaches_the_audit_trail() {
        let (st, cfg_path) = state_with_cfg("intent-e2e", CFG_YAML_TOKEN_ONLY);
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;

        let body = serde_json::json!({
            "session_id": sid,
            "command": "echo intent-probe",
            "intent": "confirm the session is responsive before changing anything",
            "considered": ["skip the check", "reopen the session instead"],
        });
        let resp = handle_request(
            req_with_json("POST", "/api/tools/terminal_execute", &body.to_string()),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let resp = handle_request(req("GET", &format!("/api/sessions/{sid}")), st.clone()).await;
        let events = json_body(resp).await["events"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let start = events
            .iter()
            .find(|e| e["kind"] == "command/start")
            .expect("the command was recorded");
        assert_eq!(
            start["intent"].as_str(),
            Some("confirm the session is responsive before changing anything"),
            "the reasoning must travel from the tool call to the trail"
        );
        assert_eq!(
            start["considered"].as_array().map(|a| a.len()),
            Some(2),
            "and the branches not taken must survive the trip too"
        );

        // A malformed `considered` is ABSENT, never a failed execute: the
        // reasoning is optional annotation on a command that should still run.
        let body = serde_json::json!({
            "session_id": sid,
            "command": "echo no-intent",
            "considered": "not-an-array",
        });
        let resp = handle_request(
            req_with_json("POST", "/api/tools/terminal_execute", &body.to_string()),
            st.clone(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "a bad annotation must not stop the command the operator asked for"
        );

        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
    }

    /// THE DISPATCH BEAT, end to end: the operator states a goal through the
    /// route and it reaches BOTH the session (so the AI reads it off
    /// `terminal_list`) and the audit trail (so a later reader knows what the
    /// session was FOR).
    ///
    /// Both halves matter and neither implies the other: a goal that only lives
    /// in memory answers "what is it doing"; one that only lives in the log
    /// answers "what was it for". The design's dispatch beat needs the first, and
    /// the evidence beat needs the second.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_goal_set_through_the_route_reaches_the_session_and_the_trail() {
        let (st, cfg_path) = state_with_cfg("goal-e2e", CFG_YAML_TOKEN_ONLY);
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;

        let resp = handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"goal":"provision the ONU on VLAN 100"}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["goal"], "provision the ONU on VLAN 100");
        // The OTHER fields were not mentioned, so they must read null rather
        // than being defaulted — a partial patch may not clear its neighbours.
        assert!(v["held_by_human"].is_null());
        assert!(v["approval_required"].is_null());

        // (a) The AI can read it off the tool surface it already polls.
        let listed = handle_request(
            req_with_token("POST", "/api/tools/terminal_list", TEST_TOKEN),
            st.clone(),
        )
        .await;
        let body = json_body(listed).await;
        let row = body["result"]
            .as_array()
            .and_then(|a| a.iter().find(|r| r["id"] == sid.as_str()))
            .cloned()
            .expect("session listed");
        assert_eq!(row["goal"], "provision the ONU on VLAN 100");

        // (b) The trail records the STATEMENT, not just the state.
        let resp = handle_request(req("GET", &format!("/api/sessions/{sid}")), st.clone()).await;
        let events = json_body(resp).await["events"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let goals: Vec<String> = events
            .iter()
            .filter(|e| e["kind"] == "goal")
            .map(|e| e["text"].as_str().unwrap_or("").to_string())
            .collect();
        assert_eq!(goals, vec!["provision the ONU on VLAN 100".to_string()]);

        // Clearing is an EVENT too: a withdrawn objective must not leave the
        // previous one looking current.
        let _ = handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"goal":""}"#,
            ),
            st.clone(),
        )
        .await;
        let resp = handle_request(req("GET", &format!("/api/sessions/{sid}")), st.clone()).await;
        let events = json_body(resp).await["events"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let goals: Vec<String> = events
            .iter()
            .filter(|e| e["kind"] == "goal")
            .map(|e| e["text"].as_str().unwrap_or("<null>").to_string())
            .collect();
        assert_eq!(goals.len(), 2, "the clear must be recorded: {goals:?}");
        assert_eq!(goals[1], "", "the clear logs an EMPTY goal, not nothing");

        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
    }

    /// A goal that is not a string is rejected rather than silently ignored.
    #[tokio::test]
    async fn a_non_string_goal_is_rejected() {
        let (st, cfg_path) = state_with_cfg("goal-bad", CFG_YAML_TOKEN_ONLY);
        let resp = handle_request(
            req_with_json("POST", "/api/sessions/abc123/control", r#"{"goal":123}"#),
            st,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert!(
            json_body(resp).await["error"]
                .as_str()
                .unwrap_or("")
                .contains("goal must be a string"),
            "a number where an objective belongs is a client bug, and guessing \
             which way they meant is the one thing this field must not do"
        );
        let _ = std::fs::remove_file(cfg_path);
    }

    /// `POST /api/sessions/{sid}/control` — the control-handoff route.
    ///
    /// The validation pins matter more than the happy path here: this route
    /// moves the keyboard, so a malformed request must be REJECTED rather than
    /// defaulted. Guessing which way an ambiguous body wanted to move it is the
    /// one thing this endpoint must never do.
    #[tokio::test]
    async fn session_control_rejects_a_malformed_request() {
        let (st, cfg_path) = state_with_cfg("ctl-bad", CFG_YAML_TOKEN_ONLY);

        // Unknown holder value.
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/sessions/abc123/control",
                r#"{"holder":"robot"}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let v = json_body(resp).await;
        assert_eq!(v["code"], "invalid_params");
        assert!(
            v["error"].as_str().unwrap_or("").contains("robot"),
            "the error must quote the offending value so the panel can show it"
        );

        // Holder absent entirely — must not default to either side.
        let resp = handle_request(
            req_with_json("POST", "/api/sessions/abc123/control", "{}"),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_body(resp).await["code"], "invalid_params");

        // Invalid JSON.
        let resp = handle_request(
            req_with_json("POST", "/api/sessions/abc123/control", "{oops"),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // A traversing sid is refused by the SHARED guard (round-116's charset
        // rule); this route must not be the one that forgot it.
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/sessions/..%5C..%5Cfoo/control",
                r#"{"holder":"human"}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::BAD_REQUEST,
            "the sid charset guard must apply to the control route too"
        );

        let _ = std::fs::remove_file(cfg_path);
    }

    /// The control route now carries approval mode too — and each field is
    /// INDEPENDENT, which is the property that matters.
    ///
    /// A partial patch must not clear what it did not mention: "hand the keyboard
    /// back" must not silently disarm the gate, and "arm the gate" must not
    /// silently hand the keyboard over. That is the documented incident class this
    /// repo already guards for the settings bodies.
    #[tokio::test]
    async fn session_control_patches_holder_and_approval_independently() {
        let (st, cfg_path) = state_with_cfg("ctl-patch", CFG_YAML_TOKEN_ONLY);

        // A request naming NEITHER field is a client bug, not a silent no-op.
        let resp = handle_request(
            req_with_json("POST", "/api/sessions/abc123/control", "{}"),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // A NON-boolean approval value reads as ABSENT, so a request that only
        // meant to hand over the keyboard still does exactly that — it must not
        // be rejected, and it must not be coerced to true.
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/sessions/abc123/control",
                r#"{"holder":"ai","approval_required":"yes"}"#,
            ),
            st.clone(),
        )
        .await;
        let v = json_body(resp).await;
        let err = v["error"].as_str().unwrap_or("");
        assert!(
            !err.contains("approval_required"),
            "a non-boolean approval_required must be read as ABSENT, not rejected \
             as a bad value; got: {v}"
        );

        let _ = std::fs::remove_file(cfg_path);
    }

    /// The approval decision route: the validation is what is worth pinning,
    /// because this route decides whether a blocked command runs.
    #[tokio::test]
    async fn session_approval_requires_a_direction_and_an_id() {
        let (st, cfg_path) = state_with_cfg("ap-bad", CFG_YAML_TOKEN_ONLY);

        // No id.
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/sessions/abc123/approval",
                r#"{"approve":true}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert!(
            json_body(resp).await["error"]
                .as_str()
                .unwrap_or("")
                .contains("id is required"),
            "the request id is what binds the answer to the command that was read"
        );

        // No direction — must NOT default. A defaulted "yes" would run a command
        // the operator never authorised.
        let resp = handle_request(
            req_with_json("POST", "/api/sessions/abc123/approval", r#"{"id":"ap-1"}"#),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert!(
            json_body(resp).await["error"]
                .as_str()
                .unwrap_or("")
                .contains("approve is required"),
            "a decision with no direction is not a decision"
        );

        // `false` is a REAL value, not "absent": a deny must be distinguishable
        // from a missing field, or every deny would be read as malformed.
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/sessions/deadbeef/approval",
                r#"{"id":"ap-1","approve":false}"#,
            ),
            st.clone(),
        )
        .await;
        let err = json_body(resp).await["error"]
            .as_str()
            .unwrap_or("")
            .to_string();
        assert!(
            !err.contains("approve is required"),
            "approve:false must be accepted as a decision; got: {err}"
        );

        let _ = std::fs::remove_file(cfg_path);
    }

    /// A valid request for a session that does not exist is a CLIENT error: not
    /// a success (the operator would believe they hold a dead keyboard) and not
    /// a 500 (it is a stale sid, which is routine).
    #[tokio::test]
    async fn session_control_on_a_missing_session_is_a_client_error() {
        let (st, cfg_path) = state_with_cfg("ctl-missing", CFG_YAML_TOKEN_ONLY);
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/sessions/deadbeef/control",
                r#"{"holder":"human"}"#,
            ),
            st,
        )
        .await;
        assert_ne!(
            resp.status(),
            StatusCode::OK,
            "holding a session that does not exist must not report success"
        );
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let _ = std::fs::remove_file(cfg_path);
    }

    /// END-TO-END: a hold reached through the ROUTE stops an execute reached
    /// through the TOOL surface, and the AI sees the typed code.
    ///
    /// The manager pins prove the refusal and the route pins prove the
    /// validation, but neither proves the two are connected — a hold stored
    /// under one session id and looked up under another, or an envelope that
    /// flattened the code to a string, would leave both suites green while the
    /// AI got the wrong answer. This drives the real dispatch and the real tool
    /// handler against a real PTY.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_hold_set_via_the_route_refuses_the_tool_call() {
        let (st, cfg_path) = state_with_cfg("ctl-e2e", CFG_YAML_TOKEN_ONLY);
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;

        // The operator takes the keyboard, through the HTTP route.
        let resp = handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"holder":"human"}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(json_body(resp).await["held_by_human"], true);

        // The AI's next execute must be refused, with the code a client routes on.
        let resp = handle_request(
            req_with_json(
                "POST",
                "/api/tools/terminal_execute",
                &format!(r#"{{"session_id":"{sid}","command":"echo hi"}}"#),
            ),
            st.clone(),
        )
        .await;
        let v = json_body(resp).await;
        assert_eq!(v["ok"], false, "a held session must refuse the execute");
        assert_eq!(
            v["code"], "human_in_control",
            "the AI routes on this code; a flattened or wrong one tells it to retry"
        );

        // Hand back, and the same call is allowed through to the lock.
        let resp = handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"holder":"ai"}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(json_body(resp).await["held_by_human"], false);

        // THE AUDIT TRAIL must record BOTH handoffs, in order, through the real
        // route. Without this the logger's own pin proves the logger works while
        // nothing proves the route calls it — a mutant that always logs "human"
        // passed every test until this assertion existed.
        let resp = handle_request(req("GET", &format!("/api/sessions/{sid}")), st.clone()).await;
        let events = json_body(resp).await["events"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let controls: Vec<String> = events
            .iter()
            .filter(|e| e["kind"] == "control")
            .map(|e| e["status"].as_str().unwrap_or("").to_string())
            .collect();
        assert_eq!(
            controls,
            vec!["human".to_string(), "ai".to_string()],
            "the route must record the handoff AND the hand-back, in order: {events:?}"
        );
        // `seq` is documented as per-session monotonic. Each route call builds a
        // FRESH logger via `sessions_logger()`, so the second call must still see
        // the first call's event — if the write were left unflushed in a
        // per-instance buffer, both events would claim the same seq and a reader
        // ordering by seq would see a broken trail.
        let seqs: Vec<u64> = events
            .iter()
            .filter(|e| e["kind"] == "control")
            .map(|e| e["seq"].as_u64().unwrap_or(0))
            .collect();
        assert_eq!(seqs.len(), 2);
        assert!(
            seqs[0] < seqs[1],
            "control events must not share a seq (got {seqs:?}) — the trail is \
             ordered by it, and two equal seqs mean one write never reached disk"
        );

        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
    }

    /// END-TO-END: arming the gate makes the TOOL surface wait, and a decision
    /// through the ROUTE releases it.
    ///
    /// The manager pins prove the gate refuses and the route pins prove the
    /// parsing; neither proves the two are connected — an execute that never
    /// consults the mode, or a decision that lands on a different session id,
    /// would leave both suites green while an armed session ran commands
    /// unapproved. This drives the real dispatch and the real tool handler.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn an_armed_session_makes_the_tool_call_wait_for_a_decision() {
        let (st, cfg_path) = state_with_cfg("ap-e2e", CFG_YAML_TOKEN_ONLY);
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;

        // Arm the gate through the route.
        let resp = handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"approval_required":true}"#,
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["approval_required"], true);
        // The holder was NOT mentioned, so it must be reported as null rather
        // than defaulted — a partial patch may not clear the other field.
        assert!(v["held_by_human"].is_null());
        assert!(!st.terminal_mgr.term_held_by_human(&sid).await.unwrap());

        // Fire the execute; it must BLOCK at the gate.
        let exec = {
            let st2 = st.clone();
            let sid2 = sid.clone();
            tokio::spawn(async move {
                handle_request(
                    req_with_json(
                        "POST",
                        "/api/tools/terminal_execute",
                        &format!(r#"{{"session_id":"{sid2}","command":"echo gated"}}"#),
                    ),
                    st2,
                )
                .await
            })
        };

        // The prompt must become visible while it waits. BOUNDED, so a mutant
        // that removes the gate fails here with a clear message instead of
        // hanging the suite until the harness gives up.
        let st3 = st.clone();
        let sid3 = sid.clone();
        let id = tokio::time::timeout(std::time::Duration::from_secs(5), async move {
            loop {
                if let Some(p) = st3.terminal_mgr.term_pending_approval(&sid3).await.unwrap() {
                    break p.id;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect(
            "no approval prompt ever appeared: the execute did not consult the \
             session's approval mode, so an ARMED session ran the command with \
             nobody asked",
        );
        assert!(!exec.is_finished(), "the execute must still be waiting");

        // ...and a DENY must surface as a refusal, not as a timeout.
        let resp = handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/approval"),
                &format!(r#"{{"id":"{id}","approve":false}}"#),
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(json_body(resp).await["decided"], true);

        let v = json_body(exec.await.unwrap()).await;
        assert_eq!(v["ok"], false);
        assert_eq!(
            v["code"], "approval_denied",
            "the AI must be told the operator refused, not that nobody answered"
        );

        // Disarm so the session can be closed cleanly.
        let _ = handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"approval_required":false}"#,
            ),
            st.clone(),
        )
        .await;
        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
    }

    /// A REFUSED COMMAND MUST NOT WEDGE THE SESSION.
    ///
    /// The gate sits between `term_acquire_execute` and every normal release, and
    /// a refusal propagates with `?` — so unless that path releases too, the
    /// busy flag stays set and EVERY later execute on the session waits out the
    /// 30 s acquire budget and answers `session_busy`. The device looks alive,
    /// the panel shows a live session, and nothing can run in it again.
    ///
    /// This is the assertion the older gate test could not make: it asserts the
    /// refusal code and then CLOSES the session, so the leak is invisible to it.
    /// The same hole exists for a TIMEOUT, which is the outcome an unattended
    /// device gets — so the bug is not an edge case, it is the normal path
    /// whenever nobody is watching.
    ///
    /// The bound is wall-clock on purpose: "did it release" is exactly the
    /// question, and a leaked lock answers it by hanging. Mutation-proven —
    /// removing the release makes this fail with `session_busy` after ~30 s.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_refused_command_leaves_the_session_usable() {
        let (st, cfg_path) = state_with_cfg("approval-release", CFG_YAML_TOKEN_ONLY);
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;

        // Arm the gate.
        handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"approval_required":true}"#,
            ),
            st.clone(),
        )
        .await;

        // First command: refused by the operator.
        let exec = {
            let (st2, sid2) = (st.clone(), sid.clone());
            tokio::spawn(async move {
                handle_request(
                    req_with_json(
                        "POST",
                        "/api/tools/terminal_execute",
                        &format!(r#"{{"session_id":"{sid2}","command":"echo refused"}}"#),
                    ),
                    st2,
                )
                .await
            })
        };
        let id = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Some(p) = st.terminal_mgr.term_pending_approval(&sid).await.unwrap() {
                    break p.id;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the prompt must appear");
        handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/approval"),
                &format!(r#"{{"id":"{id}","approve":false}}"#),
            ),
            st.clone(),
        )
        .await;
        let v = json_body(exec.await.unwrap()).await;
        assert_eq!(
            v["code"], "approval_denied",
            "the refusal itself is correct"
        );

        // THE ASSERTION: the session must still be drivable. Disarm first so the
        // second command is not gated again — the question is the LOCK, not the
        // gate.
        handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"approval_required":false}"#,
            ),
            st.clone(),
        )
        .await;

        let second = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            handle_request(
                req_with_json(
                    "POST",
                    "/api/tools/terminal_execute",
                    &format!(r#"{{"session_id":"{sid}","command":"echo after-refusal"}}"#),
                ),
                st.clone(),
            ),
        )
        .await
        .expect(
            "a refused command wedged the session: the next execute never \
             finished. The gate returns with `?` between acquire and release, so \
             a refusal (or a timeout) leaves the busy flag set — the failure \
             mode is a session that looks alive and can never run anything again",
        );
        assert_eq!(second.status(), StatusCode::OK);
        let v2 = json_body(second).await;
        assert_eq!(
            v2["ok"], true,
            "a refused command must not poison the session: {v2}"
        );
        assert_ne!(
            v2["code"], "session_busy",
            "the busy flag leaked out of the refusal path"
        );

        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
    }

    /// A PARKED command hands the session back, and a later YES still runs it.
    ///
    /// The end-to-end shape of the rework, through the routes the panel and the
    /// AI actually call. Two properties, and each was broken before:
    ///
    ///   * the session is USABLE while a question is open. The gate used to hold
    ///     the execute lock for the whole wait, so an unanswered prompt froze the
    ///     session; now the park releases it. Asserted as a wall-clock bound
    ///     because "did it release" is exactly the question and a leaked lock
    ///     answers it by hanging.
    ///   * a LATE YES still runs the command. The execute has returned by then,
    ///     so without the permit the operator's answer would decide a request
    ///     nobody is waiting on — recorded, and doing nothing.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_parked_command_hands_the_session_back_and_a_late_yes_still_runs_it() {
        let (st, cfg_path) = state_with_cfg("approval-park", CFG_YAML_TOKEN_ONLY);
        let sid = st
            .terminal_mgr
            .term_open(&crate::tools::terminal::TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap()
            .0;

        handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"approval_required":true}"#,
            ),
            st.clone(),
        )
        .await;

        // Drive the gate directly with a SHORT block, so the test exercises the
        // park without waiting the production minute. The route's own budget is
        // covered by the unit tests; what this test is about is what the CALLER
        // gets and what the session looks like afterwards.
        let outcome = st
            .terminal_mgr
            .term_await_approval(&sid, "echo parked", 200)
            .await
            .expect("a park is not an error");
        let crate::tools::terminal::ApprovalOutcome::Parked { id, expires_in_ms } = outcome else {
            panic!("expected a park, got {outcome:?}");
        };
        assert!(
            expires_in_ms > 60_000,
            "the countdown the AI is handed must be the QUESTION's TTL, not the \
             block that just expired — got {expires_in_ms}ms, which would tell a \
             client to give up at the moment the question became answerable"
        );

        // THE SESSION IS USABLE. Disarm so the next command is not gated again:
        // the question here is the LOCK, not the gate.
        handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"approval_required":false}"#,
            ),
            st.clone(),
        )
        .await;
        let second = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            handle_request(
                req_with_json(
                    "POST",
                    "/api/tools/terminal_execute",
                    &format!(r#"{{"session_id":"{sid}","command":"echo after-park"}}"#),
                ),
                st.clone(),
            ),
        )
        .await
        .expect(
            "a parked command wedged the session: the next execute never \
             finished, so an unanswered question froze the session it asked about",
        );
        assert_eq!(second.status(), StatusCode::OK);
        assert_ne!(
            json_body(second).await["code"],
            "session_busy",
            "the busy flag leaked out of the park path"
        );

        // THE LATE YES STILL RUNS IT. Re-arm, register a question, park on it,
        // then answer — and the same command with the id must go through.
        handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/control"),
                r#"{"approval_required":true}"#,
            ),
            st.clone(),
        )
        .await;
        let outcome = st
            .terminal_mgr
            .term_await_approval(&sid, "echo late-yes", 200)
            .await
            .unwrap();
        let crate::tools::terminal::ApprovalOutcome::Parked { id: late_id, .. } = outcome else {
            panic!("expected a park");
        };

        // The operator answers AFTER the park, through the real route.
        let resp = handle_request(
            req_with_json(
                "POST",
                &format!("/api/sessions/{sid}/approval"),
                &format!(r#"{{"id":"{late_id}","approve":true}}"#),
            ),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            json_body(resp).await["decided"],
            true,
            "a parked question must still be answerable inside its TTL — if this \
             is false the operator's click is silently discarded"
        );

        // The AI re-issues with approval_id: it runs, unasked.
        let run = handle_request(
            req_with_json(
                "POST",
                "/api/tools/terminal_execute",
                &format!(
                    r#"{{"session_id":"{sid}","command":"echo late-yes","approval_id":"{late_id}"}}"#
                ),
            ),
            st.clone(),
        )
        .await;
        let v = json_body(run).await;
        assert_eq!(v["ok"], true, "the permitted command must run: {v}");
        assert_ne!(
            v["state"], "awaiting_approval",
            "a command holding a valid permit must NOT be asked about again — \
             that would throw away the answer the operator already gave"
        );

        let _ = id;
        st.terminal_mgr.term_close(&sid).await.ok();
        let _ = std::fs::remove_file(cfg_path);
    }

    /// `/api/logs` reads WHERE THE WRITERS WRITE.
    ///
    /// The regression this pins is a WIRE-UP bug, not a logic one: the handler
    /// read `exe_dir()/vale-update.log` while layout v2 had already moved that
    /// file — and `agent.log`, `installer.log`, `install-result.txt`,
    /// `startup.log` with it — into `DataDir\logs`. The route therefore read a
    /// path the migration had emptied and could only ever answer `""`, on every
    /// v2 device, while every writer had followed the move. Nothing failed: the
    /// reply was well-formed and empty.
    ///
    /// So the test plants a marker where the writers ACTUALLY write and asserts
    /// the route returns it — and plants a different one where the buggy code
    /// looked, asserting the route does NOT return that. Asserting only the
    /// first half would pass against a handler that read both.
    #[tokio::test]
    async fn api_logs_reads_the_dir_the_writers_use() {
        let logs = crate::paths::logs_dir();
        std::fs::create_dir_all(&logs).unwrap();
        let real = logs.join("agent.log");
        let marker = format!("REAL-LOG-MARKER-{}", std::process::id());
        let had_real = std::fs::read_to_string(&real).ok();
        std::fs::write(&real, format!("{marker}\n")).unwrap();

        // The path the buggy code resolved. On a v2 device this file does not
        // exist at all, which is exactly why the route looked empty; the test
        // creates it so the assertion is about WHICH path is read rather than
        // about which file happens to exist.
        let exe = crate::paths::exe_dir();
        let decoy = exe.join("vale-update.log");
        let had_decoy = std::fs::read_to_string(&decoy).ok();
        let decoy_marker = format!("DECOY-MARKER-{}", std::process::id());
        if std::fs::create_dir_all(&exe).is_ok() {
            let _ = std::fs::write(&decoy, format!("{decoy_marker}\n"));
        }

        let resp = handle_request(req("GET", "/api/logs"), state()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        let body = v.to_string();
        // The body is CLIPPED in the failure messages: a real agent.log plus
        // mcp_diag.log is megabytes, and an assertion that dumps them makes a
        // failing test unreadable exactly when it is needed most.
        assert!(
            body.contains(&marker),
            "the route must read `logs_dir()` — where the update script, \
             filelog.rs and the mcp-client diag writer all put their logs. \
             Reply head: {}",
            crate::text::clip(&body, 400)
        );
        assert!(
            !body.contains(&decoy_marker),
            "the route must NOT read `exe_dir()` — layout v2 MOVES the logs out \
             of there, so that path is empty on every real device and the route \
             silently answered '' forever. Reply head: {}",
            crate::text::clip(&body, 400)
        );

        // Restore whatever was there, so a test run does not leave a fake log.
        match had_real {
            Some(prev) => std::fs::write(&real, prev).unwrap(),
            None => {
                let _ = std::fs::remove_file(&real);
            }
        }
        match had_decoy {
            Some(prev) => std::fs::write(&decoy, prev).unwrap(),
            None => {
                let _ = std::fs::remove_file(&decoy);
            }
        }
    }

    /// THE ROUTE-COVERAGE SECURITY PIN (SOLID R102).
    ///
    /// Every route the web surface dispatches must be reachable ONLY with the
    /// device token: the device token is the single gate between an
    /// unauthenticated network caller and SYSTEM-level device control
    /// (terminal_execute, system_file_write, …). A new route added without
    /// auth fails HERE instead of shipping. Both failure modes are checked —
    /// a missing header and a wrong token — because they take different paths
    /// through `check_auth`.
    #[tokio::test]
    async fn every_dispatch_route_is_auth_gated() {
        // Mirrors web::dispatch's arms verbatim plus the pre-dispatch
        // streaming routes, /mcp included: axum's nest_service normally keeps
        // /mcp away from handle_request, so asserting it here is
        // defence-in-depth against a routing change.
        let routes: &[(&str, &str)] = &[
            ("GET", "/api/spec"),
            ("GET", "/api/status"),
            ("GET", "/api/sessions"),
            ("GET", "/api/sessions/some-session-id"),
            ("POST", "/api/sessions/some-session-id/control"),
            ("POST", "/api/sessions/some-session-id/approval"),
            ("POST", "/api/sessions/some-session-id/grants"),
            ("GET", "/api/logs"),
            ("GET", "/api/events/poll"),
            ("GET", "/api/settings"),
            ("PUT", "/api/settings"),
            ("POST", "/api/gateway/connect"),
            ("GET", "/api/plugins/status"),
            ("POST", "/api/plugins/playwright/start"),
            ("POST", "/api/plugins/playwright/stop"),
            ("POST", "/api/tools/terminal_list"),
            ("GET", "/api/events"),
            ("GET", "/api/events/term"),
            ("GET", "/api/browser/pwshots"),
            ("GET", "/api/browser/actions"),
            // Carries commands, goals and plans from EVERY session, so it is
            // strictly more sensitive than the actions feed beside it.
            ("GET", "/api/operation"),
            ("GET", "/api/browser/pwshot"),
            ("GET", "/mcp"),
            ("POST", "/mcp"),
        ];
        for (m, p) in routes {
            let r = handle_request(req_anon(m, p), state()).await;
            assert_eq!(
                r.status(),
                StatusCode::UNAUTHORIZED,
                "{m} {p} served WITHOUT an Authorization header"
            );
            let r = handle_request(req_with_token(m, p, "not-the-device-token"), state()).await;
            assert_eq!(
                r.status(),
                StatusCode::UNAUTHORIZED,
                "{m} {p} served with a WRONG token"
            );
        }
    }

    /// The PUBLIC surface, pinned so an auth tightening cannot silently lock
    /// the panel/status page out (the mirror image of the test above).
    ///
    /// `/` serves a static page naming no device data, and the panel/desktop
    /// SPA is public *by design*: it shows nothing until the user supplies a
    /// token, and the token is injected server-side only for the authorised
    /// paths (loopback / gateway proxy secret / one-time grant) — see
    /// handle_panel_home.
    #[tokio::test]
    async fn deliberately_public_routes_stay_public() {
        for (m, p) in [
            ("GET", "/"),
            ("GET", "/panel"),
            ("GET", "/panel/"),
            ("GET", "/desktop"),
            ("GET", "/desktop/"),
            ("GET", "/panel/panel.js"),
            ("GET", "/desktop/panel.css"),
            ("GET", "/some-unknown-page"),
        ] {
            let r = handle_request(req_anon(m, p), state()).await;
            assert_ne!(
                r.status(),
                StatusCode::UNAUTHORIZED,
                "{m} {p} must stay public (it is a documented public surface)"
            );
        }
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
        let _sse = crate::web::sse::SSE_TEST_LOCK.lock().await;
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

    /// The operator can SET a memory cap; they must be able to SEE the fill.
    ///
    /// `/api/settings` reported `memory_max_entries` / `memory_max_bytes_mb` /
    /// `memory_retention_days` and nothing about usage, so a cap could be
    /// lowered to below the current contents — after which the device begins
    /// silently evicting the OLDEST knowledge — with no way to notice from the
    /// UI. The only accessor that could answer it, `total_bytes_live`, was
    /// documented "Test/reliability hook" and had exactly one caller: its own
    /// test.
    ///
    /// THE ORDER OF THIS WORK MATTERED: shipping a meter before round 20's
    /// ledger fix would have published a number that was WRONG after any edit
    /// (undercount) or soft-delete (overcount) — a meter nobody can trust is
    /// worse than no meter, because it drives decisions. The ledger moves with
    /// the record now, so these two assertions can be exact rather than
    /// approximate.
    #[tokio::test]
    async fn settings_reports_memory_usage_not_just_the_caps() {
        let (st, cfg_path) = state_with_cfg("mem-usage", CFG_YAML_TOKEN_ONLY);

        // MEASURE DELTAS, NOT ABSOLUTES. `AppState::new` builds its memory store
        // on `default_memory_dir()`, a PROCESS-GLOBAL path — every web test in
        // this binary shares one store, so a previous test's records are still
        // there. Asserting an absolute 0 failed exactly that way: a leftover
        // 1 entry / 16 bytes, intermittently, depending on test order.
        //
        // Same trap round 20 hit from the other side (a test reading shared
        // state and calling it its own). There the fix was a unique dir; here
        // the path is not mine to choose, so the assertion measures what THIS
        // test added. What matters is unchanged: usage must be PRESENT as a
        // number even when nothing was added, so a UI can divide it by the cap
        // without special-casing an absent field.
        let before = json_body(handle_request(req("GET", "/api/settings"), st.clone()).await).await;
        let base_entries = before["memory_entries"]
            .as_u64()
            .unwrap_or_else(|| panic!("usage present as a number: {before}"));
        let base_bytes = before["memory_bytes"]
            .as_u64()
            .unwrap_or_else(|| panic!("usage present as a number: {before}"));
        assert!(
            before["memory_max_entries"].is_u64(),
            "usage and cap must be the same kind of number so they can be divided: {before}"
        );

        // Two records of known size: the meter must reflect EXACTLY what the
        // cap is measured against. An edit is included on purpose — it is the
        // write path whose ledger was wrong before round 20.
        let store = st.memory.clone();
        // Ids are unique to THIS test. The store is process-global and keyed by
        // id, so a fixed "m-alpha" left behind by another test would make
        // `insert` an UPDATE — the count would move by 1, not 2, which is
        // exactly how this assertion first failed.
        let uniq = format!("{}-{}", std::process::id(), crate::now_millis());
        let mk = |title: &str, content: &str| crate::plugins::memory::store::MemoryRecord {
            id: format!("m-{uniq}-{title}"),
            title: title.to_string(),
            content: content.to_string(),
            tags: vec![],
            namespace: "shared".to_string(),
            source: "test".to_string(),
            run_id: None,
            created_at: crate::unix_now(),
            updated_at: crate::unix_now(),
            deleted: false,
        };
        let a = store.insert(mk("alpha", "0123456789")); // 10 bytes
        store.insert(mk("beta", "abc")); // 3 bytes
        store.update(&a, None, Some("0123456789ABCDEF".into()), None, None, None); // -> 16

        let v = json_body(handle_request(req("GET", "/api/settings"), st.clone()).await).await;
        assert_eq!(
            v["memory_entries"].as_u64(),
            base_entries.checked_add(2),
            "two records added: {v}"
        );
        assert_eq!(
            v["memory_bytes"].as_u64(),
            base_bytes.checked_add(19),
            "16 + 3. The meter must be the SAME ledger the byte cap evicts on — \
             a reader that recomputes it some other way can disagree with the \
             eviction it is supposed to explain: {v}"
        );

        // A soft-delete must leave the meter, not just the list.
        let b = store.list(None, None, 10, false);
        let doomed = b.iter().find(|r| r.title == "beta").unwrap().id.clone();
        store.delete(&doomed);
        let v = json_body(handle_request(req("GET", "/api/settings"), st.clone()).await).await;
        assert_eq!(
            v["memory_entries"].as_u64(),
            base_entries.checked_add(1),
            "tombstones are not live entries: {v}"
        );
        assert_eq!(
            v["memory_bytes"].as_u64(),
            base_bytes.checked_add(16),
            "tombstone bytes leave the meter: {v}"
        );

        let _ = std::fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    /// "THIS SESSION LEFT NO RECORD" AND "I COULD NOT READ THE RECORD" ARE
    /// DIFFERENT ANSWERS.
    ///
    /// `/api/sessions/{sid}` answered `200 {ok:true, events:[]}` for both: the
    /// handler collapsed `read_events`'s `Option` with `unwrap_or_default()`.
    /// A reader therefore cannot tell a session whose file is gone (retention,
    /// a different data dir, a typo'd id) from one that genuinely recorded
    /// nothing — and the panel that consumes this had to word its empty state
    /// to cover both possibilities, which is the honest version of a question
    /// the API should have answered.
    ///
    /// `ok` stays true in both cases: the REQUEST succeeded. What differs is
    /// whether a record exists, which is what `found` reports.
    #[tokio::test]
    async fn session_events_distinguishes_no_record_from_an_empty_one() {
        let (st, cfg_path) = state_with_cfg("events-found", CFG_YAML_TOKEN_ONLY);

        // Nothing on disk for this id: `found` is false, and it is PRESENT so a
        // consumer can branch on it rather than on an absence of events.
        let resp = handle_request(
            req("GET", "/api/sessions/no-such-session-anywhere"),
            st.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = json_body(resp).await;
        assert_eq!(v["ok"], true, "the request succeeded: {v}");
        assert_eq!(
            v["first_seq"], 0,
            "no record means no beginning to report — 0, not a fabricated 1: {v}"
        );
        assert_eq!(
            v["found"], false,
            "a session with no readable record must SAY so rather than \
             answering with an empty list that reads as 'it recorded nothing': {v}"
        );
        assert_eq!(v["events"].as_array().map(|a| a.len()), Some(0), "{v}");

        // Now a session that WAS recorded: `found` true, events present.
        let logger = sessions_logger();
        logger.log_command_start("web-events-found", "echo hi");
        let resp = handle_request(req("GET", "/api/sessions/web-events-found"), st.clone()).await;
        let v = json_body(resp).await;
        assert_eq!(v["found"], true, "a readable record is found: {v}");
        assert!(
            v["events"].as_array().is_some_and(|a| !a.is_empty()),
            "and it carries the events: {v}"
        );
        // A record that was NOT trimmed begins at 1. This is the negative half
        // of the completeness signal: `first_seq > 1` must mean something, and
        // it cannot if every record reports a large number.
        assert_eq!(
            v["first_seq"], 1,
            "an untrimmed record begins at its first event: {v}"
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
    // round-41 audit pin, RESOLVED by product sign-off (2026-09-08):
    // api_settings_put's invalid-JSON envelope now returns HTTP 400, matching
    // api_gateway_connect. The old HTTP-200 Json shape is gone on purpose.
    async fn settings_put_invalid_json_returns_http400_envelope() {
        let (st, _cfg_path) = state_with_cfg("put-bad-json", CFG_YAML_TOKEN_ONLY);
        let resp = handle_request(
            req_with_json("PUT", "/api/settings", "{not json"),
            st.clone(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::BAD_REQUEST,
            "unified 400 envelope"
        );
        let v = json_body(resp).await;
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], "invalid_params");
        assert!(
            v["error"].as_str().unwrap_or("").contains("invalid JSON"),
            "error mentions the parse failure"
        );
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
    async fn gateway_connect_reports_exactly_what_it_persists() {
        // SOLID R104: the reported `console_url` and the PERSISTED binding are
        // one evaluation of the "trimmed, blank ⇒ unset" rule. They used to be
        // two independent copies that merely happened to agree — editing one
        // would have made the device answer with a binding it had not stored
        // (or stored one it did not report).
        //
        // The tuples also pin a contract detail worth having on the record:
        // the response field ECHOES THE REQUEST, it is not a read-back of the
        // resulting state. A reg-key-only connect therefore answers
        // `console_url: null` while the stored binding is left untouched —
        // which is exactly the "partial update" semantics the handler's
        // comment describes (a reg-key-only request must not unbind).
        for (tag, body, reported, persisted) in [
            (
                "trim",
                r#"{"console_url":"  https://trim.example  "}"#,
                Some("https://trim.example"),
                Some("https://trim.example"),
            ),
            ("clear", r#"{"console_url":""}"#, None, None),
            ("blank", r#"{"console_url":"   "}"#, None, None),
            ("nonstring", r#"{"console_url":42}"#, None, None),
            (
                "regkey-only",
                r#"{"reg_key":"k"}"#,
                None,
                // CFG_YAML_TOKEN_AND_URL's pre-existing binding, KEPT.
                Some("https://gw.example"),
            ),
        ] {
            // Start from a BOUND gateway so the "absent" arm has something to keep.
            let (st, cfg_path) = state_with_cfg(tag, CFG_YAML_TOKEN_AND_URL);
            let resp = handle_request(
                req_with_json("POST", "/api/gateway/connect", body),
                st.clone(),
            )
            .await;
            assert_eq!(resp.status(), StatusCode::OK, "{tag}");
            let v = json_body(resp).await;

            assert_eq!(
                v["console_url"].as_str(),
                reported,
                "{tag}: response does not echo the request"
            );
            assert_eq!(
                st.config_snapshot().platform.console_url.as_deref(),
                persisted,
                "{tag}: in-memory binding disagrees with the parsed patch"
            );
            let cfg = Config::load(&cfg_path).unwrap();
            assert_eq!(
                cfg.platform.console_url.as_deref(),
                persisted,
                "{tag}: persisted binding disagrees with the in-memory one"
            );
            let _ = std::fs::remove_dir_all(cfg_path.parent().unwrap());
        }
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
    // round-41/49 audit pair: api_settings_put returns its invalid-JSON
    // envelope as HTTP 200 (historical round-69 shape, pinned separately)
    // while api_gateway_connect 400s the same class of error. This pin
    // documents the contrast so the OPEN-decision unification is a visible
    // wire change on BOTH endpoints, never a silent drift on one.
    async fn gateway_connect_invalid_json_returns_http400() {
        let (st, _cfg_path) = state_with_cfg("gw-bad-json", CFG_YAML_TOKEN_ONLY);
        let resp = handle_request(
            req_with_json("POST", "/api/gateway/connect", "{not json"),
            st,
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::BAD_REQUEST,
            "gateway-connect 400s"
        );
        let v = json_body(resp).await;
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], "invalid_params");
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
        assert!(check_auth(req("GET", "/api/status").headers(), &st).is_ok());
        let mut gate = TokenGate::new(OkSvc, st.clone());
        let res = Service::call(&mut gate, req_with_token("POST", "/mcp", TEST_TOKEN))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let mut cfg = st.config_snapshot();
        cfg.server.device_token = Some("rotated-token".into());
        st.update_config(cfg, false).unwrap();

        // /api/* path: old rejected, new accepted.
        assert!(check_auth(
            req_with_token("GET", "/api/status", TEST_TOKEN).headers(),
            &st
        )
        .is_err());
        assert!(check_auth(
            req_with_token("GET", "/api/status", "rotated-token").headers(),
            &st
        )
        .is_ok());
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

    // SOLID Round-43: the single constant-time compare guarding every /api
    // and /mcp route (round-116) had zero direct pins — only incidental
    // exercise through authed-handler tests. Truth table for the gate the
    // device token depends on.
    #[test]
    fn timing_safe_eq_truth_table() {
        assert!(timing_safe_eq(b"abc", b"abc"));
        assert!(timing_safe_eq(b"", b""));
        assert!(!timing_safe_eq(b"abc", b"abd"), "one bit differs");
        assert!(!timing_safe_eq(b"abc", b"ab"), "length differs (shorter)");
        assert!(!timing_safe_eq(b"ab", b"abc"), "length differs (longer)");
        assert!(!timing_safe_eq(b"", b"a"), "empty vs non-empty");
        // 64-byte token shape: last byte differs.
        let a = vec![0xABu8; 64];
        let mut b = a.clone();
        b[63] ^= 1;
        assert!(!timing_safe_eq(&a, &b));
    }

    /// The SSE viewer cap is REAL, and it is RELEASED (SOLID R124 → R128).
    ///
    /// The R124 pin asserted the OPPOSITE — that 70 held responses produced
    /// ZERO 503s, because the guard was a local dropped when the response was
    /// constructed. That pin did its job: it failed the moment the guard moved
    /// into the streaming task. It is now inverted, and the HOLD half is
    /// phrased to actually discriminate — which took two attempts:
    ///
    ///   * Counting refusals DURING the opens proves nothing about holding.
    ///     The acquires are synchronous, so 70 opens against a 64-slot pool
    ///     refuse 6 of them whether or not the slot survives afterwards; the
    ///     first version of this test therefore PASSED against a mutant that
    ///     dropped the guard at task start (verified by mutation).
    ///   * The discriminating question is asked AFTER the pump tasks have had
    ///     a chance to run: with 64 accepted streams still held, ONE MORE
    ///     request must be refused. A dropped guard frees the pool and that
    ///     request succeeds instead.
    ///
    /// The RELEASE half then pins the other failure mode: dropping the
    /// responses must return the slots, or a long-lived agent would refuse
    /// every viewer forever after 64 total connections.
    #[tokio::test]
    async fn sse_viewer_cap_holds_and_releases_per_connection() {
        // This test DRAINS the process-global pool, so it takes the shared lock
        // every other pool-touching test also takes. Without it the parallel
        // SSE tests receive 503 — the exact starvation the sse.rs NOTE used to
        // forbid by banning a drain test outright, which in turn made the cap's
        // enforcement untestable (and hid the R124 bug).
        let _sse = crate::web::sse::SSE_TEST_LOCK.lock().await;
        let st = state();
        let max = crate::web::sse::SSE_MAX_CONNECTIONS;

        let open = |st: Arc<AppState>| async move {
            let r = Request::builder()
                .method("GET")
                .uri("/api/events")
                .header("Authorization", format!("Bearer {TEST_TOKEN}"))
                .body(Body::empty())
                .unwrap();
            let (parts, _) = r.into_parts();
            route_pre_dispatch(&parts.method, "/api/events", None, &parts.headers, &st)
                .await
                .expect("GET /api/events must be handled by the pre-dispatch layer")
        };

        // Fill the pool, keeping every accepted response alive.
        let mut held = Vec::new();
        for _ in 0..(max + 6) {
            let resp = open(st.clone()).await;
            if resp.status() != StatusCode::SERVICE_UNAVAILABLE {
                held.push(resp);
            }
        }
        assert_eq!(
            held.len(),
            max,
            "expected the pool to fill to exactly {max}"
        );

        // Let every pump task run. A guard that is dropped when the task
        // STARTS would free its slot here.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // ── 1. HOLD ────────────────────────────────────────────────────────
        // With 64 accepted streams still held, one more request must be
        // refused. This is the assertion that a dropped guard cannot satisfy.
        let extra = open(st.clone()).await;
        assert_eq!(
            extra.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "the viewer cap is NOT enforced: a request was ACCEPTED while {max} \
             streams were still open. The guard is not surviving the stream — \
             that is the R124 regression, and it means the documented bound \
             does not exist."
        );
        drop(extra);

        // ── 2. RELEASE ─────────────────────────────────────────────────────
        drop(held);
        let mut freed = false;
        for _ in 0..50 {
            let resp = open(st.clone()).await;
            if resp.status() != StatusCode::SERVICE_UNAVAILABLE {
                freed = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            freed,
            "slots were NOT released after the streams were dropped — the pool \
             leaks, so an agent that has served {max} connections would refuse \
             every viewer forever. The guard must be released when the \
             streaming task ENDS, promptly (tx.closed()), not at the next \
             heartbeat tick."
        );
    }

    /// Every streaming route must acquire its SSE slot through the ONE shared
    /// path (SOLID R125).
    ///
    /// `sse_route_response` exists so the `_guard` lifetime question has a
    /// single answer. Before the extraction the two branches were
    /// byte-identical apart from their stream function, which meant the
    /// sign-off-pending fix (the guard must be owned by the RESPONSE, not by
    /// the function that builds it — see the ledger's Open threads) would have
    /// had to be applied twice, correctly, in two places. This test keeps that
    /// from regressing: it fails if a streaming route is answered WITHOUT the
    /// shared helper, or if the helper itself stops acquiring a slot.
    ///
    /// It is a SOURCE SCAN, and its limits are stated rather than implied: it
    /// checks shape, not behaviour. The behavioural half is
    /// `sse_viewer_cap_is_not_held_for_the_connection_lifetime` above plus the
    /// auth/stream tests in this module.
    #[test]
    fn streaming_routes_share_one_slot_acquisition_point() {
        const SRC: &str = include_str!("mod.rs");
        // Strip comments before counting. A naive scan counts MENTIONS, and
        // `acquire_sse_guard` is named in this file's docs (including this very
        // test) — the same false-positive trap the boot-surface and module-map
        // gates hit. Only CODE lines may count.
        // Two false-positive sources, both hit while writing this:
        //   * `///` doc comments MENTION the helper by name (including, as it
        //     happens, the comment two screens up);
        //   * this test's own string literals contain "acquire_sse_guard()".
        // So: drop the test module, then strip line comments.
        let production = match SRC.find("#[cfg(test)]") {
            Some(i) => &SRC[..i],
            None => SRC,
        };
        let code: String = production
            .lines()
            .map(|l| match l.find("//") {
                Some(i) => &l[..i],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n");
        // The helper is the only place a guard is acquired...
        let acquisitions = code.matches("acquire_sse_guard()").count();
        assert_eq!(
            acquisitions, 1,
            "acquire_sse_guard() must be CALLED in exactly ONE place (the shared \
             helper), found {acquisitions}. If a streaming route grew its own \
             acquisition, the pending guard-lifetime fix now has to be applied \
             twice — and the two copies will drift."
        );
        // ...and that one place is the helper, not some other function that
        // happens to be first in the file.
        let helper_body = code
            .split("async fn sse_route_response")
            .nth(1)
            .and_then(|rest| rest.split("async fn route_pre_dispatch").next())
            .expect("sse_route_response must still exist");
        assert!(
            helper_body.contains("acquire_sse_guard()"),
            "the ONE acquisition is not inside sse_route_response"
        );
        // ...and both streaming routes go through it.
        for (path, routed) in [
            (
                "/api/events",
                "sse_route_response(headers, state, sse_stream)",
            ),
            (
                "/api/events/term",
                "sse_route_response(headers, state, sse_term_stream)",
            ),
        ] {
            assert!(
                SRC.contains(routed),
                "{path} must be answered through the shared helper \
                 (`{routed}`); answering it inline re-opens the two-place fix"
            );
        }
        // AUTH IS NOT RE-CHECKED HERE, deliberately. The obvious assertion —
        // "the helper body mentions check_auth" — does NOT discriminate: a
        // mutant that replaces the call with `let _ = check_auth(...)` still
        // contains the string and still passes, which I verified by applying
        // it. Keeping a check that cannot fail would be worse than none.
        //
        // Authentication of this path is covered BEHAVIOURALLY, which is
        // stronger: `term_sse_requires_auth` below fails under exactly that
        // mutant (verified), and `route_pre_dispatch`'s own auth coverage
        // (R102's route walk) covers the rest.
    }
}
