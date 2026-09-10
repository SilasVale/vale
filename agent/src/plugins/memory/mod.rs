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

/// Default memory store root — under the DATA dir (C1: registry DataDir,
/// falling back to the exe dir). One source of truth via crate::paths.
pub fn default_memory_dir() -> std::path::PathBuf {
    crate::paths::data_dir().join("memory")
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
            vec![
                "memory_save",
                "memory_search",
                "memory_list",
                "memory_update",
                "memory_delete",
                "memory_export"
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// PINS A KNOWN GAP, not a desired behaviour (SOLID R109).
    ///
    /// `tools::set_source` exists, is documented as "called by the MCP layer
    /// on handshake", and has NO CALLER anywhere in the repo. So `SOURCE`
    /// keeps its `"unknown"` initializer and every record written through
    /// `memory_save` is stamped `"unknown"` — the client-identity capture
    /// three doc comments described does not happen.
    ///
    /// Writing the CURRENT fact down is the point: the gap was invisible
    /// (docs said it worked, nothing contradicted them), and wiring it is a
    /// behaviour change that needs a product decision about WHAT to record.
    /// When someone does wire it, this test fails and they must update it
    /// deliberately — the alternative is another doc comment nobody can trust.
    #[tokio::test]
    async fn records_are_stamped_unknown_until_set_source_is_wired() {
        let dir = std::env::temp_dir().join(format!("vale-mem-source-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(MemoryStore::new(dir.clone(), MemoryLimits::default()));
        let plugin = MemoryPlugin::new(store.clone());
        let save = plugin
            .tools()
            .into_iter()
            .find(|t| t.name == "memory_save")
            .expect("memory_save");
        let saved = save
            .handler
            .call(serde_json::json!({"title": "src probe", "content": "body"}))
            .await
            .expect("memory_save");
        let id = saved["id"].as_str().expect("id").to_string();

        let rec = store.get(&id, false).expect("stored record");
        assert_eq!(
            rec.source, "unknown",
            "source is no longer the hard-coded fallback — if set_source got \
             wired, replace this pin with the real identity contract"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The field is NOT rewritten on update, so a source that arrived from an
    /// older build (or a hand-edited JSONL) survives later edits. That is the
    /// other half of the picture above and would be easy to break while
    /// wiring `set_source`.
    #[tokio::test]
    async fn update_preserves_an_existing_source() {
        let dir = std::env::temp_dir().join(format!("vale-mem-srckeep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(MemoryStore::new(dir.clone(), MemoryLimits::default()));
        let rec = store::MemoryRecord {
            id: String::new(),
            title: "t".into(),
            content: "c".into(),
            tags: vec![],
            namespace: "shared".into(),
            source: "claude-code".into(),
            created_at: 0,
            updated_at: 0,
            deleted: false,
        };
        // `insert` takes ownership and mints the id, so keep it separately.
        let id = store.insert(rec);
        assert!(store.update(&id, Some("t2".into()), None, None, None, None));
        assert_eq!(
            store.get(&id, false).expect("record").source,
            "claude-code",
            "update must not clobber the recorded writing client"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
