//! Secret tools (OS keychain) — canonical names carry the `terminal_`
//! prefix (stage-l naming unification); the legacy unprefixed names stay as
//! aliases so existing AI clients keep working. One builder fn per MCP
//! tool, built once at registration. Code moved verbatim from the former
//! monolithic `plugins/terminal/tools.rs`.

use serde_json::{json, Value};

use crate::plugins::require_str;
use vale_agent_core::ToolDef;

// ── Secrets (keychain) ─────────────────────────────

pub(super) fn tool_secret_set(name: &'static str) -> ToolDef {
    ToolDef::new(
        name,
        "Store a secret (an SSH password) for a target host, so later sessions to \
         that host do not need it inline. The device is a SERVICE, not a desktop \
         app: it tries the OS keychain first and falls back to a file store, so \
         this works headless. PREFER THIS over putting a password in a command — \
         the audit trail records full command text, and a password in it is a \
         password in the record.",
        json!({"type":"object","properties":{"target":{"type":"string","description":"SSH target (user@host:port)"},"password":{"type":"string"}},"required":["target","password"]}),
        move |params: Value| async move {
            let target = require_str(&params, "target")?;
            let password = require_str(&params, "password")?;
            crate::tools::terminal::secret_set(&target, &password)?;
            Ok(json!("stored"))
        },
    )
}

pub(super) fn tool_secret_get(name: &'static str) -> ToolDef {
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

pub(super) fn tool_secret_delete(name: &'static str) -> ToolDef {
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
