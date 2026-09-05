//! web/panel.rs — the embedded terminal-panel surface + one-time grant
//! redemption (structure refactor: moved verbatim from web/mod.rs's former
//! monolith; the grant flow is the console's openPanel fix — the permanent
//! device token never rides in a URL).
//!
//! `?grant=` redemption calls the gateway (<console_url>) with the device's
//! OWN Bearer token; success serves the panel with the token injected via
//! the exact same response shape as the authorized injection paths.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::Response;
use tower::Service;

use crate::state::AppState;

use super::built_response;

// ── Terminal panel static assets (embedded, public) ──────────

/// Serve a file from the embedded panel assets. Whitelist by name — no path
/// traversal, no directory listing.
pub(crate) fn serve_panel_file(file: &str, content_type: &'static str) -> Response {
    const HTML: &str = include_str!("../../resources/panel/index.html");
    const JS: &str = include_str!("../../resources/panel/panel.js");
    const CSS: &str = include_str!("../../resources/panel/panel.css");
    const XTERM_JS: &str = include_str!("../../resources/panel/vendor/xterm.min.js");
    const XTERM_CSS: &str = include_str!("../../resources/panel/vendor/xterm.css");
    const FIT_JS: &str = include_str!("../../resources/panel/vendor/xterm-addon-fit.min.js");
    let body: &str = match file {
        "index.html" => HTML,
        "panel.js" => JS,
        "panel.css" => CSS,
        "vendor/xterm.min.js" => XTERM_JS,
        "vendor/xterm.css" => XTERM_CSS,
        "vendor/xterm-addon-fit.min.js" => FIT_JS,
        _ => {
            return built_response(
                StatusCode::NOT_FOUND,
                "text/plain; charset=utf-8",
                Body::from("not found"),
            )
        }
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

pub(crate) fn panel_content_type(file: &str) -> &'static str {
    if file.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if file.ends_with(".css") {
        "text/css; charset=utf-8"
    } else {
        "text/html; charset=utf-8"
    }
}

/// Serve the panel SPA with the device token injected as
/// `window.__PANEL_TOKEN__` (before `</head>`). Shared by every
/// injection-authorized path — loopback, the gateway proxy (X-Vale-Auth
/// secret) and a redeemed one-time panel grant — so all three produce the
/// byte-identical response shape: 200, text/html, no-store (a cached copy of
/// this page IS the device token).
pub(crate) fn panel_token_response(token: &str) -> Response {
    // serde_json escapes quotes but NOT < > (no escape_html feature), so a
    // non-hex token containing </script> could break out of the script
    // element and run attacker JS on the device origin. Escape < > manually.
    let escaped = serde_json::to_string(token)
        .unwrap_or_else(|_| "\"\"".into())
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");
    let inject = format!("<script>window.__PANEL_TOKEN__={escaped};</script>");
    let html = include_str!("../../resources/panel/index.html").replacen(
        "</head>",
        &format!("{inject}</head>"),
        1,
    );
    let mut resp = built_response(StatusCode::OK, "text/html; charset=utf-8", Body::from(html));
    resp.headers_mut().insert(
        axum::http::HeaderName::from_static("cache-control"),
        axum::http::HeaderValue::from_static("no-store"),
    );
    resp
}

/// Cheap shape check on a `?grant=` code BEFORE any network work: the gateway
/// mints 32 lowercase hex chars (store/grants.ts randomHex(16)); anything
/// else is a probe and must not cost a redeem round-trip (a probe that
/// reached the gateway would burn a KV read + a request per attempt). Pure
/// and offline-testable; the 16..=128 window stays forward-compatible if the
/// gateway ever lengthens codes (worst case then: the gateway 404s and the
/// panel falls back to the plain no-token page).
pub(crate) fn plausible_grant(code: &str) -> bool {
    (16..=128).contains(&code.len()) && code.chars().all(|c| c.is_ascii_hexdigit())
}

/// Redeem a one-time panel grant at the gateway: POST
/// `<console_url>/api/devices/panel-grant/redeem` with OUR OWN device token
/// as Bearer (possession of the token IS the device identity — the same rule
/// as self-register) and the grant code from the panel URL in the body. The
/// gateway validates the grant (single-use, 120s TTL, bound to this device),
/// consumes it and answers `{ok:true}`; only then may the token be injected.
///
/// Returns true ONLY on an explicit ok:true. ANY failure (gateway unbound,
/// network down, timeout, non-2xx, bad body) means "no injection" and the
/// caller serves the plain panel — the same readable state a bad token gets.
/// Short 5s timeout: a panel navigation must not hang on a dead gateway.
/// The grant and token values are NEVER logged or echoed anywhere.
///
/// Uses the same inline reqwest pattern as api_gateway_connect below (no
/// shared gateway-call helper exists); rustls-tls keeps the Windows
/// cross-compile pure-Rust.
pub(crate) async fn redeem_panel_grant(console_url: &str, device_token: &str, grant: &str) -> bool {
    let url = format!(
        "{}/api/devices/panel-grant/redeem",
        console_url.trim_end_matches('/')
    );
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client
        .post(url)
        .header("content-type", "application/json")
        .header("Authorization", format!("Bearer {device_token}"))
        .body(serde_json::json!({ "grant": grant }).to_string())
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("ok").and_then(|b| b.as_bool()))
            .unwrap_or(false),
        _ => false,
    }
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
            let resp = super::handle_request(req, state).await;
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
