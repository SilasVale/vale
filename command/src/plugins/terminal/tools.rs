//! Per-tool builders — one fn per MCP tool, built once at registration.
//!
//! The closures capture clones of the shared context (managers, bus, buffer),
//! so the tool list is built a single time by `PluginRegistry::register` and
//! reused for MCP list_tools and the web /api/spec endpoint alike.

use std::sync::Arc;
use std::time::Instant;
use serde_json::{json, Value};

use vale_command_core::{AgentEvent, DeviceError, EventBus, ToolDef};
use crate::plugins::{require_str, to_value_or_empty};
use crate::tools::serial::SerialPool;
use crate::tools::terminal::{parse_serial_target, parse_ssh_target, TerminalManager};
use super::{clean_terminal_output, OutputBuf};

pub(super) fn build(
    terminal_mgr: &Arc<TerminalManager>,
    serial_pool: &Arc<SerialPool>,
    bus: &Arc<dyn EventBus>,
    output_buf: &OutputBuf,
) -> Vec<ToolDef> {
    vec![
        tool_open(terminal_mgr, bus, output_buf),
        tool_write(terminal_mgr),
        tool_close(terminal_mgr, bus, output_buf),
        tool_list(terminal_mgr),
        tool_execute(terminal_mgr, bus, output_buf),
        tool_list_ports(serial_pool),
        tool_resize(terminal_mgr),
        tool_select(terminal_mgr),
        tool_read(output_buf),
        tool_screen(output_buf),
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
                tokio::spawn(async move {
                    let mut rx = _rx;
                    while let Some(output) = rx.recv().await {
                        // Poison recovery — dropping buffered output on a poisoned
                        // lock would silently lose terminal data.
                        let mut map = buf.lock().unwrap_or_else(|p| p.into_inner());
                        let entry = map.entry(sid_buf.clone()).or_default();
                        entry.data.extend_from_slice(&output.data);
                        // Cap at 1 MB — evict oldest half if exceeded
                        if entry.data.len() > MAX_BUF_BYTES {
                            let remove = entry.data.len() - MAX_BUF_BYTES / 2;
                            entry.data.drain(..remove);
                            entry.cursor = entry.cursor.saturating_sub(remove);
                            entry.dropped += remove as u64;
                        }
                        drop(map);
                        if let Ok(v) = serde_json::to_value(&output) {
                            bus2.emit_term_output(v);
                        }
                    }
                    // Session ended — release the buffer (terminal_close also
                    // removes it; whichever runs second is a no-op).
                    buf.lock().unwrap_or_else(|p| p.into_inner()).remove(&sid_buf);
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
        "Write data to a terminal session.",
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
                let kind = terminal_mgr.term_close(&session_id).await;
                // Release the session's output buffer (the drainer's own
                // cleanup on channel close is a no-op if it ran first).
                if let Ok(mut map) = buf.lock() {
                    map.remove(&session_id);
                }
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
                        .get(&sid).map(|e| e.end_abs()).unwrap_or(0);
                    // Write command + newline
                    let cmd_with_nl = if command.ends_with('\n') {
                        command.clone()
                    } else {
                        format!("{}\n", command)
                    };
                    terminal_mgr.term_write(&sid, &cmd_with_nl).await?;

                    let deadline = Instant::now() + std::time::Duration::from_secs(timeout_secs);
                    let quiet_dur = std::time::Duration::from_millis(quiet_ms);
                    let mut quiet_since: Option<Instant> = None;
                    let mut result = String::new();

                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        let (chunk, chunk_len) = buf.lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .get(&sid)
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
        "Read buffered output from a terminal session. Non-destructive: uses a cursor so repeating the call without `offset` returns only new output since last read. Use `offset: 0` to re-read from the beginning. Set `clean: true` to strip ANSI escapes and normalize line endings for AI readability.",
        json!({"type":"object","properties":{"session_id":{"type":"string"},"offset":{"type":"integer","description":"Byte offset to start reading from. 0 = beginning. Default = last cursor position."},"clean":{"type":"boolean","description":"Strip ANSI escapes and normalize \\r\\n → \\n. Default false."}},"required":["session_id"]}),
        move |params: Value| {
            let buf = buf.clone();
            async move {
                let session_id = require_str(&params, "session_id")?;
                let (text, dropped) = {
                    let mut map = buf.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(entry) = map.get_mut(&session_id) {
                        let offset = params.get("offset")
                            .and_then(|v| v.as_u64())
                            .map(|o| o as usize)
                            .unwrap_or(entry.cursor);
                        let offset = offset.min(entry.data.len());
                        let raw = &entry.data[offset..];
                        let clean = params.get("clean")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        let text = if clean {
                            clean_terminal_output(raw)
                        } else {
                            String::from_utf8_lossy(raw).to_string()
                        };
                        // Advance cursor only when no explicit offset was given
                        if params.get("offset").is_none() {
                            entry.cursor = entry.data.len();
                        }
                        (text, entry.dropped)
                    } else {
                        (String::new(), 0u64)
                    }
                };
                if dropped > 0 {
                    Ok(json!({"text": text, "dropped": dropped}))
                } else {
                    Ok(json!({"text": text}))
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
                    let mut map = buf.lock().unwrap_or_else(|p| p.into_inner());
                    let entry = map.get_mut(&session_id);
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
    use crate::tools::serial::SerialPool;
    use crate::tools::terminal::TerminalManager;
    use std::collections::HashMap;
    use vale_command_core::AppEventBus;

    /// Build the tool list with a caller-controlled output buffer so tests can
    /// pre-seed session output and exercise terminal_read / terminal_screen.
    fn seeded_tools() -> (Vec<ToolDef>, OutputBuf) {
        let bus: Arc<dyn EventBus> = Arc::new(AppEventBus::new());
        let serial = Arc::new(SerialPool::new(115200, 1000));
        let mgr = Arc::new(TerminalManager::new(serial.clone()));
        let buf: OutputBuf = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let tools = build(&mgr, &serial, &bus, &buf);
        (tools, buf)
    }

    fn find<'a>(tools: &'a [ToolDef], name: &str) -> &'a ToolDef {
        tools.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("missing tool: {name}"))
    }

    async fn call(tool: &ToolDef, params: serde_json::Value) -> serde_json::Value {
        tool.handler.call(params).await.expect("handler should not error")
    }

    fn seed(buf: &OutputBuf, sid: &str, data: &[u8], dropped: u64) {
        let mut map = buf.lock().unwrap_or_else(|p| p.into_inner());
        let entry = map.entry(sid.to_string()).or_default();
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

    // ── clean_terminal_output (edge cases) ──────────────────────

    #[test]
    fn clean_unterminated_csi_absorbed() {
        // An unterminated CSI (no final byte) must not hang or panic — it's
        // skipped conservatively.
        assert_eq!(clean_terminal_output(b"\x1b[31mred"), "red");
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
