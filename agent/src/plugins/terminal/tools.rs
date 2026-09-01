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
use std::collections::HashMap;
use std::sync::OnceLock;

/// Background-job registry (refactor Phase 3): gives run_in_background
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
type JobsMap = std::sync::Arc<std::sync::Mutex<HashMap<String, JobInfo>>>;
fn jobs_map() -> JobsMap {
    static JOBS: OnceLock<JobsMap> = OnceLock::new();
    JOBS.get_or_init(|| std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()))).clone()
}

/// Sessions that existed before the last agent restart (Phase 4). PTYs die
/// with the process; keeping their metadata lets errors say "this session
/// existed before the restart" instead of a bare not-found. Capped at 128.
fn pre_restart_map() -> std::sync::Arc<std::sync::Mutex<HashMap<String, serde_json::Value>>> {
    static PRE: OnceLock<std::sync::Arc<std::sync::Mutex<HashMap<String, serde_json::Value>>>> =
        OnceLock::new();
    PRE.get_or_init(|| {
        let path = super::log_dir().join("sessions-pre-restart.json");
        let loaded: HashMap<String, serde_json::Value> = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        std::sync::Arc::new(std::sync::Mutex::new(loaded))
    }).clone()
}
fn persist_pre_restart(map: &HashMap<String, serde_json::Value>) {
    let path = super::log_dir().join("sessions-pre-restart.json");
    if let Ok(bytes) = serde_json::to_vec(map) {
        let _ = std::fs::write(path, bytes);
    }
}

/// Build the session-mode execute result JSON (round-157): a partial (idle)
/// return means the command is STILL RUNNING — the wait loop gave up on
/// output, not on the command. Models misread a bare partial as "commands
/// queuing up" and answered with retries and new sessions (d1: 321
/// idle-partials → 167 terminal_open). Surface the continuation contract
/// EXPLICITLY inside the text the model reads, plus a structured
/// `still_running` flag for future clients. Pure so the shape is unit-tested
/// without a real shell.
fn execute_result_json(
    state: &str,
    result: String,
    truncated: bool,
    timed_out: bool,
    wait_reason: &str,
    marker_code: Option<i32>,
    read_abs: usize,
) -> serde_json::Value {
    let mut final_text = result;
    let still_running = state == "partial";
    if still_running {
        final_text.push_str(
            "\n[note: the command is still running (wait_reason=idle; the shell produced no output for the quiet window). Read the rest with terminal_read(session_id, offset=read_from). Do NOT re-run the command and do NOT open a new session — its output will arrive in this session's buffer.]",
        );
    }
    json!({
        "kind": "session",
        "state": state,
        "text": final_text,
        "truncated": truncated,
        "timed_out": timed_out,
        "wait_reason": wait_reason,
        "exit_code": marker_code,
        "read_from": read_abs,
        "still_running": still_running,
    })
}

pub(super) fn build(
    terminal_mgr: &Arc<TerminalManager>,
    serial_pool: &Arc<SerialPool>,
    bus: &Arc<dyn EventBus>,
    output_buf: &OutputBuf,
    diag: &DiagStore,
    logger: &crate::session_log::SessionLogger,
    buffer_limit: &Arc<std::sync::atomic::AtomicUsize>,
) -> Vec<ToolDef> {
    let jobs: JobsMap = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut tools = vec![
        tool_open(terminal_mgr, bus, output_buf, logger, buffer_limit),
        tool_jobs(&jobs),
        tool_write(terminal_mgr),
        tool_close(terminal_mgr, bus, output_buf),
        tool_list(terminal_mgr),
        tool_history(terminal_mgr, output_buf),
        tool_execute(terminal_mgr, bus, output_buf, logger, &jobs),
        tool_list_ports(serial_pool),
        tool_resize(terminal_mgr),
        tool_select(terminal_mgr),
        tool_read(output_buf),
        tool_screen(output_buf),
        tool_diag_write(diag),
        tool_diag_read(diag),
        tool_saved_connections(),
        tool_connect_saved(terminal_mgr, bus, output_buf, logger, buffer_limit),
        tool_terminal_env(),
    ];
    // Secrets + SFTP: canonical names carry the `terminal_` prefix (stage-l
    // naming unification); the legacy unprefixed names stay as aliases so
    // existing AI clients keep working.
    tools.push(tool_secret_set("terminal_secret_set"));
    tools.push(tool_secret_set("secret_set"));
    tools.push(tool_secret_get("terminal_secret_get"));
    tools.push(tool_secret_get("secret_get"));
    tools.push(tool_secret_delete("terminal_secret_delete"));
    tools.push(tool_secret_delete("secret_delete"));
    tools.push(tool_sftp("terminal_sftp"));
    tools.push(tool_sftp("sftp"));
    tools
}

/// P4c: SFTP file operations over SSH — stateless one-shot transfers.
/// Each call connects (password or key), performs ONE op, and closes.
/// Ops: list (remote dir), upload (local file → remote, base64 data),
/// download (remote → local path on THIS device), delete, mkdir.
/// `name` selects the canonical (`terminal_sftp`) or legacy alias (`sftp`).
///
/// Feature-gating: the real implementation needs `crate::tools::ssh`, which
/// only exists under the `terminal` feature. Headless builds get a stub that
/// returns an explicit "backend not enabled" error (same contract as
/// terminal_open's stub path).
fn tool_sftp(name: &'static str) -> ToolDef {
    ToolDef::new(
        name,
        "SFTP file transfer over SSH (stateless one-shot): connect with host/user/password or key_path, perform ONE operation, close. Ops: 'list' (remote_path dir → names+attrs), 'upload' (data base64 → remote_path), 'download' (remote_path → local_path on this device), 'delete' (remote_path), 'mkdir' (remote_path). Returns result summary. For persistent browsing use a terminal ssh session.",
        json!({
            "type": "object",
            "properties": {
                "op": {"type": "string", "enum": ["list", "upload", "download", "delete", "mkdir"]},
                "host": {"type": "string", "description": "SSH host"},
                "user": {"type": "string", "description": "SSH username"},
                "port": {"type": "integer", "description": "SSH port (default 22)"},
                "password": {"type": "string", "description": "SSH password (or key passphrase)"},
                "key_path": {"type": "string", "description": "SSH private key path (optional)"},
                "remote_path": {"type": "string", "description": "Remote path (dir for list/mkdir, file for upload/download/delete)"},
                "local_path": {"type": "string", "description": "(download) Local destination path on this device"},
                "data": {"type": "string", "description": "(upload) File content as base64"}
            },
            "required": ["op", "host", "user", "remote_path"]
        }),
        sftp_handler(),
    )
}

/// The sftp handler closure — real SSH under `terminal`, explicit error stub
/// otherwise (the feature-gating rule: public tool paths identical in both
/// configs, only the backend differs).
fn sftp_handler() -> impl vale_agent_core::ToolHandler + 'static {
    move |params: Value| {
        // round-…: headless — silence the unused closure param.
        #[cfg(not(feature = "terminal"))]
        let _ = &params;
        #[cfg(feature = "terminal")]
        {
            async move {
                let op = require_str(&params, "op")?;
                let host = require_str(&params, "host")?;
                let user = require_str(&params, "user")?;
                let port = params.get("port").and_then(|v| v.as_u64()).unwrap_or(22) as u16;
                let password = params.get("password").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let key_path = params.get("key_path").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let remote_path = require_str(&params, "remote_path")?;
                let local_path = params.get("local_path").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let data_b64 = params.get("data").and_then(|v| v.as_str()).unwrap_or("").to_string();

                // Reuse the same connect+auth path as terminal ssh sessions.
                let session = crate::tools::ssh::SshSession::connect(
                    &host, port, &user,
                    if password.is_empty() { None } else { Some(&password) },
                    if key_path.is_empty() { None } else { Some(&key_path) },
                ).await?;
                let sftp = session.sftp_session().await?;

                let result = match op.as_str() {
                    "list" => {
                        let mut entries = Vec::new();
                        let rd = sftp.read_dir(&remote_path).await.map_err(|e| DeviceError::Internal { message: format!("sftp read_dir {remote_path}: {e}") })?;
                        for dir in rd {
                            entries.push(serde_json::json!({
                                "name": dir.file_name(),
                                "size": dir.metadata().len(),
                                "is_dir": dir.file_type().is_dir(),
                            }));
                        }
                        serde_json::json!({"entries": entries})
                    }
                    "upload" => {
                        let bytes = {
                            use base64::Engine;
                            base64::engine::general_purpose::STANDARD.decode(data_b64)
                                .map_err(|e| DeviceError::Internal { message: format!("base64 decode: {e}") })?
                        };
                        // create() opens with CREATE|TRUNCATE|WRITE — the
                        // high-level write() uses WRITE only and fails with
                        // NoSuchFile on a fresh remote path (P4c).
                        {
                            use tokio::io::AsyncWriteExt;
                            let mut file = sftp.create(&remote_path).await.map_err(|e| DeviceError::Internal { message: format!("sftp create {remote_path}: {e}") })?;
                            file.write_all(&bytes).await.map_err(|e| DeviceError::Internal { message: format!("sftp write: {e}") })?;
                            file.flush().await.map_err(|e| DeviceError::Internal { message: format!("sftp flush: {e}") })?;
                        }
                        serde_json::json!({"uploaded_bytes": bytes.len(), "remote_path": remote_path})
                    }
                    "download" => {
                        if local_path.is_empty() {
                            return Ok(to_value_or_empty(json!({"error": "local_path required for download"})));
                        }
                        let buf = sftp.read(&remote_path).await.map_err(|e| DeviceError::Internal { message: format!("sftp read {remote_path}: {e}") })?;
                        std::fs::write(&local_path, &buf).map_err(|e| DeviceError::Internal { message: format!("local write {local_path}: {e}") })?;
                        serde_json::json!({"downloaded_bytes": buf.len(), "local_path": local_path})
                    }
                    "delete" => {
                        sftp.remove_file(&remote_path).await.map_err(|e| DeviceError::Internal { message: format!("sftp remove {remote_path}: {e}") })?;
                        serde_json::json!({"deleted": remote_path})
                    }
                    "mkdir" => {
                        sftp.create_dir(&remote_path).await.map_err(|e| DeviceError::Internal { message: format!("sftp mkdir {remote_path}: {e}") })?;
                        serde_json::json!({"created": remote_path})
                    }
                    _ => return Ok(to_value_or_empty(json!({"error": format!("unknown op: {op}")}))),
                };

                // Best-effort close (ignore errors — session drop cleans up).
                let _ = sftp.close().await;
                Ok(to_value_or_empty(result))
            }
        }
        #[cfg(not(feature = "terminal"))]
        {
            async move {
                Err(vale_agent_core::DeviceError::Internal {
                    message: "sftp backend not enabled (built without the terminal feature)".to_string(),
                })
            }
        }
    }
}

/// round-151: terminal_env — AI-friendly environment info: default shell,
/// install dir, bundled node, and guidance for using terminal_execute.
fn tool_terminal_env() -> ToolDef {
    ToolDef::new(
        "terminal_env",
        "Environment info for the AI when driving this device's terminal: default shell, install dir, bundled node.exe (for one-off node scripts run via terminal_execute), and usage guidance. Run BEFORE opening sessions/executing commands.",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            async move {
                let dir = crate::paths::install_dir();
                let node = dir.join("playwright").join("node.exe");
                let node_ver = if node.exists() {
                    tokio::time::timeout(
                        std::time::Duration::from_secs(4),
                        tokio::process::Command::new(&node).arg("--version").output(),
                    ).await
                    .ok()
                    .and_then(|o| o.ok())
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_default()
                } else { String::new() };
                Ok(to_value_or_empty(json!({
                    "default_shell": "pwsh (PowerShell 7)",
                    "shell_hint": "PowerShell 7 — OSC 633 shell integration active (clean display + exit codes); Windows PowerShell 5.1 is not supported",
                    "install_dir": dir.to_string_lossy(),
                    "bundled_node": { "path": node.to_string_lossy(), "version": node_ver },
                    "router_reachable": "ssh stc@192.168.1.1 (user stc)",
                    "ai_usage": [
                        "Open a PTY with terminal_open (kind=pty), then terminal_execute commands.",
                        "For script-driven work (playwright etc.) prefer browser_pw_info / browser_run_script instead of the shell.",
                    ],
                })))
            }
        },
    )
}

/// Max bytes per session buffer before evicting oldest half — now runtime-
/// configurable (round-69): an Arc<AtomicUsize> seeded from
/// config.terminal.buffer_mb and writable via PUT /api/settings. Was a
/// compile-time constant (1MB → 8MB round-68) — a serial console scrolling
/// GPON logs wrapped in seconds, and the value was unchangeable without a
/// rebuild.
fn tool_open(
    terminal_mgr: &Arc<TerminalManager>,
    bus: &Arc<dyn EventBus>,
    output_buf: &OutputBuf,
    logger: &crate::session_log::SessionLogger,
    buffer_limit: &Arc<std::sync::atomic::AtomicUsize>,
) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    let bus = bus.clone();
    let buf = output_buf.clone();
    let logger = logger.clone();
    let buffer_limit = buffer_limit.clone();
    ToolDef::new(
        "terminal_open",
        "Open a terminal connection. Kind: 'pty' (local shell; target optional — blank = default shell), 'ssh' (target=user@host:port), or 'serial' (target=port_name, optional ?baud=N&parity=E&data=8&stop=1 e.g. /dev/ttyUSB0?baud=9600&parity=even&data=8&stop=1, default 115200 8N1). Returns session ID.",
        json!({"type":"object","properties":{"kind":{"type":"string","enum":["pty","ssh","serial"]},"target":{"type":"string","description":"pty: optional (blank = default shell); ssh: user@host:port; serial: port_name (optional ?baud=N&parity=E&data=8&stop=1)"},"password":{"type":"string"},"key_path":{"type":"string","description":"(ssh) Path to a private key file. When set, public-key auth is used; password (if any) is the key passphrase."},"rows":{"type":"integer","description":"Initial terminal rows. Default 0 (backend default)."},"cols":{"type":"integer","description":"Initial terminal columns. Default 0 (backend default)."},"data_bits":{"type":"integer","description":"(serial) Data bits 5-8. Overrides the target string."},"parity":{"type":"string","description":"(serial) Parity: none|odd|even. Overrides the target string."},"stop_bits":{"type":"integer","description":"(serial) Stop bits 1 or 2. Overrides the target string."},"auto_reconnect":{"type":"boolean","description":"(serial) Auto-reconnect when the port disappears (unplug / device reboot): the session stays open and re-opens the SAME port with the SAME framing when it reappears (P4b). Default false."}},"required":["kind"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            let bus = bus.clone();
            let buf = buf.clone();
            let logger = logger.clone();
            let buffer_limit = buffer_limit.clone();
            async move {
                let kind = require_str(&params, "kind")?;
                // target is OPTIONAL (pty blank = default shell) — the schema
                // used to mark it required, contradicting the description and
                // breaking MCP clients that omit it for pty.
                let target = params.get("target").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let password = params.get("password").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let key_path = params.get("key_path").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let rows = params.get("rows").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                let cols = params.get("cols").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                let inject_marker = params.get("inject_marker").and_then(|v| v.as_bool()).unwrap_or(true);
                let data_bits = params.get("data_bits").and_then(|v| v.as_u64()).map(|v| v as u8);
                let parity = params.get("parity").and_then(|v| v.as_str()).map(|s| s.to_string());
                let stop_bits = params.get("stop_bits").and_then(|v| v.as_u64()).map(|v| v as u8);
                let auto_reconnect = params.get("auto_reconnect").and_then(|v| v.as_bool()).unwrap_or(false);
                let req = crate::tools::terminal::TermOpenRequest {
                    kind: kind.clone(),
                    target: target.clone(),
                    password,
                    key_path,
                    rows,
                    cols,
                    inject_marker,
                    data_bits,
                    parity,
                    stop_bits,
                    auto_reconnect,
                };
                let (id, _rx) = terminal_mgr.term_open(&req).await?;
                // Phase 4: persist metadata so post-restart errors can say
                // "this session existed before the restart" (the PTY itself
                // dies with the process — only the record survives).
                {
                    let map = pre_restart_map();
                    let mut m = map.lock().unwrap_or_else(|p| p.into_inner());
                    if m.len() > 128 { m.clear(); }
                    m.insert(id.clone(), serde_json::json!({
                        "kind": kind,
                        "target": req.target,
                        "opened_unix": std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs()).unwrap_or(0),
                    }));
                    persist_pre_restart(&m);
                }
                // Audit trail: session opened (round-54).
                logger.log_status(&id, "opened");
                // stage-m: NO PSReadLine removal — the VS Code shell
                // integration (OSC 633) DEPENDS on PSReadLine: the script
                // wraps PSConsoleHostReadLine to emit `633;E;<cmd>` /
                // `633;C` (round-162 removed it to silence wrapper noise;
                // with the wrapper gone, PSReadLine stays — VS Code's
                // documented requirement, see terminalEnvironment.ts).
                // Emit event based on kind
                match kind.as_str() {
                    "ssh" => {
                        let (user, host, _port) = parse_ssh_target(&target);
                        bus.emit(&AgentEvent::SshConnect { host, username: user, session_id: id.clone() });
                    }
                    "serial" => {
                        // Real baud from the target (?baud=N or the default),
                        // not a hardcoded 115200 — the event feed showed the
                        // wrong link speed for every non-default session (round-68).
                        let (port, baud) = parse_serial_target(&target);
                        bus.emit(&AgentEvent::SerialOpen { port, baud, session_id: id.clone() });
                    }
                    _ => {
                        let cmd = std::path::Path::new(&target)
                            .file_name().and_then(|n| n.to_str()).unwrap_or(&target).to_string();
                        bus.emit(&AgentEvent::ShellExec { command: if cmd.is_empty() { "shell".into() } else { cmd } });
                    }
                }
                // Connection memory (round-70): remember every successful
                // open so the AI / panel can reconnect without re-entering
                // the target. Best-effort — a read-only install dir must not
                // fail the open. PTY default shell is skipped (nothing to
                // remember).
                {
                    // round-108/109: conn_* is gated behind the terminal
                    // feature — headless builds must not call it (and the
                    // label/p computation must not warn unused there).
                    #[cfg(feature = "terminal")]
                    {
                        let label = terminal_mgr.term_info(&id).await
                            .map(|m| m.label.clone())
                            .unwrap_or_else(|| id.clone());
                        let p = params.as_object().cloned().unwrap_or_default();
                        let _ = crate::tools::terminal::conn_remember(&kind, &target, &label, &p);
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
                        // round-92: terminal_close retains the live buffer
                        // while this drainer is still draining (the backend
                        // reader hasn't EOF'd yet). Writing the remaining
                        // chunks into a FRESH live entry reset end_abs to 0 —
                        // every post-close frame carried start:0 and was
                        // dropped by incremental consumers (panel SSE at
                        // offset N dedups against start). Route the tail into
                        // the retained history entry instead; the cursor stays
                        // continuous and the tail reaches the panel.
                        let entry: &mut SessionBuf = if store.history.contains_key(&sid_buf) {
                            &mut store.history.get_mut(&sid_buf).expect("checked above").buf
                        } else {
                            store.live.entry(sid_buf.clone()).or_default()
                        };
                        // The frame's ABSOLUTE start offset, attached to the SSE
                        // frame so the panel can skip bytes already delivered by
                        // a concurrent terminal_read (dedup — see panel.js).
                        let frame_start = entry.end_abs();
                        entry.data.extend_from_slice(&output.data);
                        // Cap at the runtime buffer limit (round-69) — evict
                        // the oldest half if exceeded. The cursor is ABSOLUTE
                        // (dropped+len); eviction advances `dropped`, so the
                        // cursor is untouched — a leftover saturating_sub
                        // (remove) here corrupted it and re-delivered up to
                        // 524KB of already-read bytes.
                        let max = buffer_limit.load(std::sync::atomic::Ordering::Relaxed);
                        if entry.data.len() > max {
                            let remove = entry.data.len() - max / 2;
                            // Spill the evicted bytes BEFORE dropping them —
                            // they are the only copy of the stream's head;
                            // terminal_read merges spill + memory (round-54).
                            // round-115: cap the spill FILE too — a session
                            // producing output continuously (serial console,
                            // tail -f) evicted ~1GB/day and the file grew
                            // unbounded for the session's life; disk
                            // exhaustion on the SYSTEM drive. Rotate the file
                            // (drop the oldest half) once it exceeds the cap.
                            let spill_len = entry.dropped.saturating_sub(entry.spill_base) + remove as u64;
                            if spill_len > MAX_SPILL_BYTES {
                                let keep = MAX_SPILL_BYTES / 2;
                                let discard = spill_len - keep;
                                entry.spill_base += discard;
                                rotate_spill(&sid_buf, discard);
                            }
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
                    // The PTY's natural exit code (round-60): distinguishes a
                    // clean `exit` from a crash for the audit trail. SSH/serial
                    // have no process → None, logged as plain closed.
                    // Read it BEFORE term_unregister (round-68): unregister
                    // empties the session map, so reading after it always
                    // returned None and the exit code was never audited.
                    let exit_code = mgr2.term_exit_code(&sid_buf).await;
                    // Session ended — retain the buffer in history instead of
                    // dropping it (terminal_close also retains; whichever runs
                    // second is a no-op), and unregister the manager entry so
                    // the dead session is not listed as live / written to a void.
                    recover_guard(&buf)
                        .retain_live(&sid_buf, &kind, &label, exit_code);
                    mgr2.term_unregister(&sid_buf).await;
                    // Audit trail: session closed (round-54), then release
                    // the logger's fd for this session (round-59) — the files
                    // map must not grow with every session ever seen — and
                    // drop its spill file (round-60; the retained history
                    // entry carries the tail, the spill's head is unreachable
                    // once the session is gone).
                    if let Some(code) = exit_code {
                        logger2.log_status(&sid_buf, &format!("exited:{code}"));
                    } else {
                        logger2.log_status(&sid_buf, "closed");
                    }
                    logger2.close_session(&sid_buf);
                    // round-95: the spill file is NOT deleted here — the
                    // retained history entry still advertises bytes
                    // [0, dropped) that terminal_read merges from spill;
                    // deleting it made the session head unreachable after
                    // close (reads returned only the in-memory tail while
                    // reporting start:0/end:end_abs). The spill now lives
                    // until the history entry is evicted by
                    // enforce_history_caps (which calls remove_spill_for).
                    // Backend-initiated death (SSH channel EOF, serial read
                    // error, pty EOF) — emit the event so clients learn the
                    // session died and WHY, instead of discovering it only via
                    // terminal_list polling with no reason (round-53). A
                    // client-initiated close goes through tool_close which
                    // already emits; this is a no-op for the double-run (the
                    // event is harmless on an already-closed session).
                    bus2.emit(&close_event(&kind, &sid_buf));
                    // round-163: backend-initiated death must also push the
                    // SSE list event — with the panel's 3s terminal_list poll
                    // gone, this is what tombstones the dead tab and releases
                    // focus (the R88 contract).
                    bus2.emit_term_output(json!({ "ev": "sessions-changed" }));
                });
                // round-157: log how many sessions are already open on this
                // device — models that see "commands queuing" symptoms
                // answered by opening MORE sessions (167 opens in one d1
                // session), which interleaves buffers and worsens the
                // illusion. Log-only; the return value stays the bare
                // session id STRING — the panel (useSessions.ts) requires
                // typeof sid === "string"; never objectify this without a
                // panel-side migration.
                let open_count = terminal_mgr.term_list().await.len();
                tracing::debug!("[vale-agent] terminal_open: {id} open_sessions={open_count}");
                // round-163: push the session-list change over the SSE bus —
                // the panel dropped its 3s terminal_list poll for this event.
                bus.emit_term_output(json!({"ev": "sessions-changed"}));
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
                if terminal_mgr.term_info(&session_id).await.is_none() {
                    return Err(session_lost(&terminal_mgr, &session_id).await);
                }
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
                // Explicit close has no natural exit code — the drainer's
                // later retain (if any) carries the real code and wins.
                recover_guard(&buf)
                    .retain_live(&session_id, &kind, &label, None);
                bus.emit(&close_event(&kind, &session_id));
                // round-163: same push contract as terminal_open.
                bus.emit_term_output(json!({"ev": "sessions-changed"}));
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
        // stage-m: `\r` ONLY — VS Code's sendText sends `\r` (the terminal
        // driver maps it to Enter). `\r\n` on ConPTY can be read as TWO
        // input events (CR + LF), so PSReadLine renders an empty
        // continuation prompt (`>>`) after every command.
        format!("{command}\r")
    } else {
        format!("{command}\n")
    }
}

/// Cap for a session's spill file (round-115): the drainer's eviction used
/// to append every evicted chunk forever — a continuously-producing session
/// (serial console ~11.5KB/s, tail -f) grew the file ~1GB/day. When the
/// file exceeds this, rotate_spill drops the oldest half.
const MAX_SPILL_BYTES: u64 = 256 * 1024 * 1024; // 256 MiB per live session

fn spill_path(sid: &str) -> std::path::PathBuf {
    std::env::temp_dir().join("vale").join(format!("{sid}.spill"))
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
fn rotate_spill(sid: &str, discard: u64) {
    use std::io::{Seek, SeekFrom, Write};
    let p = spill_path(sid);
    let Ok(mut f) = std::fs::File::open(&p) else { return };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if discard >= len {
        drop(f);
        let _ = std::fs::remove_file(&p);
        return;
    }
    let _ = f.seek(SeekFrom::Start(discard));
    let mut tail = Vec::with_capacity((len - discard) as usize);
    let mut remain = len - discard;
    let mut buf = vec![0u8; 65536];
    while remain > 0 {
        let want = (remain.min(buf.len() as u64)) as usize;
        let n = std::io::Read::read(&mut f, &mut buf[..want]).unwrap_or(0);
        if n == 0 { break; }
        tail.extend_from_slice(&buf[..n]);
        remain -= n as u64;
    }
    drop(f);
    let _ = std::fs::remove_file(&p);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    if let Ok(mut nf) = opts.open(&p) {
        let _ = nf.write_all(&tail);
    }
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
fn read_spill(sid: &str, start: usize, end: usize, base: u64) -> (Vec<u8>, u64) {
    // round-110/111: the whole spill file was read into RAM then sliced —
    // a log-streaming session accumulates hundreds of MB, so a first
    // no-offset read (cursor 0) OOM'd the agent. Cap a single read at 1MB.
    use std::io::{Read, Seek, SeekFrom};
    const MAX_SPILL_READ: u64 = 1_048_576;
    let Ok(mut f) = std::fs::File::open(spill_path(sid)) else { return (Vec::new(), start.max(base as usize) as u64) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    // File covers absolute [base, base+len). Intersect the request with it.
    let file_end = base + len;
    let e = (end as u64).min(file_end);
    let s = (start as u64).max(base).min(e);
    let read_start = if e - s > MAX_SPILL_READ { e - MAX_SPILL_READ } else { s };
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
///
/// stage-l: LEGACY — the shell-injection OSC 133 marker was replaced by the
/// Netcatty-style command wrapper (see wrap_execute_command / find_exec_marker).
/// Kept only for the headless-stub path and backward-compat reads; new code
/// must use find_exec_marker.
fn find_prompt_marker(data: &[u8]) -> Option<(usize, usize, i32)> {
    const PREFIX: &[u8] = b"\x1b]133;D;";
    // round-100: the old code stopped at the FIRST prefix — a false
    // \x1b]133;D; sequence in output (e.g. a literal escape in a log line)
    // with no digits/BEL made the whole search fail even when a REAL marker
    // followed. Scan ALL prefixes; only a complete sequence counts.
    let mut search_from = 0;
    while let Some(rel) = data[search_from..].windows(PREFIX.len()).position(|w| w == PREFIX) {
        let start = search_from + rel;
        let mut i = start + PREFIX.len();
        let digits_start = i;
        while i < data.len() && data[i].is_ascii_digit() { i += 1; }
        if i == digits_start { search_from = start + 1; continue; } // prefix but no digits yet — try the next prefix
        if i >= data.len() || data[i] != 0x07 { search_from = start + 1; continue; } // incomplete — try the next
        // round-101: a digit run that overflows i32 (11+ digits) must not
        // abort the whole scan — continue to the next prefix like the other
        // false-prefix cases.
        let code: i32 = match std::str::from_utf8(&data[digits_start..i]).ok().and_then(|s| s.parse().ok()) {
            Some(c) => c,
            None => { search_from = start + 1; continue; }
        };
        return Some((start, i + 1, code));
    }
    None
}

// ── stage-l: Netcatty-style command wrapper + plain-text markers ────────
//
// The OSC 133 shell-injection marker FAILED on Windows PowerShell 5.1 +
// ConPTY: the injected `function global:Prompt` never emitted the sequence
// (PSReadLine unload / ConsoleHost prompt path), so terminal_execute waited
// for a marker that never came and burned the full timeout on every command
// (observed live on d1: `state:"timeout"` at 10s on a 50ms `echo`).
//
// The replacement (proven by Netcatty in production on the same platform):
// wrap EVERY executed command in a single-line shell wrapper that prints a
// random START marker, runs the command, then prints END:<exitcode>. The
// ── Jobs (Phase 3) ───────────────────────────────

fn tool_jobs(jobs: &JobsMap) -> ToolDef {
    let jobs = jobs.clone();
    ToolDef::new(
        "terminal_jobs",
        "Background-job registry. With no params: list recent run_in_background jobs {job_id, command, done, exit_code}. With {job_id, wait_secs}: block until that job finishes or the timeout elapses, then return its final state.",
        json!({"type":"object","properties":{
            "job_id":{"type":"string","description":"Job id returned by terminal_execute(run_in_background:true)."},
            "wait_secs":{"type":"integer","description":"Max seconds to wait for completion when job_id is given. Default 0 (instant snapshot)."}
        }}),
        move |params: Value| {
            let jobs = jobs.clone();
            async move {
                let deadline_secs = params.get("wait_secs").and_then(|v| v.as_u64()).unwrap_or(0).min(3600);
                let target = params.get("job_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(deadline_secs);
                loop {
                    {
                        let jm = jobs.lock().unwrap_or_else(|p| p.into_inner());
                        if let Some(id) = &target {
                            match jm.get(id) {
                                Some(j) if j.done => {
                                    return Ok(json!({"job_id": id, "state": "done", "exit_code": j.exit_code}));
                                }
                                None => {
                                    return Err(DeviceError::InvalidParams { message: format!("unknown job_id: {}", id) });
                                }
                                _ => {}
                            }
                        } else {
                            let mut out = Vec::new();
                            for (k, j) in jm.iter() {
                                out.push(json!({
                                    "job_id": k, "session": j.sid, "command": j.command,
                                    "done": j.done, "exit_code": j.exit_code,
                                    "started_unix": j.started_unix,
                                }));
                            }
                            return Ok(json!({"jobs": out}));
                        }
                    }
                    if std::time::Instant::now() >= deadline {
                        let state = if target.is_some() { "running" } else { "snapshot" };
                        return Ok(json!({"state": state}));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        },
    )
}

// ── Execute ──────────────────────────────────────

/// Enriched "session not found" error: lists currently open sessions so the
/// caller can self-recover (agent restarts drop in-memory PTY sessions).
async fn session_lost(mgr: &Arc<TerminalManager>, sid: &str) -> DeviceError {
    let open = mgr.term_list().await;
    let list = if open.is_empty() {
        "(none — agent restarted? re-open with terminal_open)".to_string()
    } else {
        open.iter().map(|i| i.id.clone()).collect::<Vec<_>>().join(", ")
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
    let existed = map.lock().unwrap_or_else(|p| p.into_inner()).contains_key(sid);
    if existed {
        " This session existed before the last agent restart - PTYs cannot survive restarts.".to_string()
    } else {
        String::new()
    }
}

// ── Execute ──────────────────────────────────────

fn tool_execute(terminal_mgr: &Arc<TerminalManager>, bus: &Arc<dyn EventBus>, output_buf: &OutputBuf, logger: &crate::session_log::SessionLogger, jobs: &JobsMap) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    let buf = output_buf.clone();
    let bus = bus.clone();
    let logger = logger.clone();
    let jobs = jobs.clone();
    ToolDef::new(
        "terminal_execute",
        "Run a command. If `session_id` is given, writes the command to that session and waits for output (prompt-marker detection on PTY shells, quiet-period fallback otherwise). Otherwise spawns a local shell with enforced timeout. Session mode returns {kind, state, text, read_from, wait_reason, exit_code, truncated, still_running}: state=done means text is COMPLETE; partial/timeout means text is a PREFIX and `still_running=true` — the command is STILL RUNNING, continue with terminal_read(offset=read_from) until you see the prompt/exit. NEVER re-run a command or open a new session just because a partial was returned: the output arrives in the SAME session's buffer; opening new sessions (terminal_open) while old commands run is what causes output to look interleaved/queued. Long silent SSH commands: prefer run_in_background:true or bigger timeout_secs (idle window scales: ssh 3s, serial 4s, pty 1s). Local mode returns {kind, text, truncated}. `run_in_background: true` (session mode) writes the command and returns immediately with a read_from cursor — collect output via terminal_read; do NOT busy-poll, the wait loop is the foreground path. Note: a quiet timeout or truncation does not prove the foreground command exited.",
        json!({"type":"object","properties":{"command":{"type":"string"},"session_id":{"type":"string","description":"Optional: execute in an existing terminal session."},"timeout_secs":{"type":"integer","description":"Max wait time in seconds. Default 30."},"quiet_ms":{"type":"integer","description":"(Session mode) Quiet period in ms before considering output complete. Default 200."},"run_in_background":{"type":"boolean","description":"(Session mode) Write the command and return immediately with a read_from cursor; collect via terminal_read. Default false."}},"required":["command"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            let buf = buf.clone();
            let bus = bus.clone();
            let logger = logger.clone();
            let jobs = jobs.clone();
            async move {
                let command = require_str(&params, "command")?;
                // round-98: clamp — a client-supplied u64::MAX made
                // `Instant::now() + Duration::from_secs(timeout_secs)`
                // overflow and PANIC after the busy guard was taken and the
                // command written, wedging the session busy flag forever and
                // orphaning the command. 1h is the practical max.
                let timeout_secs = params.get("timeout_secs").and_then(|v| v.as_u64()).unwrap_or(30).min(3600);
                let quiet_ms = params.get("quiet_ms").and_then(|v| v.as_u64()).unwrap_or(200);

                if let Some(session_id) = params.get("session_id").and_then(|v| v.as_str()) {
                    // ── Session-aware mode: write + wait for output ──
                    let sid = session_id.to_string();
                    // Refactor 1.0.81: session kind drives the idle-confirm
                    // window below — SSH commands run REMOTELY and their long
                    // silent stretches must not read as "command finished".
                    let sess_info = terminal_mgr.term_info(&sid).await;
                    if sess_info.is_none() {
                        return Err(session_lost(&terminal_mgr, &sid).await);
                    }
                    let sess_info = sess_info.expect("checked above");
                    let sess_kind = sess_info.kind.clone();
                    let sess_shell = sess_info.shell.clone();
                    // Background mode (round-60): write the command and return
                    // IMMEDIATELY — no wait loop, no busy lock. The caller
                    // collects output via terminal_read with the returned
                    // cursor, so long-running commands (builds, tail -f) don't
                    // block an MCP call or trip the busy guard.
                    let run_in_background = params.get("run_in_background").and_then(|v| v.as_bool()).unwrap_or(false);
                    // Absolute position of the first post-command byte.
                    // All tracking is byte-exact against the raw buffer, so
                    // UTF-8 lossy conversion and 1MB eviction can never
                    // desynchronize the index (the old String-length-based
                    // offset could panic on an out-of-range slice).
                    // stage-l: Netcatty-style command wrapping. When the
                    // session's shell is known AND the open-time
                    // `inject_marker` switch is on (its stage-l meaning: "use
                    // the command wrapper"; default true), the command is
                    // wrapped in a single-line wrapper that prints
                    // `<marker>_S` / `<marker>_E:<exitcode>` PLAIN-TEXT
                    // markers; completion is detected by scanning the raw
                    // byte stream for them. Unknown shells (ssh/serial/custom
                    // pty target) or inject_marker=false fall back to the
                    // stage-m (VS Code shell integration): PowerShell sessions
                    // were spawned WITH the OSC 633 injection (pty.rs), so the
                    // command is written RAW — no wrapper text — and completion
                    // comes from `633;D[;rc]`. Other shells (unknown/ssh/serial)
                    // keep the quiet-period fallback. Windows PowerShell only
                    // recognizes the end of a command on CRLF (\r\n) — a bare
                    // \n drops it into the multi-line continuation prompt (>>).
                    // Unix shells accept either.
                    // stage-m: 633 completion detection only for pwsh — Windows PowerShell
                    // 5.1 gets NO injection (pty.rs: its PSReadLine 2.0.0 +
                    // ConPTY re-echoes OSC as input, rendering `>>` after
                    // every prompt — VS Code has the same report, #236841).
                    // 5.1 sessions use the quiet-period completion path.
                    let shell_633 = sess_shell == "pwsh";
                    // Windows PowerShell only recognizes the end of a command
                    // on CRLF (\r\n); Unix shells accept either.
                    let cmd_with_nl = append_command_newline(&command);
                    // Busy guard FIRST (round-56): acquiring the per-session
                    // execute lock must happen BEFORE the command reaches the
                    // shell. The old order wrote the command + logged start
                    // first — on refusal the command still sat in the shell's
                    // input queue and executed anyway, and the audit trail
                    // held a dangling start with no end (misreported as
                    // interrupted on the next boot).
                    // round-160: bounded WAIT instead of hard refusal — AI
                    // clients fire executes back-to-back; 21 "Session busy"
                    // failures in one week of real usage.
                    if !terminal_mgr.term_acquire_execute(&sid, 30_000).await? {
                        return Err(DeviceError::SessionBusy { id: sid.clone() });
                    }
                    // First-prompt gate (stage-l rework): the old gate waited
                    // for the OSC prompt marker that PowerShell 5.1 + ConPTY
                    // never emitted. A command entering PowerShell during
                    // profile-init still gets shredded into continuation
                    // prompts, so the gate stays — but completion no longer
                    // depends on an injected marker: it waits for the shell to
                    // produce ANY output (the profile banner, or the wrapper's
                    // echo once execute writes), and for wrapped commands also
                    // for the START marker. A session that produced output is
                    // alive and ready; a fully silent one gets a bounded wait
                    // then proceeds (the execute wait loop's start-timeout
                    // reports the failure explicitly instead of hanging).
                    let gate_needed = recover_guard(&buf)
                        .live.get(&sid).map(|e| !e.first_prompt_seen).unwrap_or(false);
                    if gate_needed && shell_633 {
                        // stage-m: the 633-injected shell announces itself with
                        // `633;A` at the first prompt — wait up to 12s for it
                        // (cold PowerShell + PSReadLine + profile init on a
                        // slow device regularly exceeds 3s). A shell that
                        // produced ANY output (banner or prompt) is alive; a
                        // fully silent one gets marked ready anyway and the
                        // execute wait loop's start-timeout reports the dead
                        // shell explicitly instead of hanging.
                        let gate_deadline = Instant::now() + std::time::Duration::from_secs(12);
                        let mut scan_from = recover_guard(&buf)
                            .live.get(&sid).map(|e| e.end_abs()).unwrap_or(0);
                        let mut pend: Vec<u8> = Vec::new();
                        let mut saw_any_output = false;
                        loop {
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            if terminal_mgr.term_info(&sid).await.is_none() { break; }
                            let (chunk, n) = recover_guard(&buf)
                                .live.get(&sid)
                                .map(|e| {
                                    if e.dropped as usize > scan_from { scan_from = e.dropped as usize; }
                                    let sl = e.slice_from(scan_from);
                                    (sl.to_vec(), sl.len())
                                })
                                .unwrap_or_default();
                            if n > 0 {
                                scan_from += n;
                                saw_any_output = true;
                                pend.extend_from_slice(&chunk);
                            }
                            let cut = pend.len().saturating_sub(64);
                            if cut > 0 { pend.drain(..cut); }
                            // `633;A` = the injected Prompt ran → shell ready.
                            if crate::tools::terminal::shell_integration::find_prompt_started(&pend).is_some() {
                                if let Some(e) = recover_guard(&buf).live.get_mut(&sid) {
                                    e.first_prompt_seen = true;
                                }
                                break;
                            }
                            if Instant::now() >= gate_deadline { break; }
                        }
                        // Gate expired with NO output at all: mark the session
                        // ready anyway — the execute wait loop's start-timeout
                        // reports a dead shell explicitly instead of hanging.
                        if !saw_any_output {
                            if let Some(e) = recover_guard(&buf).live.get_mut(&sid) {
                                e.first_prompt_seen = true;
                            }
                        }
                    } else if gate_needed {
                        // Unknown-shell sessions (ssh/serial) have no 633
                        // injection — the shell is ready as soon as the
                        // session exists (the quiet path is tolerant).
                        if let Some(e) = recover_guard(&buf).live.get_mut(&sid) {
                            e.first_prompt_seen = true;
                        }
                    }
                    // Settle-drain: consume whatever still streams in from the
                    // PREVIOUS command before sampling the start offset —
                    // sampling end_abs while an earlier tail was mid-flight
                    // baked stale bytes into THIS result (observed live).
                    {
                        let settle_deadline = Instant::now() + std::time::Duration::from_millis(600);
                        let mut last_len: Option<usize> = None;
                        loop {
                            let cur = recover_guard(&buf)
                                .live.get(&sid).map(|e| e.end_abs()).unwrap_or(0);
                            if Some(cur) == last_len { break; }
                            last_len = Some(cur);
                            if Instant::now() >= settle_deadline { break; }
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        }
                    }
                    let mut read_abs = recover_guard(&buf)
                        .live.get(&sid).map(|e| e.end_abs()).unwrap_or(0);
                    // round-162: NO temporary widen — PSReadLine is removed
                    // at session open (see tool_open), so the wrapper echoes
                    // as one clean line at any width. No reflow scrambling.
                    // Write the command; on failure (session reaped mid-write)
                    // release the lock — the command never ran, nothing to
                    // audit, and the next execute must not bounce off a stale
                    // busy flag.
                    // round-132: receive-side diagnostics — long commands occasionally
                    // lose mid chars over the gateway link; log the length
                    // the agent actually received plus head/tail fragments
                    // to locate where the loss happened (gateway tunnel vs
                    // PTY write).
                    let _ = std::fs::OpenOptions::new().create(true).append(true)
                        .open("D:\\vale-agent\\diag.log")
                        .and_then(|mut f| {
                            use std::io::Write;
                            writeln!(f, "[term_execute] sid={sid} recv_len={} head={:?} tail={:?}",
                                cmd_with_nl.len(),
                                &cmd_with_nl[..cmd_with_nl.len().min(24)],
                                &cmd_with_nl[cmd_with_nl.len().saturating_sub(24)..])
                        });
                    // round-162: (Netcatty's `\x1b\x15\x0b` clear-line prefix
                    // was TRIED and REVERTED — under Vale's ConPTY the ESC
                    // arrives as a keypress, not a sequence, so PowerShell
                    // executed the stray `\x15` as a command. The pre-START
                    // no-finalize rule (below) already keeps all pre-marker
                    // noise out of the result, so no prefix is needed.)
                    if let Err(e) = terminal_mgr.term_write(&sid, &cmd_with_nl).await {
                        terminal_mgr.term_release_execute(&sid).await;
                        return Err(e);
                    }
                    // Audit trail: command started — AFTER the write succeeded.
                    // A command that never reached the shell must not leave a
                    // dangling start that crash recovery reports as
                    // "interrupted" (round-55).
                    logger.log_command_start(&sid, &command);
                    let quiet_dur = std::time::Duration::from_millis(quiet_ms);
                    // Background mode: return immediately with the read cursor
                    // so the caller can collect output incrementally.
                    // round-115: the busy lock is NOT released here — a
                    // background command still running while a foreground
                    // execute takes the lock makes the marker stream
                    // ambiguous (the marker carries no command identity, so
                    // the foreground call could return the BACKGROUND
                    // command's marker + exit code and miss its own output).
                    // A background task releases the lock when THIS command's
                    // marker (PTY) or quiet period (SSH/serial) arrives;
                    // foreground executes during that window get SessionBusy
                    // (correct — one shell runs one command at a time).
                    if run_in_background {
                        let start = recover_guard(&buf)
                            .live.get(&sid).map(|e| e.end_abs()).unwrap_or(0);
                        // round-98: audit — the command was handed to the
                        // shell; without an end line the trail permanently
                        // misreports it as "interrupted" on the next boot.
                        logger.log_status(&sid, "backgrounded");
                        // Phase 3: queryable job record — callers poll
                        // terminal_jobs instead of blind-read loops.
                        let job_id = format!("{}#{}", sid, start);
                        {
                            let jm_arc = jobs.clone();
                            let mut jm = jm_arc.lock().unwrap_or_else(|p| p.into_inner());
                            if jm.len() > 64 {
                                let mut finished: Vec<String> = jm.iter()
                                    .filter(|(_, j)| j.done).map(|(k, _)| k.clone()).collect();
                                finished.sort();
                                let excess = jm.len().saturating_sub(64);
                                for k in finished.into_iter().take(excess) { jm.remove(&k); }
                            }
                            jm.insert(job_id.clone(), JobInfo {
                                sid: sid.clone(), command: command.clone(),
                                started_unix: std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_secs()).unwrap_or(0),
                                done: false, exit_code: None,
                            });
                        }
                        let job_id2 = job_id.clone();
                        let marker_confirm = std::time::Duration::from_millis(300);
                        let mgr2 = terminal_mgr.clone();
                        let buf2 = buf.clone();
                        let sid2 = sid.clone();
                        let quiet_dur2 = quiet_dur;
                        let start2 = start;
                        // stage-m: the background waiter uses the same
                        // 633;D detection as the foreground loop. Unknown
                        // shells (ssh/serial) → quiet fallback.
                        let shell_633_2 = shell_633;
                        tokio::spawn(async move {
                            // Wait for the background command to finish (same
                            // 633;D/quiet semantics as the foreground wait
                            // loop), then release the execute lock.
                            let mut read_abs = start2;
                            let mut quiet_since: Option<Instant> = None;
                            let mut marker_seen_at: Option<Instant> = None;
                            let mut pending: Vec<u8> = Vec::new();
                            loop {
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                // Session closed → release; retain_live already
                                // logged the end.
                                if mgr2.term_info(&sid2).await.is_none() { break; }
                                let (chunk, chunk_len) = recover_guard(&buf2)
                                    .live.get(&sid2)
                                    .map(|e| {
                                        if e.dropped as usize > read_abs { read_abs = e.dropped as usize; }
                                        let s = e.slice_from(read_abs);
                                        (s.to_vec(), s.len())
                                    })
                                    .unwrap_or_default();
                                if chunk_len > 0 {
                                    read_abs += chunk_len;
                                    pending.extend_from_slice(&chunk);
                                    if shell_633_2 {
                                        while let Some(f) = crate::tools::terminal::shell_integration::find_finished(&pending) {
                                            pending.drain(..f.end);
                                            marker_seen_at = Some(Instant::now());
                                            if let Ok(mut jm) = jobs_map().lock() {
                                                if let Some(j) = jm.get_mut(&job_id2) {
                                                    j.done = true;
                                                    j.exit_code = f.exit_code;
                                                }
                                            }
                                        }
                                    } else {
                                        // Unknown shell: quiet-period fallback.
                                        while let Some((mstart, mend, _code)) = find_prompt_marker(&pending) {
                                            pending.drain(..mend);
                                            marker_seen_at = Some(Instant::now());
                                            let _ = mstart;
                                        }
                                    }
                                    let keep = pending.len().saturating_sub(64);
                                    if keep > 0 { pending.drain(..keep); }
                                    quiet_since = None;
                                } else if quiet_since.is_none() {
                                    quiet_since = Some(Instant::now());
                                }
                                if let Some(at) = marker_seen_at {
                                    if at.elapsed() >= marker_confirm { break; }
                                } else if let Some(qs) = quiet_since {
                                    // 633 shells never break on quiet — the
                                    // 633;D marker (at command end) or the
                                    // session close is the only terminator.
                                    // Unknown-shell backends keep the quiet
                                    // fallback.
                                    if !shell_633_2 && qs.elapsed() >= quiet_dur2 { break; }
                                }
                            }
                            mgr2.term_release_execute(&sid2).await;
                        });
                        return Ok(json!({
                            "kind": "session",
                            "status": "running",
                            "job_id": job_id,
                            "read_from": start,
                            "hint": "collect output with terminal_read offset=read_from; command may still be running",
                        }));
                    }
                    // For the audit duration (round-58): wall-clock start.
                    let cmd_started = Instant::now();

                    let deadline = Instant::now() + std::time::Duration::from_secs(timeout_secs);
                    // Marker-confirm window (dsh handoffGraceMs): once the
                    // prompt marker arrives, wait this long before returning —
                    // bash prints the prompt and then hands the tty back, and
                    // a too-eager return could race that handoff.
                    let marker_confirm = std::time::Duration::from_millis(300);
                    // Idle confirm scales with session kind — SSH commands run
                    // remotely; their silent stretches must not read as done.
                    // round-157: doubled — plink/ssh tunnels and long silent
                    // commands (Start-Sleep, remote uci) have multi-second
                    // output gaps; the old 300ms/1.2s windows returned
                    // `state:"partial"` while the command was still running,
                    // which models misread as "commands queuing" and answered
                    // by spawning new sessions (observed: 321 idle-partials,
                    // 167 opens on d1 in one session).
                    let idle_confirm = match sess_kind.as_str() {
                        "ssh" => std::time::Duration::from_millis(3000),
                        "serial" => std::time::Duration::from_millis(4000),
                        _ => std::time::Duration::from_millis(1000),
                    };
                    let mut quiet_since: Option<Instant> = None;
                    // round-105: the quiet path extends ONCE (marker-injected
                    // PTYs: echo → quiet → marker at next prompt). A second
                    // quiet expiry breaks idle — marker-less backends must
                    // not loop to the deadline.
                    let mut quiet_extended = false;
                    // round-107: when the extension is taken, the second
                    // expiry fires marker_confirm after the FIRST expiry
                    // (not 2x quiet_dur, and never a future panic).
                    let mut quiet_confirm_at: Option<Instant> = None;
                    // stage-l: the OSC marker contract is gone. Wrapped
                    // (known-shell) sessions end on the wrapper's END marker;
                    // unknown-shell sessions (ssh/serial) keep the bounded
                    // quiet path. The marker_injected flag is no longer
                    // consulted — `wrap_shell` is the only driver.
                    let mut result = String::new();
                    // round-105: cap the session-mode result like the local
                    // mode (1 MB tail) — the old code grew to the command's
                    // TOTAL output; `yes` at 1MB/s for the 3600s deadline
                    // OOM'd the agent. The tail is kept (most useful to the
                    // model); `truncated` is set so the caller knows.
                    const MAX_SESSION_BYTES: usize = 1_048_576;
                    let append_result = |result: &mut String, truncated: &mut bool, s: &str| {
                        // round-113: a SINGLE chunk larger than the cap (a
                        // burst between 50ms polls, up to the whole buffer)
                        // used to bypass the guard — it was pushed in full
                        // and only trimmed on the NEXT append. Trim `s`
                        // itself first.
                        let mut s = s;
                        if s.len() > MAX_SESSION_BYTES {
                            *truncated = true;
                            let keep = s.floor_char_boundary(MAX_SESSION_BYTES);
                            s = &s[s.len() - keep..];
                        }
                        if result.len() + s.len() > MAX_SESSION_BYTES {
                            *truncated = true;
                            let drop = result.len() + s.len() - MAX_SESSION_BYTES;
                            let drop = drop.min(result.len());
                            // round-106: String::drain panics on a non-char
                            // boundary — terminal output is arbitrary bytes
                            // (lossy-converted), so a multi-byte flood
                            // (CJK/emoji) panicked inside the wait loop and
                            // wedged the session busy flag forever. Walk
                            // back to a char boundary before draining.
                            let mut bound = drop;
                            while bound > 0 && !result.is_char_boundary(bound) {
                                bound -= 1;
                            }
                            result.drain(..bound);
                        }
                        result.push_str(s);
                    };
                    // Marker scanner state: the wrapper's plain-text markers
                    // (`<marker>_S` / `<marker>_E:<code>`) may span chunks, so
                    // the un-finalized tail stays pending until it cannot be a
                    // marker prefix anymore. `pending` starts EMPTY for wrapped
                    // commands — the settle-drain + START marker scan discard
                    // everything before the marker (the wrapper echo + prompt).
                    // Unknown-shell sessions keep the old OSC scan for
                    // backward-compat reads (a marker-injected legacy session
                    // still emits them), plus the quiet fallback.
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
                        // round-110: session liveness comes from the MANAGER
                        // map, not the output buffer — the buffer entry is
                        // created lazily on the first output chunk, so a
                        // silent-but-alive session (serial modem, no-echo PTY)
                        // would false-fire 'closed' before its first output.
                        if terminal_mgr.term_info(&sid).await.is_none() {
                            wait_reason = "closed";
                            break;
                        }
                        let (chunk, chunk_len) = recover_guard(&buf)
                            .live.get(&sid)
                            .map(|e| {
                                // Eviction advanced `dropped` past our read
                                // cursor → output was dropped (1MB burst).
                                // round-94: the cursor MUST jump forward to
                                // `dropped`, not stay behind — slice_from
                                // clamps to the in-memory window and the next
                                // poll would re-read the window tail that was
                                // already appended to `result`, duplicating
                                // it on every poll while eviction continues.
                                if e.dropped as usize > read_abs {
                                    read_abs = e.dropped as usize;
                                    truncated = true;
                                }
                                let s = e.slice_from(read_abs);
                                (s.to_vec(), s.len())
                            })
                            .unwrap_or_default();
                        if chunk_len > 0 {
                            read_abs += chunk_len;
                            pending.extend_from_slice(&chunk);
                            if shell_633 {
                                // stage-m (VS Code shell integration): the
                                // injected PowerShell emits `633;D[;rc]` when a
                                // command finishes — scan for it. Everything
                                // before the FIRST `633;D` of this command is
                                // pre-command noise (prompt sequences + the
                                // command's own echo), finalized into `result`
                                // once the first 633;D arrives (the sequence
                                // itself is invisible on the terminal).
                                while let Some(f) = crate::tools::terminal::shell_integration::find_finished(&pending) {
                                    if f.end > 0 {
                                        append_result(&mut result, &mut truncated, &String::from_utf8_lossy(&pending[..f.end]));
                                    }
                                    pending.drain(..f.end);
                                    marker_code = f.exit_code;
                                    marker_seen_at = Some(Instant::now());
                                }
                            } else {
                                // Unknown shell: legacy OSC scan (backward-
                                // compat for marker-injected legacy sessions)
                                // + quiet fallback.
                                while let Some((start, end, code)) = find_prompt_marker(&pending) {
                                    if start > 0 {
                                        append_result(&mut result, &mut truncated, &String::from_utf8_lossy(&pending[..start]));
                                    }
                                    pending.drain(..end);
                                    marker_code = Some(code);
                                    marker_seen_at = Some(Instant::now());
                                    if let Some(e) = recover_guard(&buf).live.get_mut(&sid) {
                                        e.first_prompt_seen = true;
                                    }
                                }
                            }
                            // Finalize everything that can no longer be a
                            // marker prefix.
                            // stage-m: no START marker — keep the 64B finalize
                            // window so a 633;D split across chunks is never
                            // lost, then append the rest.
                            let keep = pending.len().saturating_sub(64);
                            if keep > 0 {
                                append_result(&mut result, &mut truncated, &String::from_utf8_lossy(&pending[..keep]));
                                pending.drain(..keep);
                            }
                            quiet_since = None;
                        } else if quiet_since.is_none() {
                            quiet_since = Some(Instant::now());
                        }
                        // The 633;D marker is the AUTHORITATIVE "command
                        // finished" signal: while its confirm window runs, a
                        // quiet gap must not trigger the idle path — the
                        // command may be done and the marker chunk simply not
                        // read yet.
                        if let Some(at) = marker_seen_at {
                            if at.elapsed() >= marker_confirm {
                                wait_reason = "marker";
                                break;
                            }
                        } else if let Some(qs) = quiet_since {
                            if qs.elapsed() >= quiet_dur {
                                // Unknown-shell backends (ssh/serial) keep the
                                // bounded once-extension quiet path. 633 shells
                                // never break on quiet — the 633;D marker (at
                                // command end) or the deadline is the only
                                // terminator.
                                if !shell_633 {
                                    if !quiet_extended {
                                        quiet_extended = true;
                                        quiet_since = Some(Instant::now());
                                        quiet_confirm_at = Some(Instant::now() + idle_confirm);
                                    } else if quiet_confirm_at.map(|t| Instant::now() >= t).unwrap_or(true) {
                                        wait_reason = "idle";
                                        break;
                                    }
                                } else {
                                    // Still waiting for 633;D — keep polling
                                    // (the deadline check below ends the wait
                                    // if the command truly hangs).
                                    quiet_since = Some(Instant::now());
                                }
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
                    // round-103: flush the un-finalized marker window — the
                    // last ≤64 bytes of real output sat in `pending` and were
                    // DROPPED on the idle/timeout break (a short command's
                    // ENTIRE output; marker-less SSH/serial always).
                    if !pending.is_empty() {
                        let keep = pending.len();
                        append_result(&mut result, &mut truncated, &String::from_utf8_lossy(&pending[..keep]));
                        pending.clear();
                    }
                    // Audit trail: command ended, with the shell's exit code
                    // (marker) and the reason the wait stopped (round-54).
                    logger.log_command_end(&sid, marker_code, Some(wait_reason),
                        Some(cmd_started.elapsed().as_millis() as u64));
                    // Release the per-session execute lock (round-55) — the
                    // only exit path from the wait loop.
                    terminal_mgr.term_release_execute(&sid).await;
                    bus.emit(&AgentEvent::ShellExec { command });
                    // stage-m: no wrapper → nothing to strip. The 633
                    // sequences are invisible on the terminal and were already
                    // consumed during the wait.
                    let result = result;
                    // Strip ANSI/OSC noise for the model — the MCP text path
                    // must be printable text; the panel keeps raw bytes
                    // via its own SSE stream (round-54, dsh sanitize.ts).
                    let result = clean_terminal_output(result.as_bytes());
                    let state = match wait_reason {
                        "marker" => "done",
                        // stage-l: a wrapped command whose START marker never
                        // arrived is a DEFINITE failure (the shell swallowed
                        // the wrapper) — report it like a timeout, never as
                        // "still running" (that note would make the model
                        // re-read/retry a command that never started).
                        "start-timeout" => "timeout",
                        "timeout" => "timeout",
                        _ => "partial",
                    };
                    Ok(execute_result_json(
                        state, result, truncated, timed_out, wait_reason, marker_code, read_abs,
                    ))
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
                    ) -> tokio::task::JoinHandle<()> {
                        tokio::spawn(async move {
                            let mut buf = [0u8; 8192];
                            loop {
                                match stream.read(&mut buf).await {
                                    Ok(0) | Err(_) => break,
                                    Ok(n) => { if tx.send(buf[..n].to_vec()).await.is_err() { break; } }
                                }
                            }
                        })
                    }
                    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
                    // round-n: never panic on a missing pipe — tokio spawn
                    // with Stdio::piped() normally guarantees both, but a
                    // defensive take() keeps a platform quirk from killing
                    // the whole execute handler (MCP request) with an
                    // unwrap panic. Missing stdout → no output capture;
                    // missing stderr just drops stderr. Both reader tasks
                    // are still spawned so the wait loop below behaves the
                    // same (an empty reader just ends immediately).
                    let reader_stdout = match child.stdout.take() {
                        Some(out) => pipe_reader(out, tx.clone()),
                        None => tokio::task::spawn(async {}),
                    };
                    let reader_stderr = match child.stderr.take() {
                        Some(err) => pipe_reader(err, tx.clone()),
                        None => tokio::task::spawn(async {}),
                    };
                    drop(tx); // main loop is the last receiver

                    const MAX_LOCAL_BYTES: usize = 1_048_576; // 1 MB tail cap
                    let mut captured: Vec<u8> = Vec::new();
                    let mut truncated = false;
                    let mut timed_out = false;
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
                    // Capture tail append + truncation — shared by the live
                    // receive path and the final drain before exit (round-57).
                    let append_chunk = |captured: &mut Vec<u8>, truncated: &mut bool, c: Vec<u8>| {
                        if captured.len() + c.len() > MAX_LOCAL_BYTES {
                            let keep = MAX_LOCAL_BYTES / 2;
                            if captured.len() > keep {
                                captured.drain(..captured.len() - keep);
                            }
                            *truncated = true;
                        }
                        captured.extend_from_slice(&c);
                        if captured.len() > MAX_LOCAL_BYTES {
                            captured.drain(..captured.len() - MAX_LOCAL_BYTES);
                            *truncated = true;
                        }
                    };
                    loop {
                        tokio::select! {
                            chunk = rx.recv() => {
                                if let Some(c) = chunk {
                                    append_chunk(&mut captured, &mut truncated, c);
                                } else {
                                    // Both pipes closed but the child still runs
                                    // (`sh -c 'exec >/dev/null 2>&1; sleep 100'`)
                                    // — recv() returns None IMMEDIATELY every
                                    // round, and select! keeps picking the only
                                    // ready branch, starving the 50ms probe and
                                    // hot-spinning try_wait at full core. Yield
                                    // briefly (round-58: round-57 dropped the
                                    // old is_closed throttle and re-opened the
                                    // burn).
                                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                                }
                            }
                            // Periodic wakeup so the exit probe below runs even
                            // when NO output ever arrives — a daemonized
                            // grandchild holding the pipes open keeps rx.recv()
                            // pending forever (round-57: the probe sat AFTER the
                            // select, which never woke in pure-silent daemon
                            // cases — `sh -c 'sleep 100 & exit 0'` was falsely
                            // reported as TIMEOUT).
                            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
                        }
                        // Deadline check OUTSIDE the select (round-59): select!
                        // picks the FIRST ready branch in declaration order —
                        // after both pipes EOF, rx.recv() is Ready(None) every
                        // round, so the None branch always wins and a sleep
                        // branch declared after it NEVER fires (verified: the
                        // timeout branch did not trigger once in 60 rounds).
                        // The timeout contract ("kill the command at the
                        // deadline") was silently broken for pipe-closed
                        // commands; a plain instant compare cannot starve.
                        if std::time::Instant::now() >= deadline {
                            timed_out = true;
                            break;
                        }
                        // Exit probe — the authoritative done signal (round-56):
                        // the child exited but a daemon grandchild keeps rx
                        // open forever.
                        if let Ok(Some(_)) = child.try_wait() {
                            // round-107/108: the exit-flush drain used
                            // try_recv — the pipe_reader tasks may still hold
                            // the final bytes, so a fast exit lost the tail.
                            // Give the readers one bounded tick to flush and
                            // APPEND the received chunk (the R107 fix
                            // discarded it with `let _`).
                            if let Ok(Some(c)) = tokio::time::timeout(
                                std::time::Duration::from_millis(50),
                                rx.recv(),
                            ).await {
                                append_chunk(&mut captured, &mut truncated, c);
                            }
                            // Drain whatever the exit flushed out (round-57):
                            // skipping this silently dropped up to 16 chunks
                            // (~128KB) of tail output with truncated unset.
                            while let Ok(c) = rx.try_recv() {
                                append_chunk(&mut captured, &mut truncated, c);
                            }
                            // round-115: the readers block in stream.read(),
                            // NOT tx.send — closing rx only fails future sends
                            // and does NOT wake the pending reads (round-55's
                            // "Close rx so the two pipe_reader tasks stop
                            // blocking" was wrong for the daemon case: a
                            // grandchild inherits the pipe write ends, so the
                            // reads never EOF and 2 tasks + 2 fds leaked per
                            // execute forever). Abort them explicitly.
                            rx.close();
                            reader_stdout.abort();
                            reader_stderr.abort();
                            break;
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
                            append_chunk(&mut captured, &mut truncated, c);
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
                    // Unified shape (round-60): same `kind`/`output`/truncated
                    // contract as the session mode; stdout/stderr stay as
                    // attached fields for old parsers.
                    Ok(json!({
                        "kind": "local",
                        "text": result,
                        "truncated": truncated,
                    }))
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
                        // round-105: a closed session lives in history —
                        // terminal_read serves it; screen must too (an empty
                        // screen misleads the model into 'no output').
                        None => match store.history.get(&session_id) {
                            Some(h) => {
                                let data = &h.buf.data;
                                let mut end = data.len();
                                while end > 0 && (data[end - 1] == b'\n' || data[end - 1] == b'\r') {
                                    end -= 1;
                                }
                                let mut seen = 0;
                                let mut i = end;
                                while i > 0 && seen < lines {
                                    i -= 1;
                                    if data[i] == b'\n' { seen += 1; }
                                }
                                let start = if seen >= lines { i + 1 } else { 0 };
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
                // round-110/111: a caller-supplied line up to the 1MB HTTP
                // body limit × 200 ring entries = 200MB retained. Cap a
                // line — at a CHAR boundary (the R110 &line[..4096] panicked
                // when byte 4096 fell mid-UTF-8, the R106-H1 class).
                let bound = line.floor_char_boundary(4096);
                let capped = if line.len() > bound { &line[..bound] } else { &line };
                let mut d = recover_guard(&diag);
                d.push(format!("{} {capped}", chrono_timestamp()));
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

fn tool_secret_set(name: &'static str) -> ToolDef {
    ToolDef::new(
        name,
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

fn tool_secret_get(name: &'static str) -> ToolDef {
    ToolDef::new(
        name,
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

fn tool_secret_delete(name: &'static str) -> ToolDef {
    ToolDef::new(
        name,
        "Delete a stored secret for a target host.",
        json!({"type":"object","properties":{"target":{"type":"string"}},"required":["target"]}),
        move |params: Value| async move {
            let target = require_str(&params, "target")?;
            crate::tools::terminal::secret_delete(&target)?;
            Ok(json!("deleted"))
        },
    )
}

/// List every successfully-opened connection (round-70) — the device's
/// connection memory. An AI reconnects via terminal_connect_saved instead of
/// re-entering the target/params from scratch.
fn tool_saved_connections() -> ToolDef {
    ToolDef::new(
        "terminal_saved_connections",
        "List saved terminal connections (successfully-opened sessions). Each entry has id (kind:target), kind, target, label and the original open params — reconnect with terminal_connect_saved. Connect-failures are not saved; a reconnect updates the entry.",
        json!({"type":"object","properties":{},"additionalProperties":false}),
        move |_params: Value| async move {
            #[cfg(feature = "terminal")]
            let conns = crate::tools::terminal::conn_list();
            #[cfg(not(feature = "terminal"))]
            let conns: Vec<serde_json::Value> = vec![];
            Ok(json!({ "connections": conns }))
        },
    )
}

/// Reconnect to a saved connection by id (round-70). The saved params are
/// replayed through terminal_open (baud/parity/rows/cols preserved), so a
/// serial console reconnects at the same link config without re-typing it.
fn tool_connect_saved(
    terminal_mgr: &Arc<TerminalManager>,
    bus: &Arc<dyn EventBus>,
    output_buf: &OutputBuf,
    logger: &crate::session_log::SessionLogger,
    buffer_limit: &Arc<std::sync::atomic::AtomicUsize>,
) -> ToolDef {
    let terminal_mgr = terminal_mgr.clone();
    let bus = bus.clone();
    let buf = output_buf.clone();
    let logger = logger.clone();
    let buffer_limit = buffer_limit.clone();
    ToolDef::new(
        "terminal_connect_saved",
        "Reconnect to a saved terminal connection (from terminal_saved_connections) by id. Replays the saved params through terminal_open; returns the new session id. Optional params override the saved ones.",
        json!({"type":"object","properties":{"id":{"type":"string","description":"The id (kind:target) from terminal_saved_connections."},"rows":{"type":"integer"},"cols":{"type":"integer"}},"required":["id"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            let bus = bus.clone();
            let buf = buf.clone();
            let logger = logger.clone();
            let buffer_limit = buffer_limit.clone();
            async move {
                let id = require_str(&params, "id")?;
                // round-109: headless — silence the unused closure clones.
                #[cfg(not(feature = "terminal"))]
                let _ = (&terminal_mgr, &bus, &buf, &logger, &buffer_limit, &id);
                // round-108: saved connections are terminal-feature only.
                #[cfg(feature = "terminal")]
                {
                    let conn = crate::tools::terminal::conn_list()
                        .into_iter()
                        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
                        .ok_or_else(|| DeviceError::Internal { message: format!("unknown saved connection: {id}") })?;
                    let mut open_params = conn.get("params").and_then(|p| p.as_object()).cloned().unwrap_or_default();
                    // Overrides: rows/cols from the caller win.
                    if let Some(r) = params.get("rows") { open_params.insert("rows".into(), r.clone()); }
                    if let Some(c) = params.get("cols") { open_params.insert("cols".into(), c.clone()); }
                    // Reuse the open handler's full body (prompt-marker injection,
                    // audit, connection memory) via a fresh closure.
                    let handler = {
                        let terminal_mgr = terminal_mgr.clone();
                        let bus = bus.clone();
                        let buf = buf.clone();
                        let logger = logger.clone();
                        let buffer_limit = buffer_limit.clone();
                        tool_open(&terminal_mgr, &bus, &buf, &logger, &buffer_limit).handler
                    };
                    return handler.call(serde_json::Value::Object(open_params)).await;
                }
                #[cfg(not(feature = "terminal"))]
                return Err(DeviceError::Internal { message: "terminal feature disabled".into() });
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::terminal::{DiagBuf, SessionStore};
    use crate::tools::serial::SerialPool;
    #[cfg(feature = "terminal")]
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
        let tools = build(&mgr, &serial, &bus, &buf, &diag, &logger, &Arc::new(std::sync::atomic::AtomicUsize::new(8 * 1024 * 1024)));
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
    async fn screen_utf8_multibyte_survives() {
        let (tools, buf) = seeded_tools();
        seed(&buf, "s1", "héllo wörld\nsécond líne".as_bytes(), 0);
        let out = call(find(&tools, "terminal_screen"), json!({"session_id": "s1", "lines": 10})).await;
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
        let out = call(find(&tools, "terminal_read"), json!({"session_id": "spill-s1", "offset": 6, "clean": false})).await;
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
        buf.lock().unwrap().retain_live("s1", "serial", "COM4", None);
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
        buf.lock().unwrap().retain_live("s1", "ssh", "admin@host", None);
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
        buf.lock().unwrap().retain_live("s1", "pty", "shell", Some(42));
        let out = call(find(&tools, "terminal_history"), json!({})).await;
        let arr = out.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["exit_code"], 42, "natural exit code must surface in history");
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
            store.live.entry(format!("s{i}")).or_default().data.extend_from_slice(b"x");
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
            store.live.entry(format!("s{i}")).or_default().data.extend_from_slice(b"xx");
            store.retain_live(&format!("s{i}"), "pty", "shell", None);
        }
        // Total bytes exceed 3 → evict oldest until under. s0 (2B) evicted first.
        let total: u64 = store.history.values().map(|h| h.buf.end_abs() as u64).sum();
        assert!(total <= 3, "history bytes {total} exceed cap");
    }

    #[test]
    fn retain_idempotent_second_call_false() {
        let mut store = SessionStore::new();
        store.live.entry("s1".into()).or_default().data.extend_from_slice(b"hi");
        assert!(store.retain_live("s1", "pty", "shell", None), "first retain moves it");
        assert!(!store.retain_live("s1", "pty", "shell", None), "second retain is a no-op");
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
        // Unified shape (round-60): {"kind":"local","text":...,"truncated":...}.
        assert_eq!(out["kind"], "local");
        let text = out["text"].as_str().unwrap_or_default();
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
            assert!(!text.contains("\x1b]633"), "no raw 633 bytes may leak: {text:?}");
            assert!(text.contains("PS C:\\Users\\x>"), "next prompt must be in result: {text:?}");
        }

        #[test]
        fn pty_stream_marker_split_inside_exit_code() {
            // The 633;D sequence is split mid-exit-code across chunks — the
            // carry buffer must bridge it and still report the code.
            let chunks: &[&[u8]] = &[
                b"ok\r\n\x1b]633;D;",
                b"42\x07\x1b]633;A\x07PS> ",
            ];
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
            assert!(text.contains("cmd-1") && text.contains("cmd-2"), "both commands in result: {text:?}");
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
        assert!(!text.contains("[note:"), "done must not carry the partial note");
        assert_eq!(out["exit_code"], 0);
    }

    #[test]
    fn execute_result_partial_carries_note_and_flag() {
        let out = execute_result_json("partial", "half".into(), false, false, "idle", None, 4);
        assert_eq!(out["state"], "partial");
        assert_eq!(out["still_running"], true);
        let text = out["text"].as_str().unwrap_or_default();
        assert!(text.starts_with("half"), "partial must keep the prefix: {text}");
        assert!(text.contains("[note:"), "partial must carry the continuation note: {text}");
        assert!(text.contains("terminal_read"), "note must name terminal_read: {text}");
        assert!(text.contains("Do NOT re-run"), "note must forbid re-runs: {text}");
        assert!(text.contains("do NOT open a new session"), "note must forbid new sessions: {text}");
    }

    #[test]
    fn execute_result_timeout_has_no_note() {
        let out = execute_result_json("timeout", "part".into(), true, true, "timeout", None, 9);
        assert_eq!(out["state"], "timeout");
        assert_eq!(out["still_running"], false, "timeout aborted the command");
        assert_eq!(out["timed_out"], true);
        let text = out["text"].as_str().unwrap_or_default();
        assert!(!text.contains("[note:"), "timeout must not carry the partial note: {text}");
    }
}
