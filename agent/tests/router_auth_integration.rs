//! ROUTER-LEVEL auth integration (SOLID R103).
//!
//! R102 made `web::handle_request`'s auth gate unconditional and pinned it with
//! unit tests — but those tests call the handler DIRECTLY, so they say nothing
//! about the axum layer that actually decides which handler sees a request.
//! That layer is assembled in exactly one place (`mcp::bind`):
//!
//! ```text
//! Router::new()
//!   .nest_service("/mcp", TokenGate::new(StreamableHttpService, state))
//!   .fallback_service(WebPanel::new(state))
//! ```
//!
//! Everything security-relevant about it is structural: `/mcp` is protected by
//! a Tower layer that never runs `handle_request`, and everything else falls
//! through to the Tower service that DOES. A routing edit (a nested path that
//! no longer matches, a fallback that swallows `/mcp`, a gate applied to the
//! wrong branch) would leave every existing test green.
//!
//! So this file drives a REAL server over real HTTP and asserts the composed
//! behaviour of both branches. No rmcp client: the point is the routing layer,
//! not the MCP protocol (tests/mcp_integration.rs covers that).

use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use vale_agent::state::AppState;
use vale_agent_core::Config;

const TOKEN: &str = "router-test-token";

/// Start the real composed router on an ephemeral loopback port.
async fn start() -> (String, CancellationToken) {
    let mut cfg = Config::default();
    cfg.server.host = "127.0.0.1".into();
    cfg.server.port = 0; // ephemeral — bind() reports the real port
    cfg.server.device_token = Some(TOKEN.into());
    let state = Arc::new(AppState::new(cfg.clone()));
    let ct = CancellationToken::new();
    let (addr, _handle) = vale_agent::mcp::bind(cfg, state, ct.clone())
        .await
        .expect("bind real server");
    // `_handle` is dropped on purpose: dropping a JoinHandle DETACHES the
    // server task rather than aborting it, so the listener keeps serving while
    // the test drives it. Each test stops its server with ct.cancel() at the
    // end (a failing assertion skips that, leaving the task to die with the
    // test process — a detached test server on an ephemeral loopback port).
    (format!("http://{addr}"), ct)
}

/// Status of one request, with a timeout so a routing mistake fails the test
/// instead of hanging the suite.
async fn status(base: &str, method: &str, path: &str, token: Option<&str>) -> u16 {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("client");
    let mut req = match method {
        "GET" => client.get(format!("{base}{path}")),
        "POST" => client.post(format!("{base}{path}")),
        other => panic!("unsupported method {other}"),
    };
    if let Some(t) = token {
        // The device protocol is `Authorization: Bearer <token>`.
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    req.send()
        .await
        .expect("request must reach the server")
        .status()
        .as_u16()
}

/// `/mcp` is protected by `TokenGate`, a Tower layer that sits ON TOP of the
/// MCP service and never enters `handle_request`. If the nest_service wiring
/// ever changed such that `/mcp` fell through to the web fallback, the MCP
/// surface would be served by the wrong gate (or none) — this catches that.
#[tokio::test]
async fn mcp_route_is_gated_by_the_router_not_the_fallback() {
    let (base, ct) = start().await;

    assert_eq!(
        status(&base, "POST", "/mcp", None).await,
        401,
        "/mcp served without a token"
    );
    assert_eq!(
        status(&base, "POST", "/mcp", Some("wrong-token")).await,
        401,
        "/mcp served with a WRONG token"
    );
    // With the right token the gate opens: whatever the MCP transport answers
    // for an empty POST (400/406/…), it must no longer be an auth rejection.
    let ok = status(&base, "POST", "/mcp", Some(TOKEN)).await;
    assert_ne!(ok, 401, "/mcp rejected a VALID token");

    ct.cancel();
}

/// The fallback branch (everything that is not `/mcp`) goes through
/// `WebPanel::call` → `handle_request`. R102 pinned the handler; this pins
/// that the router actually routes to it, for both the gated and the public
/// side of that surface.
#[tokio::test]
async fn fallback_route_reaches_the_web_gate() {
    let (base, ct) = start().await;

    // Gated: no token / wrong token.
    for path in ["/api/status", "/api/spec", "/api/tools/terminal_list"] {
        assert_eq!(
            status(&base, "GET", path, None).await,
            401,
            "{path} served without a token through the fallback"
        );
    }
    assert_eq!(
        status(&base, "GET", "/api/status", Some("wrong-token")).await,
        401,
        "/api/status served with a WRONG token"
    );
    // A POST is gated too (the old needs_auth flag short-circuited GETs).
    assert_eq!(
        status(&base, "POST", "/api/tools/terminal_list", None).await,
        401,
        "POST dispatch served without a token"
    );
    // Right token opens the API.
    assert_eq!(
        status(&base, "GET", "/api/status", Some(TOKEN)).await,
        200,
        "/api/status rejected a VALID token"
    );

    ct.cancel();
}

/// The public surfaces must survive the router composition too — they are
/// reachable without a token BY DESIGN (the SPA shows nothing until the user
/// supplies one, and the status page names no device data).
#[tokio::test]
async fn public_routes_stay_public_through_the_router() {
    let (base, ct) = start().await;

    for path in ["/", "/panel/", "/desktop/"] {
        let code = status(&base, "GET", path, None).await;
        assert_ne!(code, 401, "{path} must stay public through the router");
        assert!(
            (200..300).contains(&code),
            "{path} should serve content, got {code}"
        );
    }

    ct.cancel();
}
