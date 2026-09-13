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

use super::{built_response, set_cache_control};

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
    set_cache_control(&mut resp, "no-cache");
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
    set_cache_control(&mut resp, "no-store");
    resp
}

/// Cheap shape check on a `?grant=` code BEFORE any network work.
///
/// THE WIDTH IS THE GATEWAY'S CONTRACT, NOT A GUESS. `store/grants.ts` mints
/// `randomHex(PANELGRANT_CODE_LEN / 2)` and its own read gate is
/// `/^[0-9a-f]{32}$/` — exactly 32 LOWERCASE hex, no `i` flag. This used to accept
/// `16..=128` "for forward-compatibility", which directly contradicted the sentence
/// above it: a 16-hex probe DID cost a redeem round-trip, and that route is
/// unauthenticated, unrate-limited and builds a fresh reqwest client (a new TLS
/// handshake) per attempt. `is_ascii_hexdigit()` also accepted UPPERCASE, which the
/// gateway rejects outright — costing a round-trip for a code that could never be valid.
///
/// If the gateway ever lengthens codes, this bound moves with it; the two are one
/// contract and `panel_grant_shape_matches_the_gateway` pins the pair.
pub(crate) fn plausible_grant(code: &str) -> bool {
    code.len() == 32
        && code
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
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
    // AUDIT. This returned a bool and logged NOTHING, so a redemption left no device-side
    // trace at all — and the grant is exactly the credential an attacker would rather
    // steal than forge (it is redeemed unauthenticated by whoever holds the URL, and its
    // single-use property is only best-effort over eventually-consistent KV). The operator
    // could not tell that anyone had redeemed one.
    //
    // The grant itself is NOT logged: it is a live credential until the gateway deletes
    // it, and logs outlive that window. A short prefix correlates with the gateway's own
    // record without being replayable.
    let tag = &grant[..grant.len().min(8)];
    tracing::info!(grant_prefix = %tag, "panel grant redemption attempted");
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
        Ok(r) if r.status().is_success() => {
            let ok = r
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("ok").and_then(|b| b.as_bool()))
                .unwrap_or(false);
            if ok {
                tracing::warn!(
                    grant_prefix = %tag,
                    "panel grant REDEEMED -- a permanent device token was just injected \
                     into a browser; if this was not the operator, the grant URL leaked"
                );
            } else {
                tracing::info!(grant_prefix = %tag, "panel grant rejected by the gateway");
            }
            ok
        }
        Ok(r) => {
            tracing::info!(
                grant_prefix = %tag,
                status = r.status().as_u16(),
                "panel grant redeem failed"
            );
            false
        }
        Err(e) => {
            tracing::info!(grant_prefix = %tag, error = %e, "panel grant redeem errored");
            false
        }
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

// ── Replay guard for redeemed panel grants ───────────────────
//
// THE GATEWAY CANNOT MAKE A GRANT SINGLE-USE, AND THAT IS A KV PROPERTY, NOT A BUG TO
// PATCH THERE. `store/grants.ts` is Cloudflare KV: `get` caches at the edge (60 s default)
// and a `delete` takes up to ~60 s to become visible everywhere, so a check-then-delete
// lets a SECOND redemption through — the code in `devices.ts` says so itself. A claim key
// does not close it either: the replay usually arrives at a DIFFERENT colo, which has never
// read `grantclaim:<code>` and therefore sees null and claims it happily.
//
// The DEVICE closes it, and it is the right place: this process is SINGLE and STRONGLY
// CONSISTENT, and the realistic replay MUST come through it — an attacker holding a leaked
// grant URL cannot call the gateway's redeem (that needs a device token) but can open
// `/panel/?grant=<code>` at the device, which holds its own token and would redeem on their
// behalf. So a code this device has already redeemed is refused here, where there is no
// eventual consistency to exploit.
//
// Persisted, because an agent restart between the two redemptions would otherwise forget.
// The file is age-pruned: an entry cannot matter after the grant's own TTL has expired.
const REDEEMED_GRANTS_FILE: &str = "panel-grants-redeemed.txt";
/// 120 s is the gateway's `expirationTtl`; keep memory of a code a little past that so a
/// redemption cannot straddle the boundary.
const REDEEMED_GRANT_TTL_SECS: u64 = 600;

static REDEEMED_GRANTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();

fn redeemed_grants() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    REDEEMED_GRANTS.get_or_init(|| std::sync::Mutex::new(load_redeemed_grants()))
}

fn redeemed_grants_path() -> std::path::PathBuf {
    crate::paths::etc_dir().join(REDEEMED_GRANTS_FILE)
}

/// Read the persisted set, dropping entries past the TTL (which cannot matter).
fn load_redeemed_grants() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let Ok(raw) = std::fs::read_to_string(redeemed_grants_path()) else {
        return set;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for line in raw.lines() {
        // `<unix_secs> <code>` — an unparsable line is DROPPED, not trusted.
        let Some((ts, code)) = line.split_once(' ') else {
            continue;
        };
        let Ok(ts) = ts.parse::<u64>() else { continue };
        if now.saturating_sub(ts) < REDEEMED_GRANT_TTL_SECS && !code.is_empty() {
            set.insert(code.to_string());
        }
    }
    set
}

/// Has this device already redeemed `code`? An unreadable/locked store answers `true` —
/// FAIL CLOSED, because the question is "may I inject a permanent token", and "I cannot
/// tell whether this code was already spent" must not authorise it.
pub(crate) fn grant_already_redeemed(code: &str) -> bool {
    match redeemed_grants().lock() {
        Ok(set) => set.contains(code),
        Err(p) => p.into_inner().contains(code),
    }
}

/// Clear the guard: for TESTS ONLY.
///
/// The store is process-global AND file-backed, which is correct for the device (one
/// process, one set of spent codes) and hostile to tests — one test's redemption is
/// another test's refusal, and the file outlives the test BINARY, so a code redeemed by an
/// earlier `cargo test` run is still spent on the next one. Every test that exercises the
/// grant path must start from a clean guard.
#[cfg(test)]
pub(crate) fn reset_redeemed_grants_for_test() {
    if let Ok(mut set) = redeemed_grants().lock() {
        set.clear();
    }
    let _ = std::fs::remove_file(redeemed_grants_path());
}

/// Record a SUCCESSFUL redemption so a replay is refused. Best-effort persistence: if the
/// file cannot be written the in-memory set still guards this process's lifetime.
pub(crate) fn remember_redeemed_grant(code: &str) {
    {
        let mut set = match redeemed_grants().lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        set.insert(code.to_string());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = redeemed_grants_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Rewrite rather than append: the file must stay small and self-pruning, and this runs
    // at most once per successful grant.
    let live: Vec<String> = {
        let set = match redeemed_grants().lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        set.iter().cloned().collect()
    };
    let body: String = live
        .iter()
        .map(|c| format!("{now} {c}\n"))
        .collect::<Vec<_>>()
        .join("");
    let _ = std::fs::write(path, body);
}

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
        assert!(
            plausible_grant(&"a".repeat(32)),
            "the gateway's exact shape"
        );
        // THESE TWO USED TO ASSERT THE LOOSENESS: `"A".repeat(16)` as "uppercase hex +
        // lower bound" and `"f".repeat(128)` as "upper bound". Both are shapes the
        // gateway REJECTS (`/^[0-9a-f]{32}$/`, no `i`), so accepting them bought a
        // redeem round-trip per probe on an unauthenticated, unrate-limited route that
        // opens a fresh TLS connection each time. The test was pinning the defect.
        assert!(
            !plausible_grant(&"A".repeat(32)),
            "uppercase must be rejected: the gateway's regex has no `i` flag"
        );
        assert!(
            !plausible_grant(&"A".repeat(16)),
            "and a 16-char code is not the gateway's shape at all"
        );
        assert!(
            !plausible_grant(&"f".repeat(128)),
            "nor is 128: the width is the contract, not a window"
        );
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
