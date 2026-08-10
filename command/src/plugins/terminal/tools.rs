//! Per-tool builders — one fn per MCP tool, built once at registration.
//!
//! The closures capture clones of the shared context (managers, bus, buffer),
//! so the tool list is built a single time by `PluginRegistry::register` and
//! reused for MCP list_tools and the web /api/spec endpoint alike.

use std::sync::Arc;
use std::time::Instant;
use serde_json::{json, Value};

use vale_agent_core::{AgentEvent, DeviceError, EventBus, ToolDef};
use crate::plugins::{require_str, to_value_or_empty};
use crate::tools::serial::SerialPool;
use crate::tools::terminal::{parse_serial_target, parse_ssh_target, TerminalManager};
use super::{clean_terminal_output, DiagStore, OutputBuf, RetainedSession};

pub(super) fn build(
    terminal_mgr: &Arc<TerminalManager>,
    serial_pool: &Arc<SerialPool>,
    bus: &Arc<dyn EventBus>,
    output_buf: &OutputBuf,
    diag: &DiagStore,
) -> Vec<ToolDef> {
    vec![
        tool_open(terminal_mgr, bus, output_buf),
        tool_write(terminal_mgr),
        tool_close(terminal_mgr, bus, output_buf),
        tool_list(terminal_mgr),
        tool_history(terminal_mgr, output_buf),
        tool_execute(terminal_mgr, bus, output_buf),
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
) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    let bus = bus.clone();
    let buf = output_buf.clone();
    ToolDef::new(
        "terminal_open",
        "Open a terminal connection. Kind: 'pty' (local shell; target optional — blank = default shell), 'ssh' (target=user@host:port), or 'serial' (target=port_name, optional ?baud=N e.g. /dev/ttyUSB0?baud=115200, default 115200). Returns session ID.",
        json!({"type":"object","properties":{"kind":{"type":"string","enum":["pty","ssh","serial"]},"target":{"type":"string"},"password":{"type":"string"},"rows":{"type":"integer","description":"Initial terminal rows. Default 0 (backend default)."},"cols":{"type":"integer","description":"Initial terminal columns. Default 0 (backend default)."}},"required":["kind","target"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            let bus = bus.clone();
            let buf = buf.clone();
            async move {
                let kind = require_str(&params, "kind")?;
                let target = require_str(&params, "target")?;
                let password = params.get("password").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let rows = params.get("rows").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                let cols = params.get("cols").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                let req = crate::tools::terminal::TermOpenRequest {
                    kind: kind.clone(),
                    target: target.clone(),
                    password,
                    rows,
                    cols,
                };
                let (id, _rx) = terminal_mgr.term_open(&req).await?;
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
                        // Poison recovery — dropping buffered output on a poisoned
                        // lock would silently lose terminal data.
                        let mut store = buf.lock().unwrap_or_else(|p| p.into_inner());
                        let entry = store.live.entry(sid_buf.clone()).or_default();
                        entry.data.extend_from_slice(&output.data);
                        // Cap at 1 MB — evict oldest half if exceeded
                        if entry.data.len() > MAX_BUF_BYTES {
                            let remove = entry.data.len() - MAX_BUF_BYTES / 2;
                            entry.data.drain(..remove);
                            entry.cursor = entry.cursor.saturating_sub(remove);
                            entry.dropped += remove as u64;
                        }
                        drop(store);
                        if let Ok(v) = serde_json::to_value(&output) {
                            bus2.emit_term_output(v);
                        }
                    }
                    // Session ended — retain the buffer in history instead of
                    // dropping it (terminal_close also retains; whichever runs
                    // second is a no-op).
                    buf.lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .retain_live(&sid_buf, &kind, &label);
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
        "Write raw data to a terminal session. Sends bytes exactly as given. For shell commands on Unix devices (serial/ssh to Linux), the command must end with a newline (\\n) — otherwise the shell joins it with whatever is typed next, mangling both. For Windows PowerShell use \\r\\n. Control characters (e.g. \\u0003 for Ctrl+C) are sent verbatim and need no newline.",
        json!({"type":"object","properties":{"session_id":{"type":"string"},"data":{"type":"string"}},"required":["session_id","data"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            async move {
                let session_id = require_str(&params, "session_id")?;
                let data = require_str(&params, "data")?;
                terminal_mgr.term_write(&session_id, &data).await?;
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
                // Capture metadata before close, then close.
                let meta = terminal_mgr.term_info(&session_id).await;
                let kind = terminal_mgr.term_close(&session_id).await;
                // Retain the session's output in history instead of deleting
                // it (the drainer's own retain on channel close is a no-op if
                // it ran first — retain_live is idempotent).
                let label = meta.as_ref().map(|m| m.label.clone()).unwrap_or_default();
                let kind_ref = kind.as_deref().unwrap_or("pty");
                buf.lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .retain_live(&session_id, kind_ref, &label);
                if let Some(k) = kind {
                    match k.as_str() {
                        "ssh" => bus.emit(&AgentEvent::SshDisconnect { session_id: session_id.clone() }),
                        "serial" => bus.emit(&AgentEvent::SerialClose { port_id: session_id.clone() }),
                        _ => bus.emit(&AgentEvent::TermClose { session_id: session_id.clone() }),
                    };
                }
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
                let store = buf.lock().unwrap_or_else(|p| p.into_inner());
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

fn tool_execute(terminal_mgr: &Arc<TerminalManager>, bus: &Arc<dyn EventBus>, output_buf: &OutputBuf) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    let buf = output_buf.clone();
    let bus = bus.clone();
    ToolDef::new(
        "terminal_execute",
        "Run a command. If `session_id` is given, writes the command to that session and waits for output (quiet-period detection). Otherwise spawns a local shell with enforced timeout. Returns stdout, stderr, exit code (local) or accumulated terminal output (session).",
        json!({"type":"object","properties":{"command":{"type":"string"},"session_id":{"type":"string","description":"Optional: execute in an existing terminal session."},"timeout_secs":{"type":"integer","description":"Max wait time in seconds. Default 30."},"quiet_ms":{"type":"integer","description":"(Session mode) Quiet period in ms before considering output complete. Default 200."}},"required":["command"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            let buf = buf.clone();
            let bus = bus.clone();
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
                    let mut read_abs = buf.lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .live.get(&sid).map(|e| e.end_abs()).unwrap_or(0);
                    // Write command + newline. Windows PowerShell only recognizes
                    // the end of a command on CRLF (\r\n) — a bare \n drops it
                    // into the multi-line continuation prompt (>>), so the
                    // command never executes. Unix shells accept either.
                    let cmd_with_nl = append_command_newline(&command);
                    terminal_mgr.term_write(&sid, &cmd_with_nl).await?;

                    let deadline = Instant::now() + std::time::Duration::from_secs(timeout_secs);
                    let quiet_dur = std::time::Duration::from_millis(quiet_ms);
                    let mut quiet_since: Option<Instant> = None;
                    let mut result = String::new();

                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        let (chunk, chunk_len) = buf.lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .live.get(&sid)
                            .map(|e| {
                                let s = e.slice_from(read_abs);
                                (String::from_utf8_lossy(s).to_string(), s.len())
                            })
                            .unwrap_or_default();
                        if !chunk.is_empty() {
                            result.push_str(&chunk);
                            read_abs += chunk_len;
                            quiet_since = None;
                        } else if quiet_since.is_none() {
                            quiet_since = Some(Instant::now());
                        }
                        if let Some(qs) = quiet_since {
                            if qs.elapsed() >= quiet_dur {
                                break;
                            }
                        }
                        if Instant::now() >= deadline {
                            break;
                        }
                    }
                    bus.emit(&AgentEvent::ShellExec { command });
                    Ok(json!({"text": result}))
                } else {
                    // ── Local shell mode with enforced timeout (tokio::process) ──
                    let (shell, flag) = if cfg!(target_os = "windows") {
                        ("cmd", "/C")
                    } else {
                        ("sh", "-c")
                    };
                    let child = tokio::process::Command::new(shell)
                        .arg(flag)
                        .arg(&command)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .spawn()
                        .map_err(|e| DeviceError::Internal {
                            message: format!("spawn failed: {e}"),
                        })?;
                    // Snapshot PID before consuming child in wait_with_output
                    let pid = child.id();
                    let output = tokio::select! {
                        result = child.wait_with_output() => result,
                        _ = tokio::time::sleep(std::time::Duration::from_secs(timeout_secs)) => {
                            // Kill the process tree by PID (async — no executor blocking)
                            if let Some(pid) = pid {
                                let pid_str = pid.to_string();
                                #[cfg(unix)]
                                { let _ = tokio::process::Command::new("kill").arg("-9").arg(&pid_str).output().await; }
                                #[cfg(windows)]
                                { let _ = tokio::process::Command::new("taskkill").args(["/F", "/PID", &pid_str]).output().await; }
                            }
                            return Err(DeviceError::Internal {
                                message: format!("command timed out after {timeout_secs}s"),
                            });
                        }
                    }
                    .map_err(|e| DeviceError::Internal {
                        message: format!("exec failed: {e}"),
                    })?;
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let exit_code = output.status.code().unwrap_or(-1);
                    let result = format!("Exit: {exit_code}\nStdout:\n{stdout}\nStderr:\n{stderr}");
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

fn tool_read(output_buf: &OutputBuf) -> ToolDef {
    let buf = output_buf.clone();
    ToolDef::new(
        "terminal_read",
        "Read buffered output from a terminal session. Non-destructive: uses a cursor so repeating the call without `offset` returns only new output since last read. `offset` is an ABSOLUTE byte offset into the session's byte stream (see `start`/`end` in the response); `offset: 0` re-reads from the beginning. Reads work on closed sessions (retained history). Set `clean: true` to strip ANSI escapes and normalize line endings for AI readability.",
        json!({"type":"object","properties":{"session_id":{"type":"string"},"offset":{"type":"integer","description":"ABSOLUTE byte offset to start reading from. 0 = beginning. Default = last cursor position."},"clean":{"type":"boolean","description":"Strip ANSI escapes and normalize \\r\\n → \\n. Default false."}},"required":["session_id"]}),
        move |params: Value| {
            let buf = buf.clone();
            async move {
                let session_id = require_str(&params, "session_id")?;
                let (text, start, end, dropped) = {
                    let mut store = buf.lock().unwrap_or_else(|p| p.into_inner());
                    // Live session, or retained history (closed).
                    let explicit_offset = params.get("offset").is_some();
                    let offset = params.get("offset").and_then(|v| v.as_u64()).map(|o| o as usize);
                    let clean = params.get("clean").and_then(|v| v.as_bool()).unwrap_or(false);
                    match store.live.get_mut(&session_id) {
                        Some(entry) => {
                            let offset = offset.unwrap_or(entry.cursor);
                            let rel = offset.saturating_sub(entry.dropped as usize).min(entry.data.len());
                            let start = entry.dropped as usize + rel;
                            let end = entry.end_abs();
                            let raw = &entry.data[rel..];
                            let text = if clean {
                                clean_terminal_output(raw)
                            } else {
                                String::from_utf8_lossy(raw).to_string()
                            };
                            // Advance cursor only when no explicit offset was given
                            if !explicit_offset {
                                entry.cursor = entry.data.len();
                            }
                            (text, start, end, entry.dropped)
                        }
                        None => match store.history.get(&session_id) {
                            Some(h) => {
                                let entry = &h.buf;
                                let offset = offset.unwrap_or(entry.cursor);
                                let rel = offset.saturating_sub(entry.dropped as usize).min(entry.data.len());
                                let start = entry.dropped as usize + rel;
                                let end = entry.end_abs();
                                let raw = &entry.data[rel..];
                                let text = if clean {
                                    clean_terminal_output(raw)
                                } else {
                                    String::from_utf8_lossy(raw).to_string()
                                };
                                // History reads never advance any cursor.
                                (text, start, end, entry.dropped)
                            }
                            None => (String::new(), 0usize, 0usize, 0u64),
                        },
                    }
                };
                if dropped > 0 {
                    Ok(json!({"text": text, "start": start, "end": end, "dropped": dropped}))
                } else {
                    Ok(json!({"text": text, "start": start, "end": end}))
                }
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
                    let mut store = buf.lock().unwrap_or_else(|p| p.into_inner());
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
                let mut d = diag.lock().unwrap_or_else(|p| p.into_inner());
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
                let d = diag.lock().unwrap_or_else(|p| p.into_inner());
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
        let tools = build(&mgr, &serial, &bus, &buf, &diag);
        (tools, buf)
    }

    fn find<'a>(tools: &'a [ToolDef], name: &str) -> &'a ToolDef {
        tools.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("missing tool: {name}"))
    }

    async fn call(tool: &ToolDef, params: serde_json::Value) -> serde_json::Value {
        tool.handler.call(params).await.expect("handler should not error")
    }

    fn seed(buf: &OutputBuf, sid: &str, data: &[u8], dropped: u64) {
        let mut store = buf.lock().unwrap_or_else(|p| p.into_inner());
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
        // offset 6 absolute → rel = 6-10 clamped to 0 → start 10, text whole.
        let out = call(find(&tools, "terminal_read"), json!({"session_id": "s1", "offset": 6})).await;
        assert_eq!(out["text"], "hello world");
        assert_eq!(out["start"], 10);
        assert_eq!(out["end"], 21);
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
}
