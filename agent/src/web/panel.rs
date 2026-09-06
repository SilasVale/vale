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
    // The host page carries content-hash bundle URLs (each panel rebuild is
    // a distinct cache key); the raw assets serve byte-identical.
    let body = if file == "index.html" {
        Body::from(apply_bundle_hash(body))
    } else {
        Body::from(body)
    };
    let mut resp = built_response(StatusCode::OK, content_type, body);
    resp.headers_mut().insert(
        axum::http::HeaderName::from_static("cache-control"),
        axum::http::HeaderValue::from_static("no-cache"),
    );
    resp
}

/// Content hash of the served panel bundle (`panel.js` + `panel.css`),
/// computed at compile time by `agent/build.rs` (FNV-1a-64, 16 hex chars).
/// Every panel rebuild yields a new value even when the Cargo crate version
/// (frozen at 1.0.x while the npm release rides 1.2.x) does not — the old
/// `?v=<crate-version>` key never changed between releases, so Cloudflare's
/// 4h Browser-Cache-TTL override for .js/.css kept serving the PREVIOUS
/// panel for hours after an update.
pub(crate) fn panel_bundle_hash() -> &'static str {
    env!("PANEL_BUNDLE_HASH")
}

/// Stamp the bundle URLs in the served `index.html` with the content hash.
/// Cloudflare overrides our no-cache with Browser-Cache-TTL 4h for .js/.css,
/// so after an update browsers kept running the PREVIOUS panel for hours
/// (blank page if it was a broken build). A content-hash query string gives
/// each build a distinct cache key; the `?v=` is stripped before whitelist
/// matching on the asset routes. Exactly one replacement per bundle — the
/// vendor `xterm.css` link carries no `?v=` (third-party, changes with the
/// bundle rebuild) and must be left untouched.
pub(crate) fn apply_bundle_hash(html: &str) -> String {
    let ver = panel_bundle_hash();
    html.replacen("panel.css", &format!("panel.css?v={ver}"), 1)
        .replacen("panel.js", &format!("panel.js?v={ver}"), 1)
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
    // Same content-hash bundle URLs as the plain panel path above: this
    // no-store page is always fresh, but without `?v=` its subresources
    // would still resolve to the 4h-cached PREVIOUS bundle after an update.
    let html = apply_bundle_hash(include_str!("../../resources/panel/index.html")).replacen(
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

#[cfg(test)]
mod panel_tests {
    //! round-379: the static whitelist, bundle-hash stamping, token XSS
    //! escaping, grant shape check, and grant redeem outcomes had zero
    //! direct tests (only endpoint-level coverage in mod.rs).
    use super::*;

    async fn body_text(resp: Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap();
        String::from_utf8_lossy(&bytes).to_string()
    }

    #[test]
    fn content_type_map() {
        assert_eq!(
            panel_content_type("panel.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            panel_content_type("vendor/xterm.min.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(panel_content_type("panel.css"), "text/css; charset=utf-8");
        assert_eq!(panel_content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(
            panel_content_type("anything-else"),
            "text/html; charset=utf-8"
        );
    }

    #[tokio::test]
    async fn whitelist_serves_known_files_and_404s_the_rest() {
        for file in [
            "index.html",
            "panel.js",
            "panel.css",
            "vendor/xterm.min.js",
            "vendor/xterm.css",
            "vendor/xterm-addon-fit.min.js",
        ] {
            let resp = serve_panel_file(file, panel_content_type(file));
            assert_eq!(resp.status(), StatusCode::OK, "{file}");
            assert_eq!(
                resp.headers().get("cache-control").unwrap(),
                "no-cache",
                "{file}"
            );
            assert!(!body_text(resp).await.is_empty(), "{file} must have a body");
        }
        // Traversal, query-suffixed, empty, and unknown names all 404 —
        // the match is on exact names, never the filesystem.
        for evil in [
            "../secret",
            "..\\secret",
            "panel.js?v=1",
            "panel.js ",
            "",
            "vendor/evil.js",
            "index.html ",
            "/panel.js",
        ] {
            let resp = serve_panel_file(evil, "text/plain; charset=utf-8");
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{evil:?}");
        }
    }

    #[test]
    fn bundle_hash_stamps_once_and_leaves_vendor_css() {
        let html = r#"<link href="panel.css"><script src="panel.js"></script><link href="vendor/xterm.css">"#;
        let out = apply_bundle_hash(html);
        let ver = panel_bundle_hash();
        assert_eq!(out.matches(&format!("panel.css?v={ver}")).count(), 1);
        assert_eq!(out.matches(&format!("panel.js?v={ver}")).count(), 1);
        assert!(
            out.contains("vendor/xterm.css\">"),
            "vendor css untouched: {out}"
        );
        assert_eq!(ver.len(), 16, "FNV-1a-64 hex");
    }

    #[tokio::test]
    async fn token_response_shape_and_xss_escape() {
        let resp = panel_token_response("abc123");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(resp.headers().get("cache-control").unwrap(), "no-store");
        let body = body_text(resp).await;
        assert!(body.contains("window.__PANEL_TOKEN__=\"abc123\""));

        // A hostile token must not break out of the script element.
        let evil = "ab</script><script>alert(1)//";
        let body = body_text(panel_token_response(evil)).await;
        assert!(
            !body.contains("</script><script>"),
            "script breakout: {body}"
        );
        assert!(body.contains("\\u003c"), "angle brackets escaped: {body}");
    }

    #[test]
    fn grant_shape_check() {
        assert!(plausible_grant(&"a".repeat(32)));
        assert!(
            plausible_grant(&"A".repeat(16)),
            "uppercase hex + lower bound"
        );
        assert!(plausible_grant(&"f".repeat(128)), "upper bound");
        for bad in [
            "",
            "abc",
            &"g".repeat(32),
            &"a".repeat(15),
            &"a".repeat(129),
            "..../../....",
        ] {
            assert!(!plausible_grant(bad), "{bad:?} must be a probe");
        }
    }

    async fn stub_redeem(status: u16, body: Vec<u8>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 8192];
            let mut req = Vec::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
                if req.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let resp = format!(
                "HTTP/1.1 {status} OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.write_all(&body).await;
        });
        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn redeem_true_only_on_explicit_ok_true() {
        let base = stub_redeem(200, br#"{"ok":true}"#.to_vec()).await;
        assert!(redeem_panel_grant(&base, "tok", &"a".repeat(32)).await);

        let base = stub_redeem(200, br#"{"ok":false}"#.to_vec()).await;
        assert!(!redeem_panel_grant(&base, "tok", &"a".repeat(32)).await);

        let base = stub_redeem(200, br#"{"unexpected":1}"#.to_vec()).await;
        assert!(!redeem_panel_grant(&base, "tok", &"a".repeat(32)).await);

        let base = stub_redeem(500, br#"oops"#.to_vec()).await;
        assert!(!redeem_panel_grant(&base, "tok", &"a".repeat(32)).await);

        // Dead gateway: connection refused fails fast (no 5s hang).
        assert!(!redeem_panel_grant("http://127.0.0.1:1", "tok", &"a".repeat(32)).await);
    }
}
