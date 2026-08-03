//! CDP client via WebSocket to a Chromium remote debugging port (19623).
//!
//! The client machinery is gated behind the `browser` feature (used by both
//! the Tauri desktop backend and the headless Chrome/Edge backend); CDP_PORT
//! stays ungated because tests assert it in both configs.

pub const CDP_PORT: u16 = 19623;

#[cfg(feature = "browser")]
mod client {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::sync::{broadcast, oneshot};

    use super::CDP_PORT;
    use vale_command_core::DeviceError;

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>;

    pub struct CdpClient {
        write: tokio::sync::Mutex<futures::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, tokio_tungstenite::tungstenite::Message>>,
        pending: PendingMap,
        /// CDP event broadcaster (Page.loadEventFired, etc.)
        events_tx: broadcast::Sender<serde_json::Value>,
    }

    impl CdpClient {
        /// List all CDP targets on the default port. Returns (id, url, title, webSocketDebuggerUrl).
        pub async fn list_targets() -> Result<Vec<(String, String, String, String)>, DeviceError> {
            Self::list_targets_on(CDP_PORT).await
        }

        /// List all CDP targets on a specific port (headless browsers use a
        /// configurable port). Returns (id, url, title, webSocketDebuggerUrl).
        pub async fn list_targets_on(port: u16) -> Result<Vec<(String, String, String, String)>, DeviceError> {
            let list_url = format!("http://localhost:{port}/json");
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .map_err(|e| DeviceError::CdpConnectionFailed { reason: format!("http client: {e}") })?;
            let resp = client.get(&list_url).send().await
                .map_err(|e| DeviceError::CdpConnectionFailed { reason: format!("http: {e}") })?;
            let pages: Vec<serde_json::Value> = resp.json().await
                .map_err(|e| DeviceError::CdpConnectionFailed { reason: format!("parse: {e}") })?;
            Ok(pages.iter().map(|p| (
                p.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                p.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                p.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                p.get("webSocketDebuggerUrl").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            )).collect())
        }

        pub async fn connect_ws(ws_url: &str) -> Result<Self, DeviceError> {
            let (ws, _) = tokio_tungstenite::connect_async(ws_url).await
                .map_err(|e| DeviceError::CdpConnectionFailed { reason: format!("ws: {e}") })?;

            use futures::StreamExt;
            let (write, mut read) = ws.split();
            let write = tokio::sync::Mutex::new(write);
            let pending: PendingMap = Default::default();
            let pending_rx = pending.clone();
            let (events_tx, _) = broadcast::channel(64);
            let events_tx2 = events_tx.clone();

            tokio::spawn(async move {
                while let Some(msg) = read.next().await {
                    if let Ok(tokio_tungstenite::tungstenite::Message::Text(text)) = msg {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
                                // Response to a command
                                if let Ok(mut map) = pending_rx.lock() {
                                    if let Some(tx) = map.remove(&id) {
                                        let _ = tx.send(v.get("result").cloned().unwrap_or_default());
                                    }
                                }
                            } else if v.get("method").is_some() {
                                // CDP event (Page.loadEventFired, etc.)
                                let _ = events_tx2.send(v);
                            }
                        }
                    }
                }
                // Stream ended — drop all in-flight senders so callers fail
                // immediately with "closed" instead of waiting out the 10s timeout.
                if let Ok(mut map) = pending_rx.lock() {
                    map.clear();
                }
            });

            Ok(CdpClient { write, pending, events_tx })
        }

        pub async fn send(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, DeviceError> {
            use futures::SinkExt;
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = oneshot::channel();
            self.pending.lock().unwrap().insert(id, tx);
            let msg = serde_json::json!({"id": id, "method": method, "params": params});
            let msg_str = serde_json::to_string(&msg).unwrap();
            if let Err(e) = self.write.lock().await
                .send(tokio_tungstenite::tungstenite::Message::Text(msg_str)).await
            {
                // Don't leave the entry behind — the reader may never see this id
                if let Ok(mut map) = self.pending.lock() { map.remove(&id); }
                return Err(DeviceError::CdpCommand { method: method.into(), reason: format!("send: {e}") });
            }
            match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
                Ok(Ok(v)) => Ok(v),
                Ok(Err(_)) => Err(DeviceError::CdpCommand { method: method.into(), reason: "closed".into() }),
                Err(_) => {
                    if let Ok(mut map) = self.pending.lock() { map.remove(&id); }
                    Err(DeviceError::Timeout { message: format!("cdp {method} (10s)") })
                }
            }
        }

        /// Subscribe to CDP events (Page.loadEventFired, etc.)
        pub fn subscribe_events(&self) -> broadcast::Receiver<serde_json::Value> {
            self.events_tx.subscribe()
        }

        pub async fn navigate(&self, url: &str) -> Result<(), DeviceError> {
            // Enable Page domain events (idempotent)
            self.send("Page.enable", serde_json::json!({})).await.ok();
            self.send("Page.navigate", serde_json::json!({"url": url})).await?;
            Ok(())
        }

        pub async fn evaluate(&self, js: &str) -> Result<serde_json::Value, DeviceError> {
            let resp = self.send("Runtime.evaluate", serde_json::json!({
                "expression": js, "returnByValue": true, "awaitPromise": true
            })).await?;
            // CDP returns {result: {type, value}} — extract the actual value
            Ok(resp.get("result")
                .and_then(|r| r.get("value"))
                .cloned()
                .unwrap_or_default())
        }

        pub async fn screenshot(&self) -> Result<String, DeviceError> {
            let r = self.send("Page.captureScreenshot", serde_json::json!({"format": "png"})).await?;
            r.get("data").and_then(|d| d.as_str()).map(|s| s.to_string())
                .ok_or_else(|| DeviceError::CdpCommand { method: "Page.captureScreenshot".into(), reason: "no data".into() })
        }
    }
}

#[cfg(feature = "browser")]
pub use client::CdpClient;
