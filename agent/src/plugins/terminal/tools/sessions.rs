//! Session-lifecycle tools — open/write/close/list/resize/select/list_ports.
//!
//! One builder fn per MCP tool, built once at registration. The closures
//! capture clones of the shared context (managers, bus, buffer), so the tool
//! list is built a single time by `PluginRegistry::register` and reused for
//! MCP list_tools and the web /api/spec endpoint alike. Code moved verbatim
//! from the former monolithic `plugins/terminal/tools.rs`.

use std::sync::Arc;
use serde_json::{json, Value};

use vale_agent_core::{recover_guard, AgentEvent, DeviceError, EventBus, ToolDef};
use crate::plugins::{require_str, to_value_or_empty};
use crate::plugins::terminal::{OutputBuf, SessionBuf};
use crate::tools::serial::SerialPool;
use crate::tools::terminal::{parse_serial_target, parse_ssh_target, TerminalManager};
use super::ctx::{append_spill, persist_pre_restart, pre_restart_map, rotate_spill, session_lost, MAX_SPILL_BYTES};

// P2-5: drainer frames rerouted after a vanished history entry (warn path
// below). Monotonic process-lifetime counter — a rising value means the
// retain/close race is firing, not silent data loss.
static DRAINER_DROPPED_FRAMES: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

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

/// Max bytes per session buffer before evicting oldest half — now runtime-
/// configurable (round-69): an Arc<AtomicUsize> seeded from
/// config.terminal.buffer_mb and writable via PUT /api/settings. Was a
/// compile-time constant (1MB → 8MB round-68) — a serial console scrolling
/// GPON logs wrapped in seconds, and the value was unchangeable without a
/// rebuild.
pub(super) fn tool_open(
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
                        // P2-5: no expect() on the contains/get pair — degrade
                        // loudly (warn + drop-frame count) instead of panicking
                        // the drainer task mid-stream.
                        let entry: &mut SessionBuf = if store.history.contains_key(&sid_buf) {
                            match store.history.get_mut(&sid_buf) {
                                Some(h) => &mut h.buf,
                                None => {
                                    DRAINER_DROPPED_FRAMES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                    tracing::warn!(
                                        sid = %sid_buf,
                                        dropped = DRAINER_DROPPED_FRAMES.load(std::sync::atomic::Ordering::Relaxed),
                                        "drainer: history entry vanished after contains_key; routing frame to live entry"
                                    );
                                    store.live.entry(sid_buf.clone()).or_default()
                                }
                            }
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
                                // review #5: advance spill_base ONLY when the
                                // rotation truly happened (Windows remove_file
                                // loses to a concurrent terminal_read handle;
                                // advancing anyway misaligns every later spill
                                // read). On failure the evicted bytes simply
                                // drop with `dropped` — the existing gap
                                // invariant already covers it.
                                if rotate_spill(&sid_buf, discard) {
                                    entry.spill_base += discard;
                                }
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

pub(super) fn tool_write(terminal_mgr: &Arc<TerminalManager>) -> ToolDef {
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

pub(super) fn tool_close(terminal_mgr: &Arc<TerminalManager>, bus: &Arc<dyn EventBus>, output_buf: &OutputBuf) -> ToolDef {
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

pub(super) fn tool_list(terminal_mgr: &Arc<TerminalManager>) -> ToolDef {
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

pub(super) fn tool_list_ports(serial_pool: &Arc<SerialPool>) -> ToolDef {
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

pub(super) fn tool_resize(terminal_mgr: &Arc<TerminalManager>) -> ToolDef {
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

pub(super) fn tool_select(terminal_mgr: &Arc<TerminalManager>) -> ToolDef {
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
