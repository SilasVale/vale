//! Memory Plugin — device-local knowledge base shared across AI clients.
//!
//! AI clients (Claude Code / DSH / the desktop shell) persist and query
//! knowledge entries through 6 MCP tools (memory_save / search / list /
//! update / delete / export). Entries live in `<install>/memory/memory.jsonl`
//! (append-only JSONL + in-memory index), are device-wide (namespace-optional
//! scoping), soft-deleted, and capacity-capped (oldest-written first — see
//! store.rs; this is NOT LRU, because reads do not move `updated_at`) by the
//! config `memory:` limits.
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

    /// THE TOOL MUST DECLARE THE PARAMETER IT IS EXPECTED TO HONOUR.
    ///
    /// `MemoryPage` has passed `params.tag` to `memory_search` since round 161,
    /// and the tool neither declared nor read it — a silent no-op that returned
    /// UNFILTERED results which looked filtered. A declared parameter that is
    /// ignored and an undeclared one that is sent are the same defect from two
    /// sides, so this pins the declaration and the test above pins the behaviour.
    #[test]
    fn memory_search_declares_its_tag_filter() {
        let dir = std::env::temp_dir().join(format!("vale-mem-tagdecl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = MemoryPlugin::new(Arc::new(MemoryStore::new(
            dir.clone(),
            MemoryLimits::default(),
        )));
        let tools = p.tools();
        let search = tools
            .iter()
            .find(|t| t.name == "memory_search")
            .expect("memory_search must exist");
        let props = search
            .input_schema
            .get("properties")
            .and_then(|v| v.as_object())
            .expect("schema properties");
        assert!(
            props.contains_key("tag"),
            "memory_search must declare `tag`: the panel sends it, and an \
             undeclared parameter is dropped without a word. Declared: {:?}",
            props.keys().collect::<Vec<_>>()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE HANDLER MUST ACTUALLY PASS THE TAG THROUGH.
    ///
    /// The store test pins that `search` CAN filter by tag; this pins that the
    /// TOOL asks it to. Both are needed, and only this one would have caught the
    /// original defect: `MemoryPage` sent `params.tag`, the handler read three
    /// parameters and dropped the fourth, and the filter was a silent no-op for
    /// as long as it existed. A test on the store passes happily either way —
    /// the helpers were perfect and the bug was in how they were CALLED.
    #[tokio::test]
    async fn memory_search_honours_the_tag_the_panel_sends() {
        let dir = std::env::temp_dir().join(format!("vale-mem-tagwire-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(MemoryStore::new(dir.clone(), MemoryLimits::default()));
        let mk = |title: &str, tags: &[&str]| store::MemoryRecord {
            id: format!("m-{title}"),
            title: title.to_string(),
            content: "shared body".to_string(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            namespace: "shared".to_string(),
            source: "test".to_string(),
            run_id: None,
            created_at: crate::unix_now(),
            updated_at: crate::unix_now(),
            deleted: false,
        };
        store.insert(mk("alpha", &["net"]));
        store.insert(mk("beta", &["db"]));

        let p = MemoryPlugin::new(store);
        let tools = p.tools();
        let search = tools
            .iter()
            .find(|t| t.name == "memory_search")
            .expect("memory_search must exist");

        // WITHOUT a tag: both records match the body text.
        let all = search
            .handler
            .call(serde_json::json!({"query": "shared"}))
            .await
            .expect("call");
        assert_eq!(
            all["results"].as_array().map(|a| a.len()),
            Some(2),
            "the unfiltered search sees both: {all}"
        );

        // WITH the tag the panel sends: exactly the tagged one. If the handler
        // drops `tag`, this returns 2 and the operator is shown unfiltered
        // results as though the filter had been applied.
        let tagged = search
            .handler
            .call(serde_json::json!({"query": "shared", "tag": "net"}))
            .await
            .expect("call");
        let hits = tagged["results"].as_array().expect("results");
        assert_eq!(
            hits.len(),
            1,
            "the tag filter must reach the store — dropping it is a silent \
             no-op that shows unfiltered results as filtered: {tagged}"
        );
        assert_eq!(hits[0]["title"], "alpha");

        let _ = std::fs::remove_dir_all(&dir);
    }

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
            run_id: None,
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

    /// The RUN gets the same treatment as `source`, and for the same reason:
    /// an edit revises content, it does not re-attribute the knowledge.
    ///
    /// Two halves, both load-bearing. A record that HAS a run keeps it (the
    /// store clones the stored record, and `memory_update` deliberately accepts
    /// no run id, so nothing can overwrite it — the append-only JSONL is
    /// last-wins, so an overwritten provenance would be unrecoverable). And a
    /// record with NO run stays that way: an update is not an occasion to
    /// invent one, which would make an unattributed entry look like the work of
    /// whatever execution happened to touch it last.
    #[test]
    fn update_preserves_an_existing_run_and_never_fabricates_one() {
        let dir = std::env::temp_dir().join(format!("vale-mem-runkeep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(MemoryStore::new(dir.clone(), MemoryLimits::default()));
        let mut stamped = store::MemoryRecord {
            id: "m-stamped".into(),
            title: "learned".into(),
            content: "c".into(),
            tags: vec![],
            namespace: "shared".into(),
            source: "unknown".into(),
            run_id: Some("run-1000-abc123".into()),
            created_at: 0,
            updated_at: 0,
            deleted: false,
        };
        // `insert` keys the record by its OWN id (it does not mint one), so the
        // two records in this test need distinct ids — a shared key would make
        // the second insert silently replace the first.
        let id = store.insert(stamped.clone());
        assert!(store.update(&id, None, Some("revised".into()), None, None, None));
        assert_eq!(
            store.get(&id, false).expect("record").run_id.as_deref(),
            Some("run-1000-abc123"),
            "an edit must not restamp the run that produced the content"
        );

        stamped.id = "m-plain".into();
        stamped.run_id = None;
        let plain = store.insert(stamped);
        assert!(store.update(&plain, None, Some("revised again".into()), None, None, None));
        assert_eq!(
            store.get(&plain, false).expect("record").run_id,
            None,
            "an update must not fabricate a run for an unattributed record"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
