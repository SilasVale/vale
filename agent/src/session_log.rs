//! Session audit log — append-only JSONL per terminal session.
//!
//! Every terminal command on a device is recorded as an event stream
//! (`<install>/sessions/<sid>.jsonl`): command/start → output chunks →
//! command/end. On agent restart the logger replays each file and appends a
//! synthetic `command/end { reason: interrupted }` for any command that never
//! finished — an audit trail for device-control compliance, and the panel
//! can show "interrupted — may still be running on the device" instead of
//! pretending the command vanished with the process (round-54, dsh event
//! sourcing: the append-only log is the source of truth).
//!
//! Writes are best-effort by design — a log failure must never block or
//! break the terminal itself.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// One audit event for a session. `seq` is per-session monotonic; `ts` is
/// unix seconds. Optional fields are omitted when absent (compact JSONL).
#[derive(Debug, Clone, Serialize)]
pub struct SessionEvent {
    pub seq: u64,
    pub ts: u64,
    pub kind: String, // "command/start" | "output" | "command/end" | "status"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

impl SessionEvent {
    pub fn command_start(seq: u64, command: &str) -> Self {
        Self { seq, ts: unix_now(), kind: "command/start".into(), command: Some(command.to_string()), text: None, exit_code: None, reason: None, status: None }
    }
    pub fn output(seq: u64, text: String) -> Self {
        Self { seq, ts: unix_now(), kind: "output".into(), command: None, text: Some(text), exit_code: None, reason: None, status: None }
    }
    pub fn command_end(seq: u64, exit_code: Option<i32>, reason: Option<&str>) -> Self {
        Self { seq, ts: unix_now(), kind: "command/end".into(), command: None, text: None, exit_code, reason: reason.map(|s| s.to_string()), status: None }
    }
    pub fn status(seq: u64, status: &str) -> Self {
        Self { seq, ts: unix_now(), kind: "status".into(), command: None, text: None, exit_code: None, reason: None, status: Some(status.to_string()) }
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// One JSONL file per session under the log dir. Internal state is a mutex
/// so concurrent tools (drainer + execute) can log without serializing on
/// callers; file appends are atomic enough for line-level integrity (each
/// event is written in a single write()).
#[derive(Clone)]
pub struct SessionLogger {
    dir: PathBuf,
    seq: std::sync::Arc<Mutex<HashMap<String, u64>>>,
}

impl SessionLogger {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self { dir, seq: std::sync::Arc::new(Mutex::new(HashMap::new())) }
    }

    /// Directory holding the JSONL files (exposed for tests).
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn next_seq(&self, sid: &str) -> u64 {
        let mut seqs = self.seq.lock().unwrap_or_else(|p| p.into_inner());
        let n = seqs.entry(sid.to_string()).or_insert(0);
        *n += 1;
        *n
    }

    /// Append one event for a session. Best-effort: a write error (disk
    /// full, read-only install dir) is logged via tracing, never surfaced —
    /// the terminal must keep working when the audit trail cannot.
    pub fn log(&self, sid: &str, ev: SessionEvent) {
        let seq = self.next_seq(sid);
        let ev = SessionEvent { seq, ..ev };
        let path = self.dir.join(format!("{sid}.jsonl"));
        let line = serde_json::to_string(&ev).unwrap_or_default();
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            // New file → write the version header FIRST (round-56). A future
            // format change reads the header and knows whether it can parse
            // the file, instead of assuming the old shape.
            if f.metadata().map(|m| m.len() == 0).unwrap_or(false) {
                let _ = writeln!(f, "{}", serde_json::json!({
                    "type": "session", "version": 1, "id": sid,
                    "createdAt": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs()).unwrap_or(0),
                }));
            }
            let _ = writeln!(f, "{line}");
        } else {
            tracing::warn!("[vale-agent] session log write failed: {}", path.display());
        }
    }

    pub fn log_command_start(&self, sid: &str, command: &str) {
        self.log(sid, SessionEvent::command_start(0, command));
    }
    pub fn log_output(&self, sid: &str, text: String) {
        // Cap a single chunk at 4 KiB — a full 1MB burst would dominate the
        // audit trail for one session. The event stream stays dense enough
        // to reconstruct what ran.
        let text = if text.len() > 4096 { format!("{}…[truncated {} bytes]", &text[..4096], text.len() - 4096) } else { text };
        self.log(sid, SessionEvent::output(0, text));
    }
    pub fn log_command_end(&self, sid: &str, exit_code: Option<i32>, reason: Option<&str>) {
        self.log(sid, SessionEvent::command_end(0, exit_code, reason));
    }
    pub fn log_status(&self, sid: &str, status: &str) {
        self.log(sid, SessionEvent::status(0, status));
    }

    /// Replay a session file, skipping the version header. Returns the parsed
    /// events (for recovery/fold) — or None if the file has no events.
    fn read_events(&self, sid: &str) -> Option<(Vec<serde_json::Value>, u64)> {
        let path = self.dir.join(format!("{sid}.jsonl"));
        let content = std::fs::read_to_string(&path).ok()?;
        let mut events = Vec::new();
        let mut max_seq = 0u64;
        for line in content.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            // Header line — not an event.
            if v.get("type").and_then(|t| t.as_str()) == Some("session") { continue; }
            if let Some(seq) = v.get("seq").and_then(|s| s.as_u64()) {
                max_seq = max_seq.max(seq);
            }
            events.push(v);
        }
        Some((events, max_seq))
    }

    /// Public read of a session's events (for /api/sessions UI — round-56).
    pub fn events_of(&self, sid: &str) -> Vec<serde_json::Value> {
        self.read_events(sid).map(|(e, _)| e).unwrap_or_default()
    }

    /// Fold a session's last event into a terminal state (round-56): the
    /// panel's history can show "last activity / final status" instead of
    /// nothing.
    pub fn terminal_state_of(&self, sid: &str) -> Option<serde_json::Value> {
        let (events, _) = self.read_events(sid)?;
        let last = events.last()?;
        Some(serde_json::json!({
            "kind": last.get("kind").and_then(|k| k.as_str()).unwrap_or(""),
            "ts": last.get("ts").and_then(|t| t.as_u64()).unwrap_or(0),
            "reason": last.get("reason").and_then(|r| r.as_str()),
            "exit_code": last.get("exit_code").and_then(|c| c.as_i64()),
            // round-57: a status event (opened/closed) folds to its VALUE —
            // without it a new session's terminal state was just kind:"status"
            // with no way to tell opened from closed.
            "status": last.get("status").and_then(|s| s.as_str()),
        }))
    }

    /// List all session files (id → terminal state) for /api/sessions.
    pub fn list_sessions(&self) -> Vec<(String, serde_json::Value)> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return out };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
            let Some(sid) = path.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string()) else { continue };
            if let Some(state) = self.terminal_state_of(&sid) {
                out.push((sid, state));
            }
        }
        out
    }

    /// Crash recovery: replay every session file; a file whose last
    /// `command/start` has no paired `command/end` gets a synthetic
    /// `command/end { reason: interrupted }` appended. Returns the affected
    /// session ids (the panel shows "interrupted — may still be running").
    pub fn recover_interrupted(&self) -> Vec<String> {
        let mut affected = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return affected };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
            let Some(sid) = path.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string()) else { continue };
            let Some((events, max_seq)) = self.read_events(&sid) else { continue };
            // Seed the in-memory counter from the file's max seq — the
            // counter restarted at 0 after restart, so post-restart events
            // re-used seqs that already existed on disk (violating the
            // "per-session monotonic seq" contract; event-sourced consumers
            // would mis-correlate) (round-55).
            if max_seq > 0 {
                if let Ok(mut seqs) = self.seq.lock() {
                    let slot = seqs.entry(sid.clone()).or_insert(0);
                    *slot = max_seq;
                }
            }
            // Track the positions of the last command/start and command/end.
            let mut last_start = None;
            let mut last_end = None;
            for (i, v) in events.iter().enumerate() {
                match v.get("kind").and_then(|k| k.as_str()) {
                    Some("command/start") => last_start = Some(i),
                    Some("command/end") => last_end = Some(i),
                    _ => {}
                }
            }
            // A start after the last end = the command never finished (the
            // agent died mid-execute — the command may STILL be running on
            // the device as an orphan).
            if let Some(start) = last_start {
                if last_end.map(|e| e < start).unwrap_or(true) {
                    self.log_command_end(&sid, None, Some("interrupted"));
                    affected.push(sid);
                }
            }
        }
        affected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vale-sesslog-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn log_writes_jsonl_lines_with_monotonic_seq() {
        let dir = temp_dir("seq");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("s1", "echo hi");
        logger.log_output("s1", "hi\n".to_string());
        logger.log_command_end("s1", Some(0), Some("marker"));

        let content = std::fs::read_to_string(dir.join("s1.jsonl")).unwrap();
        let lines: Vec<serde_json::Value> = content.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        // 1 version header + 3 events (round-56).
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["type"], "session");
        assert_eq!(lines[0]["version"], 1);
        assert_eq!(lines[1]["seq"], 1);
        assert_eq!(lines[2]["seq"], 2);
        assert_eq!(lines[3]["seq"], 3);
        assert_eq!(lines[3]["exit_code"], 0);
        assert_eq!(lines[3]["reason"], "marker");
        // Optional fields are omitted, not null.
        assert!(lines[1].get("exit_code").is_none());
    }

    #[test]
    fn per_session_seq_is_independent() {
        let dir = temp_dir("persid");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("a", "x");
        logger.log_command_start("b", "y");
        logger.log_command_start("a", "z");
        let content = std::fs::read_to_string(dir.join("a.jsonl")).unwrap();
        assert_eq!(content.lines().count(), 3); // header + 2 events
        let content_b = std::fs::read_to_string(dir.join("b.jsonl")).unwrap();
        assert_eq!(content_b.lines().count(), 2); // header + 1 event
    }

    #[test]
    fn recovery_appends_interrupted_for_unfinished_command() {
        let dir = temp_dir("recover");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("s1", "sleep 600");
        logger.log_output("s1", "running\n".to_string());
        // s1 has an open command; s2 completed normally.
        logger.log_command_start("s2", "done");
        logger.log_command_end("s2", Some(0), Some("marker"));

        let affected = logger.recover_interrupted();
        assert_eq!(affected, vec!["s1"]);

        let content = std::fs::read_to_string(dir.join("s1.jsonl")).unwrap();
        let last: serde_json::Value = content.lines().last().map(|l| serde_json::from_str(l).unwrap()).unwrap();
        assert_eq!(last["kind"], "command/end");
        assert_eq!(last["reason"], "interrupted");
        assert_eq!(last["seq"], 3);

        // Idempotent: a second recovery finds the closed command.
        assert!(logger.recover_interrupted().is_empty());
    }

    #[test]
    fn recovery_ignores_completed_command_then_new_one() {
        // start1 end1 start2(open) — only start2 triggers interrupted.
        let dir = temp_dir("multi");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("s1", "a");
        logger.log_command_end("s1", Some(0), Some("marker"));
        logger.log_command_start("s1", "b");
        assert_eq!(logger.recover_interrupted(), vec!["s1"]);
    }

    #[test]
    fn output_chunk_capped_at_4k() {
        let dir = temp_dir("cap");
        let logger = SessionLogger::new(dir.clone());
        logger.log_output("s1", "x".repeat(10_000));
        let content = std::fs::read_to_string(dir.join("s1.jsonl")).unwrap();
        // Last line is the event (first is the version header).
        let ev: serde_json::Value = content.lines().last().map(|l| serde_json::from_str(l).unwrap()).unwrap();
        let text = ev["text"].as_str().unwrap();
        assert!(text.len() < 5000, "capped text too long: {}", text.len());
        assert!(text.contains("truncated"));
    }
}
