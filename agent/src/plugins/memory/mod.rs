//! Memory Plugin — device-local knowledge base shared across AI clients.
//!
//! AI clients (Claude Code / DSH / the desktop shell) persist and query
//! knowledge entries through 6 MCP tools (memory_save / search / list /
//! update / delete / export). Entries live in `<install>/memory/memory.jsonl`
//! (append-only JSONL + in-memory index), are device-wide (namespace-optional
//! scoping), soft-deleted, and LRU-capped by config `memory:` limits.
//!
//! Patterned after the terminal plugin: the plugin holds an `Arc<MemoryStore>`
//! so web.rs routes and the registry share one state machine.

pub mod sanitize;
pub mod store;
pub mod tools;

use std::sync::Arc;

use vale_agent_core::{Plugin, ToolDef};

use store::MemoryStore;

/// Plugin struct — thin facade over the shared MemoryStore.
pub struct MemoryPlugin {
    store: Arc<MemoryStore>,
}

impl MemoryPlugin {
    /// Build the plugin over an existing store (AppState owns the Arc).
    pub fn new(store: Arc<MemoryStore>) -> Self {
        Self { store }
    }

    /// Shared store (web.rs routes read it for tool dispatch state if needed).
    pub fn store(&self) -> Arc<MemoryStore> {
        self.store.clone()
    }
}

impl Plugin for MemoryPlugin {
    fn name(&self) -> &'static str {
        "memory"
    }
    fn display_name(&self) -> &'static str {
        "Memory"
    }
    fn description(&self) -> &'static str {
        "Device-local knowledge base shared across AI clients (memory_save/search/list/update/delete/export)"
    }
    fn tools(&self) -> Vec<ToolDef> {
        tools::build(self.store.clone())
    }
}

/// Default memory store root (under the install dir). The install dir is the
/// directory of the running exe — same heuristic as the update plugin.
pub fn default_memory_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("D:\\vale-agent"))
        .join("memory")
}

#[cfg(test)]
mod tests {
    use super::*;
    use store::MemoryLimits;

    #[test]
    fn plugin_exposes_six_tools() {
        let dir = std::env::temp_dir().join(format!("vale-mem-plugin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(MemoryStore::new(dir.clone(), MemoryLimits::default()));
        let p = MemoryPlugin::new(store);
        assert_eq!(p.name(), "memory");
        let tools = p.tools();
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["memory_save", "memory_search", "memory_list", "memory_update", "memory_delete", "memory_export"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
