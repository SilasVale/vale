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
//!   GET  /api/plugins/status → plugin status (playwright-mcp running state)
//!   POST /api/plugins/playwright/start|stop → start/stop playwright-mcp
//!   POST /api/tools/{name}   → generic tool dispatch via PluginRegistry
//!   /mcp (via TokenGate)     → rmcp streamable HTTP server

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
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

// ── Terminal panel static assets (embedded, public) ──────────

/// Provision the free cloudflared tunnel from the Settings-page Gateway card:
/// login with the token, create the tunnel, route DNS, write tunnel.yml, and
/// spawn cloudflared (agent-owned, spawn-if-absent model). Returns a status
/// string for the API response. Best-effort — failures are reported, not fatal.
/// Make sure the SYSTEM agent's cloudflared credentials exist. `tunnel
/// login --token` under SYSTEM writes to systemprofile\.cloudflared — if
/// that failed, copy cert.pem + tunnel credentials from a real user profile
/// (Administrator runs the console/install flows and already has them).
async fn ensure_cf_credentials() {
    let sys_cf = std::env::var("USERPROFILE")
        .map(|u| std::path::PathBuf::from(u).join(".cloudflared"))
        .unwrap_or_default();
    if sys_cf.join("cert.pem").exists() {
        return; // already authenticated
    }
    // Candidate user profiles to copy from.
    for user in ["Administrator", "admin", "user"] {
        let src = std::path::PathBuf::from(r"C:\Users").join(user).join(".cloudflared");
        let cert = src.join("cert.pem");
        if cert.exists() {
            let _ = std::fs::create_dir_all(&sys_cf);
            if std::fs::copy(&cert, sys_cf.join("cert.pem")).is_ok() {
                // Copy all *.<uuid>.json credentials too.
                if let Ok(rd) = std::fs::read_dir(&src) {
                    for e in rd.flatten() {
                        let name = e.file_name().to_string_lossy().to_string();
                        if name.ends_with(".json") && e.path().is_file() {
                            let _ = std::fs::copy(e.path(), sys_cf.join(&name));
                        }
                    }
                }
                tracing::info!("[vale-agent] provision_tunnel: copied cloudflared credentials from {user}");
                return;
            }
        }
    }
    tracing::warn!("[vale-agent] provision_tunnel: no cert.pem found in any user profile — tunnel auth may fail");
}

/// Update a tunnel's REMOTE config (Cloudflare API) so its ingress points at
/// 127.0.0.1:18080. cloudflared prefers the remote config over the local file
/// when one exists; a stale remote (e.g. an old 127.0.0.2 ingress) would keep
/// proxying to a dead address (502) no matter what tunnel.yml says.
async fn update_remote_config(cf_token: &str, tunnel_id: &str, hostname: &str) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    // 1. Resolve the account id from the token.
    let acc = match client
        .get("https://api.cloudflare.com/client/v4/accounts")
        .header("authorization", format!("Bearer {cf_token}"))
        .send().await
    {
        Ok(r) => match r.json::<serde_json::Value>().await { Ok(j) => j, Err(_) => return },
        Err(_) => return,
    };
    let account_id = match acc["result"].as_array().and_then(|a| a.first()).and_then(|x| x["id"].as_str()) {
        Some(v) => v.to_string(),
        None => return,
    };
    // 2. PUT the ingress config.
    let body = serde_json::json!({
        "config": {
            "ingress": [
                { "hostname": hostname, "service": "http://127.0.0.1:18080" },
                { "service": "http_status:404" }
            ]
        }
    });
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations"
    );
    match client
        .put(&url)
        .header("authorization", format!("Bearer {cf_token}"))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send().await
    {
        Ok(r) => {
            let ok = r.status().is_success();
            tracing::info!("[vale-agent] provision_tunnel: remote config update ok={ok}");
        }
        Err(_) => tracing::warn!("[vale-agent] provision_tunnel: remote config update failed (network)"),
    }
}

async fn provision_tunnel(cf_token: &str) -> String {
    let install_dir = crate::paths::install_dir();
    let cf = install_dir.join("tools").join("cloudflared.exe");
    if !cf.exists() {
        // cloudflared is NOT bundled (the npm package stays small) — download
        // the official Windows binary on demand (same source the installer
        // used; ~54MB, one-time).
        tracing::info!("[vale-agent] provision_tunnel: downloading cloudflared via the gateway proxy");
        // Download through the vale-gate proxy (agent.saisi.online) — the
        // device can reach our worker even when GitHub is blocked (GFW etc.).
        // The worker streams the official GitHub release back to us.
        let url = "https://agent.saisi.online/vale-agent/cloudflared.exe";
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
        {
            Ok(c) => c,
            Err(_) => return "cloudflared download client build failed".to_string(),
        };
        let resp = match client.get(url).send().await {
            Ok(r) => r,
            Err(_) => return "cloudflared download failed (official GitHub release unreachable)".to_string(),
        };
        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(_) => return "cloudflared download failed (read error)".to_string(),
        };
        if bytes.len() <= 1_000_000 {
            return "cloudflared download failed (unexpected small payload)".to_string();
        }
        let _ = std::fs::create_dir_all(install_dir.join("tools"));
        if std::fs::write(&cf, &bytes).is_err() {
            return "cloudflared download write failed".to_string();
        }
        tracing::info!("[vale-agent] provision_tunnel: cloudflared downloaded ({} bytes)", bytes.len());
    }
    let hostname = std::fs::read_to_string(install_dir.join("vale-agent.hostname"))
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    // Supervision audit #5: hostname flows into cloudflared ARGV and an
    // unquoted YAML line. A value starting with '-' becomes a FLAG, an
    // embedded newline injects keys (e.g. a different `service:` target).
    // Validate to bare subdomain charset before anything else touches it.
    let host_ok = |v: &str| -> bool {
        !v.is_empty()
            && v.len() <= 253
            && !v.starts_with('-')
            && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    };
    if !host_ok(&hostname) {
        return "cannot provision: vale-agent.hostname missing or invalid (set it via `vale setup --hostname <sub>` first)".to_string();
    }
    if !host_ok(cf_token) {
        return "cannot provision: gateway returned a malformed API token".to_string();
    }
    let tunnel_name = format!("vale-agent-{}", hostname.split('.').next().unwrap_or("device"));
    // 1. login with token. cloudflared writes cert.pem to %USERPROFILE%\.cloudflared\
    //    — under the SYSTEM service that is systemprofile, and `tunnel login
    //    --token` may not write it there reliably. After login, ensure the
    //    credentials exist: copy from a real user profile if missing.
    let login = tokio::process::Command::new(&cf)
        .args(["tunnel", "login", "--token", cf_token])
        .output().await;
    let login_ok = login.map(|o| o.status.success()).unwrap_or(false);
    if !login_ok {
        return "cloudflared login failed".to_string();
    }
    ensure_cf_credentials().await;
    // 2. create tunnel (idempotent-ish: list first). The tunnel ID is a
    //    canonical UUID — parse it with the dash-delimited regex from the
    //    `tunnel list` output; `tunnel create` prints the full ID on success,
    //    so if the list parse fails (table truncation etc.) grab it from the
    //    create output directly.
    fn parse_tunnel_id(text: &str) -> Option<String> {
        // Canonical UUID with dashes: 8-4-4-4-12 hex. Scan char windows to
        // avoid pulling in the regex crate (cargo-xwin build stays lean).
        let bytes = text.as_bytes();
        let is_hex = |c: u8| c.is_ascii_hexdigit();
        let mut i = 0;
        while i + 36 <= bytes.len() {
            let seg = [8usize, 4, 4, 4, 12];
            let mut ok = true;
            let mut pos = i;
            for (si, len) in seg.iter().enumerate() {
                for _ in 0..*len {
                    if !is_hex(bytes[pos]) { ok = false; break; }
                    pos += 1;
                }
                if !ok { break; }
                if si < seg.len() - 1 {
                    if bytes[pos] != b'-' { ok = false; break; }
                    pos += 1;
                }
            }
            if ok {
                return Some(text[i..i + 36].to_string());
            }
            i += 1;
        }
        None
    }
    // `tunnel list` WITHOUT --name: the --name filter behaves differently
    // across cloudflared versions and can return empty — match the NAME
    // column ourselves (ID is col 1, NAME is col 2 in the table).
    fn find_tunnel_id_by_name(text: &str, name: &str) -> Option<String> {
        for line in text.lines() {
            let toks: Vec<&str> = line.split_whitespace().collect();
            if toks.len() >= 2 && toks[1] == name {
                if let Some(id) = parse_tunnel_id(toks[0]) {
                    return Some(id);
                }
            }
        }
        None
    }
    let list = tokio::process::Command::new(&cf)
        .args(["tunnel", "list"])
        .output().await;
    let list_text = list.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let mut tunnel_id = find_tunnel_id_by_name(&list_text, &tunnel_name);
    if tunnel_id.is_none() {
        let created = tokio::process::Command::new(&cf)
            .args(["tunnel", "create", &tunnel_name])
            .output().await;
        let (created_text, created_err) = match created {
            Ok(o) => (
                String::from_utf8_lossy(&o.stdout).to_string(),
                String::from_utf8_lossy(&o.stderr).to_string(),
            ),
            Err(_) => (String::new(), String::new()),
        };
        tunnel_id = parse_tunnel_id(&created_text).or_else(|| parse_tunnel_id(&created_err));
        if tunnel_id.is_none() {
            let list2 = tokio::process::Command::new(&cf)
                .args(["tunnel", "list"])
                .output().await;
            let list2_text = list2.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
            tunnel_id = find_tunnel_id_by_name(&list2_text, &tunnel_name);
        }
    }
    let Some(id) = tunnel_id else {
        // Include the raw list output in the error so a device report
        // pinpoints WHY parsing failed (auth? empty list? different format?).
        let diag = format!(
            "could not determine tunnel id for '{tunnel_name}'. login_ok={} list_out={:?}",
            login_ok,
            &list_text[..list_text.len().min(400)],
        );
        return diag;
    };
    // 3. DNS route (best-effort)
    let _ = tokio::process::Command::new(&cf)
        .args(["tunnel", "route", "dns", &tunnel_name, &hostname])
        .output().await;
    // 3b. Update the tunnel's REMOTE config via the Cloudflare API — cloudflared
    //     prefers the remote config when one exists, and a stale remote (old
    //     127.0.0.2 ingress) would override the local tunnel.yml. Point the
    //     remote ingress at 127.0.0.1 so both agree.
    update_remote_config(cf_token, &id, &hostname).await;
    // 4. write tunnel.yml (single location, agent spawns it on boot)
    let cred = std::env::var("USERPROFILE")
        .map(|u| format!(r"{u}\.cloudflared\{id}.json"))
        .unwrap_or_else(|_| format!(".cloudflared/{id}.json"));
    let yml = format!(
        "tunnel: {id}\ncredentials-file: {cred}\nallow-remote-config: false\ningress:\n  - hostname: {hostname}\n    service: http://127.0.0.1:18080\n  - service: http_status:404\n"
    );
    let cfg_path = install_dir.join("tunnel.yml");
    // Supervision audit #5: atomic (the boot-spawned cloudflared may be
    // mid-read) — and #1: DO NOT spawn a second tunnel here; the supervisor
    // task owns the single child and restarts on the generation bump.
    let _ = crate::bootstrap::atomic_write(&cfg_path, yml.as_bytes());
    crate::tunnel_ctl::request_restart();
    format!("ok ({hostname})")
}

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
    // Version-query the bundle URLs on the HTML: Cloudflare overrides our
    // no-cache with Browser-Cache-TTL 4h for .js/.css, so after an update
    // browsers kept running the PREVIOUS panel for hours (blank page if it
    // was a broken build). Per-release query strings give each build a
    // distinct cache key; the ?v= is stripped below before whitelist match.
    let html_ver = if file == "index.html" {
        Some(env!("CARGO_PKG_VERSION"))
    } else {
        None
    };
    let body = match html_ver {
        Some(ver) => Body::from(
            body.replacen("panel.css", &format!("panel.css?v={ver}"), 1)
                .replacen("panel.js", &format!("panel.js?v={ver}"), 1),
        ),
        None => Body::from(body),
    };
    let mut resp = built_response(StatusCode::OK, content_type, body);
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
        if let Err(resp) = check_auth(&req, &state) { return *resp; }
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
    if method == Method::GET && (path == "/api/browser/pwshots" || path == "/api/browser/pwshot" || path == "/api/browser/actions") {
        if let Err(resp) = check_auth(&req, &state) { return *resp; }
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
            return built_response(StatusCode::OK, "application/json", Body::from(serde_json::json!({"actions": actions}).to_string()));
        }
        if path == "/api/browser/pwshots" {
            let mut shots: Vec<serde_json::Value> = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&pwout) {
                for e in rd.filter_map(|e| e.ok()) {
                    let name = e.file_name().to_string_lossy().to_string();
                    if !name.ends_with(".png") { continue; }
                    let meta = e.metadata().ok();
                    let mtime_ms = meta.as_ref().and_then(|m| m.modified().ok()).map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)).unwrap_or(0);
                    shots.push(serde_json::json!({
                        "name": name,
                        "mtime_ms": mtime_ms,
                        "size": meta.map(|m| m.len()).unwrap_or(0),
                    }));
                }
            }
            shots.sort_by(|a, b| b["mtime_ms"].as_u64().cmp(&a["mtime_ms"].as_u64()));
            shots.truncate(40);
            return built_response(StatusCode::OK, "application/json", Body::from(serde_json::json!({"shots": shots}).to_string()));
        }
        // /api/browser/pwshot?name=xxx — serve one screenshot (basename only)
        let name = req.uri().query().unwrap_or("")
            .split('&')
            .find_map(|kv| kv.strip_prefix("name="))
            .unwrap_or("");
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
            return built_response(StatusCode::BAD_REQUEST, "text/plain", Body::from("bad name"));
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
            Err(_) => built_response(StatusCode::NOT_FOUND, "text/plain", Body::from("no such shot")),
        }
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
    if method == Method::GET && (path.starts_with("/panel/") || path.starts_with("/desktop/")) {
        // Strip any ?v=… cache-buster before whitelist matching.
        let prefix_len = if path.starts_with("/desktop/") { "/desktop/".len() } else { "/panel/".len() };
        let file = path[prefix_len..].split('?').next().unwrap_or("");
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
            // HIGH(audit round): the WRITER (terminal plugin) logs to
                // paths::data_dir()/sessions — on registry-first installs the
                // exe dir is NOT the data dir (d1: D:\Vale vs C:\ProgramData\
                // Vale), and these endpoints scanned an empty dir: the audit
                // panel was permanently blind. Read the same dir; also honors
                // the "zero current_exe() guessing outside paths.rs" rule.
                let dir = crate::paths::sessions_dir();
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
            // HIGH(audit round): the WRITER (terminal plugin) logs to
                // paths::data_dir()/sessions — on registry-first installs the
                // exe dir is NOT the data dir (d1: D:\Vale vs C:\ProgramData\
                // Vale), and these endpoints scanned an empty dir: the audit
                // panel was permanently blind. Read the same dir; also honors
                // the "zero current_exe() guessing outside paths.rs" rule.
                let dir = crate::paths::sessions_dir();
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
            let cfg_path = state.config_path.lock().unwrap_or_else(|p| p.into_inner()).clone().unwrap_or_default();
            let console_url = Config::load(&cfg_path).ok()
                .and_then(|c| c.platform.console_url.clone());
            // Tunnel state: tunnel.yml present + cloudflared running? Lets the
            // Settings page show the persisted state after a refresh (the
            // Gateway card must not blank out once connected).
            let install_dir = crate::paths::install_dir();
            let tunnel_configured = install_dir.join("tunnel.yml").exists();
            let tunnel_running = std::process::Command::new("tasklist")
                .args(["/FI", "IMAGENAME eq cloudflared.exe"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("cloudflared"))
                .unwrap_or(false);
            serde_json::json!({
                "ok": true,
                "buffer_mb": state.terminal_buf_bytes.load(std::sync::atomic::Ordering::Relaxed) / (1024 * 1024),
                "console_url": console_url,
                "tunnel_configured": tunnel_configured,
                "tunnel_running": tunnel_running,
            })
        }
        ("PUT", "/api/settings") => {
            let v: serde_json::Value = match serde_json::from_str(&body_str) {
                Ok(v) => v,
                Err(e) => return axum::Json(serde_json::json!({
                    "ok": false, "error": format!("invalid JSON: {e}"), "code": "invalid_params",
                })).into_response(),
            };
            // stage-n (settings audit): a PUT may legitimately carry ONLY ONE
            // of the keys — the old code reset buffer_mb to 8 whenever it was
            // ABSENT (a console-only save silently clobbered a user's 64).
            // Missing key = leave unchanged; empty console_url string =
            // explicit clear (unchanged semantics).
            let mb = v.get("buffer_mb").and_then(|b| b.as_u64()).map(|x| (x as usize).clamp(1, 64));
            if let Some(mb) = mb {
                state.terminal_buf_bytes.store(mb * 1024 * 1024, std::sync::atomic::Ordering::Relaxed);
            }
            let console_url = v.get("console_url").map(|val| {
                val.as_str().map(|x| x.trim().to_string()).filter(|x| !x.is_empty())
            });
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
            if mb.is_some() || console_url.is_some() {
                if let Ok(mut cfg) = Config::load(&cfg_path) {
                    if let Some(mb) = mb {
                        cfg.terminal.buffer_mb = mb as u32;
                    }
                    if let Some(url) = console_url.clone() {
                        cfg.platform.console_url = url;
                    }
                    if let Ok(yaml) = serde_yaml::to_string(&cfg) {
                        let _ = crate::bootstrap::atomic_write(&cfg_path, yaml.as_bytes());
                    }
                }
            }
            serde_json::json!({ "ok": true, "buffer_mb": mb.unwrap_or_else(|| {
                state.terminal_buf_bytes.load(std::sync::atomic::Ordering::Relaxed) / (1024 * 1024)
            }) })
        }

        // Gateway connect (Settings page card): persist console_url, then
        // register the device with the gateway (reg-key exchange) and
        // optionally provision the free cloudflared tunnel. Returns per-step
        // results so the page can show what happened.
        ("POST", "/api/gateway/connect") => {
            let v: serde_json::Value = match serde_json::from_str(&body_str) {
                Ok(v) => v,
                Err(_) => return built_response(
                    StatusCode::BAD_REQUEST,
                    "application/json",
                    Body::from(serde_json::json!({
                        "ok": false, "error": "invalid JSON", "code": "invalid_params",
                    }).to_string()),
                ),
            };
            let console_url = v.get("console_url").and_then(|c| c.as_str()).map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let reg_key = v.get("reg_key").and_then(|c| c.as_str()).map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let want_tunnel = v.get("tunnel").and_then(|t| t.as_bool()).unwrap_or(false);
            // 1. Persist console_url to config.yaml.
            let cfg_path = state.config_path.lock().unwrap_or_else(|p| p.into_inner()).clone().unwrap_or_default();
            // HIGH(audit round): the old `unwrap_or_default()` meant a
            // TRANSIENT load failure (AV file-sharing lock, concurrent edit)
            // rewrote the WHOLE config.yaml from a token-less default — next
            // boot ensure_token minted a NEW device token, the gateway saw a
            // fresh device, and every client 401'd. Fall back to the LIVE
            // in-memory config instead of a blank default.
            let mut cfg = Config::load(&cfg_path)
                .unwrap_or_else(|_| state.config.clone());
            // Only touch console_url when the request actually speaks to it:
            // absent = keep binding, "" = clear (the partial-PUT semantics
            // audit flagged — a reg-key-only request used to silently
            // unbind the gateway).
            if let Some(val) = v.get("console_url") {
                cfg.platform.console_url = val
                    .as_str()
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty());
            }
            if let Ok(yaml) = serde_yaml::to_string(&cfg) {
                let _ = crate::bootstrap::atomic_write(&cfg_path, yaml.as_bytes());
            }
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
                        .post(format!("{}/api/install/tunnel-token", url.trim_end_matches('/')))
                        .header("content-type", "application/json")
                        // MED(audit round): a key containing \" or , used to
                        // corrupt/inject fields in the hand-built JSON body.
                        .body(serde_json::json!({ "key": key }).to_string())
                        .send().await;
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
            //    the token (free tier). Best-effort; report the outcome.
            let mut tunnel_status = "skipped".to_string();
            if want_tunnel && !cf_token.is_empty() {
                tunnel_status = provision_tunnel(&cf_token).await;
            } else if want_tunnel {
                tunnel_status = "no cf token (register first or set CLOUDFLARE_API_TOKEN)".to_string();
            }
            serde_json::json!({
                "ok": true,
                "registered": registered,
                "console_url": console_url,
                "tunnel": tunnel_status,
            })
        }

        // ---- Plugin management (round-admin-ui): playwright-mcp process
        // ---- control for the panel's plugins page. Auth: all /api/* POSTs
        // and /api GETs pass the gate above.
        ("GET", "/api/plugins/status") => {
            serde_json::json!({ "ok": true, "playwright": state.playwright.status().await })
        }
        ("POST", "/api/plugins/playwright/start") => {
            match state.playwright.start().await {
                Ok(v) => {
                    // {ok:true, ...v} — merge the manager payload at top level
                    let mut obj = v.as_object().cloned().unwrap_or_default();
                    obj.insert("ok".into(), serde_json::json!(true));
                    serde_json::Value::Object(obj)
                }
                // Dev builds have no bundled node.exe — fail loudly with the
                // path hint instead of pretending the process started.
                Err(e) => return built_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "application/json",
                    Body::from(serde_json::json!({ "ok": false, "error": e.to_string() }).to_string()),
                ),
            }
        }
        ("POST", "/api/plugins/playwright/stop") => {
            match state.playwright.stop().await {
                Ok(v) => {
                    let mut obj = v.as_object().cloned().unwrap_or_default();
                    obj.insert("ok".into(), serde_json::json!(true));
                    serde_json::Value::Object(obj)
                }
                Err(e) => return built_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "application/json",
                    Body::from(serde_json::json!({ "ok": false, "error": e.to_string() }).to_string()),
                ),
            }
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

/// stage-n SSE audit LOW: bound concurrent SSE connections so a flood of
/// viewers can't exhaust tasks/memory. 64 slots shared across /api/events
/// and /api/events/term; each slot is a permit that releases on drop.
static SSE_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
const SSE_MAX_CONNECTIONS: usize = 64;
struct SseConnectionGuard;
impl SseConnectionGuard {
    fn acquire() -> Option<Self> {
        let prev = SSE_CONNECTIONS.fetch_add(1, Ordering::SeqCst);
        if prev < SSE_MAX_CONNECTIONS {
            Some(SseConnectionGuard)
        } else {
            SSE_CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
            None
        }
    }
}
impl Drop for SseConnectionGuard {
    fn drop(&mut self) {
        SSE_CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
    }
}

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
    initial: Option<String>,
) -> Response
where
    T: Clone + Send + 'static,
{
    let (tx, mpsc_rx) = mpsc::channel::<Result<Bytes, Infallible>>(128);

    tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        // stage-n: emit an epoch marker as the FIRST frame so SSE clients can
        // distinguish a fresh agent boot from a quiet stream (the epoch nonce
        // is otherwise only in /api/events/poll).
        if let Some(init) = &initial {
            let _ = tx.send(Ok(Bytes::from(init.clone()))).await;
        }
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
    // this is purely a diagnostic marker.
    let encode = |event: &vale_agent_core::events::SeqEvent| {
        let mut obj = serde_json::to_value(event).unwrap_or_default();
        if let Some(o) = obj.as_object_mut() { o.insert("v".into(), serde_json::json!(1)); }
        format!("data: {}\n\n", obj)
    };
    // Plain data frame so EventSource.onmessage fires; the client responds by
    // polling once from its last seq to catch up.
    let lagged = |n: u64| format!("data: {{\"v\":1,\"lagged\":{n}}}\n\n");
    // stage-n: emit the epoch nonce as the initial frame so SSE clients can
    // distinguish a fresh boot from a quiet stream.
    let epoch = state.event_bus.epoch();
    let initial = Some(format!("data: {{\"v\":1,\"epoch\":{epoch}}}\n\n"));
    sse_response(rx, encode, lagged, initial).await
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

    #[tokio::test]
    async fn desktop_route_serves_spa_and_injects_token() {
        // /desktop/ (vale-desktop shell) serves the same SPA and gets the
        // loopback token injection exactly like /panel/.
        let mut cfg = Config::default();
        cfg.server.device_token = Some("test-token-123".into());
        let st = Arc::new(AppState::new(cfg));
        let r = handle_request(req_with_host("/desktop/", "127.0.0.1:18080"), st.clone()).await;
        assert_eq!(r.status(), StatusCode::OK, "desktop route must serve the SPA");
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        let html = String::from_utf8_lossy(&b);
        assert!(html.contains("id=\"root\""), "desktop SPA html: {html}");
        assert!(html.contains("__PANEL_TOKEN__"), "loopback token injection on /desktop/: {html}");
        // Static asset route: /desktop/panel.js serves the bundle.
        let r = handle_request(req_with_host("/desktop/panel.js", "127.0.0.1:18080"), st).await;
        assert_eq!(r.status(), StatusCode::OK, "desktop panel.js must serve");
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
        assert!(err.contains("node.exe"), "error must name the missing node.exe: {err}");
        assert!(err.contains("playwright"), "error must point at the playwright bundle: {err}");
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
