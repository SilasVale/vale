//! Shared context + helpers for the terminal tool modules.
//!
//! Dependency rule: `ctx` depends on NOTHING inside `tools/` — the
//! per-domain modules (`sessions`, `exec`, `output`, `connections`,
//! `secrets`, `files`) may use `ctx`, never each other (the single
//! documented exception is `connections` reusing `sessions::tool_open` for
//! the verbatim reconnect path). Split out of the former monolithic
//! `plugins/terminal/tools.rs` — code moved verbatim, no behavior change.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use crate::tools::terminal::TerminalManager;
use vale_agent_core::DeviceError;

/// Background-job record (refactor Phase 3): gives run_in_background
/// commands completion semantics — callers poll terminal_jobs instead of
/// blind-read loops. Process-lifetime only.
#[derive(Debug, Clone)]
pub struct JobInfo {
    pub sid: String,
    pub command: String,
    pub started_unix: u64,
    pub done: bool,
    pub exit_code: Option<i32>,
}
pub(super) type JobsMap = std::sync::Arc<std::sync::Mutex<HashMap<String, JobInfo>>>;
// (A process-global jobs_map() once existed here — review #2 removed it:
// the bg waiter wrote THAT map while inserts/reads used the per-registry
// one, so terminal_jobs never observed completion. One map, threaded
// explicitly, is the fix.)

/// Sessions that existed before the last agent restart (Phase 4). PTYs die
/// with the process; keeping their metadata lets errors say "this session
/// existed before the restart" instead of a bare not-found. Capped at 128.
pub(super) fn pre_restart_map(
) -> std::sync::Arc<std::sync::Mutex<HashMap<String, serde_json::Value>>> {
    static PRE: OnceLock<std::sync::Arc<std::sync::Mutex<HashMap<String, serde_json::Value>>>> =
        OnceLock::new();
    PRE.get_or_init(|| {
        let path = crate::plugins::terminal::log_dir().join("sessions-pre-restart.json");
        let loaded: HashMap<String, serde_json::Value> = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        std::sync::Arc::new(std::sync::Mutex::new(loaded))
    })
    .clone()
}
pub(super) fn persist_pre_restart(map: &HashMap<String, serde_json::Value>) {
    let path = crate::plugins::terminal::log_dir().join("sessions-pre-restart.json");
    if let Ok(bytes) = serde_json::to_vec(map) {
        let _ = std::fs::write(path, bytes);
    }
}

// ── Execute (shared error path) ──────────────────

/// Enriched "session not found" error: lists currently open sessions so the
/// caller can self-recover (agent restarts drop in-memory PTY sessions).
/// Session-scoped tools check existence BEFORE touching the backend so a
/// vanished session yields the enriched session_lost error (open list +
/// reopen instruction), NOT a bare backend/SessionNotFound error. Uniform
/// across write/execute/screen/resize/select/close (round-87: resize etc.
/// answered bare "not found"/disabled — the client's recovery path was
/// tool-dependent).
pub(super) async fn ensure_session_known(
    mgr: &Arc<TerminalManager>,
    sid: &str,
) -> Result<(), DeviceError> {
    if mgr.term_info(sid).await.is_none() {
        return Err(session_lost(mgr, sid).await);
    }
    Ok(())
}

pub(super) async fn session_lost(mgr: &Arc<TerminalManager>, sid: &str) -> DeviceError {
    let open = mgr.term_list().await;
    let list = if open.is_empty() {
        "(none — agent restarted? re-open with terminal_open)".to_string()
    } else {
        open.iter()
            .map(|i| i.id.clone())
            .collect::<Vec<_>>()
            .join(", ")
    };
    DeviceError::InvalidParams { message: format!(
        "Session not found: {sid}.{} Open sessions: [{list}]. Re-open with terminal_open(kind,target) then retry.",
        pre_restart_context(sid)
    ) }
}

/// Phase 4: "existed before the last agent restart" context from persisted
/// metadata — PTYs cannot survive restarts, but the record explains why the
/// session vanished instead of a bare not-found.
fn pre_restart_context(sid: &str) -> String {
    let map = pre_restart_map();
    let existed = map
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains_key(sid);
    if existed {
        " This session existed before the last agent restart - PTYs cannot survive restarts."
            .to_string()
    } else {
        String::new()
    }
}

// ── Spill file (round-54, dsh OutputCollector) ─────────────────
// The in-memory session buffer caps at 1 MB; evicted bytes were DROPPED —
// a >1MB burst (build log, dd) made everything before the tail
// unrecoverable. Evicted bytes now append to a per-session spill file
// (%TEMP%/vale/<sid>.spill) and terminal_read merges spill + memory, so
// the stream reads continuously from any absolute offset.

/// Cap for a session's spill file (round-115): the drainer's eviction used
/// to append every evicted chunk forever — a continuously-producing session
/// (serial console ~11.5KB/s, tail -f) grew the file ~1GB/day. When the
/// file exceeds this, rotate_spill drops the oldest half.
pub(super) const MAX_SPILL_BYTES: u64 = 256 * 1024 * 1024; // 256 MiB per live session

/// review #8: session ids are server-generated `term-<hex>-<n>`; anything
/// else (path separators, `..`) must NEVER reach spill_path — read_spill is
/// driven by client-controlled `session_id` and this process runs as SYSTEM.
fn valid_spill_id(sid: &str) -> bool {
    // The whitelist itself is the traversal defense: no '.', '/' or '\'
    // can appear, so neither ".." nor absolute paths can be named. (Term
    // ids are `term-<hex>-<n>`; tests seed simpler synthetic ids.)
    !sid.is_empty()
        && sid.len() <= 64
        && sid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub(super) fn spill_path(sid: &str) -> std::path::PathBuf {
    std::env::temp_dir()
        .join("vale")
        .join(format!("{sid}.spill"))
}

/// Drop the oldest `discard` bytes from a session's spill file (round-115).
/// The absolute offset base is advanced by the caller (`entry.spill_base`);
/// `discard` counts from the file's current first byte. The file keeps the
/// WHOLE tail [discard, len) so the invariant "file covers [spill_base,
/// dropped)" holds and reads stay continuous. Best-effort: a missing file
/// is fine. Rewrites via a temp file so a crash mid-rotation can't truncate
/// the file (append_spill's create_new also refuses to follow a symlink
/// planted by another local process). A rotation copies up to MAX_SPILL_BYTES
/// — rare (once per ~128MiB of output) and bounded.
/// true when the file now starts at `discard` (or is gone) — the caller
/// advances spill_base only on true (review #5).
pub(super) fn rotate_spill(sid: &str, discard: u64) -> bool {
    use std::io::{Seek, SeekFrom, Write};
    let p = spill_path(sid);
    let Ok(mut f) = std::fs::File::open(&p) else {
        return true;
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if discard >= len {
        drop(f);
        return std::fs::remove_file(&p).is_ok();
    }
    let _ = f.seek(SeekFrom::Start(discard));
    let mut tail = Vec::with_capacity((len - discard) as usize);
    let mut remain = len - discard;
    let mut buf = vec![0u8; 65536];
    while remain > 0 {
        let want = (remain.min(buf.len() as u64)) as usize;
        let n = std::io::Read::read(&mut f, &mut buf[..want]).unwrap_or(0);
        if n == 0 {
            break;
        }
        tail.extend_from_slice(&buf[..n]);
        remain -= n as u64;
    }
    drop(f);
    if std::fs::remove_file(&p).is_err() {
        return false; // old file intact — do NOT advance the base
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    match opts.open(&p) {
        Ok(mut nf) => {
            let _ = nf.write_all(&tail);
            true
        }
        Err(_) => false,
    }
}

pub(super) fn append_spill(sid: &str, bytes: &[u8]) {
    use std::io::Write;
    let p = spill_path(sid);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).append(true);
    if p.exists() {
        opts.create(true);
    } else {
        // Exclusive first creation: a pre-existing file could be a symlink
        // planted by another local process — refuse to follow it.
        opts.create_new(true);
    }
    if let Ok(mut f) = opts.open(&p) {
        let _ = f.write_all(bytes);
    }
}

/// Read absolute bytes [start, end) that live in the spill file (everything
/// before the in-memory window). Best-effort: a missing file yields nothing.
/// Reads [start, end) of the spill file. Returns (bytes, actual_start) —
/// actual_start is the file offset the bytes begin at, which the caller
/// must surface: when the window is capped (round-111), bytes begin later
/// than the requested offset and the response start must reflect it (the
/// R110 cap silently mislabeled the tail as [offset, end), making the
/// head unreachable AND duplicating on the panel's incremental reads).
/// Read absolute bytes [start, end) of a session's spill file. `base` is the
/// absolute offset of the file's first byte (round-115: the file is rotated
/// — oldest half dropped — when it exceeds MAX_SPILL_BYTES, so byte 0 of the
/// file is no longer stream byte 0). Everything before `base` is gone;
/// requests there return empty with actual_start = max(start, base).
pub(super) fn read_spill(sid: &str, start: usize, end: usize, base: u64) -> (Vec<u8>, u64) {
    if !valid_spill_id(sid) {
        return (Vec::new(), 0);
    }
    // round-110/111: the whole spill file was read into RAM then sliced —
    // a log-streaming session accumulates hundreds of MB, so a first
    // no-offset read (cursor 0) OOM'd the agent. Cap a single read at 1MB.
    use std::io::{Read, Seek, SeekFrom};
    const MAX_SPILL_READ: u64 = 1_048_576;
    let Ok(mut f) = std::fs::File::open(spill_path(sid)) else {
        return (Vec::new(), start.max(base as usize) as u64);
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    // File covers absolute [base, base+len). Intersect the request with it.
    let file_end = base + len;
    let e = (end as u64).min(file_end);
    let s = (start as u64).max(base).min(e);
    let read_start = if e - s > MAX_SPILL_READ {
        e - MAX_SPILL_READ
    } else {
        s
    };
    let _ = f.seek(SeekFrom::Start(read_start - base)); // file-relative offset
    let mut out = Vec::with_capacity((e - read_start) as usize);
    let _ = f.take(e - read_start).read_to_end(&mut out);
    (out, read_start)
}

/// Remove a session's spill file (round-60): append_spill had NO deletion
/// path anywhere — closed sessions and evicted history entries left orphan
/// files in %TEMP%/vale forever (sid is per-boot unique, so they only ever
/// accumulated). Call when the session's last reference disappears (drainer
/// close, history eviction). Idempotent; a missing file is fine.
fn remove_spill(sid: &str) {
    let _ = std::fs::remove_file(spill_path(sid));
}

/// Public alias for mod.rs (history eviction calls it under a different
/// module path).
/// Startup sweep: delete every *.spill file. History is in-memory, so a fresh
/// process can never reference them — they are orphans from a previous run
/// (round-96, closes the R60-H2 leak re-opened by spill retention). Runs ONCE
/// per process (OnceLock) — a per-construction sweep would race concurrent
/// tests that write their own spill files.
pub(crate) fn sweep_spills_once() {
    use std::sync::OnceLock;
    static SWEPT: OnceLock<()> = OnceLock::new();
    SWEPT.get_or_init(|| {
        let dir = std::env::temp_dir().join("vale");
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if e.path().extension().is_some_and(|x| x == "spill") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    });
}

pub(crate) fn remove_spill_for(sid: &str) {
    remove_spill(sid);
}
