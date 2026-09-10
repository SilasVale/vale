//! Output tools — terminal_read, terminal_screen, terminal_history (the
//! retained-session views over the session buffers) and the terminal_diag_*
//! panel-diagnostics ring. One builder fn per MCP tool, built once at
//! registration. Code moved verbatim from the former monolithic
//! `plugins/terminal/tools.rs`.

use serde_json::{json, Value};
use std::sync::Arc;

use super::ctx::{read_spill, spill_path};
use crate::plugins::require_str;
use crate::plugins::terminal::{
    clean_terminal_output, DiagStore, OutputBuf, RetainedSession, SessionBuf,
};
use crate::tools::terminal::TerminalManager;
use vale_agent_core::{recover_guard, ToolDef};

/// Byte range of the last `lines` CONTENT lines in `data`: trailing blank
/// lines (`\r\n`/`\n`) are skipped first so the Nth-from-end scan counts
/// content, not an empty tail — otherwise screen came back blank whenever
/// the buffer ended in a newline. Returns (start, end); with fewer than
/// `lines` content lines start is 0. Shared by tool_screen's live and
/// history branches (used to copy-paste this tail scan).
pub(super) fn tail_n_lines(data: &[u8], lines: usize) -> (usize, usize) {
    let mut end = data.len();
    while end > 0 && (data[end - 1] == b'\n' || data[end - 1] == b'\r') {
        end -= 1;
    }
    let mut seen = 0;
    let mut i = end;
    while i > 0 && seen < lines {
        i -= 1;
        if data[i] == b'\n' {
            seen += 1;
        }
    }
    let start = if seen >= lines { i + 1 } else { 0 };
    (start, end)
}

// ── History ───────────────────────────────────────

pub(super) fn tool_history(terminal_mgr: &Arc<TerminalManager>, output_buf: &OutputBuf) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    let buf = output_buf.clone();
    ToolDef::new(
        "terminal_history",
        "List ALL terminal sessions, including closed ones retained in history. Each entry: {id, kind, label, status: 'live'|'closed', bytes, closed_at? (unix seconds), exit_code? (natural shell exit code)}. Closed entries sorted newest-first.",
        json!({"type":"object","properties":{
            "limit":{"type":"integer","description":"Max entries to return (default 20; live sessions are always included)."}
        }}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            let buf = buf.clone();
            async move {
                let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(20).max(1) as usize;
                let mut entries: Vec<Value> = Vec::new();
                // Live sessions (from the manager) + their current byte count.
                let live = terminal_mgr.term_list().await;
                let store = recover_guard(&buf);
                for s in &live {
                    let bytes = store.live.get(&s.id).map(|e| e.end_abs()).unwrap_or(0);
                    entries.push(json!({"id": s.id, "kind": s.kind, "label": s.label, "status": "live", "bytes": bytes}));
                }
                // Retained closed sessions, newest-closed first, capped so the
                // total (live + closed) does not exceed the requested limit.
                let mut closed: Vec<(String, &RetainedSession)> = store.history.iter()
                    .map(|(k, v)| (k.clone(), v))
                    .collect();
                // Newest-closed first; closed_at_unix is second-granular, so
                // same-second closes break ties on seq (monotonic retain
                // order — a later retain is always the newer close).
                closed.sort_by(|(_, a), (_, b)| {
                    b.closed_at_unix.cmp(&a.closed_at_unix).then_with(|| b.seq.cmp(&a.seq))
                });
                let closed_budget = limit.saturating_sub(entries.len());
                for (sid, h) in closed.iter().take(closed_budget) {
                    entries.push(json!({
                        "id": sid, "kind": h.kind, "label": h.label,
                        "status": "closed", "bytes": h.buf.end_abs(),
                        "closed_at": h.closed_at_unix,
                        "exit_code": h.exit_code,
                    }));
                }
                drop(store);
                Ok(json!(entries))
            }
        },
    )
}

// ── Output (read/screen) ────────────────────────────

pub(super) fn tool_read(output_buf: &OutputBuf) -> ToolDef {
    let buf = output_buf.clone();
    ToolDef::new(
        "terminal_read",
        "Read buffered output from a terminal session. Non-destructive: uses a cursor so repeating the call without `offset` returns only new output since last read. `offset` is an ABSOLUTE byte offset into the session's byte stream (see `start`/`end` in the response); `offset: 0` re-reads from the beginning. Reads work on closed sessions (retained history). ANSI escapes are stripped and line endings normalized by default (AI-readable); pass `clean: false` for raw bytes.",
        json!({"type":"object","properties":{"session_id":{"type":"string"},"offset":{"type":"integer","description":"ABSOLUTE byte offset to start reading from. 0 = beginning. Default = last cursor position."},"clean":{"type":"boolean","description":"Strip ANSI escapes and normalize \\r\\n → \\n. Default true (round-54: the MCP text path must be printable text; the panel uses its own raw SSE stream)."}},"required":["session_id"]}),
        move |params: Value| {
            let buf = buf.clone();
            async move {
                let session_id = require_str(&params, "session_id")?;
                let (text, raw, clean_out, start, end, dropped, spilled) = {
                    let mut store = recover_guard(&buf);
                    // Live session, or retained history (closed).
                    let explicit_offset = params.get("offset").is_some();
                    let offset = params.get("offset").and_then(|v| v.as_u64()).map(|o| o as usize);
                    let clean = params.get("clean").and_then(|v| v.as_bool()).unwrap_or(true);
                    // Merge spill + memory so the stream reads continuously
                    // from any absolute offset (round-54): bytes before the
                    // eviction window live in the spill file.
                    let merged = |entry: &SessionBuf, offset: usize| {
                        let in_mem_start = entry.dropped as usize;
                        let spilled = offset < in_mem_start;
                        // round-111: read_spill returns the ACTUAL start —
                        // when the window is capped, bytes begin later than
                        // `offset`; report that as `start` (the R110 cap
                        // silently mislabeled the tail as [offset, end),
                        // making the head unreachable and duplicating on
                        // incremental reads).
                        let (spill_bytes, actual_start) = if spilled {
                            read_spill(&session_id, offset, in_mem_start, entry.spill_base)
                        } else {
                            (Vec::new(), offset as u64)
                        };
                        let mut raw = spill_bytes;
                        // The in-memory slice starts at the actual spill end
                        // (capped or not) so the stream stays continuous.
                        let mem_rel = (actual_start as usize).saturating_sub(in_mem_start).min(entry.data.len());
                        raw.extend_from_slice(&entry.data[mem_rel..]);
                        let text = if clean {
                            clean_terminal_output(&raw)
                        } else {
                            String::from_utf8_lossy(&raw).to_string()
                        };
                        let raw_out = if clean { Vec::new() } else { raw.clone() };
                        (text, raw_out, clean, actual_start as usize, entry.end_abs(), entry.dropped, spilled)
                    };
                    match store.live.get_mut(&session_id) {
                        Some(entry) => {
                            let offset = offset.unwrap_or(entry.cursor);
                            let r = merged(entry, offset);
                            // Advance cursor only when no explicit offset was given.
                            // Cursor is an ABSOLUTE stream offset (the read path
                            // consumes it as such at line 461) — storing the
                            // relative data.len() here re-delivered up to 1MB of
                            // already-read output after the first eviction.
                            if !explicit_offset {
                                entry.cursor = entry.dropped as usize + entry.data.len();
                            }
                            r
                        }
                        None => match store.history.get(&session_id) {
                            Some(h) => {
                                let offset = offset.unwrap_or(h.buf.cursor);
                                // History reads never advance any cursor.
                                merged(&h.buf, offset)
                            }
                            // Neither live nor history: the session was evicted
                            // by history caps, or never existed. Mark it so a
                            // client can distinguish 'no data' from 'gone'.
                            None => return Ok(json!({"text": "", "start": 0, "end": 0, "evicted": true})),
                        },
                    }
                };
                let mut out = json!({"text": text, "start": start, "end": end});
                // round-94: the panel's sync loop dedups against the SSE
                // stream by BYTE delta — a lossy UTF-16 string can't be
                // sliced byte-precisely (CJK/emoji diverged and dropped live
                // characters). When clean:false, also return the raw BYTES
                // (base64) so the panel can subarray the exact byte range.
                if !clean_out && !raw.is_empty() {
                    use base64::Engine as _;
                    out["raw"] = json!(base64::engine::general_purpose::STANDARD.encode(&raw));
                }
                if dropped > 0 {
                    out["dropped"] = json!(dropped);
                }
                if spilled {
                    // Debug aid only: the spill file backing this read.
                    // Non-whitelisted ids (see ctx::spill_path) surface as ""
                    // rather than a joined attacker-influenced path.
                    let spill_dbg = spill_path(&session_id)
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    out["spill"] = json!(spill_dbg);
                }
                Ok(out)
            }
        },
    )
}

pub(super) fn tool_screen(output_buf: &OutputBuf) -> ToolDef {
    let buf = output_buf.clone();
    ToolDef::new(
        "terminal_screen",
        "Get the current on-screen text of a terminal session — the tail of the output buffer (ANSI-stripped), for AI readability. Returns up to `lines` lines (default 60).",
        json!({"type":"object","properties":{"session_id":{"type":"string"},"lines":{"type":"integer","description":"Number of lines from the tail. Default 60."}},"required":["session_id"]}),
        move |params: Value| {
            let buf = buf.clone();
            async move {
                let session_id = require_str(&params, "session_id")?;
                let lines = params.get("lines").and_then(|v| v.as_u64()).unwrap_or(60).max(1) as usize;
                let (screen, dropped) = {
                    let mut store = recover_guard(&buf);
                    let entry = store.live.get_mut(&session_id);
                    match entry {
                        Some(entry) => {
                            // Tail: find the start of the Nth-from-end line
                            // (shared tail_n_lines helper).
                            let data = &entry.data;
                            let (start, end) = tail_n_lines(data, lines);
                            (clean_terminal_output(&data[start..end]), entry.dropped)
                        }
                        // round-105: a closed session lives in history —
                        // terminal_read serves it; screen must too (an empty
                        // screen misleads the model into 'no output').
                        None => match store.history.get(&session_id) {
                            Some(h) => {
                                let data = &h.buf.data;
                                let (start, end) = tail_n_lines(data, lines);
                                (clean_terminal_output(&data[start..end]), h.buf.dropped)
                            }
                            None => (String::new(), 0u64),
                        },
                    }
                };
                if dropped > 0 {
                    Ok(json!({"screen": screen, "dropped": dropped}))
                } else {
                    Ok(json!({"screen": screen}))
                }
            }
        },
    )
}

// ── Diagnostics ────────────────────────────────────

pub(super) fn tool_diag_write(diag: &DiagStore) -> ToolDef {
    let diag = diag.clone();
    ToolDef::new(
        "terminal_diag_write",
        "POST a diagnostic line from the terminal panel (poll results, adopt events, SSE status, errors). Stored in a process-lifetime ring buffer (cap 200), read via terminal_diag_read.",
        json!({"type":"object","properties":{"line":{"type":"string"}},"required":["line"]}),
        move |params: Value| {
            let diag = diag.clone();
            async move {
                let line = require_str(&params, "line")?;
                // round-110/111: a caller-supplied line up to the 1MB HTTP
                // body limit × 200 ring entries = 200MB retained. Cap a
                // line — at a CHAR boundary (the R110 &line[..4096] panicked
                // when byte 4096 fell mid-UTF-8, the R106-H1 class).
                let capped = crate::text::clip(&line, 4096);
                let mut d = recover_guard(&diag);
                d.push(format!("{} {capped}", chrono_timestamp()));
                Ok(json!("ok"))
            }
        },
    )
}

pub(super) fn tool_diag_read(diag: &DiagStore) -> ToolDef {
    let diag = diag.clone();
    ToolDef::new(
        "terminal_diag_read",
        "Read the panel diagnostic ring buffer (newest last). Returns {entries: [...]}.",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            let diag = diag.clone();
            async move {
                let d = recover_guard(&diag);
                Ok(json!({"entries": d.snapshot()}))
            }
        },
    )
}

/// Seconds-since-epoch as a string (for diag timestamps; no chrono dep needed).
fn chrono_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "?".into())
}
