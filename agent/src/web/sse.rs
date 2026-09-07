//! web/sse.rs — Server-Sent-Events streams (structure refactor: moved
//! verbatim from web/mod.rs). Bounded connection count, heartbeat keep-alive,
//! epoch first-frames — the loss-tolerant stream contract lives here.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::Body;
use axum::http::StatusCode;
use axum::response::Response;
use bytes::Bytes;
use tokio::sync::mpsc;

use vale_agent_core::EventBus;

use crate::state::AppState;

use super::{built_response, set_cache_control};

/// Bound one mpsc send at 5s. Both SSE streams funnel their frames through
/// this: a client that stopped reading fills the bounded channel and an
/// unbounded send would block FOREVER (leaking the task + broadcast
/// subscription on a silently-dead client). Returns true when the send
/// failed or timed out — the caller breaks its loop and drops the stream.
async fn send_bounded(tx: &mpsc::Sender<Result<Bytes, Infallible>>, bytes: Bytes) -> bool {
    tokio::time::timeout(std::time::Duration::from_secs(5), tx.send(Ok(bytes)))
        .await
        .map(|r| r.is_err())
        .unwrap_or(true)
}

static SSE_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
const SSE_MAX_CONNECTIONS: usize = 64;
pub(crate) struct SseConnectionGuard;
impl SseConnectionGuard {
    pub(crate) fn acquire() -> Option<Self> {
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

/// Acquire an SSE viewer slot, or the 503 response to return when the
/// 64-viewer pool is full. The /api/events and /api/events/term handlers in
/// mod.rs used to each inline the same acquire-match-503 block.
pub(crate) fn acquire_sse_guard() -> Result<SseConnectionGuard, Box<Response>> {
    match SseConnectionGuard::acquire() {
        Some(g) => Ok(g),
        None => Err(Box::new(built_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "text/plain",
            Body::from("too many SSE viewers (max 64)"),
        ))),
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
pub(crate) async fn sse_response<T>(
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
            // it and an unbounded send would block FOREVER (leak: the task +
            // broadcast subscription survive a silently-dead client). Bound
            // each send at 5s — a full channel means the client is gone.
            // (send_bounded is the shared helper both SSE streams use.)
            match tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv()).await {
                Ok(Ok(item)) => {
                    if send_bounded(&tx, Bytes::from(encode(&item))).await {
                        break;
                    }
                }
                Ok(Err(RecvError::Lagged(n))) => {
                    // Client gone: stop like the Ok branch, or this task keeps
                    // the broadcast subscription and a failing send forever.
                    if send_bounded(&tx, Bytes::from(lagged(n))).await {
                        break;
                    }
                }
                Ok(Err(RecvError::Closed)) => break,
                Err(_) => {
                    // 30s of silence — heartbeat.
                    if send_bounded(&tx, Bytes::from(": ping\n\n")).await {
                        break;
                    }
                }
            }
        }
    });

    sse_response_from_rx(mpsc_rx)
}

/// Wrap an mpsc receiver into the SSE Response — content-type plus the
/// no-cache / keep-alive header set. sse_response and sse_term_stream
/// used to each inline this tail.
fn sse_response_from_rx(mpsc_rx: mpsc::Receiver<Result<Bytes, Infallible>>) -> Response {
    let body = Body::from_stream(MpscStream { rx: mpsc_rx });

    let mut resp = built_response(StatusCode::OK, "text/event-stream", body);
    set_cache_control(&mut resp, "no-cache");
    resp.headers_mut().insert(
        axum::http::HeaderName::from_static("connection"),
        axum::http::HeaderValue::from_static("keep-alive"),
    );
    resp
}

pub(crate) async fn sse_stream(state: Arc<AppState>) -> Response {
    let rx = state.event_bus.subscribe();
    // SeqEvent serializes as {"seq":n,"event":{...}}. The `v` field is a
    // protocol version anchor (round-54): clients ignore unknown fields, so
    // this is purely a diagnostic marker.
    let encode = |event: &vale_agent_core::events::SeqEvent| {
        let mut obj = serde_json::to_value(event).unwrap_or_default();
        if let Some(o) = obj.as_object_mut() {
            o.insert("v".into(), serde_json::json!(1));
        }
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
pub(crate) async fn sse_term_stream(state: Arc<AppState>) -> Response {
    use tokio::sync::broadcast::error::RecvError;
    use tokio::sync::mpsc;
    let mut rx = state.event_bus.subscribe_term_output();
    // {"v":1,"session_id":"term-0","data":[104,101,...]} — the v field is a
    // protocol version anchor (round-54), same semantics as /api/events.
    let encode = |output: &serde_json::Value| {
        let mut obj = output.clone();
        if let Some(o) = obj.as_object_mut() {
            o.insert("v".into(), serde_json::json!(1));
        }
        format!(
            "data: {}\n\n",
            serde_json::to_string(&obj).unwrap_or_default()
        )
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
            tokio::select! {
                _ = tick.tick() => {
                    // Heartbeat byte — dead-client detection depends on a
                    // send failing (the 5s bounded send into the full mpsc).
                    if send_bounded(&tx, Bytes::from(": ping\n\n")).await { break; }
                }
                msg = rx.recv() => {
                    match msg {
                        Ok(item) => {
                            if send_bounded(&tx, Bytes::from(encode(&item))).await { break; }
                        }
                        Err(RecvError::Lagged(n)) => {
                            if send_bounded(&tx, Bytes::from(lagged(n))).await { break; }
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    sse_response_from_rx(mpsc_rx)
}

// ── Status ────────────────────────────────────────────────────

#[cfg(test)]
mod sse_tests {
    //! round-371: the SSE loss-tolerant contract (epoch-first frames,
    //! lagged fallback, header shape) and the guard acquire/release cycle
    //! had zero tests. All sse_response cases use pre-queued broadcast
    //! sends + sender-drop, so no timers are involved (the 30s heartbeat
    //! arm is intentionally untested — it would take 30s).
    //!
    //! NOTE: SseConnectionGuard tests never drain the 64-slot pool: the
    //! process-global counter is shared with the parallel endpoint tests
    //! (term_sse_streams_output holds a real guard) — a drain-to-None test
    //! would starve them into 503s.
    use super::*;

    async fn body_bytes(resp: Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn frames() -> (impl Fn(&String) -> String, impl Fn(u64) -> String) {
        (
            |s: &String| format!("data: {s}\n\n"),
            |n: u64| format!("data: lagged={n}\n\n"),
        )
    }

    #[test]
    fn guard_acquire_release_cycle() {
        let g = SseConnectionGuard::acquire();
        assert!(g.is_some(), "a free pool must grant a slot");
        drop(g);
        assert!(
            SseConnectionGuard::acquire().is_some(),
            "a dropped guard must release its slot"
        );
    }

    #[test]
    fn guard_two_concurrent_holds_coexist() {
        let a = SseConnectionGuard::acquire();
        let b = SseConnectionGuard::acquire();
        assert!(a.is_some() && b.is_some(), "two holds must both grant");
    }

    #[tokio::test]
    async fn response_carries_sse_headers() {
        let (_tx, rx) = tokio::sync::broadcast::channel::<String>(16);
        let (encode, lagged) = frames();
        let resp = sse_response(rx, encode, lagged, None).await;
        let h = resp.headers();
        assert_eq!(h.get("content-type").unwrap(), "text/event-stream");
        assert_eq!(h.get("cache-control").unwrap(), "no-cache");
        assert_eq!(h.get("connection").unwrap(), "keep-alive");
        drop(_tx);
    }

    #[tokio::test]
    async fn initial_frame_comes_first_then_close_ends_stream() {
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(16);
        let (encode, lagged) = frames();
        let resp = sse_response(rx, encode, lagged, Some("data: epoch=7\n\n".into())).await;
        drop(tx); // no live items: Closed must end the body right after initial
        assert_eq!(body_bytes(resp).await, "data: epoch=7\n\n");
    }

    #[tokio::test]
    async fn live_items_encode_in_fifo_order() {
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(16);
        tx.send("a".to_string()).unwrap();
        tx.send("b".to_string()).unwrap();
        let (encode, lagged) = frames();
        let resp = sse_response(rx, encode, lagged, None).await;
        drop(tx);
        assert_eq!(body_bytes(resp).await, "data: a\n\ndata: b\n\n");
    }

    #[tokio::test]
    async fn lagged_receiver_gets_lagged_frame() {
        // cap-2 channel, 5 sends, zero recvs before handoff: the receiver
        // is lagged by exactly 3 when the pump task takes over.
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(2);
        for i in 0..5 {
            tx.send(format!("m{i}")).unwrap();
        }
        let (encode, lagged) = frames();
        let resp = sse_response(rx, encode, lagged, None).await;
        drop(tx);
        // Lag notice first, then the surviving tail (m3, m4) the channel
        // kept — the loss-tolerant contract: notice + newest, never a gap
        // mistaken for a quiet stream.
        assert_eq!(
            body_bytes(resp).await,
            "data: lagged=3\n\ndata: m3\n\ndata: m4\n\n"
        );
    }
}
