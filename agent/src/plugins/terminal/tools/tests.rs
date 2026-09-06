//! Test module for the terminal tools — moved verbatim (plus import-path
//! adjustments only) from the former monolithic `plugins/terminal/tools.rs`.
//! The `seeded_tools` harness builds the FULL tool registry via `build`, so
//! these tests exercise the same dispatch path production uses.

use crate::plugins::terminal::tools::ctx::spill_path;
use crate::plugins::terminal::tools::exec::{
    append_command_newline, execute_result_json, find_prompt_marker,
};
use crate::plugins::terminal::{
    clean_terminal_output, DiagBuf, DiagStore, OutputBuf, SessionStore,
};
use crate::tools::serial::SerialPool;
use crate::tools::terminal::TerminalManager;
use serde_json::json;
use std::sync::Arc;
use vale_agent_core::{recover_guard, AppEventBus, EventBus, ToolDef};

use super::build;

/// Build the tool list with a caller-controlled output buffer so tests can
/// pre-seed session output and exercise terminal_read / terminal_screen.
fn seeded_tools() -> (Vec<ToolDef>, OutputBuf) {
    let bus: Arc<dyn EventBus> = Arc::new(AppEventBus::new());
    let serial = Arc::new(SerialPool::new(115200, 1000));
    let mgr = Arc::new(TerminalManager::new(serial.clone()));
    let buf: OutputBuf = Arc::new(std::sync::Mutex::new(SessionStore::new()));
    let diag: DiagStore = Arc::new(std::sync::Mutex::new(DiagBuf::default()));
    // Session logger in a scratch dir — the audit trail is exercised
    // through the same full path as production (round-54).
    let log_dir = std::env::temp_dir().join(format!("vale-sesslog-tools-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&log_dir);
    let logger = crate::session_log::SessionLogger::new(log_dir);
    let tools = build(
        &mgr,
        &serial,
        &bus,
        &buf,
        &diag,
        &logger,
        &Arc::new(std::sync::atomic::AtomicUsize::new(8 * 1024 * 1024)),
    );
    (tools, buf)
}

fn find<'a>(tools: &'a [ToolDef], name: &str) -> &'a ToolDef {
    tools
        .iter()
        .find(|t| t.name == name)
        .unwrap_or_else(|| panic!("missing tool: {name}"))
}

async fn call(tool: &ToolDef, params: serde_json::Value) -> serde_json::Value {
    tool.handler
        .call(params)
        .await
        .expect("handler should not error")
}

fn seed(buf: &OutputBuf, sid: &str, data: &[u8], dropped: u64) {
    let mut store = recover_guard(buf);
    let entry = store.live.entry(sid.to_string()).or_default();
    entry.data.extend_from_slice(data);
    entry.dropped = dropped;
    entry.cursor = 0;
}

// ── terminal_screen (tail-N lines) ──────────────────────────

#[tokio::test]
async fn screen_empty_session_returns_empty() {
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", b"", 0);
    let out = call(find(&tools, "terminal_screen"), json!({"session_id": "s1"})).await;
    assert_eq!(out["screen"], "");
    assert!(
        out.get("dropped").is_none(),
        "no dropped when nothing evicted"
    );
}

#[tokio::test]
async fn screen_tail_lines_with_ansi_stripped() {
    let (tools, buf) = seeded_tools();
    // 10 lines; request the last 3.
    let mut data = Vec::new();
    for i in 0..10 {
        data.extend_from_slice(format!("\x1b[32mline-{i}\x1b[0m\n").as_bytes());
    }
    seed(&buf, "s1", &data, 0);
    let out = call(
        find(&tools, "terminal_screen"),
        json!({"session_id": "s1", "lines": 3}),
    )
    .await;
    assert_eq!(out["screen"], "line-7\nline-8\nline-9");
}

#[tokio::test]
async fn screen_skips_trailing_blank_lines() {
    // Regression for the "blank screen" bug: a buffer ending in \r\n (or \n)
    // must not collapse the tail scan — the Nth-from-end scan counts content
    // lines, so screen must return real content even with a trailing newline.
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", b"hello\r\nworld\r\n", 0);
    let out = call(
        find(&tools, "terminal_screen"),
        json!({"session_id": "s1", "lines": 5}),
    )
    .await;
    assert_eq!(out["screen"], "hello\nworld");
}

#[tokio::test]
async fn screen_lines_exceeds_buffer_returns_all() {
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", b"a\nb\nc", 0);
    let out = call(
        find(&tools, "terminal_screen"),
        json!({"session_id": "s1", "lines": 100}),
    )
    .await;
    assert_eq!(out["screen"], "a\nb\nc");
}

#[tokio::test]
async fn screen_reports_dropped_after_eviction() {
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", b"tail-content", 500);
    let out = call(find(&tools, "terminal_screen"), json!({"session_id": "s1"})).await;
    assert_eq!(out["screen"], "tail-content");
    assert_eq!(out["dropped"], 500);
}

#[tokio::test]
async fn screen_utf8_multibyte_survives() {
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", "héllo wörld\nsécond líne".as_bytes(), 0);
    let out = call(
        find(&tools, "terminal_screen"),
        json!({"session_id": "s1", "lines": 10}),
    )
    .await;
    assert_eq!(out["screen"], "héllo wörld\nsécond líne");
}

// ── terminal_read (cursor) ──────────────────────────────────

#[tokio::test]
async fn read_first_call_returns_all_and_advances_cursor() {
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", b"hello world", 0);
    let out1 = call(find(&tools, "terminal_read"), json!({"session_id": "s1"})).await;
    assert_eq!(out1["text"], "hello world");
    // Cursor advanced: a second no-offset read returns nothing new.
    let out2 = call(find(&tools, "terminal_read"), json!({"session_id": "s1"})).await;
    assert_eq!(out2["text"], "");
}

#[tokio::test]
async fn read_offset_zero_rereads_from_beginning() {
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", b"abc", 0);
    // First read advances cursor to end.
    call(find(&tools, "terminal_read"), json!({"session_id": "s1"})).await;
    let out = call(
        find(&tools, "terminal_read"),
        json!({"session_id": "s1", "offset": 0}),
    )
    .await;
    assert_eq!(out["text"], "abc");
}

#[tokio::test]
async fn read_explicit_offset_slices() {
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", b"hello world", 0);
    let out = call(
        find(&tools, "terminal_read"),
        json!({"session_id": "s1", "offset": 6}),
    )
    .await;
    assert_eq!(out["text"], "world");
}

#[tokio::test]
async fn read_clean_strips_ansi() {
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", b"\x1b[31mred\x1b[0m", 0);
    let out = call(
        find(&tools, "terminal_read"),
        json!({"session_id": "s1", "clean": true}),
    )
    .await;
    assert_eq!(out["text"], "red");
}

#[tokio::test]
async fn read_unknown_session_empty() {
    let (tools, _buf) = seeded_tools();
    let out = call(
        find(&tools, "terminal_read"),
        json!({"session_id": "missing"}),
    )
    .await;
    assert_eq!(out["text"], "");
}

// ── terminal_read: absolute offsets + start/end + history ────

#[tokio::test]
async fn read_reports_start_end_spans() {
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", b"hello world", 0);
    let out = call(
        find(&tools, "terminal_read"),
        json!({"session_id": "s1", "offset": 0}),
    )
    .await;
    assert_eq!(out["text"], "hello world");
    assert_eq!(out["start"], 0);
    assert_eq!(out["end"], 11);
}

#[tokio::test]
async fn read_absolute_offset_after_eviction() {
    let (tools, buf) = seeded_tools();
    // 10 bytes evicted from the front; data holds "hello world" (11 bytes).
    seed(&buf, "s1", b"hello world", 10);
    // No spill file (seed sets dropped directly) — the read starts at the
    // requested offset and yields whatever the spill yields (nothing) +
    // the in-memory window (round-54: the old clamp silently re-pointed
    // the read to the in-memory window start).
    let p = spill_path("s1");
    let _ = std::fs::remove_file(&p);
    let out = call(
        find(&tools, "terminal_read"),
        json!({"session_id": "s1", "offset": 6}),
    )
    .await;
    assert_eq!(out["text"], "hello world");
    assert_eq!(out["start"], 6);
    assert_eq!(out["end"], 21);
}

#[tokio::test]
async fn read_merges_spill_and_memory() {
    let (tools, buf) = seeded_tools();
    // Unique sid (round-56): the spill files live in a shared %TEMP%
    // dir keyed by sid — concurrent tests reusing "s1" raced on the
    // same file (one test's remove_file killed the other's data).
    seed(&buf, "spill-s1", b"tail", 10); // 10 bytes evicted, memory holds "tail"
                                         // Write the evicted head to the spill file the way the drainer does.
    use std::io::Write;
    let p = spill_path("spill-s1");
    let _ = std::fs::create_dir_all(p.parent().unwrap());
    let mut f = std::fs::File::create(&p).unwrap();
    f.write_all(b"0123456789").unwrap();
    // offset 6 → spill [6,10) = "6789" + memory "tail" = "6789tail";
    // end_abs = dropped(10) + memory(4) = 14.
    let out = call(
        find(&tools, "terminal_read"),
        json!({"session_id": "spill-s1", "offset": 6, "clean": false}),
    )
    .await;
    assert_eq!(out["text"], "6789tail");
    assert_eq!(out["start"], 6);
    assert_eq!(out["end"], 14);
    assert_eq!(out["spill"], p.to_string_lossy().as_ref());
    let _ = std::fs::remove_file(&p);
}

#[tokio::test]
async fn read_works_on_retained_session() {
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", b"closed-log", 0);
    buf.lock()
        .unwrap()
        .retain_live("s1", "serial", "COM4", None);
    let out = call(
        find(&tools, "terminal_read"),
        json!({"session_id": "s1", "offset": 0}),
    )
    .await;
    assert_eq!(out["text"], "closed-log");
    assert_eq!(out["start"], 0);
    assert_eq!(out["end"], 10);
}

#[tokio::test]
async fn read_history_does_not_advance_cursor() {
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", b"abc", 0);
    // Advance the live cursor past all bytes.
    call(find(&tools, "terminal_read"), json!({"session_id": "s1"})).await;
    // Retain (moves to history) — the cursor snapshot rides along.
    buf.lock().unwrap().retain_live("s1", "pty", "shell", None);
    // A no-offset read on a retained session still returns all — history
    // reads never advance a cursor, so a fresh read must not be suppressed.
    let out = call(find(&tools, "terminal_read"), json!({"session_id": "s1"})).await;
    assert_eq!(out["text"], "abc");
}

// ── terminal_history ─────────────────────────────────────────

#[tokio::test]
async fn history_lists_live_and_closed_sorted_newest_first() {
    let (tools, buf) = seeded_tools();
    // Live session (no output → bytes 0).
    let out = call(find(&tools, "terminal_history"), json!({})).await;
    assert!(out.is_array(), "history should return an array, got {out}");
    // No live sessions in seeded_tools (manager has none) — only history.
    seed(&buf, "s1", b"a", 0);
    buf.lock()
        .unwrap()
        .retain_live("s1", "ssh", "admin@host", None);
    let out = call(find(&tools, "terminal_history"), json!({})).await;
    let arr = out.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["id"], "s1");
    assert_eq!(arr[0]["kind"], "ssh");
    assert_eq!(arr[0]["label"], "admin@host");
    assert_eq!(arr[0]["status"], "closed");
    assert!(arr[0]["closed_at"].as_u64().unwrap() > 0);
    assert_eq!(arr[0]["bytes"], 1);
}

#[tokio::test]
async fn history_retains_natural_exit_code() {
    let (tools, buf) = seeded_tools();
    seed(&buf, "s1", b"exit 42", 0);
    // Drainer path: retain with the natural exit code (Some(42)).
    buf.lock()
        .unwrap()
        .retain_live("s1", "pty", "shell", Some(42));
    let out = call(find(&tools, "terminal_history"), json!({})).await;
    let arr = out.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(
        arr[0]["exit_code"], 42,
        "natural exit code must surface in history"
    );
    // Explicit close (None) → exit_code null in JSON.
    seed(&buf, "s2", b"closed", 0);
    buf.lock().unwrap().retain_live("s2", "pty", "shell", None);
    let out2 = call(find(&tools, "terminal_history"), json!({})).await;
    let arr2 = out2.as_array().unwrap();
    let s2 = arr2.iter().find(|e| e["id"] == "s2").unwrap();
    assert!(s2["exit_code"].is_null(), "explicit close has no exit code");
}

#[tokio::test]
async fn history_limit_caps_closed_entries() {
    let (tools, buf) = seeded_tools();
    // Two closed sessions, newest first: s2 then s1.
    seed(&buf, "s1", b"one", 0);
    buf.lock().unwrap().retain_live("s1", "pty", "shell", None);
    seed(&buf, "s2", b"two", 0);
    buf.lock().unwrap().retain_live("s2", "pty", "shell", None);
    // limit=1 → only the newest closed (s2) plus any live (none here).
    let out = call(find(&tools, "terminal_history"), json!({"limit": 1})).await;
    let arr = out.as_array().unwrap();
    assert_eq!(arr.len(), 1, "limit=1 caps to the newest closed");
    assert_eq!(arr[0]["id"], "s2", "newest closed first");
    // limit=5 → both.
    let out2 = call(find(&tools, "terminal_history"), json!({"limit": 5})).await;
    let arr2 = out2.as_array().unwrap();
    assert_eq!(arr2.len(), 2);
}

// ── SessionStore caps + idempotent retain ────────────────────

#[test]
fn retain_evicts_oldest_beyond_session_cap() {
    let mut store = SessionStore::with_caps(2, 10_000_000);
    for i in 0..3 {
        store
            .live
            .entry(format!("s{i}"))
            .or_default()
            .data
            .extend_from_slice(b"x");
        store.retain_live(&format!("s{i}"), "pty", "shell", None);
    }
    // Cap 2 → oldest (s0) evicted.
    assert!(!store.history.contains_key("s0"), "s0 should be evicted");
    assert!(store.history.contains_key("s1") && store.history.contains_key("s2"));
}

#[test]
fn retain_evicts_oldest_beyond_byte_cap() {
    let mut store = SessionStore::with_caps(10, 3); // 3 bytes total cap
    for i in 0..3 {
        store
            .live
            .entry(format!("s{i}"))
            .or_default()
            .data
            .extend_from_slice(b"xx");
        store.retain_live(&format!("s{i}"), "pty", "shell", None);
    }
    // Total bytes exceed 3 → evict oldest until under. s0 (2B) evicted first.
    let total: u64 = store.history.values().map(|h| h.buf.end_abs() as u64).sum();
    assert!(total <= 3, "history bytes {total} exceed cap");
}

#[test]
fn retain_idempotent_second_call_false() {
    let mut store = SessionStore::new();
    store
        .live
        .entry("s1".into())
        .or_default()
        .data
        .extend_from_slice(b"hi");
    assert!(
        store.retain_live("s1", "pty", "shell", None),
        "first retain moves it"
    );
    assert!(
        !store.retain_live("s1", "pty", "shell", None),
        "second retain is a no-op"
    );
}

#[tokio::test]
async fn read_requires_session_id() {
    let (tools, _buf) = seeded_tools();
    let tool = find(&tools, "terminal_read");
    let err = tool.handler.call(json!({})).await.unwrap_err();
    assert!(
        err.to_string().contains("missing required field"),
        "unexpected: {err}"
    );
}

// ── terminal_execute (dispatch) ─────────────────────────────

#[tokio::test]
async fn execute_requires_command() {
    let (tools, _buf) = seeded_tools();
    let tool = find(&tools, "terminal_execute");
    let err = tool.handler.call(json!({})).await.unwrap_err();
    assert!(
        err.to_string().contains("missing required field"),
        "unexpected: {err}"
    );
}

#[tokio::test]
async fn execute_local_shell_mode_runs_on_stub() {
    // Headless (no `terminal` feature): the local-shell mode uses tokio::process
    // and must work — the stub only affects terminal_open/write/resize.
    let (tools, _buf) = seeded_tools();
    let out = call(
        find(&tools, "terminal_execute"),
        json!({"command": "echo stub-ok"}),
    )
    .await;
    // Unified shape (round-60): {"kind":"local","text":...,"truncated":...}.
    assert_eq!(out["kind"], "local");
    let text = out["text"].as_str().unwrap_or_default();
    assert!(
        text.contains("stub-ok"),
        "expected echo output in result, got: {text}"
    );
}

#[tokio::test]
async fn execute_session_mode_missing_session_errors() {
    // Writing to a session that doesn't exist must return an Err (not panic
    // or hang). The exact message differs by backend (stub: "backend not
    // enabled"; real: "session not found") — only assert it errors.
    let (tools, _buf) = seeded_tools();
    let tool = find(&tools, "terminal_execute");
    let err = tool
        .handler
        .call(json!({"command": "echo hi", "session_id": "nope"}))
        .await
        .unwrap_err();
    assert!(
        !err.to_string().is_empty(),
        "expected a DeviceError, got empty"
    );
}

// ── append_command_newline (Windows CRLF vs Unix LF) ───────

#[test]
fn append_newline_unix_uses_lf() {
    // On non-Windows, a command gets a bare \n.
    if !cfg!(target_os = "windows") {
        assert_eq!(append_command_newline("echo hi"), "echo hi\n");
    }
}

#[test]
fn append_newline_windows_uses_cr_only() {
    // stage-m: on Windows the command terminator is a bare `\r` — VS
    // Code's sendText sends `\r` (the terminal driver maps it to Enter).
    // `\r\n` on ConPTY can be read as TWO input events (CR + LF), which
    // made PSReadLine render an empty continuation prompt (`>>`) after
    // every command (the stage-l wrapper-era CRLF bug). This is
    // Windows-only, so the assertion is gated — but it must MATCH the
    // implementation or it silently stops guarding.
    if cfg!(target_os = "windows") {
        assert_eq!(append_command_newline("echo hi"), "echo hi\r");
    }
}

#[test]
fn append_newline_does_not_duplicate_existing_terminator() {
    // A command that already ends in a line terminator must not get another
    // appended (both platforms).
    assert!(append_command_newline("echo hi\n").ends_with('\n'));
    assert_eq!(append_command_newline("echo hi\r\n"), "echo hi\r\n");
    assert_eq!(append_command_newline("echo hi\r"), "echo hi\r");
}

// ── clean_terminal_output (edge cases) ──────────────────────

#[test]
fn clean_unterminated_csi_absorbed() {
    // An unterminated CSI (no final byte) must not hang or panic — it's
    // skipped conservatively.
    assert_eq!(clean_terminal_output(b"\x1b[31mred"), "red");
}

#[test]
fn clean_osc_title_stripped() {
    // OSC title sequences (ESC ]0;... BEL) appear in every bash prompt —
    // they must be stripped so AI-read screen text isn't full of noise.
    assert_eq!(
        clean_terminal_output(b"\x1b]0;user@host: ~\x07prompt$ "),
        "prompt$ "
    );
}

#[test]
fn clean_osc_with_st_terminator() {
    // OSC terminated by ST (ESC \) rather than BEL.
    assert_eq!(clean_terminal_output(b"\x1b]0;title\x1b\\hi"), "hi");
}

#[test]
fn clean_bash_prompt_with_osc_and_csi() {
    // A real bash prompt: OSC title + CSI color codes + prompt text.
    let input = b"\x1b]0;zhengsaisi@61-83: ~\x07\x1b[01;32mzhengsaisi@61-83\x1b[00m:\x1b[01;34m~\x1b[00m$ echo hi\nhi";
    assert_eq!(
        clean_terminal_output(input),
        "zhengsaisi@61-83:~$ echo hi\nhi"
    );
}

#[test]
fn clean_crlf_mixed_with_ansi() {
    assert_eq!(clean_terminal_output(b"a\r\x1b[Kb\r\nc\rd"), "a\nb\nc\nd");
}

#[test]
fn clean_dropped_utf8_replacement() {
    // A lone continuation byte is replaced, not dropped silently.
    let input = b"ab\x80cd";
    assert_eq!(clean_terminal_output(input), "ab\u{FFFD}cd");
}

// ── prompt-marker scanner (round-54) ──────────────────────────

#[test]
fn marker_found_in_stream() {
    // "ok\n" + marker(exit 0) + prompt text.
    let data = b"ok\n\x1b]133;D;0\x07PS C:\\>";
    let (start, end, code) = find_prompt_marker(data).unwrap();
    assert_eq!(code, 0);
    assert_eq!(&data[start..end], b"\x1b]133;D;0\x07");
}

#[test]
fn marker_with_nonzero_exit() {
    let data = b"\x1b]133;D;127\x07";
    let (start, end, code) = find_prompt_marker(data).unwrap();
    assert_eq!(code, 127);
    assert_eq!(&data[start..end], b"\x1b]133;D;127\x07");
}

#[test]
fn marker_prefix_incomplete_returns_none() {
    // Prefix split across chunks: digits and BEL not there yet.
    assert_eq!(find_prompt_marker(b"\x1b]133;D;"), None);
    assert_eq!(find_prompt_marker(b"ok\n\x1b]133;D;0"), None);
    assert_eq!(find_prompt_marker(b"x\x1b]133;D;"), None);
}

#[test]
fn marker_complete_wins_over_trailing_incomplete() {
    // A complete marker is found even when an incomplete prefix follows
    // (the scanner is position-independent; the caller drains the whole
    // marker and re-scans, so the trailing prefix stays pending).
    let data = b"\x1b]133;D;0\x07x\x1b]133;D;";
    let (start, end, code) = find_prompt_marker(data).unwrap();
    assert_eq!(code, 0);
    assert_eq!(&data[start..end], b"\x1b]133;D;0\x07");
}

#[test]
fn marker_not_found_in_plain_output() {
    // ANSI colors and OSC titles do not match the 133;D; prefix.
    assert_eq!(find_prompt_marker(b"hello world\n"), None);
    assert_eq!(find_prompt_marker(b"\x1b[01;32mok\x1b[00m\n"), None);
    assert_eq!(find_prompt_marker(b"\x1b]0;title\x07"), None);
}

#[test]
fn marker_found_with_text_after() {
    // Marker then more prompt text — only the sequence is returned.
    let data = b"done\x1b]133;D;3\x07user@host:~$ ";
    let (start, end, code) = find_prompt_marker(data).unwrap();
    assert_eq!(code, 3);
    assert_eq!(&data[start..end], b"\x1b]133;D;3\x07");
}

// ── stage-m: 633 wait-loop chunk simulation ────────────
// The execute wait loop feeds raw pty chunks into a carry buffer and
// drains each found 633;D (find_finished). These tests simulate that
// loop over realistic PowerShell + shellIntegration.ps1 byte streams to
// pin the completion semantics: what text lands in `result`, what exit
// code, and that no partial garbage is returned. The scanner module is
// pure byte-parsing (available in both feature configs), so these tests
// run everywhere.

mod wait_loop_sim {
    /// Simulate the execute wait loop's marker scan over a chunked stream.
    /// Applies the same final cleaning as the real pipeline
    /// (`clean_terminal_output` strips the invisible 633 sequences).
    /// Returns (finalized text, last exit code seen).
    fn scan_633_stream(chunks: &[&[u8]]) -> (String, Option<i32>) {
        let mut carry: Vec<u8> = Vec::new();
        let mut result = String::new();
        let mut code: Option<i32> = None;
        for chunk in chunks {
            carry.extend_from_slice(chunk);
            while let Some(f) = crate::tools::terminal::shell_integration::find_finished(&carry) {
                if f.end > 0 {
                    result.push_str(&String::from_utf8_lossy(&carry[..f.end]));
                }
                carry.drain(..f.end);
                code = f.exit_code;
            }
            // 64B finalize window like the real loop.
            let keep = carry.len().saturating_sub(64);
            if keep > 0 {
                result.push_str(&String::from_utf8_lossy(&carry[..keep]));
                carry.drain(..keep);
            }
        }
        result.push_str(&String::from_utf8_lossy(&carry));
        let result = crate::plugins::terminal::clean_terminal_output(result.as_bytes());
        (result, code)
    }

    #[test]
    fn pty_stream_echo_then_d_marker() {
        // `echo hi`: the shell echoes the command, prints output, then the
        // injected Prompt emits 633;D;0. The wait loop must finalize the
        // echo+output as result and report exit 0.
        let chunks: &[&[u8]] = &[
            b"PS C:\\Users\\x> echo hi\r\nhi\r\n\x1b]633;D;0\x07",
            b"\x1b]633;A\x07PS C:\\Users\\x> ",
        ];
        let (text, code) = scan_633_stream(chunks);
        assert_eq!(code, Some(0));
        // The 633 sequences are invisible on the terminal: what remains is
        // exactly the echoed prompt + command + output + next prompt.
        assert!(text.contains("echo hi"), "echo must be in result: {text:?}");
        assert!(text.contains("hi"), "output must be in result: {text:?}");
        assert!(
            !text.contains("\x1b]633"),
            "no raw 633 bytes may leak: {text:?}"
        );
        assert!(
            text.contains("PS C:\\Users\\x>"),
            "next prompt must be in result: {text:?}"
        );
    }

    #[test]
    fn pty_stream_marker_split_inside_exit_code() {
        // The 633;D sequence is split mid-exit-code across chunks — the
        // carry buffer must bridge it and still report the code.
        let chunks: &[&[u8]] = &[b"ok\r\n\x1b]633;D;", b"42\x07\x1b]633;A\x07PS> "];
        let (text, code) = scan_633_stream(chunks);
        assert_eq!(code, Some(42));
        assert!(text.contains("ok"), "output must survive: {text:?}");
        assert!(!text.contains("\x1b]633"), "no raw 633 leaks: {text:?}");
    }

    #[test]
    fn pty_stream_nonzero_exit_and_multiple_commands() {
        // Two commands: one failing (exit 3), one clean (exit 0). The loop
        // must observe BOTH codes in order (the background waiter drains
        // repeatedly until no marker remains).
        let chunks: &[&[u8]] = &[
            b"cmd-1\r\n\x1b]633;D;3\x07\x1b]633;A\x07PS> ",
            b"cmd-2\r\nout2\r\n\x1b]633;D;0\x07\x1b]633;A\x07PS> ",
        ];
        let (text, code) = scan_633_stream(chunks);
        assert_eq!(code, Some(0), "last code wins");
        assert!(
            text.contains("cmd-1") && text.contains("cmd-2"),
            "both commands in result: {text:?}"
        );
        assert!(text.contains("out2"), "second output in result: {text:?}");
    }

    #[test]
    fn pty_stream_enter_on_empty_prompt_no_d() {
        // Bare Enter on an empty prompt: ps1 emits 633;D (NO rc) — exit code
        // None, and no command text pollutes the result.
        let chunks: &[&[u8]] = &[
            b"\x1b]633;E;;nonce\x07\x1b]633;C\x07\x1b]633;D\x07",
            b"\x1b]633;A\x07PS> ",
        ];
        let (text, code) = scan_633_stream(chunks);
        assert_eq!(code, None, "empty command has no exit code");
        assert!(text.contains("PS>"), "prompt text kept: {text:?}");
        assert!(!text.contains("\x1b]633"), "no raw 633 leaks: {text:?}");
    }

    #[test]
    fn pty_stream_false_prefix_then_real_d() {
        // A truncated/false 633;D prefix in output must not abort the scan —
        // the real marker after it is found. Regression: the old OSC-skip
        // jumped to the next BEL, which swallowed the real marker's
        // terminator (execute would hang until timeout).
        let data = b"log: \x1b]633;D;\r\nreal-output\r\n\x1b]633;D;0\x07";
        let f = crate::tools::terminal::shell_integration::find_finished(data).expect("finished");
        assert_eq!(f.exit_code, Some(0));
        assert_eq!(&data[f.end..], b"");
    }
}

// ── round-157: partial-return contract (still_running + note) ──
// The shape is a pure function; tests below exercise both paths without
// a real shell (CI-safe, no feature gate needed).

#[test]
fn execute_result_done_has_no_note() {
    let out = execute_result_json("done", "ok\n".into(), false, false, "marker", Some(0), 4);
    assert_eq!(out["state"], "done");
    assert_eq!(out["still_running"], false);
    let text = out["text"].as_str().unwrap_or_default();
    assert_eq!(text, "ok\n", "done must keep text verbatim: {text}");
    assert!(
        !text.contains("[note:"),
        "done must not carry the partial note"
    );
    assert_eq!(out["exit_code"], 0);
}

#[test]
fn execute_result_partial_carries_note_and_flag() {
    let out = execute_result_json("partial", "half".into(), false, false, "idle", None, 4);
    assert_eq!(out["state"], "partial");
    assert_eq!(out["still_running"], true);
    let text = out["text"].as_str().unwrap_or_default();
    assert!(
        text.starts_with("half"),
        "partial must keep the prefix: {text}"
    );
    assert!(
        text.contains("[note:"),
        "partial must carry the continuation note: {text}"
    );
    assert!(
        text.contains("terminal_read"),
        "note must name terminal_read: {text}"
    );
    assert!(
        text.contains("Do NOT re-run"),
        "note must forbid re-runs: {text}"
    );
    assert!(
        text.contains("do NOT open a new session"),
        "note must forbid new sessions: {text}"
    );
}

#[test]
fn execute_result_timeout_has_no_note() {
    let out = execute_result_json("timeout", "part".into(), true, true, "timeout", None, 9);
    assert_eq!(out["state"], "timeout");
    assert_eq!(out["still_running"], false, "timeout aborted the command");
    assert_eq!(out["timed_out"], true);
    let text = out["text"].as_str().unwrap_or_default();
    assert!(
        !text.contains("[note:"),
        "timeout must not carry the partial note: {text}"
    );
}

// ── terminal_connect_saved unknown-id (round-359) ──────────────
// Unknown saved-connection id is a CALLER error (InvalidParams with the
// known-id list for self-recovery), not Internal. Feature-gated: the
// lookup path only exists with the real terminal backend.

#[cfg(feature = "terminal")]
fn isolated_conns(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("vale-conn-tool-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    crate::tools::terminal::TEST_DIR.with(|d| *d.borrow_mut() = Some(dir.clone()));
    dir
}

#[cfg(feature = "terminal")]
fn unisolate_conns(dir: &std::path::Path) {
    crate::tools::terminal::TEST_DIR.with(|d| *d.borrow_mut() = None);
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(feature = "terminal")]
#[tokio::test]
async fn connect_saved_unknown_id_is_invalid_params_with_known_list() {
    use vale_agent_core::DeviceError;
    let dir = isolated_conns("unknown");
    crate::tools::terminal::conn_remember("ssh", "u@h:22", "seeded", &serde_json::Map::new())
        .unwrap();
    let (tools, _buf) = seeded_tools();
    let err = find(&tools, "terminal_connect_saved")
        .handler
        .call(json!({"id": "ssh:nobody@nowhere:22"}))
        .await
        .unwrap_err();
    assert!(
        matches!(err, DeviceError::InvalidParams { .. }),
        "unknown id must be InvalidParams, got: {err}"
    );
    let msg = err.to_string();
    assert!(
        msg.contains("unknown saved connection: ssh:nobody@nowhere:22"),
        "must name the bad id: {msg}"
    );
    assert!(
        msg.contains("ssh:u@h:22"),
        "must list the known id for recovery: {msg}"
    );
    unisolate_conns(&dir);
}

#[cfg(feature = "terminal")]
#[tokio::test]
async fn connect_saved_unknown_id_empty_store_hint() {
    let dir = isolated_conns("empty");
    let (tools, _buf) = seeded_tools();
    let err = find(&tools, "terminal_connect_saved")
        .handler
        .call(json!({"id": "ssh:nobody@nowhere:22"}))
        .await
        .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("none saved yet"),
        "empty store must say so: {msg}"
    );
    unisolate_conns(&dir);
}
