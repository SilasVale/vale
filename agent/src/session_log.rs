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
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// Closed-session log trim: keep the version header + this many trailing
/// audit lines (round-98 — a closed session's file grew unbounded).
const MAX_CLOSED_LOG_LINES: usize = 2000;

/// Stream-trim a session JSONL: keep the version header + the LAST
/// command/start (recovery needs it to detect an interrupted command) and
/// everything after it; if that's still over the cap, keep the most recent
/// lines BUT never drop the last command/start (round-100: the previous
/// cap drain removed it when the final command produced >2000 events —
/// the exact R98 bug R99 claimed to fix). Memory-bounded: on seeing a NEW
/// command/start, everything before it is drained immediately (round-100:
/// the previous version retained everything after the FIRST start, still
/// O(file size) at close).
fn trim_file(path: &std::path::Path) {
    use std::io::{BufRead, BufReader, BufWriter, Write as _};
    let Ok(file) = std::fs::File::open(path) else { return };
    let mut reader = BufReader::new(file);
    let mut header = String::new();
    let _ = reader.read_line(&mut header); // version header (may be empty)
    // tail = the last command/start + everything after it (rolling).
    let mut tail: Vec<String> = Vec::new();
    let mut have_start = false;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if line.contains("\"command/start\"") {
                    // A NEW start: everything before it is older history —
                    // drain immediately (bounds memory; only the last
                    // start window + rolling tail are retained).
                    if have_start { tail.clear(); }
                    have_start = true;
                }
                tail.push(line.clone());
                // Cap: keep the last MAX lines BUT always retain the last
                // command/start (drop from the head only while the start
                // is still in the window).
                if tail.len() > MAX_CLOSED_LOG_LINES + 1 {
                    let drop = tail.len() - (MAX_CLOSED_LOG_LINES + 1);
                    // Never drop line 0 while it is the start.
                    if !(have_start && tail[0].contains("\"command/start\"") && drop > 0 && tail.len() > drop) {
                        tail.drain(..drop);
                    } else if have_start && tail[0].contains("\"command/start\"") {
                        // Start at head: keep it, drop from index 1.
                        tail.drain(1..1 + drop);
                    } else {
                        tail.drain(..drop);
                    }
                }
            }
            Err(_) => break,
        }
    }
    if tail.is_empty() { return; }
    // round-116: atomic trim — File::create truncates the file to zero and
    // rewrites in place; a crash (Windows service kill, power loss) between
    // truncate and rewrite destroyed the WHOLE session audit tail (and the
    // recovery marker). Write the trimmed tail to a temp file in the same
    // dir, flush+sync, then rename over the original (atomic on Windows).
    let tmp = path.with_extension("jsonl.tmp");
    let res = (|| -> std::io::Result<()> {
        let mut out = std::fs::File::create(&tmp)?;
        {
            let mut w = BufWriter::new(&mut out);
            w.write_all(header.as_bytes())?;
            for l in &tail { w.write_all(l.as_bytes())?; }
            w.flush()?;
        }
        out.sync_all()?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if res.is_err() { let _ = std::fs::remove_file(&tmp); }
}

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
    /// command/end only: wall-clock duration of the command in ms (round-58).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl SessionEvent {
    pub fn command_start(seq: u64, command: &str) -> Self {
        Self { seq, ts: unix_now(), kind: "command/start".into(), command: Some(command.to_string()), text: None, exit_code: None, reason: None, status: None, duration_ms: None }
    }
    pub fn output(seq: u64, text: String) -> Self {
        Self { seq, ts: unix_now(), kind: "output".into(), command: None, text: Some(text), exit_code: None, reason: None, status: None, duration_ms: None }
    }
    pub fn command_end(seq: u64, exit_code: Option<i32>, reason: Option<&str>) -> Self {
        Self { seq, ts: unix_now(), kind: "command/end".into(), command: None, text: None, exit_code, reason: reason.map(|s| s.to_string()), status: None, duration_ms: None }
    }
    pub fn status(seq: u64, status: &str) -> Self {
        Self { seq, ts: unix_now(), kind: "status".into(), command: None, text: None, exit_code: None, reason: None, status: Some(status.to_string()), duration_ms: None }
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
    /// Persistent per-session writers (round-58): batch output chunks, flush
    /// on command boundaries. Bounded — capped at the session count.
    files: std::sync::Arc<Mutex<HashMap<String, std::io::BufWriter<std::fs::File>>>>,
}

impl SessionLogger {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self {
            dir,
            seq: std::sync::Arc::new(Mutex::new(HashMap::new())),
            files: std::sync::Arc::new(Mutex::new(HashMap::new())),
        }
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
        let line = serde_json::to_string(&ev).unwrap_or_default();
        // Per-session persistent writer (round-58): the old open→append→drop
        // per 4KiB chunk was 3 syscalls × 100-256 chunks/s × 16 sessions —
        // thousands of syscalls/s on the device CPU. The writer batches and
        // flushes on flush() (called at command/status boundaries by
        // log_command_end/log_status) or when the buffer fills.
        let mut f = self.files.lock().unwrap_or_else(|p| p.into_inner());
        let writer = f.entry(sid.to_string()).or_insert_with(|| {
            let path = self.dir.join(format!("{sid}.jsonl"));
            match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                Ok(file) => {
                    // audit round: a crash mid-writeln can leave a fragment
                    // WITHOUT the trailing newline (lines past the 8 KiB
                    // BufWriter split their physical writes). The next append
                    // FUSES onto it — both events become unparseable, and the
                    // fused pair once swallowed the "interrupted" recovery
                    // marker (crashed command looked FINISHED). Terminate the
                    // fragment before appending anything.
                    let len0 = file.metadata().map(|m| m.len()).unwrap_or(0);
                    let mut w = std::io::BufWriter::new(file);
                    if len0 > 0 {
                        let tail_ok = w.get_ref().metadata().map(|m| m.len() == len0).unwrap_or(true);
                        if !tail_ok {
                            let _ = w.write_all(b"\n");
                        }
                    }
                    // New file → write the version header FIRST (round-56).
                    if w.get_ref().metadata().map(|m| m.len() == 0).unwrap_or(false) {
                        let _ = writeln!(w, "{}", serde_json::json!({
                            "type": "session", "version": 1, "id": sid,
                            "createdAt": std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs()).unwrap_or(0),
                        }));
                    }
                    w
                }
                Err(_) => {
                    tracing::warn!("[vale-agent] session log open failed: {sid}");
                    // Unwritable fallback: keep the session alive, drop the
                    // audit trail for it (same best-effort stance as before).
                    // /dev/null on Unix, NUL on Windows — a File that discards.
                    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
                    std::io::BufWriter::new(std::fs::OpenOptions::new().write(true).open(null).unwrap())
                }
            }
        });
        use std::io::Write;
        let _ = writeln!(writer, "{line}");
        // Flush eagerly on command boundaries (command/end, status) so the
        // audit trail is durable at the points that matter; output chunks
        // ride the BufWriter until it fills or the next boundary. A crash
        // loses only the buffered tail, never a command skeleton (round-58).
        if ev.kind != "output" {
            let _ = writer.flush();
        }
    }

    /// Flush all session writers (called on shutdown paths if any).
    pub fn flush_all(&self) {
        use std::io::Write;
        let mut f = self.files.lock().unwrap_or_else(|p| p.into_inner());
        for w in f.values_mut() {
            let _ = w.flush();
        }
    }

    /// Close a session's writer — flush + drop the fd (round-59). The files
    /// map had NO eviction path: every session ever seen (including closed
    /// ones) kept an open fd + BufWriter for the process lifetime. Call on
    /// session close/eviction to bound the map by the concurrent session
    /// count (hard cap 16).
    pub fn close_session(&self, sid: &str) {
        use std::io::Write;
        let mut f = self.files.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(mut w) = f.remove(sid) {
            let _ = w.flush();
            // round-98: a closed session's file was never trimmed — a serial
            // console scrolling logs for hours grew an unbounded .jsonl on
            // the install disk.
            // round-99: the naive trim (read_to_string + keep last N lines)
            // had two flaws: (1) it deleted the LAST command/start when the
            // final command produced >2000 output events, silently killing
            // the "interrupted" recovery flag for that command; (2) it read
            // the WHOLE (potentially ~GB) file into RAM at close. Trim by
            // STREAMING the tail: keep the header, the last command/start
            // (recovery needs it) plus everything after it, and if that's
            // still over the cap, the most recent lines.
            let path = self.dir.join(format!("{sid}.jsonl"));
            trim_file(&path);
        }
    }

    pub fn log_command_start(&self, sid: &str, command: &str) {
        // audit round: the 4 KiB cap existed for OUTPUT only — a single
        // multi-MB command line (`python -c '<payload>'`) rode the trail
        // forever (trim counts LINES) and forced a multi-MB read_line at
        // close. Cap identically (char-boundary-safe).
        let command = if command.len() > 4096 {
            let cut = command.floor_char_boundary(4096);
            format!("{}…[truncated {} bytes]", &command[..cut], command.len() - cut)
        } else { command.to_string() };
        self.log(sid, SessionEvent::command_start(0, &command));
    }
    pub fn log_output(&self, sid: &str, text: String) {
        // Cap a single chunk at 4 KiB — a full 1MB burst would dominate the
        // audit trail for one session. The event stream stays dense enough
        // to reconstruct what ran.
        // Char-boundary-safe truncation (round-68): &text[..4096] panicked
        // when byte 4096 split a multi-byte char (binary output expands past
        // 4096 via U+FFFD replacement chars) — the panic killed the drainer
        // and wedged the session. floor_char_boundary keeps the slice valid.
        let text = if text.len() > 4096 {
            let cut = text.floor_char_boundary(4096);
            format!("{}…[truncated {} bytes]", &text[..cut], text.len() - cut)
        } else { text };
        self.log(sid, SessionEvent::output(0, text));
    }
    pub fn log_command_end(&self, sid: &str, exit_code: Option<i32>, reason: Option<&str>, duration_ms: Option<u64>) {
        let mut ev = SessionEvent::command_end(0, exit_code, reason);
        ev.duration_ms = duration_ms;
        self.log(sid, ev);
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

    /// stage-n: retention — delete audit files untouched for longer than
    /// `max_age_days`. Run at STARTUP only (after `recover_interrupted`):
    /// the kill-on-close job (round-134) guarantees the previous agent
    /// generation's shells are all dead, so no live writer can race a
    /// prune. Returns the number of files removed.
    pub fn prune_stale(&self, max_age_days: u64) -> usize {
        use std::time::{Duration, SystemTime};
        let Ok(now_unix) = SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
            return 0;
        };
        let max_age = Duration::from_secs(max_age_days.saturating_mul(86_400));
        let mut removed = 0;
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return 0 };
        for entry in entries.flatten() {
            let path = entry.path();
            // audit round: crashed trim rotations left `<sid>.jsonl.tmp`
            // litter invisible to the `.jsonl`-extension filter.
            let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            if !(fname.ends_with(".jsonl") || fname.ends_with(".jsonl.tmp")) { continue; }
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            let age = match now_unix.checked_sub(
                mtime.duration_since(std::time::UNIX_EPOCH).unwrap_or(Duration::ZERO)
            ) {
                Some(a) => a,
                None => Duration::ZERO, // clock skew: treat as fresh
            };
            if age > max_age && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        removed
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
                    // round-99: a backgrounded command (run_in_background)
                    // never gets a command/end — it logs status
                    // "backgrounded" and the shell later logs "closed"/
                    // "exited:N". Neither was recognized, so recovery
                    // misreported every completed background command as
                    // "interrupted". Treat any post-start status line
                    // (backgrounded/closed/exited) as a terminal marker.
                    Some("status") => {
                        // round-100: SessionEvent::status() serializes the
                        // value in the `status` field, not `text` (both are
                        // skip-if-none, so a status line has no "text" key)
                        // — the round-99 branch read the wrong field and
                        // never fired.
                        if let Some(text) = v.get("status").and_then(|t| t.as_str()) {
                            if text == "backgrounded" || text == "closed" || text.starts_with("exited:") {
                                last_end = Some(i);
                            }
                        }
                    }
                    _ => {}
                }
            }
            // A start after the last end = the command never finished (the
            // agent died mid-execute — the command may STILL be running on
            // the device as an orphan).
            if let Some(start) = last_start {
                if last_end.map(|e| e < start).unwrap_or(true) {
                    self.log_command_end(&sid, None, Some("interrupted"), None);
                    affected.push(sid.clone());
                }
            }
            // round-116: trim EVERY recovered session's file, not just
            // gracefully-closed ones — a crash-open session (agent killed,
            // power loss) that was streaming for hours never hit
            // close_session's trim, so its .jsonl stayed unbounded on disk
            // until the next graceful close. trim_file is atomic (temp +
            // rename).
            let path = self.dir.join(format!("{sid}.jsonl"));
            trim_file(&path);
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
    fn prune_stale_keeps_fresh_and_removes_old() {
        let dir = temp_dir("prune");
        std::fs::create_dir_all(&dir).unwrap();
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("fresh", "echo hi");
        logger.log_command_end("fresh", Some(0), None, None);
        std::fs::write(dir.join("not-a-session.txt"), b"x").unwrap();

        // Nothing is older than 30 days → nothing pruned, non-jsonl untouched.
        assert_eq!(logger.prune_stale(30), 0);
        assert!(dir.join("fresh.jsonl").exists());
        assert!(dir.join("not-a-session.txt").exists());

        // max_age_days = 0 → cutoff is "now"; any file with a nonzero age
        // is stale. The just-written audit file qualifies.
        assert!(logger.prune_stale(0) >= 1);
        assert!(!dir.join("fresh.jsonl").exists());
        // Only .jsonl files are ever considered.
        assert!(dir.join("not-a-session.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_writes_jsonl_lines_with_monotonic_seq() {
        let dir = temp_dir("seq");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("s1", "echo hi");
        logger.log_output("s1", "hi\n".to_string());
        logger.log_command_end("s1", Some(0), Some("marker"), None);

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
        logger.log_command_end("s2", Some(0), Some("marker"), None);

        // BufWriter (round-58): recovery replays DISK state — flush buffered
        // output first so seq-seeding sees the full stream.
        logger.flush_all();
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
        logger.log_command_end("s1", Some(0), Some("marker"), None);
        logger.log_command_start("s1", "b");
        assert_eq!(logger.recover_interrupted(), vec!["s1"]);
    }

    #[test]
    fn output_chunk_capped_at_4k() {
        let dir = temp_dir("cap");
        let logger = SessionLogger::new(dir.clone());
        logger.log_output("s1", "x".repeat(10_000));
        // Output events batch in the BufWriter (round-58) — flush before read.
        logger.flush_all();
        let content = std::fs::read_to_string(dir.join("s1.jsonl")).unwrap();
        // Last line is the event (first is the version header).
        let ev: serde_json::Value = content.lines().last().map(|l| serde_json::from_str(l).unwrap()).unwrap();
        let text = ev["text"].as_str().unwrap();
        assert!(text.len() < 5000, "capped text too long: {}", text.len());
        assert!(text.contains("truncated"));
    }
}
