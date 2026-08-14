//! Plugin registry — discovers and manages capability plugins.
//!
//! Tools are the single source of truth for MCP and the Web API.

pub mod design;
pub mod mcp_client;
pub mod terminal;
pub mod update;

use vale_agent_core::DeviceError;
use vale_agent_core::Plugin;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// Helper: extract a required string field from JSON params.
pub fn require_str(params: &Value, field: &str) -> Result<String, DeviceError> {
    params.get(field)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| DeviceError::InvalidParams { message: format!("missing required field: {field}") })
}

/// Serialize a value, falling back to an empty JSON array on failure.
/// (Tool results that are expected to serialize can't reasonably fail, but
/// returning `[]` beats propagating a serialization panic.)
pub fn to_value_or_empty<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap_or_else(|_| json!([]))
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
        Self { plugins: vec![], by_name: HashMap::new(), tools_by_plugin: Vec::new() }
    }

    pub fn register(&mut self, plugin: Box<dyn Plugin>) {
        let tools: Vec<Arc<vale_agent_core::ToolDef>> = plugin.tools().into_iter().map(Arc::new).collect();
        for t in &tools {
            self.by_name.insert(t.name.clone(), t.clone());
        }
        self.tools_by_plugin.push((plugin.name().to_string(), tools));
        self.plugins.push(plugin);
    }

    /// All tools across plugins (cached — no rebuilds).
    pub fn all_tools(&self) -> Vec<Arc<vale_agent_core::ToolDef>> {
        self.tools_by_plugin.iter().flat_map(|(_, ts)| ts.iter().cloned()).collect()
    }

    /// Tools of one plugin by name (cached).
    pub fn plugin_tools(&self, name: &str) -> &[Arc<vale_agent_core::ToolDef>] {
        self.tools_by_plugin.iter()
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
    use vale_agent_core::ToolDef;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Counting plugin — tools() must run exactly once at register time.
    struct CountingPlugin(Arc<AtomicUsize>);

    impl Plugin for CountingPlugin {
        fn name(&self) -> &'static str { "counting" }
        fn display_name(&self) -> &'static str { "Counting" }
        fn description(&self) -> &'static str { "" }
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
        assert_eq!(count.load(Ordering::SeqCst), 1, "register must build tools once");

        let all = reg.all_tools();
        assert_eq!(all.len(), 1);
        assert_eq!(count.load(Ordering::SeqCst), 1, "all_tools must not rebuild");
        assert_eq!(reg.plugin_tools("counting").len(), 1);
        assert_eq!(count.load(Ordering::SeqCst), 1, "plugin_tools must not rebuild");
        assert!(reg.find_tool("c1").is_some());
    }
}