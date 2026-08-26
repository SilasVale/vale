//! WebSocket relay for the interactive remote browser (round-137, Plan C).
//!
//! The panel's BrowserPane previously polled JPEG frames over HTTP
//! (/api/browser/frame at ~7fps). This module adds the streaming path:
//!
//!   POST /api/browser/ws-ticket   Bearer-gated, issues a one-time ticket
//!                                 (30 s TTL, in-memory, single-use)
//!   GET  /api/browser/ws?ticket=  validates the ticket, upgrades the client
//!                                 WebSocket, dials ws://127.0.0.1:9224/ws,
//!                                 and relays raw bytes both ways.
//!
//! Design constraints that shaped this:
//!   * Browser WebSocket cannot carry an Authorization header — hence the
//!     ticket (a long-lived device token must never appear in a URL; the
//!     ticket itself is single-use and expires in seconds, so CF/tunnel logs
//!     only ever capture a worthless value).
//!   * The agent does NOT parse WebSocket frames. It terminates the client
//!     handshake (computing Sec-WebSocket-Accept itself), performs its own
//!     handshake against the local bridge, then pipes raw bytes with
//!     `copy_bidirectional`. Framing stays at the two ends (browser and
//!     bridge.js), so no tungstenite-class dependency rides along — the
//!     hand-rolled Tower service + cargo-xwin cross-compile stay intact.
//!   * Bridge tokens: main.rs spawns bridge.js without a token argument, so
//!     the bridge trusts loopback connections; the agent connects from
//!     loopback, which is the only place it ever reaches.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use base64::Engine as _;

/// One-time tickets: hex id → expiry instant. Redeemed or expired entries
/// are removed eagerly; the map is bounded in practice (tickets live 30 s
/// and each is redeemed at most once), but a sweep guards pathological
/// issuance rates anyway.
static TICKETS: std::sync::Mutex<Option<HashMap<String, Instant>>> =
    std::sync::Mutex::new(None);

const TICKET_TTL: Duration = Duration::from_secs(30);
const MAX_LIVE_TICKETS: usize = 256;

/// Random hex string (32 chars = 16 bytes) from the OS/CPU RNG.
fn random_hex_32() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("RNG failure is unrecoverable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Issue a one-time WS ticket. Fails (None) only if the store is poisoned
/// beyond recovery AND pruning cannot make room — practically never.
pub fn issue_ticket() -> Option<String> {
    let mut guard = TICKETS.lock().ok()?;
    let map = guard.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    // Lazy sweep: drop expired entries while we hold the lock.
    map.retain(|_, exp| *exp > now);
    if map.len() >= MAX_LIVE_TICKETS {
        return None;
    }
    // Constant-time-ish uniqueness is irrelevant here; collision with a live
    // ticket would be a 128-bit accident, but retry once regardless.
    let ticket = random_hex_32();
    if map.contains_key(&ticket) {
        return None;
    }
    map.insert(ticket.clone(), now + TICKET_TTL);
    Some(ticket)
}

/// Redeem a ticket: single-use — valid tickets are consumed on read.
pub fn redeem_ticket(ticket: &str) -> bool {
    if ticket.is_empty() || ticket.len() != 32 || !ticket.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let Ok(mut guard) = TICKETS.lock() else { return false };
    let Some(map) = guard.as_mut() else { return false };
    match map.remove(ticket) {
        Some(exp) => exp > Instant::now(),
        None => false,
    }
}

/// Sec-WebSocket-Accept per RFC 6455 §1.3: base64(SHA-1(key + GUID)).
pub fn ws_accept(client_key: &str) -> String {
    use sha1::{Digest, Sha1};
    const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    let mut h = Sha1::new();
    h.update(client_key.as_bytes());
    h.update(GUID.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(h.finalize())
}

/// Random 16-byte value as base64 — Sec-WebSocket-Key for OUR side of the
/// upstream handshake (the bridge never validates it beyond presence).
fn random_ws_key() -> String {
    use base64::Engine as _;
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("RNG failure is unrecoverable");
    base64::engine::general_purpose::STANDARD.encode(buf)
}

/// Dial the device-local bridge and perform OUR side of a RFC6455 handshake,
/// BEFORE the caller upgrades the browser side — so a dead bridge surfaces as
/// a plain 502 instead of a 101 that instantly dies.
///
/// `on_upgrade` is the pending-upgrade handle taken from the request
/// extensions (hyper inserts it for every HTTP/1 connection); owning it —
/// instead of borrowing the response, whose lifetime ends at return — is
/// exactly how axum's own ws flow stays 'static.
pub async fn relay_to_bridge(
    client_key: String,
    on_upgrade: hyper::upgrade::OnUpgrade,
) -> Result<axum::response::Response, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut up = tokio::net::TcpStream::connect("127.0.0.1:9224")
        .await
        .map_err(|e| format!("bridge unreachable: {e}"))?;

    let hs = format!(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:9224\r\nUpgrade: websocket\r\n\
         Connection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        random_ws_key()
    );
    up.write_all(hs.as_bytes())
        .await
        .map_err(|e| format!("bridge handshake write: {e}"))?;

    // Read the bridge's 101 head (bounded: headers only, 5 s ceiling).
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let n = up.read(&mut byte).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("bridge closed during handshake".to_string());
            }
            head.push(byte[0]);
            if head.ends_with(b"\r\n\r\n") {
                break;
            }
            if head.len() > 8192 {
                return Err("bridge handshake oversized".to_string());
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "bridge handshake timeout".to_string())?
    .map_err(|e: String| e)?;

    if !head.starts_with(b"HTTP/1.1 101") && !head.starts_with(b"HTTP/1.0 101") {
        return Err(format!(
            "bridge refused upgrade: {}",
            String::from_utf8_lossy(&head[..head.len().min(64)])
        ));
    }

    // All preconditions met — upgrade the BROWSER side now.
    let accept = ws_accept(&client_key);
    let resp = axum::http::Response::builder()
        .status(axum::http::StatusCode::SWITCHING_PROTOCOLS)
        .header("upgrade", "websocket")
        .header("connection", "Upgrade")
        .header("sec-websocket-accept", accept)
        .body(axum::body::Body::empty())
        .map_err(|e| format!("build 101: {e}"))?;

    tokio::spawn(async move {
        match on_upgrade.await {
            Ok(io) => {
                // hyper 1.x's Upgraded only implements hyper::rt::{Read, Write};
                // TokioIo adapts it to tokio::io style (same approach as axum ws).
                let mut io = hyper_util::rt::TokioIo::new(io);
                if let Err(e) = tokio::io::copy_bidirectional(&mut io, &mut up).await {
                    tracing::debug!(target: "ws_relay", "pipe ended: {e}");
                }
            }
            Err(e) => tracing::debug!(target: "ws_relay", "upgrade failed: {e}"),
        }
    });

    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_matches_rfc_example() {
        // RFC 6455 §1.3 worked example.
        assert_eq!(
            ws_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn ticket_roundtrip_and_single_use() {
        let t = issue_ticket().expect("issue");
        assert!(t.len() == 32 && t.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(redeem_ticket(&t), "first redemption must succeed");
        assert!(!redeem_ticket(&t), "second redemption must fail");
    }

    #[test]
    fn ticket_rejects_garbage() {
        assert!(!redeem_ticket(""));
        assert!(!redeem_ticket("short"));
        assert!(!redeem_ticket("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")); // non-hex, right length
    }

    #[test]
    fn tickets_are_unique_across_issues() {
        let a = issue_ticket().unwrap();
        let b = issue_ticket().unwrap();
        assert_ne!(a, b);
    }
}
