//! Terminal Plugin — unified terminal access (PTY, SSH, Serial).
//!
//! Tools: terminal_open, terminal_write, terminal_close, terminal_list,
//!        terminal_execute, terminal_list_ports, terminal_read,
//!        terminal_screen, terminal_resize, terminal_select,
//!        terminal_history, secret_set/get/delete
//!
//! Tool definitions live in `tools.rs` (one builder fn per tool); this module
//! holds the plugin struct, the per-session output buffer, and the shared
//! ANSI-stripping helper.

mod tools;

use std::collections::HashMap;
use std::sync::Arc;

use vale_agent_core::{Plugin, ToolDef};
use crate::tools::serial::SerialPool;
use crate::tools::terminal::TerminalManager;
use vale_agent_core::EventBus;

/// Per-session output buffer for non-destructive MCP read access.
/// Stores accumulated raw bytes with a cursor tracking how much has been read.
#[derive(Default)]
pub struct SessionBuf {
    pub data: Vec<u8>,
    pub cursor: usize,    // bytes already consumed by terminal_read (index into data)
    pub dropped: u64,     // total bytes evicted from the front (absolute offset base)
    /// Marker-injected PTY only: set once the shell's FIRST prompt marker
    /// has been observed. terminal_execute refuses to write before this —
    /// a command entering PowerShell mid-profile-init gets shredded into
    /// continuation prompts (observed live as `>>` + lost output).
    pub first_prompt_seen: bool,
    pub spill_base: u64,  // absolute offset of the spill FILE's first byte (round-115: the file
                          // is rotated when it exceeds MAX_SPILL_BYTES — the head is dropped,
                          // so reads must offset by this base to stay continuous)
}

impl SessionBuf {
    pub fn new() -> Self {
        Self::default()
    }

    /// Absolute end offset — bytes evicted plus bytes retained.
    pub fn end_abs(&self) -> usize {
        self.dropped as usize + self.data.len()
    }

    /// Slice from an absolute byte offset, clamped. Eviction can at worst
    /// skip or boundedly duplicate data — never panic on an out-of-range index.
    pub fn slice_from(&self, abs: usize) -> &[u8] {
        let rel = abs.saturating_sub(self.dropped as usize).min(self.data.len());
        &self.data[rel..]
    }
}

/// A closed session's buffer retained in memory for terminal_read /
/// terminal_history (process lifetime only — no persistence).
pub struct RetainedSession {
    pub buf: SessionBuf,
    pub kind: String,
    pub label: String,
    pub closed_at_unix: u64, // seconds since epoch, set at retain time
    pub seq: u64,            // monotonic retain order — tie-breaks same-second closes
}

/// Live + retained output buffers, guarded by one mutex so the live→history
/// move on close is atomic (no window where a session is in neither map).
#[derive(Default)]
pub struct SessionStore {
    pub live: HashMap<String, SessionBuf>,
    pub history: HashMap<String, RetainedSession>,
    max_history_sessions: usize,
    max_history_bytes: u64,
    retain_seq: u64,
}

const MAX_HISTORY_SESSIONS: usize = 32;
const MAX_HISTORY_BYTES: u64 = 8 * 1024 * 1024; // 8 MiB

impl SessionStore {
    pub fn new() -> Self {
        // round-96: spill files are retained until their history entry is
        // evicted (R95) — but history is in-memory, so on agent restart every
        // spill file becomes an orphan (R60-H2 leak). A fresh process has an
        // empty history map, so ALL *.spill files are unreachable: sweep them
        // ONCE at process startup (a per-construction sweep would race tests
        // that write their own spill files concurrently).
        crate::plugins::terminal::tools::sweep_spills_once();
        Self {
            live: HashMap::new(),
            history: HashMap::new(),
            max_history_sessions: MAX_HISTORY_SESSIONS,
            max_history_bytes: MAX_HISTORY_BYTES,
            retain_seq: 0,
        }
    }

    #[cfg(test)]
    pub fn with_caps(sessions: usize, bytes: u64) -> Self {
        Self {
            live: HashMap::new(),
            history: HashMap::new(),
            max_history_sessions: sessions,
            max_history_bytes: bytes,
            retain_seq: 0,
        }
    }

    /// Move a live buffer into history (idempotent: false if the drainer
    /// already retained it). Enforces the caps, evicting oldest-closed first.
    pub fn retain_live(&mut self, sid: &str, kind: &str, label: &str) -> bool {
        if let Some(mut buf) = self.live.remove(sid) {
            let closed_at_unix = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            // History reads must be able to read from the beginning again, so
            // reset the cursor (it rode along from the live session).
            buf.cursor = 0;
            self.retain_seq += 1;
            match self.history.get_mut(sid) {
                // Already retained (term_close ran, then the drainer's final
                // tail arrived): MERGE — append the tail, keep the original
                // start offset. A second retain_live that OVERWROTE the entry
                // with only the post-close tail destroyed the full history.
                Some(existing) => {
                    // end_abs is derived (dropped + data.len()) — appending
                    // the tail extends it automatically; original dropped/start
                    // is preserved so reads from the beginning stay correct.
                    existing.buf.data.extend_from_slice(&buf.data);
                    existing.closed_at_unix = closed_at_unix;
                    existing.seq = self.retain_seq;
                }
                None => {
                    self.history.insert(
                        sid.to_string(),
                        RetainedSession { buf, kind: kind.to_string(), label: label.to_string(), closed_at_unix, seq: self.retain_seq },
                    );
                }
            }
            self.enforce_history_caps();
            true
        } else {
            false
        }
    }

    fn enforce_history_caps(&mut self) {
        // Evict the OLDEST-closed first. closed_at_unix is second-granular, so
        // same-second closes tie on it — `seq` (monotonic retain order) breaks
        // the tie deterministically.
        let oldest_key = |history: &HashMap<String, RetainedSession>| {
            history.iter()
                .min_by_key(|(_, h)| (h.closed_at_unix, h.seq))
                .map(|(k, _)| k.clone())
        };
        while self.history.len() > self.max_history_sessions {
            match oldest_key(&self.history) {
                Some(k) => {
                    self.history.remove(&k);
                    // Evicted history entry — its spill head is unreachable
                    // (terminal_read returns evicted:true); drop the file
                    // (round-60: spill had no deletion path anywhere).
                    crate::plugins::terminal::tools::remove_spill_for(&k);
                }
                None => break,
            }
        }
        let mut total: u64 = self.history.values().map(|h| h.buf.end_abs() as u64).sum();
        while total > self.max_history_bytes {
            match oldest_key(&self.history) {
                Some(k) => {
                    total -= self.history.get(&k).map(|h| h.buf.end_abs() as u64).unwrap_or(0);
                    self.history.remove(&k);
                    crate::plugins::terminal::tools::remove_spill_for(&k);
                }
                None => break,
            }
        }
    }
}

pub(super) type OutputBuf = Arc<std::sync::Mutex<SessionStore>>;

/// Ring buffer of panel diagnostics — the terminal page POSTs its runtime
/// state (poll results, adopt events, SSE status, errors) so the developer
/// can read it remotely via terminal_diag_read instead of asking the user to
/// copy DevTools output. Cap 200 entries, process lifetime.
#[derive(Default)]
pub struct DiagBuf {
    entries: std::collections::VecDeque<String>,
}

pub(super) type DiagStore = Arc<std::sync::Mutex<DiagBuf>>;

impl DiagBuf {
    pub fn push(&mut self, line: String) {
        self.entries.push_back(line);
        if self.entries.len() > 200 {
            self.entries.pop_front();
        }
    }
    pub fn snapshot(&self) -> Vec<String> {
        self.entries.iter().cloned().collect()
    }
}

/// Strip ANSI escape sequences and normalize line endings for AI readability.
pub fn clean_terminal_output(raw: &[u8]) -> String {
    let mut out = String::with_capacity(raw.len());
    let bytes = raw;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            // Skip ANSI CSI sequence: ESC [ ... letter
            i += 2;
            while i < bytes.len() && !(bytes[i] >= 0x40 && bytes[i] <= 0x7e) {
                i += 1;
            }
            if i < bytes.len() { i += 1; } // skip the terminating letter
        } else if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b']' {
            // Skip OSC sequence (ESC ] ... ST|BEL): terminal title (ESC ]0;...
            // BEL) appears in every bash prompt, so leaving it in makes AI-read
            // screen text full of ESC]0;... noise. Ends at BEL (\x07) or ST
            // (ESC \).
            // round-105: an OSC that runs to the END of the buffer with no
            // terminator is truncated garbage — the OLD code consumed it all
            // and SWALLOWED the real output after it (up to the next BEL).
            // Only skip OSC sequences that actually terminate.
            i += 2;
            let start = i;
            let mut term = false;
            while i < bytes.len() && bytes[i] != 0x07 {
                if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                    i += 2;
                    term = true;
                    break;
                }
                i += 1;
            }
            if i >= bytes.len() && !term {
                // Unterminated OSC — keep everything from the ESC on (the
                // content is real output; only a complete sequence is noise).
                out.push_str(&String::from_utf8_lossy(&bytes[start - 2..]));
                break;
            } else if !term && i < bytes.len() {
                i += 1; // skip the BEL (ST already consumed)
            }
        } else if bytes[i] == b'\r' {
            // \r\n → \n, standalone \r → \n
            if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                out.push('\n');
                i += 2;
            } else {
                out.push('\n');
                i += 1;
            }
        } else {
            // ASCII or properly-sized UTF-8 sequence
            let b = bytes[i];
            let len = if b < 0x80 {
                1
            } else if b & 0xE0 == 0xC0 {
                2
            } else if b & 0xF0 == 0xE0 {
                3
            } else if b & 0xF8 == 0xF0 {
                4
            } else {
                1 // continuation byte or invalid — replacement below
            };
            let end = (i + len).min(bytes.len());
            let chunk = &bytes[i..end];
            match std::str::from_utf8(chunk) {
                Ok(s) => { out.push_str(s); i = end; }
                Err(_) => { out.push(char::REPLACEMENT_CHARACTER); i += 1; }
            }
        }
    }
    out
}

pub struct TerminalPlugin {
    terminal_mgr: Arc<TerminalManager>,
    serial_pool: Arc<SerialPool>,
    bus: Arc<dyn EventBus>,
    output_buf: OutputBuf,
    diag: DiagStore,
    logger: crate::session_log::SessionLogger,
    buffer_limit: Arc<std::sync::atomic::AtomicUsize>,
}

/// Install dir of the audit log — next to the exe, same place as
/// vale-known-hosts.json (the only location guaranteed writable and stable
/// across upgrades).
pub(super) fn log_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default()
        .join("sessions")
}

impl TerminalPlugin {
    pub fn new(
        terminal_mgr: Arc<TerminalManager>,
        serial_pool: Arc<SerialPool>,
        bus: Arc<dyn EventBus>,
        buffer_limit: Arc<std::sync::atomic::AtomicUsize>,
    ) -> Self {
        // Crash recovery (round-54): a command that never finished (agent
        // died mid-execute) gets a synthetic command/end{interrupted} in its
        // audit file. The command may STILL be running on the device as an
        // orphan — the log says so instead of pretending it vanished.
        let logger = crate::session_log::SessionLogger::new(log_dir());
        let interrupted = logger.recover_interrupted();
        if !interrupted.is_empty() {
            tracing::info!(
                "[vale-agent] session log recovery: {} interrupted session(s) marked: {:?}",
                interrupted.len(), interrupted
            );
        }
        Self {
            terminal_mgr, serial_pool, bus,
            output_buf: Arc::new(std::sync::Mutex::new(SessionStore::new())),
            diag: Arc::new(std::sync::Mutex::new(DiagBuf::default())),
            logger,
            buffer_limit,
        }
    }
}

impl Plugin for TerminalPlugin {
    fn name(&self) -> &'static str { "terminal" }
    fn display_name(&self) -> &'static str { "Terminal" }
    fn description(&self) -> &'static str {
        "Terminal access — PTY local shell, SSH remote, serial port"
    }

    fn tools(&self) -> Vec<ToolDef> {
        tools::build(&self.terminal_mgr, &self.serial_pool, &self.bus, &self.output_buf, &self.diag, &self.logger, &self.buffer_limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vale_agent_core::{AppEventBus, Plugin};
    use serde_json::json;

    fn plugin() -> TerminalPlugin {
        let bus: Arc<dyn EventBus> = Arc::new(AppEventBus::new());
        let serial = Arc::new(SerialPool::new(115200, 1000));
        let mgr = Arc::new(TerminalManager::new(serial.clone()));
        TerminalPlugin::new(mgr, serial, bus, Arc::new(std::sync::atomic::AtomicUsize::new(8 * 1024 * 1024)))
    }

    #[test]
    fn tool_count_and_names() {
        let tools = plugin().tools();
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(tools.len(), 19);
        for expected in [
            "terminal_open", "terminal_write", "terminal_close", "terminal_list",
            "terminal_execute", "terminal_list_ports", "terminal_resize",
            "terminal_select", "terminal_read", "terminal_screen",
            "terminal_history", "terminal_diag_write", "terminal_diag_read",
            "secret_set", "secret_get", "secret_delete",
            "terminal_saved_connections", "terminal_connect_saved",
            "terminal_jobs",
        ] {
            assert!(names.contains(&expected), "missing tool: {expected}");
        }
    }

    #[cfg(not(feature = "terminal"))]
    #[tokio::test]
    async fn terminal_open_headless_errors_propagate() {
        // The stub manager's "backend not enabled" error must reach the caller
        // through the full tool-handler path. Skipped when the real terminal
        // backend is compiled (it would open a real PTY).
        let tools = plugin().tools();
        let t = tools.iter().find(|t| t.name == "terminal_open").unwrap();
        let err = t.handler.call(json!({"kind": "pty", "target": ""})).await.unwrap_err();
        assert!(err.to_string().contains("backend not enabled"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn terminal_write_missing_params() {
        let tools = plugin().tools();
        let t = tools.iter().find(|t| t.name == "terminal_write").unwrap();
        let err = t.handler.call(json!({})).await.unwrap_err();
        assert!(err.to_string().contains("missing required field"), "unexpected error: {err}");
    }
}
