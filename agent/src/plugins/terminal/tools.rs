//! Per-tool builders — one fn per MCP tool, built once at registration.
//!
//! The closures capture clones of the shared context (managers, bus, buffer),
//! so the tool list is built a single time by `PluginRegistry::register` and
//! reused for MCP list_tools and the web /api/spec endpoint alike.

use std::sync::Arc;
use std::time::Instant;
use serde_json::{json, Value};

use vale_agent_core::{recover_guard, AgentEvent, DeviceError, EventBus, ToolDef};
use crate::plugins::{require_str, to_value_or_empty};
use crate::tools::serial::SerialPool;
use crate::tools::terminal::{parse_serial_target, parse_ssh_target, TerminalManager};
use super::{clean_terminal_output, DiagStore, OutputBuf, RetainedSession, SessionBuf};

pub(super) fn build(
    terminal_mgr: &Arc<TerminalManager>,
    serial_pool: &Arc<SerialPool>,
    bus: &Arc<dyn EventBus>,
    output_buf: &OutputBuf,
    diag: &DiagStore,
    logger: &crate::session_log::SessionLogger,
) -> Vec<ToolDef> {
    vec![
        tool_open(terminal_mgr, bus, output_buf, logger),
        tool_write(terminal_mgr),
        tool_close(terminal_mgr, bus, output_buf),
        tool_list(terminal_mgr),
        tool_history(terminal_mgr, output_buf),
        tool_execute(terminal_mgr, bus, output_buf, logger),
        tool_list_ports(serial_pool),
        tool_resize(terminal_mgr),
        tool_select(terminal_mgr),
        tool_read(output_buf),
        tool_screen(output_buf),
        tool_diag_write(diag),
        tool_diag_read(diag),
        tool_secret_set(),
        tool_secret_get(),
        tool_secret_delete(),
    ]
}

/// Max bytes per session buffer before evicting oldest half.
const MAX_BUF_BYTES: usize = 1_048_576; // 1 MB

fn tool_open(
    terminal_mgr: &Arc<TerminalManager>,
    bus: &Arc<dyn EventBus>,
    output_buf: &OutputBuf,
    logger: &crate::session_log::SessionLogger,
) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    let bus = bus.clone();
    let buf = output_buf.clone();
    let logger = logger.clone();
    ToolDef::new(
        "terminal_open",
        "Open a terminal connection. Kind: 'pty' (local shell; target optional — blank = default shell), 'ssh' (target=user@host:port), or 'serial' (target=port_name, optional ?baud=N&parity=E&data=8&stop=1 e.g. /dev/ttyUSB0?baud=9600&parity=even&data=8&stop=1, default 115200 8N1). Returns session ID.",
        json!({"type":"object","properties":{"kind":{"type":"string","enum":["pty","ssh","serial"]},"target":{"type":"string","description":"pty: optional (blank = default shell); ssh: user@host:port; serial: port_name (optional ?baud=N&parity=E&data=8&stop=1)"},"password":{"type":"string"},"rows":{"type":"integer","description":"Initial terminal rows. Default 0 (backend default)."},"cols":{"type":"integer","description":"Initial terminal columns. Default 0 (backend default)."},"data_bits":{"type":"integer","description":"(serial) Data bits 5-8. Overrides the target string."},"parity":{"type":"string","description":"(serial) Parity: none|odd|even. Overrides the target string."},"stop_bits":{"type":"integer","description":"(serial) Stop bits 1 or 2. Overrides the target string."}},"required":["kind"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            let bus = bus.clone();
            let buf = buf.clone();
            let logger = logger.clone();
            async move {
                let kind = require_str(&params, "kind")?;
                // target is OPTIONAL (pty blank = default shell) — the schema
                // used to mark it required, contradicting the description and
                // breaking MCP clients that omit it for pty.
                let target = params.get("target").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let password = params.get("password").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let rows = params.get("rows").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                let cols = params.get("cols").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                let inject_marker = params.get("inject_marker").and_then(|v| v.as_bool()).unwrap_or(true);
                let data_bits = params.get("data_bits").and_then(|v| v.as_u64()).map(|v| v as u8);
                let parity = params.get("parity").and_then(|v| v.as_str()).map(|s| s.to_string());
                let stop_bits = params.get("stop_bits").and_then(|v| v.as_u64()).map(|v| v as u8);
                let req = crate::tools::terminal::TermOpenRequest {
                    kind: kind.clone(),
                    target: target.clone(),
                    password,
                    rows,
                    cols,
                    inject_marker,
                    data_bits,
                    parity,
                    stop_bits,
                };
                let (id, _rx) = terminal_mgr.term_open(&req).await?;
                // Audit trail: session opened (round-54).
                logger.log_status(&id, "opened");
                // Prompt-marker injection (round-54): teach the PTY shell to
                // emit OSC 133;D;<exit-code> right before each prompt, so the
                // execute wait-loop can distinguish "command finished" from
                // "output paused" (the 200ms-silence heuristic misread a
                // `sleep 0.5 && echo done` as complete before it finished).
                // bash: PROMPT_COMMAND runs right before the prompt, $? still
                // holds the previous command's exit code; the existing
                // PROMPT_COMMAND (if any) is preserved. PowerShell: the
                // Prompt function emits the same sequence, keeping the
                // default "PS path>" text. Only PTY sessions with a KNOWN
                // shell get this — a custom shell target or SSH/serial are
                // untouched (unknown syntax, must not corrupt the session).
                if kind == "pty" && inject_marker {
                    let (inject, injectable) = if cfg!(windows) {
                        // target blank → default powershell.exe; a custom
                        // target may be cmd.exe or anything else — only the
                        // default gets the PS Prompt function (cmd has no
                        // prompt hook, falls back to idle detection).
                        // CRLF: PowerShell only recognizes a command on \r\n.
                        // PS 5.1 (the default PTY shell) does NOT support the
                        // `e backtick-escape — use [char]27/[char]7 instead
                        // (round-55: the old `e form emitted a literal 'e',
                        // the marker scanner never matched on the main
                        // platform).
                        let cmd = std::path::Path::new(&target)
                            .file_name().and_then(|n| n.to_str()).unwrap_or(&target);
                        if cmd.is_empty() || cmd.eq_ignore_ascii_case("powershell.exe") || cmd.eq_ignore_ascii_case("pwsh.exe") {
                            (r#"function global:Prompt { Write-Host -NoNewline (([string][char]27) + "]133;D;" + $LASTEXITCODE + ([char]7)); "PS " + $(Get-Location) + "> " }"#.to_string() + "\r\n", true)
                        } else { (String::new(), false) }
                    } else {
                        let cmd = std::path::Path::new(&target)
                            .file_name().and_then(|n| n.to_str()).unwrap_or(&target);
                        if cmd.is_empty() || cmd == "bash" || cmd == "sh" {
                            // Single-quoted outer: a double-quoted RHS expands
                            // $? AT ASSIGNMENT TIME (a fresh session's value,
                            // always 0), freezing the exit code — every failed
                            // command reported 0 (round-55). The marker string
                            // stays literal; the old PROMPT_COMMAND is joined
                            // outside the quotes so it expands now.
                            (r#"export PROMPT_COMMAND='printf "\033]133;D;$?\007";'"$PROMPT_COMMAND""#.to_string() + "\n", true)
                        } else { (String::new(), false) }
                    };
                    if injectable {
                        // The shell echoes the injection line itself; the
                        // first prompt after it carries the marker.
                        let _ = terminal_mgr.term_write(&id, &inject).await;
                    }
                }
                // Emit event based on kind
                match kind.as_str() {
                    "ssh" => {
                        let (user, host, _port) = parse_ssh_target(&target);
                        bus.emit(&AgentEvent::SshConnect { host, username: user, session_id: id.clone() });
                    }
                    "serial" => {
                        let (port, _baud) = parse_serial_target(&target);
                        bus.emit(&AgentEvent::SerialOpen { port, baud: 115200, session_id: id.clone() });
                    }
                    _ => {
                        let cmd = std::path::Path::new(&target)
                            .file_name().and_then(|n| n.to_str()).unwrap_or(&target).to_string();
                        bus.emit(&AgentEvent::ShellExec { command: if cmd.is_empty() { "shell".into() } else { cmd } });
                    }
                }
                // Drain output channel to keep backend alive.
                // Forward via EventBus, also buffer for MCP terminal_read.
                let bus2 = bus.clone();
                let sid_buf = id.clone();
                // Capture metadata BEFORE the recv loop, while the session is
                // still registered in the manager — retained history needs it.
                let mgr2 = terminal_mgr.clone();
                let logger2 = logger.clone();
                tokio::spawn(async move {
                    // Metadata for the retained history entry (kind/label).
                    let (kind, label) = {
                        let meta = mgr2.term_info(&sid_buf).await;
                        (
                            meta.as_ref().map(|m| m.kind.clone()).unwrap_or_default(),
                            meta.as_ref().map(|m| m.label.clone()).unwrap_or_else(|| sid_buf.clone()),
                        )
                    };
                    let mut rx = _rx;
                    while let Some(output) = rx.recv().await {
                        // Audit trail: every output chunk (lossy text, capped
                        // inside the logger) (round-54).
                        logger2.log_output(&sid_buf, String::from_utf8_lossy(&output.data).to_string());
                        // Deliberately NO touch here (round-54): output
                        // activity is not presence. Touching on every chunk
                        // kept abandoned high-output sessions (`tail -f`,
                        // `yes`) alive forever — only the 16-session cap ever
                        // reaped them. Presence is explicit: the panel pings
                        // terminal_select every 30s, the MCP execute wait-loop
                        // pings every poll, term_write/resize touch. A session
                        // nobody watches is reaped by the 15-min idle sweeper.
                        // Poison recovery — dropping buffered output on a poisoned
                        // lock would silently lose terminal data.
                        let mut store = recover_guard(&buf);
                        let entry = store.live.entry(sid_buf.clone()).or_default();
                        // The frame's ABSOLUTE start offset, attached to the SSE
                        // frame so the panel can skip bytes already delivered by
                        // a concurrent terminal_read (dedup — see panel.js).
                        let frame_start = entry.end_abs();
                        entry.data.extend_from_slice(&output.data);
                        // Cap at 1 MB — evict oldest half if exceeded. The
                        // cursor is ABSOLUTE (dropped+len); eviction advances
                        // `dropped`, so the cursor is untouched — a leftover
                        // saturating_sub(remove) here corrupted it and
                        // re-delivered up to 524KB of already-read bytes.
                        if entry.data.len() > MAX_BUF_BYTES {
                            let remove = entry.data.len() - MAX_BUF_BYTES / 2;
                            // Spill the evicted bytes BEFORE dropping them —
                            // they are the only copy of the stream's head;
                            // terminal_read merges spill + memory (round-54).
                            append_spill(&sid_buf, &entry.data[..remove]);
                            entry.data.drain(..remove);
                            entry.dropped += remove as u64;
                        }
                        drop(store);
                        // Attach the start offset to the emitted frame.
                        let mut framed = serde_json::to_value(&output).unwrap_or_default();
                        if let Some(obj) = framed.as_object_mut() {
                            obj.insert("start".into(), serde_json::json!(frame_start));
                        }
                        bus2.emit_term_output(framed);
                    }
                    // Session ended — retain the buffer in history instead of
                    // dropping it (terminal_close also retains; whichever runs
                    // second is a no-op), and unregister the manager entry so
                    // the dead session is not listed as live / written to a void.
                    recover_guard(&buf)
                        .retain_live(&sid_buf, &kind, &label);
                    mgr2.term_unregister(&sid_buf).await;
                    // Audit trail: session closed (round-54).
                    logger2.log_status(&sid_buf, "closed");
                    // Backend-initiated death (SSH channel EOF, serial read
                    // error, pty EOF) — emit the event so clients learn the
                    // session died and WHY, instead of discovering it only via
                    // terminal_list polling with no reason (round-53). A
                    // client-initiated close goes through tool_close which
                    // already emits; this is a no-op for the double-run (the
                    // event is harmless on an already-closed session).
                    bus2.emit(&close_event(&kind, &sid_buf));
                });
                Ok(json!(id))
            }
        },
    )
}

fn tool_write(terminal_mgr: &Arc<TerminalManager>) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    ToolDef::new(
        "terminal_write",
        "Write data to a terminal session. `data` is UTF-8 text (JSON strings cannot carry arbitrary bytes); use `data_base64` for binary frames (control bytes, non-UTF-8 serial protocols) — it is decoded and written exactly as given. For shell commands on Unix devices (serial/ssh to Linux), the command must end with a newline (\\n) — otherwise the shell joins it with whatever is typed next, mangling both. For Windows PowerShell use \\r\\n. Control characters (e.g. \\u0003 for Ctrl+C) are sent verbatim and need no newline.",
        json!({"type":"object","properties":{"session_id":{"type":"string"},"data":{"type":"string","description":"UTF-8 text to write. Required unless data_base64 is given."},"data_base64":{"type":"string","description":"Base64-encoded bytes to write (for binary frames that JSON strings cannot carry). Takes precedence over data."}},"required":["session_id"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            async move {
                let session_id = require_str(&params, "session_id")?;
                // data_base64 wins — it is the only path that can carry
                // arbitrary bytes (round-54); `data` is UTF-8 text.
                let bytes: Vec<u8> = if let Some(b64) = params.get("data_base64").and_then(|v| v.as_str()) {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD.decode(b64)
                        .map_err(|e| DeviceError::InvalidParams { message: format!("data_base64: {e}") })?
                } else {
                    let data = require_str(&params, "data")?;
                    data.into_bytes()
                };
                terminal_mgr.term_write_bytes(&session_id, &bytes).await?;
                Ok(json!("OK"))
            }
        },
    )
}

fn tool_close(terminal_mgr: &Arc<TerminalManager>, bus: &Arc<dyn EventBus>, output_buf: &OutputBuf) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    let bus = bus.clone();
    let buf = output_buf.clone();
    ToolDef::new(
        "terminal_close",
        "Close a terminal session.",
        json!({"type":"object","properties":{"session_id":{"type":"string"}},"required":["session_id"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            let bus = bus.clone();
            let buf = buf.clone();
            async move {
                let session_id = require_str(&params, "session_id")?;
                // Capture metadata before close, then close. term_close fails
                // on unknown sessions instead of fabricating a kind.
                let meta = terminal_mgr.term_info(&session_id).await;
                let kind = terminal_mgr.term_close(&session_id).await?;
                // Retain the session's output in history instead of deleting
                // it (the drainer's own retain on channel close is a no-op if
                // it ran first — retain_live is idempotent).
                let label = meta.as_ref().map(|m| m.label.clone()).unwrap_or_default();
                recover_guard(&buf)
                    .retain_live(&session_id, &kind, &label);
                bus.emit(&close_event(&kind, &session_id));
                Ok(json!(format!("Closed terminal session {session_id}")))
            }
        },
    )
}

fn tool_list(terminal_mgr: &Arc<TerminalManager>) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    ToolDef::new(
        "terminal_list",
        "List all active terminal sessions (PTY, SSH, and serial).",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            async move {
                let sessions = terminal_mgr.term_list().await;
                Ok(to_value_or_empty(&sessions))
            }
        },
    )
}


// ── History ───────────────────────────────────────

fn tool_history(terminal_mgr: &Arc<TerminalManager>, output_buf: &OutputBuf) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    let buf = output_buf.clone();
    ToolDef::new(
        "terminal_history",
        "List ALL terminal sessions, including closed ones retained in history. Each entry: {id, kind, label, status: 'live'|'closed', bytes, closed_at? (unix seconds)}. Closed entries sorted newest-first.",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            let buf = buf.clone();
            async move {
                let mut entries: Vec<Value> = Vec::new();
                // Live sessions (from the manager) + their current byte count.
                let live = terminal_mgr.term_list().await;
                let store = recover_guard(&buf);
                for s in &live {
                    let bytes = store.live.get(&s.id).map(|e| e.end_abs()).unwrap_or(0);
                    entries.push(json!({"id": s.id, "kind": s.kind, "label": s.label, "status": "live", "bytes": bytes}));
                }
                // Retained closed sessions, newest-closed first.
                let mut closed: Vec<(String, &RetainedSession)> = store.history.iter()
                    .map(|(k, v)| (k.clone(), v))
                    .collect();
                closed.sort_by_key(|(_, h)| std::cmp::Reverse(h.closed_at_unix));
                for (sid, h) in closed {
                    entries.push(json!({
                        "id": sid, "kind": h.kind, "label": h.label,
                        "status": "closed", "bytes": h.buf.end_abs(),
                        "closed_at": h.closed_at_unix,
                    }));
                }
                drop(store);
                Ok(json!(entries))
            }
        },
    )
}

// ── Spill file (round-54, dsh OutputCollector) ─────────────────
// The in-memory session buffer caps at 1 MB; evicted bytes were DROPPED —
// a >1MB burst (build log, dd) made everything before the tail
// unrecoverable. Evicted bytes now append to a per-session spill file
// (%TEMP%/vale/<sid>.spill) and terminal_read merges spill + memory, so
// the stream reads continuously from any absolute offset.

/// Append the platform-appropriate line terminator to a command sent to a
/// terminal session. Windows PowerShell only ends a command on CRLF (\r\n) — a
/// bare \n leaves the shell in the multi-line continuation prompt (>>) and the
/// command never runs. Unix shells accept a bare \n.
pub fn append_command_newline(command: &str) -> String {
    if command.ends_with('\n') || command.ends_with('\r') {
        command.to_string()
    } else if cfg!(target_os = "windows") {
        format!("{command}\r\n")
    } else {
        format!("{command}\n")
    }
}

fn spill_path(sid: &str) -> std::path::PathBuf {
    std::env::temp_dir().join("vale").join(format!("{sid}.spill"))
}

fn append_spill(sid: &str, bytes: &[u8]) {
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
fn read_spill(sid: &str, start: usize, end: usize) -> Vec<u8> {
    std::fs::read(spill_path(sid))
        .map(|bytes| {
            let s = start.min(bytes.len());
            let e = end.min(bytes.len());
            bytes[s..e].to_vec()
        })
        .unwrap_or_default()
}

/// Map a session kind to its close/death event (round-54): the same
/// three-way mapping used to live in the drainer AND tool_close — a new
/// session type added in only one place would emit the wrong event, and
/// retain_live's idempotency silently masked the mismatch.
fn close_event(kind: &str, sid: &str) -> AgentEvent {
    match kind {
        "ssh" => AgentEvent::SshDisconnect { session_id: sid.to_string() },
        "serial" => AgentEvent::SerialClose { port_id: sid.to_string() },
        _ => AgentEvent::TermClose { session_id: sid.to_string() },
    }
}

/// Find a complete prompt marker — `ESC ] 133 ; D ; <exit-code> BEL` — in
/// `data`, returning (start, end, exit_code) over the WHOLE sequence.
/// The marker may be split across chunks, so it is searched over the
/// un-finalized tail; an incomplete sequence returns None and the caller
/// keeps waiting for the next chunk.
fn find_prompt_marker(data: &[u8]) -> Option<(usize, usize, i32)> {
    const PREFIX: &[u8] = b"\x1b]133;D;";
    let start = data.windows(PREFIX.len()).position(|w| w == PREFIX)?;
    let mut i = start + PREFIX.len();
    let digits_start = i;
    while i < data.len() && data[i].is_ascii_digit() { i += 1; }
    if i == digits_start { return None; } // prefix but no digits yet
    if i >= data.len() || data[i] != 0x07 { return None; }
    let code: i32 = std::str::from_utf8(&data[digits_start..i]).ok()?.parse().ok()?;
    Some((start, i + 1, code))
}


// ── Execute ──────────────────────────────────────

fn tool_execute(terminal_mgr: &Arc<TerminalManager>, bus: &Arc<dyn EventBus>, output_buf: &OutputBuf, logger: &crate::session_log::SessionLogger) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    let buf = output_buf.clone();
    let bus = bus.clone();
    let logger = logger.clone();
    ToolDef::new(
        "terminal_execute",
        "Run a command. If `session_id` is given, writes the command to that session and waits for output (prompt-marker detection on PTY shells, quiet-period fallback otherwise). Otherwise spawns a local shell with enforced timeout. Returns stdout, stderr, exit code (local) or accumulated terminal output (session) with wait_reason and exit_code.",
        json!({"type":"object","properties":{"command":{"type":"string"},"session_id":{"type":"string","description":"Optional: execute in an existing terminal session."},"timeout_secs":{"type":"integer","description":"Max wait time in seconds. Default 30."},"quiet_ms":{"type":"integer","description":"(Session mode) Quiet period in ms before considering output complete. Default 200."}},"required":["command"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            let buf = buf.clone();
            let bus = bus.clone();
            let logger = logger.clone();
            async move {
                let command = require_str(&params, "command")?;
                let timeout_secs = params.get("timeout_secs").and_then(|v| v.as_u64()).unwrap_or(30);
                let quiet_ms = params.get("quiet_ms").and_then(|v| v.as_u64()).unwrap_or(200);

                if let Some(session_id) = params.get("session_id").and_then(|v| v.as_str()) {
                    // ── Session-aware mode: write + wait for output ──
                    let sid = session_id.to_string();
                    // Absolute position of the first post-command byte.
                    // All tracking is byte-exact against the raw buffer, so
                    // UTF-8 lossy conversion and 1MB eviction can never
                    // desynchronize the index (the old String-length-based
                    // offset could panic on an out-of-range slice).
                    let mut read_abs = recover_guard(&buf)
                        .live.get(&sid).map(|e| e.end_abs()).unwrap_or(0);
                    // Write command + newline. Windows PowerShell only recognizes
                    // the end of a command on CRLF (\r\n) — a bare \n drops it
                    // into the multi-line continuation prompt (>>), so the
                    // command never executes. Unix shells accept either.
                    let cmd_with_nl = append_command_newline(&command);
                    terminal_mgr.term_write(&sid, &cmd_with_nl).await?;
                    // Audit trail: command started — AFTER the write succeeded.
                    // A command that never reached the shell (session reaped
                    // mid-write) must not leave a dangling start that crash
                    // recovery later reports as "interrupted" (round-55).
                    logger.log_command_start(&sid, &command);
                    // Busy guard (round-55): a second concurrent execute on
                    // this session would share one buffer cursor and interleave
                    // reads + marker ownership — refuse instead.
                    if !terminal_mgr.term_try_execute(&sid).await {
                        return Err(DeviceError::InvalidParams {
                            message: "execute already in progress on this session".into(),
                        });
                    }

                    let deadline = Instant::now() + std::time::Duration::from_secs(timeout_secs);
                    let quiet_dur = std::time::Duration::from_millis(quiet_ms);
                    // Marker-confirm window (dsh handoffGraceMs): once the
                    // prompt marker arrives, wait this long before returning —
                    // bash prints the prompt and then hands the tty back, and
                    // a too-eager return could race that handoff.
                    let marker_confirm = std::time::Duration::from_millis(300);
                    let mut quiet_since: Option<Instant> = None;
                    let mut result = String::new();
                    // Marker scanner state: the OSC 133;D;N BEL sequence may
                    // span chunks, so the last 64 bytes stay un-finalized until
                    // they cannot be a marker prefix anymore.
                    let mut pending: Vec<u8> = Vec::new();
                    let mut marker_code: Option<i32> = None;
                    let mut marker_seen_at: Option<Instant> = None;
                    // Every exit path below assigns it (marker / idle / timeout).
                    let wait_reason: &str;

                    let mut truncated = false;
                    let mut timed_out = false;
                    // Poll cadence: 50ms keeps output responsiveness; the
                    // liveness heartbeat only needs ~1s granularity — a
                    // term_select every 50ms hammered the manager lock
                    // for no benefit (round-55).
                    let mut ticks: u64 = 0;
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        ticks += 1;
                        // Client-liveness heartbeat every 1s: the 15-min idle
                        // sweeper kills sessions with no OUTPUT — a long quiet
                        // command (build, sleep 600, interactive SSH) would be
                        // reaped mid-execute even though the MCP client is
                        // actively waiting on this execute (round-49). A
                        // genuinely abandoned session still dies via the
                        // sweeper once the execute returns.
                        if ticks.is_multiple_of(20) {
                            let _ = terminal_mgr.term_select(&sid).await;
                        }
                        let (chunk, chunk_len) = recover_guard(&buf)
                            .live.get(&sid)
                            .map(|e| {
                                // Eviction advanced `dropped` past our read
                                // cursor → output was dropped (1MB burst).
                                if e.dropped as usize > read_abs { truncated = true; }
                                let s = e.slice_from(read_abs);
                                (s.to_vec(), s.len())
                            })
                            .unwrap_or_default();
                        if chunk_len > 0 {
                            read_abs += chunk_len;
                            pending.extend_from_slice(&chunk);
                            // Strip complete markers out of the un-finalized
                            // tail (multiple can appear in one chunk).
                            while let Some((start, end, code)) = find_prompt_marker(&pending) {
                                if start > 0 {
                                    result.push_str(&String::from_utf8_lossy(&pending[..start]));
                                }
                                pending.drain(..end);
                                marker_code = Some(code);
                                marker_seen_at = Some(Instant::now());
                            }
                            // Finalize everything that can no longer be a
                            // marker prefix.
                            let keep = pending.len().saturating_sub(64);
                            if keep > 0 {
                                result.push_str(&String::from_utf8_lossy(&pending[..keep]));
                                pending.drain(..keep);
                            }
                            quiet_since = None;
                        } else if quiet_since.is_none() {
                            quiet_since = Some(Instant::now());
                        }
                        // The marker is the AUTHORITATIVE "command finished"
                        // signal (dsh pollReadiness): while its confirm window
                        // runs, a quiet gap must not trigger the idle path —
                        // the command may be done and the marker chunk simply
                        // not read yet.
                        if let Some(at) = marker_seen_at {
                            if at.elapsed() >= marker_confirm {
                                wait_reason = "marker";
                                break;
                            }
                        } else if let Some(qs) = quiet_since {
                            if qs.elapsed() >= quiet_dur {
                                wait_reason = "idle";
                                break;
                            }
                        }
                        if Instant::now() >= deadline {
                            // Timeout: abort the running command (kill the PTY
                            // process tree / ^C over SSH) so a timed-out
                            // command cannot keep running on the device. The
                            // session itself stays open (round-54).
                            let _ = terminal_mgr.term_terminate(&sid).await;
                            timed_out = true;
                            wait_reason = "timeout";
                            break;
                        }
                    }
                    // Audit trail: command ended, with the shell's exit code
                    // (marker) and the reason the wait stopped (round-54).
                    logger.log_command_end(&sid, marker_code, Some(wait_reason));
                    // Release the per-session execute lock (round-55) — the
                    // only exit path from the wait loop.
                    terminal_mgr.term_release_execute(&sid).await;
                    bus.emit(&AgentEvent::ShellExec { command });
                    // Strip ANSI/OSC noise for the model — the MCP text path
                    // must be printable text (the prompt markers were already
                    // stripped during the wait); the panel keeps raw bytes
                    // via its own SSE stream (round-54, dsh sanitize.ts).
                    let result = clean_terminal_output(result.as_bytes());
                    // Surface truncation honestly: a >1MB burst evicted output
                    // the model would otherwise treat as complete. timed_out
                    // distinguishes "command finished" from "deadline hit and
                    // command aborted" (round-54); wait_reason says WHY the
                    // wait ended (marker = command really finished, idle =
                    // quiet period elapsed, timeout = deadline) and exit_code
                    // is the shell's own exit status when a marker was seen.
                    Ok(json!({
                        "text": result,
                        "truncated": truncated,
                        "timed_out": timed_out,
                        "wait_reason": wait_reason,
                        "exit_code": marker_code,
                    }))
                } else {
                    // ── Local shell mode with enforced timeout (tokio::process) ──
                    let (shell, flag) = if cfg!(target_os = "windows") {
                        ("cmd", "/C")
                    } else {
                        ("sh", "-c")
                    };
                    let mut cmd = tokio::process::Command::new(shell);
                    cmd.arg(flag)
                        .arg(&command)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped());
                    // The command runs in its own process group (Unix) so a
                    // timeout can kill the WHOLE tree — shell AND descendants.
                    // Without this a timed-out `make` / `agent_update`
                    // installer kept running orphaned on the device after
                    // only the direct child died (round-54).
                    #[cfg(unix)]
                    cmd.process_group(0);
                    let mut child = cmd.spawn().map_err(|e| DeviceError::Internal {
                        message: format!("spawn failed: {e}"),
                    })?;
                    let pid = child.id();

                    // BOUNDED capture (round-55): wait_with_output buffered
                    // stdout+stderr into RAM WITHOUT limit — a `yes`-style
                    // command OOM'd the device. Two reader tasks stream both
                    // pipes into a bounded channel; the main loop keeps only
                    // the TAIL (1 MB cap, oldest half dropped on overflow).
                    // stdout/stderr are merged to preserve interleaving.
                    use tokio::io::AsyncReadExt as _;
                    fn pipe_reader<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
                        mut stream: R,
                        tx: tokio::sync::mpsc::Sender<Vec<u8>>,
                    ) {
                        tokio::spawn(async move {
                            let mut buf = [0u8; 8192];
                            loop {
                                match stream.read(&mut buf).await {
                                    Ok(0) | Err(_) => break,
                                    Ok(n) => { if tx.send(buf[..n].to_vec()).await.is_err() { break; } }
                                }
                            }
                        });
                    }
                    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
                    pipe_reader(child.stdout.take().unwrap(), tx.clone());
                    pipe_reader(child.stderr.take().unwrap(), tx.clone());
                    drop(tx); // main loop is the last receiver

                    const MAX_LOCAL_BYTES: usize = 1_048_576; // 1 MB tail cap
                    let mut captured: Vec<u8> = Vec::new();
                    let mut truncated = false;
                    let mut timed_out = false;
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
                    loop {
                        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                        tokio::select! {
                            chunk = rx.recv() => {
                                if let Some(c) = chunk {
                                    if captured.len() + c.len() > MAX_LOCAL_BYTES {
                                        let keep = MAX_LOCAL_BYTES / 2;
                                        if captured.len() > keep {
                                            captured.drain(..captured.len() - keep);
                                        }
                                        truncated = true;
                                    }
                                    captured.extend_from_slice(&c);
                                    if captured.len() > MAX_LOCAL_BYTES {
                                        captured.drain(..captured.len() - MAX_LOCAL_BYTES);
                                        truncated = true;
                                    }
                                }
                                // None = both pipes closed — the child has no
                                // more output; fall through to the exit check.
                            }
                            _ = tokio::time::sleep(remaining) => {
                                timed_out = true;
                                break;
                            }
                        }
                        // Pipes can close while the child still runs (a
                        // daemonized grandchild holding them open is rare);
                        // the exit check is the authoritative done signal.
                        if rx.is_closed() {
                            if let Ok(Some(_)) = child.try_wait() { break; }
                        }
                    }

                    if timed_out {
                        // Graceful first, then SIGKILL (round-55): kill -9
                        // straight away left databases/build caches half
                        // written. Unix: SIGTERM to the process group;
                        // Windows: taskkill /T (graceful tree kill).
                        if child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
                            if let Some(pid) = pid {
                                let pid_str = pid.to_string();
                                #[cfg(unix)]
                                { let _ = tokio::process::Command::new("kill").args(["-15", "--", &format!("-{pid_str}")]).output().await; }
                                #[cfg(windows)]
                                { let _ = tokio::process::Command::new("taskkill").args(["/T", "/PID", &pid_str]).output().await; }
                            }
                            // Grace window: let the tree exit on its own.
                            let graceful = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                                loop {
                                    if child.try_wait().ok().flatten().is_some() { break; }
                                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                }
                            }).await;
                            if graceful.is_err() {
                                // Still alive — SIGKILL the tree.
                                if let Some(pid) = pid {
                                    let pid_str = pid.to_string();
                                    #[cfg(unix)]
                                    { let _ = tokio::process::Command::new("kill").args(["-9", "--", &format!("-{pid_str}")]).output().await; }
                                    #[cfg(windows)]
                                    { let _ = tokio::process::Command::new("taskkill").args(["/F", "/T", "/PID", &pid_str]).output().await; }
                                }
                                // Bounded re-await (round-55): a group stuck in
                                // D-state (uninterruptible IO) would hang the
                                // tool forever. Wait up to 5s, then return
                                // with the partial output either way.
                                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                                    loop {
                                        if child.try_wait().ok().flatten().is_some() { break; }
                                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                    }
                                }).await;
                            }
                        }
                        // Drain whatever the kill flushed out (bounded).
                        while let Ok(c) = rx.try_recv() {
                            if captured.len() + c.len() > MAX_LOCAL_BYTES {
                                captured.drain(..captured.len().saturating_sub(MAX_LOCAL_BYTES / 2));
                                truncated = true;
                            }
                            captured.extend_from_slice(&c);
                            if captured.len() > MAX_LOCAL_BYTES {
                                captured.drain(..captured.len() - MAX_LOCAL_BYTES);
                                truncated = true;
                            }
                        }
                    }
                    // Reap whatever exited (may be None if the group is stuck).
                    let exit_code = child.try_wait().ok().flatten().and_then(|s| s.code()).unwrap_or(-1);
                    let text = String::from_utf8_lossy(&captured);
                    let mut result = format!("Exit: {exit_code}\nOutput:\n{text}");
                    if timed_out {
                        // Explicit TIMEOUT marker: the output above is
                        // PARTIAL — the model must not read it as a complete
                        // result (round-54).
                        result.push_str(&format!("\nTIMEOUT: killed after {timeout_secs}s — output above is partial"));
                    }
                    if truncated {
                        result.push_str("\n[output truncated — tail only]");
                    }
                    // Strip ANSI/OSC noise for the model — the MCP text path
                    // must be printable text, the panel keeps raw bytes via
                    // its own SSE stream (round-54, dsh sanitize.ts).
                    let result = clean_terminal_output(result.as_bytes());
                    bus.emit(&AgentEvent::ShellExec { command });
                    Ok(json!(result))
                }
            }
        },
    )
}

fn tool_list_ports(serial_pool: &Arc<SerialPool>) -> ToolDef {
    let serial_pool = serial_pool.clone();
    ToolDef::new(
        "terminal_list_ports",
        "List available serial ports on this machine.",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            let serial_pool = serial_pool.clone();
            async move {
                // Device enumeration blocks — never on the executor
                let ports = tokio::task::spawn_blocking(move || serial_pool.list_ports())
                    .await
                    .map_err(|e| DeviceError::Internal {
                        message: format!("list ports task failed: {e}"),
                    })??;
                Ok(to_value_or_empty(&ports))
            }
        },
    )
}

fn tool_resize(terminal_mgr: &Arc<TerminalManager>) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    ToolDef::new(
        "terminal_resize",
        "Resize a terminal session (PTY or SSH). Updates rows and columns.",
        json!({"type":"object","properties":{"session_id":{"type":"string"},"rows":{"type":"integer"},"cols":{"type":"integer"}},"required":["session_id","rows","cols"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            async move {
                let session_id = require_str(&params, "session_id")?;
                let rows = params.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
                let cols = params.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
                terminal_mgr.term_resize(&session_id, rows, cols).await?;
                Ok(json!("OK"))
            }
        },
    )
}

fn tool_select(terminal_mgr: &Arc<TerminalManager>) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    ToolDef::new(
        "terminal_select",
        "Set the active terminal session.",
        json!({"type":"object","properties":{"session_id":{"type":"string"}},"required":["session_id"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            async move {
                let session_id = require_str(&params, "session_id")?;
                terminal_mgr.term_select(&session_id).await?;
                Ok(json!("OK"))
            }
        },
    )
}


// ── Output (read/screen) ────────────────────────────

fn tool_read(output_buf: &OutputBuf) -> ToolDef {
    let buf = output_buf.clone();
    ToolDef::new(
        "terminal_read",
        "Read buffered output from a terminal session. Non-destructive: uses a cursor so repeating the call without `offset` returns only new output since last read. `offset` is an ABSOLUTE byte offset into the session's byte stream (see `start`/`end` in the response); `offset: 0` re-reads from the beginning. Reads work on closed sessions (retained history). ANSI escapes are stripped and line endings normalized by default (AI-readable); pass `clean: false` for raw bytes.",
        json!({"type":"object","properties":{"session_id":{"type":"string"},"offset":{"type":"integer","description":"ABSOLUTE byte offset to start reading from. 0 = beginning. Default = last cursor position."},"clean":{"type":"boolean","description":"Strip ANSI escapes and normalize \\r\\n → \\n. Default true (round-54: the MCP text path must be printable text; the panel uses its own raw SSE stream)."}},"required":["session_id"]}),
        move |params: Value| {
            let buf = buf.clone();
            async move {
                let session_id = require_str(&params, "session_id")?;
                let (text, start, end, dropped, spilled) = {
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
                        let mut raw = if spilled {
                            read_spill(&session_id, offset, in_mem_start)
                        } else {
                            Vec::new()
                        };
                        let rel = offset.saturating_sub(in_mem_start).min(entry.data.len());
                        raw.extend_from_slice(&entry.data[rel..]);
                        let text = if clean {
                            clean_terminal_output(&raw)
                        } else {
                            String::from_utf8_lossy(&raw).to_string()
                        };
                        (text, offset, entry.end_abs(), entry.dropped, spilled)
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
                if dropped > 0 {
                    out["dropped"] = json!(dropped);
                }
                if spilled {
                    out["spill"] = json!(spill_path(&session_id).to_string_lossy());
                }
                Ok(out)
            }
        },
    )
}

fn tool_screen(output_buf: &OutputBuf) -> ToolDef {
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
                            // Tail: find the start of the Nth-from-end line.
                            let data = &entry.data;
                            // Skip trailing blank lines (`\r\n`/`\n` at the end of
                            // the buffer) so the Nth-from-end scan counts content
                            // lines, not an empty tail — otherwise screen came back
                            // blank whenever the buffer ended in a newline.
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
                            (clean_terminal_output(&data[start..end]), entry.dropped)
                        }
                        None => (String::new(), 0u64),
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

fn tool_diag_write(diag: &DiagStore) -> ToolDef {
    let diag = diag.clone();
    ToolDef::new(
        "terminal_diag_write",
        "POST a diagnostic line from the terminal panel (poll results, adopt events, SSE status, errors). Stored in a process-lifetime ring buffer (cap 200), read via terminal_diag_read.",
        json!({"type":"object","properties":{"line":{"type":"string"}},"required":["line"]}),
        move |params: Value| {
            let diag = diag.clone();
            async move {
                let line = require_str(&params, "line")?;
                let mut d = recover_guard(&diag);
                d.push(format!("{} {line}", chrono_timestamp()));
                Ok(json!("ok"))
            }
        },
    )
}

fn tool_diag_read(diag: &DiagStore) -> ToolDef {
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


// ── Secrets (keychain) ─────────────────────────────

fn tool_secret_set() -> ToolDef {
    ToolDef::new(
        "secret_set",
        "Store a secret (SSH password) in the OS keychain for a target host. Desktop only.",
        json!({"type":"object","properties":{"target":{"type":"string","description":"SSH target (user@host:port)"},"password":{"type":"string"}},"required":["target","password"]}),
        move |params: Value| async move {
            let target = require_str(&params, "target")?;
            let password = require_str(&params, "password")?;
            crate::tools::terminal::secret_set(&target, &password)?;
            Ok(json!("stored"))
        },
    )
}

fn tool_secret_get() -> ToolDef {
    ToolDef::new(
        "secret_get",
        "Retrieve a stored secret for a target host. Returns the password or null.",
        json!({"type":"object","properties":{"target":{"type":"string"}},"required":["target"]}),
        move |params: Value| async move {
            let target = require_str(&params, "target")?;
            match crate::tools::terminal::secret_get(&target)? {
                Some(pwd) => Ok(json!({"password": pwd})),
                None => Ok(json!({"password": serde_json::Value::Null})),
            }
        },
    )
}

fn tool_secret_delete() -> ToolDef {
    ToolDef::new(
        "secret_delete",
        "Delete a stored secret for a target host.",
        json!({"type":"object","properties":{"target":{"type":"string"}},"required":["target"]}),
        move |params: Value| async move {
            let target = require_str(&params, "target")?;
            crate::tools::terminal::secret_delete(&target)?;
            Ok(json!("deleted"))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::terminal::{DiagBuf, SessionStore};
    use crate::tools::serial::SerialPool;
    use crate::tools::terminal::TerminalManager;
    use vale_agent_core::AppEventBus;

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
        let tools = build(&mgr, &serial, &bus, &buf, &diag, &logger);
        (tools, buf)
    }

    fn find<'a>(tools: &'a [ToolDef], name: &str) -> &'a ToolDef {
        tools.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("missing tool: {name}"))
    }

    async fn call(tool: &ToolDef, params: serde_json::Value) -> serde_json::Value {
        tool.handler.call(params).await.expect("handler should not error")
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
        assert!(out.get("dropped").is_none(), "no dropped when nothing evicted");
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
        let out = call(find(&tools, "terminal_screen"), json!({"session_id": "s1", "lines": 3})).await;
        assert_eq!(out["screen"], "line-7\nline-8\nline-9");
    }

    #[tokio::test]
    async fn screen_skips_trailing_blank_lines() {
        // Regression for the "blank screen" bug: a buffer ending in \r\n (or \n)
        // must not collapse the tail scan — the Nth-from-end scan counts content
        // lines, so screen must return real content even with a trailing newline.
        let (tools, buf) = seeded_tools();
        seed(&buf, "s1", b"hello\r\nworld\r\n", 0);
        let out = call(find(&tools, "terminal_screen"), json!({"session_id": "s1", "lines": 5})).await;
        assert_eq!(out["screen"], "hello\nworld");
    }

    #[tokio::test]
    async fn screen_lines_exceeds_buffer_returns_all() {
        let (tools, buf) = seeded_tools();
        seed(&buf, "s1", b"a\nb\nc", 0);
        let out = call(find(&tools, "terminal_screen"), json!({"session_id": "s1", "lines": 100})).await;
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
    async fn screen_utf8_chinese_survives() {
        let (tools, buf) = seeded_tools();
        seed(&buf, "s1", "你好世界\n第二行".as_bytes(), 0);
        let out = call(find(&tools, "terminal_screen"), json!({"session_id": "s1", "lines": 10})).await;
        assert_eq!(out["screen"], "你好世界\n第二行");
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
        let out = call(find(&tools, "terminal_read"), json!({"session_id": "s1", "offset": 0})).await;
        assert_eq!(out["text"], "abc");
    }

    #[tokio::test]
    async fn read_explicit_offset_slices() {
        let (tools, buf) = seeded_tools();
        seed(&buf, "s1", b"hello world", 0);
        let out = call(find(&tools, "terminal_read"), json!({"session_id": "s1", "offset": 6})).await;
        assert_eq!(out["text"], "world");
    }

    #[tokio::test]
    async fn read_clean_strips_ansi() {
        let (tools, buf) = seeded_tools();
        seed(&buf, "s1", b"\x1b[31mred\x1b[0m", 0);
        let out = call(find(&tools, "terminal_read"), json!({"session_id": "s1", "clean": true})).await;
        assert_eq!(out["text"], "red");
    }

    #[tokio::test]
    async fn read_unknown_session_empty() {
        let (tools, _buf) = seeded_tools();
        let out = call(find(&tools, "terminal_read"), json!({"session_id": "missing"})).await;
        assert_eq!(out["text"], "");
    }

    // ── terminal_read: absolute offsets + start/end + history ────

    #[tokio::test]
    async fn read_reports_start_end_spans() {
        let (tools, buf) = seeded_tools();
        seed(&buf, "s1", b"hello world", 0);
        let out = call(find(&tools, "terminal_read"), json!({"session_id": "s1", "offset": 0})).await;
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
        let out = call(find(&tools, "terminal_read"), json!({"session_id": "s1", "offset": 6})).await;
        assert_eq!(out["text"], "hello world");
        assert_eq!(out["start"], 6);
        assert_eq!(out["end"], 21);
    }

    #[tokio::test]
    async fn read_merges_spill_and_memory() {
        let (tools, buf) = seeded_tools();
        seed(&buf, "s1", b"tail", 10); // 10 bytes evicted, memory holds "tail"
        // Write the evicted head to the spill file the way the drainer does.
        use std::io::Write;
        let p = spill_path("s1");
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(b"0123456789").unwrap();
        // offset 6 → spill [6,10) = "6789" + memory "tail" = "6789tail";
        // end_abs = dropped(10) + memory(4) = 14.
        let out = call(find(&tools, "terminal_read"), json!({"session_id": "s1", "offset": 6, "clean": false})).await;
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
        buf.lock().unwrap().retain_live("s1", "serial", "COM4");
        let out = call(find(&tools, "terminal_read"), json!({"session_id": "s1", "offset": 0})).await;
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
        buf.lock().unwrap().retain_live("s1", "pty", "shell");
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
        buf.lock().unwrap().retain_live("s1", "ssh", "admin@host");
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

    // ── SessionStore caps + idempotent retain ────────────────────

    #[test]
    fn retain_evicts_oldest_beyond_session_cap() {
        let mut store = SessionStore::with_caps(2, 10_000_000);
        for i in 0..3 {
            store.live.entry(format!("s{i}")).or_default().data.extend_from_slice(b"x");
            store.retain_live(&format!("s{i}"), "pty", "shell");
        }
        // Cap 2 → oldest (s0) evicted.
        assert!(!store.history.contains_key("s0"), "s0 should be evicted");
        assert!(store.history.contains_key("s1") && store.history.contains_key("s2"));
    }

    #[test]
    fn retain_evicts_oldest_beyond_byte_cap() {
        let mut store = SessionStore::with_caps(10, 3); // 3 bytes total cap
        for i in 0..3 {
            store.live.entry(format!("s{i}")).or_default().data.extend_from_slice(b"xx");
            store.retain_live(&format!("s{i}"), "pty", "shell");
        }
        // Total bytes exceed 3 → evict oldest until under. s0 (2B) evicted first.
        let total: u64 = store.history.values().map(|h| h.buf.end_abs() as u64).sum();
        assert!(total <= 3, "history bytes {total} exceed cap");
    }

    #[test]
    fn retain_idempotent_second_call_false() {
        let mut store = SessionStore::new();
        store.live.entry("s1".into()).or_default().data.extend_from_slice(b"hi");
        assert!(store.retain_live("s1", "pty", "shell"), "first retain moves it");
        assert!(!store.retain_live("s1", "pty", "shell"), "second retain is a no-op");
    }

    #[tokio::test]
    async fn read_requires_session_id() {
        let (tools, _buf) = seeded_tools();
        let tool = find(&tools, "terminal_read");
        let err = tool.handler.call(json!({})).await.unwrap_err();
        assert!(err.to_string().contains("missing required field"), "unexpected: {err}");
    }

    // ── terminal_execute (dispatch) ─────────────────────────────

    #[tokio::test]
    async fn execute_requires_command() {
        let (tools, _buf) = seeded_tools();
        let tool = find(&tools, "terminal_execute");
        let err = tool.handler.call(json!({})).await.unwrap_err();
        assert!(err.to_string().contains("missing required field"), "unexpected: {err}");
    }

    #[tokio::test]
    async fn execute_local_shell_mode_runs_on_stub() {
        // Headless (no `terminal` feature): the local-shell mode uses tokio::process
        // and must work — the stub only affects terminal_open/write/resize.
        let (tools, _buf) = seeded_tools();
        let out = call(find(&tools, "terminal_execute"), json!({"command": "echo stub-ok"})).await;
        let text = out.as_str().unwrap_or_default();
        assert!(text.contains("stub-ok"), "expected echo output in result, got: {text}");
    }

    #[tokio::test]
    async fn execute_session_mode_missing_session_errors() {
        // Writing to a session that doesn't exist must return an Err (not panic
        // or hang). The exact message differs by backend (stub: "backend not
        // enabled"; real: "session not found") — only assert it errors.
        let (tools, _buf) = seeded_tools();
        let tool = find(&tools, "terminal_execute");
        let err = tool.handler.call(json!({"command": "echo hi", "session_id": "nope"})).await.unwrap_err();
        assert!(!err.to_string().is_empty(), "expected a DeviceError, got empty");
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
    fn append_newline_windows_uses_crlf() {
        // On Windows, PowerShell needs \r\n to end a command — a bare \n would
        // drop it into the continuation prompt (>>) and never execute.
        if cfg!(target_os = "windows") {
            assert_eq!(append_command_newline("echo hi"), "echo hi\r\n");
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
        assert_eq!(clean_terminal_output(b"\x1b]0;user@host: ~\x07prompt$ "), "prompt$ ");
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
        assert_eq!(clean_terminal_output(input), "zhengsaisi@61-83:~$ echo hi\nhi");
    }

    #[test]
    fn clean_crlf_mixed_with_ansi() {
        assert_eq!(
            clean_terminal_output(b"a\r\x1b[Kb\r\nc\rd"),
            "a\nb\nc\nd"
        );
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
        let (start, end, code) = super::find_prompt_marker(data).unwrap();
        assert_eq!(code, 0);
        assert_eq!(&data[start..end], b"\x1b]133;D;0\x07");
    }

    #[test]
    fn marker_with_nonzero_exit() {
        let data = b"\x1b]133;D;127\x07";
        let (start, end, code) = super::find_prompt_marker(data).unwrap();
        assert_eq!(code, 127);
        assert_eq!(&data[start..end], b"\x1b]133;D;127\x07");
    }

    #[test]
    fn marker_prefix_incomplete_returns_none() {
        // Prefix split across chunks: digits and BEL not there yet.
        assert_eq!(super::find_prompt_marker(b"\x1b]133;D;"), None);
        assert_eq!(super::find_prompt_marker(b"ok\n\x1b]133;D;0"), None);
        assert_eq!(super::find_prompt_marker(b"x\x1b]133;D;"), None);
    }

    #[test]
    fn marker_complete_wins_over_trailing_incomplete() {
        // A complete marker is found even when an incomplete prefix follows
        // (the scanner is position-independent; the caller drains the whole
        // marker and re-scans, so the trailing prefix stays pending).
        let data = b"\x1b]133;D;0\x07x\x1b]133;D;";
        let (start, end, code) = super::find_prompt_marker(data).unwrap();
        assert_eq!(code, 0);
        assert_eq!(&data[start..end], b"\x1b]133;D;0\x07");
    }

    #[test]
    fn marker_not_found_in_plain_output() {
        // ANSI colors and OSC titles do not match the 133;D; prefix.
        assert_eq!(super::find_prompt_marker(b"hello world\n"), None);
        assert_eq!(super::find_prompt_marker(b"\x1b[01;32mok\x1b[00m\n"), None);
        assert_eq!(super::find_prompt_marker(b"\x1b]0;title\x07"), None);
    }

    #[test]
    fn marker_found_with_text_after() {
        // Marker then more prompt text — only the sequence is returned.
        let data = b"done\x1b]133;D;3\x07user@host:~$ ";
        let (start, end, code) = super::find_prompt_marker(data).unwrap();
        assert_eq!(code, 3);
        assert_eq!(&data[start..end], b"\x1b]133;D;3\x07");
    }
}
