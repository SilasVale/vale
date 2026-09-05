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

use super::built_response;

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
            // it and tx.send blocks FOREVER (leak: the task + broadcast
            // subscription survive a silently-dead client). Bound each send
            // at 5s — a full channel means the client is gone.
            let send_bounded = async |bytes: Bytes| {
                tokio::time::timeout(std::time::Duration::from_secs(5), tx.send(Ok(bytes)))
                    .await
                    .map(|r| r.is_err())
                    .unwrap_or(true)
            };
            match tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv()).await {
                Ok(Ok(item)) => {
                    if send_bounded(Bytes::from(encode(&item))).await {
                        break;
                    }
                }
                Ok(Err(RecvError::Lagged(n))) => {
                    // Client gone: stop like the Ok branch, or this task keeps
                    // the broadcast subscription and a failing send forever.
                    if send_bounded(Bytes::from(lagged(n))).await {
                        break;
                    }
                }
                Ok(Err(RecvError::Closed)) => break,
                Err(_) => {
                    // 30s of silence — heartbeat.
                    if send_bounded(Bytes::from(": ping\n\n")).await {
                        break;
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
            let send_bounded = async |bytes: Bytes| {
                tokio::time::timeout(std::time::Duration::from_secs(5), tx.send(Ok(bytes)))
                    .await
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
