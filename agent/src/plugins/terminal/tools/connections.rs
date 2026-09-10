//! Saved-connection tools — the device's connection memory (round-70):
//! list, reconnect-by-id (replays the saved params through terminal_open)
//! and forget (cascades the keychain secret). One builder fn per MCP tool,
//! built once at registration. Code moved verbatim from the former
//! monolithic `plugins/terminal/tools.rs`.

use serde_json::{json, Value};
use std::sync::Arc;

use crate::plugins::terminal::OutputBuf;
use crate::plugins::{require_str, tool_error};
use crate::tools::terminal::TerminalManager;
use vale_agent_core::{DeviceError, EventBus, ToolDef};
// The reconnect path reuses the open tool's full handler — terminal-feature
// only (headless builds return the explicit "terminal feature disabled"
// error without it).
#[cfg(feature = "terminal")]
use super::sessions::tool_open;

/// List every successfully-opened connection (round-70) — the device's
/// connection memory. An AI reconnects via terminal_connect_saved instead of
/// re-entering the target/params from scratch.
pub(super) fn tool_saved_connections() -> ToolDef {
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

/// Credential audit round MED-4: forget() existed but was UNREACHABLE —
/// saved connections accumulated forever and their keychain passwords
/// orphaned. This tool removes the saved entry AND cascades the secret for
/// ssh targets (the password lives in the vault under the same target).
pub(super) fn tool_forget_saved() -> ToolDef {
    ToolDef::new(
        "terminal_forget_saved",
        "Remove a saved terminal connection by id (from terminal_saved_connections) and delete its stored password (ssh targets). The live session, if any, is untouched.",
        json!({"type":"object","properties":{"id":{"type":"string","description":"The id (kind:target) from terminal_saved_connections."}},"required":["id"]}),
        move |params: Value| async move {
            let id = params.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if id.is_empty() {
                return Ok(tool_error("id is required"));
            }
            #[cfg(feature = "terminal")]
            {
                let removed = crate::tools::terminal::conn_forget(&id)?;
                let mut secret_removed = false;
                if removed {
                    if let Some(target) = id.strip_prefix("ssh:") {
                        // best-effort cascade: forgetting must not fail when
                        // no password was ever stored for this target.
                        secret_removed = crate::tools::terminal::secret_delete(target).is_ok();
                    }
                }
                Ok(json!({ "ok": removed, "id": id, "secret_removed": secret_removed }))
            }
            #[cfg(not(feature = "terminal"))]
            {
                let _ = id;
                Ok(tool_error("terminal support not compiled in"))
            }
        },
    )
}

/// Reconnect to a saved connection by id (round-70). The saved params are
/// replayed through terminal_open (baud/parity/rows/cols preserved), so a
/// serial console reconnects at the same link config without re-typing it.
pub(super) fn tool_connect_saved(
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
                    // Round-359: unknown id is a CALLER error, not an internal
                    // one (was DeviceError::Internal — same class as exec's
                    // "unknown job_id", which correctly uses InvalidParams).
                    // Enrich like ctx::session_lost so the caller can
                    // self-recover from terminal_saved_connections.
                    let conns = crate::tools::terminal::conn_list();
                    let conn = conns
                        .iter()
                        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
                        .cloned()
                        .ok_or_else(|| {
                            let known = conns
                                .iter()
                                .filter_map(|c| {
                                    c.get("id").and_then(|v| v.as_str())
                                })
                                .collect::<Vec<_>>()
                                .join(", ");
                            let known = if known.is_empty() {
                                "(none saved yet — successful terminal_open calls save automatically; list via terminal_saved_connections)".to_string()
                            } else {
                                known
                            };
                            DeviceError::InvalidParams {
                                message: format!(
                                    "unknown saved connection: {id}. Saved connections: [{known}]."
                                ),
                            }
                        })?;
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
