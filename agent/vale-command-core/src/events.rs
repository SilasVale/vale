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
    BrowserNavigate {
        url: String,
        title: String,
    },
    BrowserClick {
        selector: String,
    },
    BrowserType {
        selector: String,
        text: String,
    },
    BrowserScreenshot,
    BrowserScroll {
        direction: String,
        amount: String,
    },
    BrowserTabNew {
        url: String,
        tab_id: String,
    },
    BrowserTabClose {
        tab_id: String,
    },
    BrowserTabSelect {
        tab_id: String,
    },
    BrowserEvaluate {
        js: String,
    },
    BrowserWaitFor {
        selector: String,
    },

    // ── SSH ──
    SshConnect {
        host: String,
        username: String,
        session_id: String,
    },
    SshDisconnect {
        session_id: String,
    },

    // ── Serial ──
    SerialOpen {
        port: String,
        baud: u32,
        session_id: String,
    },
    SerialClose {
        port_id: String,
    },

    // ── Terminal / Shell ──
    TermClose {
        session_id: String,
    },
    ShellExec {
        command: String,
    },
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
// Must be >= the broadcast channel cap (256) so a Lagged subscriber can
// always catch up by polling from its last seq — with 200 < 256, poll could
// never replay the broadcast's retained window.
const RING_CAP: usize = 256;

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
        // Per-boot NONCE, not wall-clock seconds: a same-second restart was
        // undetectable and the panel silently skipped the fresh boot's events.
        let mut e = [0u8; 8];
        let _ = getrandom::getrandom(&mut e);
        let epoch = u64::from_le_bytes(e);
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
        ring.push_back(SeqEvent {
            seq,
            event: event.clone(),
        });
        if ring.len() > RING_CAP {
            ring.pop_front();
        }
        // round-120: the broadcast send used to happen AFTER drop(guard) with
        // an allocation in between — two concurrent emitters (session drainer
        // tasks, handler emits) could deliver events OUT of seq order on the
        // SSE stream, and a seq-deduping client dropped the straggler
        // permanently (poll_after only returns seq > after). tokio broadcast
        // send is synchronous and never awaits, so sending INSIDE the lock
        // keeps send order == seq order at no cost.
        let _ = self.tx.send(SeqEvent {
            seq,
            event: event.clone(),
        });
        drop(guard);
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

#[cfg(test)]
mod event_tests {
    //! round-384: the seq/ring/eviction/epoch contract (gap detection,
    //! poll_after atomicity, the RING_CAP>=broadcast-cap invariant) is
    //! load-bearing for /api/events + SSE yet had zero tests.
    use super::*;
    use std::sync::{Arc, Mutex};

    fn nav(n: u64) -> AgentEvent {
        AgentEvent::BrowserNavigate {
            url: format!("https://example.com/{n}"),
            title: format!("t{n}"),
        }
    }

    #[test]
    fn emit_assigns_monotonic_seq_from_one() {
        let bus = AppEventBus::new();
        assert_eq!(bus.emit(&nav(0)), 1);
        assert_eq!(bus.emit(&nav(1)), 2);
        assert_eq!(bus.last_seq(), 2);
        assert_eq!(bus.first_seq(), 1);
    }

    #[test]
    fn recent_filters_by_cursor_and_empty_bus_is_zeroed() {
        let bus = AppEventBus::new();
        assert_eq!(bus.last_seq(), 0);
        assert_eq!(bus.first_seq(), 0);
        assert!(bus.recent(0).is_empty());
        for i in 0..5 {
            bus.emit(&nav(i));
        }
        let got: Vec<u64> = bus.recent(3).iter().map(|e| e.seq).collect();
        assert_eq!(got, vec![4, 5]);
        assert!(bus.recent(99).is_empty());
    }

    #[test]
    fn poll_after_is_a_consistent_snapshot() {
        let bus = AppEventBus::new();
        for i in 0..3 {
            bus.emit(&nav(i));
        }
        let (events, first, last) = bus.poll_after(1);
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![2, 3]);
        assert_eq!((first, last), (1, 3));
        assert_eq!((bus.first_seq(), bus.last_seq()), (first, last));
    }

    #[test]
    fn ring_evicts_oldest_and_gap_stays_detectable() {
        // RING_CAP (256) must cover the broadcast cap so a Lagged
        // subscriber can always catch up by polling — pinned here.
        assert!(RING_CAP >= 256);
        let bus = AppEventBus::new();
        for i in 0..(RING_CAP as u64 + 44) {
            bus.emit(&nav(i));
        }
        assert_eq!(bus.last_seq(), RING_CAP as u64 + 44);
        assert_eq!(
            bus.first_seq(),
            45,
            "oldest 44 evicted, first retained is 45"
        );
        assert_eq!(bus.recent(0).len(), RING_CAP);
        // A cursor below first_seq sees the gap instead of silent loss.
        assert!(bus.first_seq() > 1);
        assert!(bus.recent(44).iter().all(|e| e.seq >= 45));
    }

    #[test]
    fn hook_fires_with_seq_and_event() {
        let bus = AppEventBus::new();
        let seen: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        bus.set_hook(move |seq, _| seen2.lock().unwrap().push(seq));
        bus.emit(&nav(0));
        bus.emit(&nav(1));
        assert_eq!(*seen.lock().unwrap(), vec![1, 2]);
    }

    #[test]
    fn epoch_is_a_per_boot_nonce() {
        let a = AppEventBus::new();
        let b = AppEventBus::new();
        assert_eq!(a.epoch(), a.epoch(), "stable within a process");
        assert_ne!(a.epoch(), b.epoch(), "a restart must look different");
    }

    #[test]
    fn term_output_reaches_subscribers_and_hook() {
        let bus = AppEventBus::new();
        let mut rx = bus.subscribe_term_output();
        let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        bus.set_term_hook(move |v| seen2.lock().unwrap().push(v));
        bus.emit_term_output(serde_json::json!({"sid": "s1"}));
        let got = rx.try_recv().expect("broadcast must carry term output");
        assert_eq!(got, serde_json::json!({"sid": "s1"}));
        assert_eq!(
            *seen.lock().unwrap(),
            vec![serde_json::json!({"sid": "s1"})]
        );
    }

    #[test]
    fn seq_event_serializes_with_seq_and_tagged_type() {
        // The /api/events/poll + SSE wire shape.
        let e = SeqEvent {
            seq: 7,
            event: AgentEvent::BrowserScreenshot,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["seq"], 7);
        assert_eq!(v["event"]["type"], "BrowserScreenshot");
    }

    #[test]
    fn broadcast_carries_emits_in_seq_order() {
        // The round-120 invariant: send-inside-lock keeps SSE order == seq.
        let bus = AppEventBus::new();
        let mut rx = bus.subscribe();
        for i in 0..10 {
            bus.emit(&nav(i));
        }
        let mut seqs = Vec::new();
        while let Ok(e) = rx.try_recv() {
            seqs.push(e.seq);
        }
        assert_eq!(seqs, (1..=10).collect::<Vec<_>>());
    }
}
