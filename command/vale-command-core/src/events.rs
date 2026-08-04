//! Agent events and unified EventBus for real-time observability.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use tokio::sync::broadcast;

/// Events emitted after Agent actions complete.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    // ── Browser ──
    BrowserNavigate { url: String, title: String },
    BrowserClick { selector: String },
    BrowserType { selector: String, text: String },
    BrowserScreenshot,
    BrowserScroll { direction: String, amount: String },
    BrowserTabNew { url: String, tab_id: String },
    BrowserTabClose { tab_id: String },
    BrowserTabSelect { tab_id: String },
    BrowserEvaluate { js: String },
    BrowserWaitFor { selector: String },

    // ── SSH ──
    SshConnect { host: String, username: String, session_id: String },
    SshDisconnect { session_id: String },

    // ── Serial ──
    SerialOpen { port: String, baud: u32, session_id: String },
    SerialClose { port_id: String },

    // ── Terminal / Shell ──
    TermClose { session_id: String },
    ShellExec { command: String },
}

/// Broadcast envelope — every event carries a bus-assigned monotonically
/// increasing sequence number. Pollers resume from their last seq; ring
/// eviction can never silently desync them (a gap is detectable).
#[derive(Debug, Clone, Serialize)]
pub struct SeqEvent {
    pub seq: u64,
    pub event: AgentEvent,
}

// ── EventBus ──────────────────────────────────────────────────

/// Unified event distribution. Replaces the previous three-channel approach
/// (broadcast + event_log + Tauri emit) and the NAV_EVENTS static.
pub trait EventBus: Send + Sync {
    /// Emit an event to all subscribers (broadcast, ring buffer, hook).
    /// Returns the assigned sequence number.
    fn emit(&self, event: &AgentEvent) -> u64;

    /// Subscribe to the broadcast channel (for SSE streams).
    fn subscribe(&self) -> broadcast::Receiver<SeqEvent>;

    /// Get recent events with seq > `after` (for polling).
    fn recent(&self, after: u64) -> Vec<SeqEvent>;

    /// Forward terminal output to the desktop UI (no-op by default).
    fn emit_term_output(&self, _output: serde_json::Value) {}
}

/// Max events retained in the ring buffer.
const RING_CAP: usize = 200;

/// Emit hook (e.g. Tauri event forwarding).
type Hook = Mutex<Option<Box<dyn Fn(u64, &AgentEvent) + Send + Sync>>>;
/// Terminal output forwarding hook (e.g. to Tauri "term-output" event).
type TermHook = Mutex<Option<Box<dyn Fn(serde_json::Value) + Send + Sync>>>;

/// Default EventBus implementation: broadcast channel + seq'd ring buffer.
/// An optional hook callback is invoked on each emit (e.g. for Tauri event forwarding).
pub struct AppEventBus {
    tx: broadcast::Sender<SeqEvent>,
    /// Terminal output broadcast (headless web panel streams this via SSE).
    term_tx: broadcast::Sender<serde_json::Value>,
    /// (ring buffer, next sequence number) — single lock keeps seq assignment atomic.
    log: Mutex<(VecDeque<SeqEvent>, u64)>,
    hook: Hook,
    term_hook: TermHook,
}

impl AppEventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        let (term_tx, _) = broadcast::channel(1024);
        Self {
            tx,
            term_tx,
            log: Mutex::new((VecDeque::with_capacity(RING_CAP + 1), 1)),
            hook: Mutex::new(None),
            term_hook: Mutex::new(None),
        }
    }

    /// Set a hook callback invoked on every emit (e.g. Tauri event forwarding).
    pub fn set_hook(&self, hook: impl Fn(u64, &AgentEvent) + Send + Sync + 'static) {
        let mut h = self.hook.lock().unwrap_or_else(|p| p.into_inner());
        *h = Some(Box::new(hook));
    }

    /// Set a hook for terminal output forwarding.
    pub fn set_term_hook(&self, hook: impl Fn(serde_json::Value) + Send + Sync + 'static) {
        let mut h = self.term_hook.lock().unwrap_or_else(|p| p.into_inner());
        *h = Some(Box::new(hook));
    }

    /// Subscribe to the terminal-output broadcast (used by the web panel SSE).
    pub fn subscribe_term_output(&self) -> broadcast::Receiver<serde_json::Value> {
        self.term_tx.subscribe()
    }
}

impl Default for AppEventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus for AppEventBus {
    fn emit(&self, event: &AgentEvent) -> u64 {
        // Assign seq + ring buffer (keep last RING_CAP events, O(1) eviction).
        // A poisoned lock must never silently produce seq 0 — the buffer's
        // contents are still valid, so recover the guard.
        let mut guard = self.log.lock().unwrap_or_else(|p| p.into_inner());
        let (ring, next_seq) = &mut *guard;
        let seq = *next_seq;
        *next_seq += 1;
        ring.push_back(SeqEvent { seq, event: event.clone() });
        if ring.len() > RING_CAP {
            ring.pop_front();
        }
        drop(guard);
        // Broadcast to SSE / any subscriber
        let _ = self.tx.send(SeqEvent { seq, event: event.clone() });
        // Optional hook (e.g. Tauri event forwarding)
        let hook = self.hook.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(ref f) = *hook {
            f(seq, event);
        }
        seq
    }

    fn subscribe(&self) -> broadcast::Receiver<SeqEvent> {
        self.tx.subscribe()
    }

    fn recent(&self, after: u64) -> Vec<SeqEvent> {
        let guard = self.log.lock().unwrap_or_else(|p| p.into_inner());
        guard.0.iter().filter(|e| e.seq > after).cloned().collect()
    }

    fn emit_term_output(&self, output: serde_json::Value) {
        // Broadcast to web-panel SSE subscribers first, then the desktop hook —
        // the hook order is preserved so the Tauri "term-output" event is unchanged.
        let _ = self.term_tx.send(output.clone());
        let hook = self.term_hook.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(ref f) = *hook {
            f(output);
        }
    }
}
