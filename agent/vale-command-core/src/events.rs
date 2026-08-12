//! Agent events and unified EventBus for real-time observability.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use tokio::sync::broadcast;

use crate::recover_guard;

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

    /// Highest seq emitted so far (0 when none) — poll clients advance their
    /// cursor from this even when no events match.
    fn last_seq(&self) -> u64;

    /// Oldest seq still retained in the ring (0 when empty). A client whose
    /// cursor is BELOW this has missed events that were evicted — it can
    /// detect the gap instead of silently losing them.
    fn first_seq(&self) -> u64;

    /// Server boot epoch (unix seconds) — a client detects an agent restart
    /// (seq re-seeded to 1) and resets its cursor instead of silently
    /// skipping the first batch of post-restart events.
    fn epoch(&self) -> u64;

    /// Atomic poll snapshot: events after `after`, plus first/last seq, under
    /// ONE lock. Three separate recent()/last_seq()/first_seq() calls could
    /// see different snapshots — an emit between them made a client skip an
    /// event forever.
    fn poll_after(&self, after: u64) -> (Vec<SeqEvent>, u64, u64);

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
    /// Boot time (unix seconds) — the seq cursor restarts at 1 per process,
    /// so clients use this to detect an agent restart.
    epoch: u64,
}

impl AppEventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        let (term_tx, _) = broadcast::channel(1024);
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Self {
            tx,
            term_tx,
            log: Mutex::new((VecDeque::with_capacity(RING_CAP + 1), 1)),
            hook: Mutex::new(None),
            term_hook: Mutex::new(None),
            epoch,
        }
    }

    /// Set a hook callback invoked on every emit (e.g. Tauri event forwarding).
    pub fn set_hook(&self, hook: impl Fn(u64, &AgentEvent) + Send + Sync + 'static) {
        let mut h = recover_guard(&self.hook);
        *h = Some(Box::new(hook));
    }

    /// Set a hook for terminal output forwarding.
    pub fn set_term_hook(&self, hook: impl Fn(serde_json::Value) + Send + Sync + 'static) {
        let mut h = recover_guard(&self.term_hook);
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
        let mut guard = recover_guard(&self.log);
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
        let hook = recover_guard(&self.hook);
        if let Some(ref f) = *hook {
            f(seq, event);
        }
        seq
    }

    fn subscribe(&self) -> broadcast::Receiver<SeqEvent> {
        self.tx.subscribe()
    }

    fn recent(&self, after: u64) -> Vec<SeqEvent> {
        let guard = recover_guard(&self.log);
        guard.0.iter().filter(|e| e.seq > after).cloned().collect()
    }

    /// Highest seq emitted so far (0 when none). Lets poll clients advance
    /// their cursor even when no events match — the poll response must return
    /// this, otherwise the panel's lastSeq stays 0 and every 2s poll re-fetches
    /// the whole ring and resurrects closed sessions.
    fn last_seq(&self) -> u64 {
        let guard = recover_guard(&self.log);
        guard.1.saturating_sub(1)
    }

    fn first_seq(&self) -> u64 {
        let guard = recover_guard(&self.log);
        guard.0.front().map(|e| e.seq).unwrap_or(0)
    }

    fn poll_after(&self, after: u64) -> (Vec<SeqEvent>, u64, u64) {
        let guard = recover_guard(&self.log);
        let events = guard.0.iter().filter(|e| e.seq > after).cloned().collect();
        let first = guard.0.front().map(|e| e.seq).unwrap_or(0);
        let last = guard.1.saturating_sub(1);
        (events, first, last)
    }

    fn epoch(&self) -> u64 {
        self.epoch
    }

    fn emit_term_output(&self, output: serde_json::Value) {
        // Broadcast to web-panel SSE subscribers first, then the desktop hook —
        // the hook order is preserved so the Tauri "term-output" event is unchanged.
        let _ = self.term_tx.send(output.clone());
        let hook = recover_guard(&self.term_hook);
        if let Some(ref f) = *hook {
            f(output);
        }
    }
}
