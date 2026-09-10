//! Plugin registry — discovers and manages capability plugins.
//!
//! Tools are the single source of truth for MCP and the Web API.

pub mod design;
pub mod mcp_client;
pub mod memory;
pub mod playwright;
pub mod system;
pub mod terminal;
pub mod update;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use vale_agent_core::DeviceError;
use vale_agent_core::Plugin;

/// Helper: extract a required string field from JSON params.
pub fn require_str(params: &Value, field: &str) -> Result<String, DeviceError> {
    params
        .get(field)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| DeviceError::InvalidParams {
            message: format!("missing required field: {field}"),
        })
}

/// Serialize a value, falling back to an empty JSON array on failure.
/// (Tool results that are expected to serialize can't reasonably fail, but
/// returning `[]` beats propagating a serialization panic.)
pub fn to_value_or_empty<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap_or_else(|_| json!([]))
}

/// The device-tool FAILURE envelope: exactly `{"ok": false, "error": msg}`.
///
/// This is the ONE definition of the convention the system plugin's header
/// documents ("errors are returned as structured JSON, never thrown"): a tool
/// that can fail in a way it wants the MODEL to read reports it in-band and
/// returns `Ok`, rather than raising a [`DeviceError`]. Before this helper the
/// literal was hand-written at 46 sites across four plugins — one shape with
/// 46 independent copies, and no owner to pin it.
///
/// Two DIFFERENT failure families reach a caller, and the distinction matters
/// because the layers above treat them differently:
///
/// * **typed** — `Err(DeviceError)`. `web::api_call_tool` renders it as
///   `{"ok": false, "error", "code"}`, so the outer `ok` is false and the
///   gateway maps `code` onto its own failure class (round-59).
/// * **in-band** (this helper) — `Ok({"ok": false, "error"})`. The same wrapper
///   renders it as `{"ok": true, "result": {"ok": false, …}}`: the OUTER `ok`
///   is TRUE, so a consumer that only inspects `data.ok` (the gateway's
///   round-58 check) does not see a failure here — the message survives as
///   text inside a successful tool result.
///
/// That asymmetry is DELIBERATE and left alone: it is the long-standing
/// contract on the MCP path, where the model reads the envelope as content.
/// It is pinned by tests on both sides so a future change is a visible
/// decision rather than a silent drift — see `tool_error_*` in this module and
/// `tool_error_envelope_survives_the_api_wrapper` in `web`.
pub fn tool_error(message: impl Into<String>) -> Value {
    json!({ "ok": false, "error": message.into() })
}

/// Holds all active plugins and provides access to their tools.
/// Tools are built ONCE at registration time and cached — `find_tool` is O(1)
/// and `all_tools`/spec iteration never re-runs the closure factories.
pub struct PluginRegistry {
    pub plugins: Vec<Box<dyn Plugin>>,
    by_name: HashMap<String, Arc<vale_agent_core::ToolDef>>,
    /// Tools per plugin, built once at register time.
    tools_by_plugin: Vec<(String, Vec<Arc<vale_agent_core::ToolDef>>)>,
}

impl Default for PluginRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginRegistry {
    pub fn new() -> Self {
        Self {
            plugins: vec![],
            by_name: HashMap::new(),
            tools_by_plugin: Vec::new(),
        }
    }

    pub fn register(&mut self, plugin: Box<dyn Plugin>) {
        let tools: Vec<Arc<vale_agent_core::ToolDef>> =
            plugin.tools().into_iter().map(Arc::new).collect();
        for t in &tools {
            if let Some(prev) = self.by_name.insert(t.name.clone(), t.clone()) {
                // Core audit #12: last-wins SHADOWING silently duplicates the
                // name in tools/list (MCP spec violation) while dispatch hits
                // the later handler. None exists today — surface it if one
                // ever does.
                let _ = &prev;
                tracing::warn!("plugin tool name collision: '{}' registered twice", t.name);
            }
        }
        self.tools_by_plugin
            .push((plugin.name().to_string(), tools));
        self.plugins.push(plugin);
    }

    /// All tools across plugins (cached — no rebuilds).
    pub fn all_tools(&self) -> Vec<Arc<vale_agent_core::ToolDef>> {
        self.tools_by_plugin
            .iter()
            .flat_map(|(_, ts)| ts.iter().cloned())
            .collect()
    }

    /// Tools of one plugin by name (cached).
    pub fn plugin_tools(&self, name: &str) -> &[Arc<vale_agent_core::ToolDef>] {
        self.tools_by_plugin
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, ts)| ts.as_slice())
            .unwrap_or(&[])
    }

    pub fn find_tool(&self, name: &str) -> Option<Arc<vale_agent_core::ToolDef>> {
        self.by_name.get(name).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use vale_agent_core::ToolDef;

    /// Counting plugin — tools() must run exactly once at register time.
    struct CountingPlugin(Arc<AtomicUsize>);

    impl Plugin for CountingPlugin {
        fn name(&self) -> &'static str {
            "counting"
        }
        fn display_name(&self) -> &'static str {
            "Counting"
        }
        fn description(&self) -> &'static str {
            ""
        }
        fn tools(&self) -> Vec<ToolDef> {
            self.0.fetch_add(1, Ordering::SeqCst);
            vec![ToolDef::new(
                "c1",
                "one",
                json!({"type": "object"}),
                |_| async move { Ok(json!(1)) },
            )]
        }
    }

    #[test]
    fn tools_built_once_at_register() {
        let count = Arc::new(AtomicUsize::new(0));
        let mut reg = PluginRegistry::new();
        reg.register(Box::new(CountingPlugin(count.clone())));
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "register must build tools once"
        );

        let all = reg.all_tools();
        assert_eq!(all.len(), 1);
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "all_tools must not rebuild"
        );
        assert_eq!(reg.plugin_tools("counting").len(), 1);
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "plugin_tools must not rebuild"
        );
        assert!(reg.find_tool("c1").is_some());
    }

    // ── tool_error: the device-tool failure envelope ──────────

    #[test]
    fn tool_error_is_the_two_key_envelope() {
        // Byte-identity with the literal it replaced at 46 call sites: the
        // shape is EXACTLY {ok:false, error} — no extra keys, and `ok` is the
        // boolean false (not "false", not 0). Consumers match on this.
        let v = tool_error("stat /x: No such file");
        assert_eq!(v, json!({"ok": false, "error": "stat /x: No such file"}));
        assert_eq!(
            v.as_object().map(|o| o.len()),
            Some(2),
            "the envelope carries exactly ok + error"
        );
        assert_eq!(v["ok"], serde_json::Value::Bool(false));
        assert!(v["error"].is_string());
        assert!(
            v.get("code").is_none(),
            "in-band failures carry no code — that is the typed family's job \
             (see the tool_error doc comment)"
        );
    }

    #[test]
    fn tool_error_accepts_owned_and_borrowed_messages() {
        // Call sites pass `&str`, a `String`, or a `format!(...)` with inline
        // args (the shape every migrated site uses); all must render the same
        // string so the migration could not alter an error message.
        let path = "boom";
        let a = tool_error("stat boom: gone");
        let b = tool_error(String::from("stat boom: gone"));
        let c = tool_error(format!("stat {path}: gone"));
        assert_eq!(a, b);
        assert_eq!(b, c);
        assert_eq!(tool_error(""), json!({"ok": false, "error": ""}));
    }
}
