//! Memory MCP tools — device-local knowledge the AI curates across sessions
//! and clients. 6 tools: memory_save / memory_search / memory_list /
//! memory_update / memory_delete / memory_export.
//!
//! All tools operate on the shared MemoryStore (device-wide); `namespace`
//! optionally scopes a query/save.
//!
//! `source` (the writing client identity) is INTENDED to be captured at the
//! transport, but the capture is not wired — see `set_source` — so records are
//! stamped "unknown" today. The gap is pinned by a test in this plugin's
//! parent module rather than left as a claim here.
//!
//! `run_id` (the EXECUTION that produced an entry) is a different question and
//! IS wired: `memory_save` reads it from its params like every other run-aware
//! tool, and it comes back out through search/list/export. `memory_update`
//! deliberately does not take one — see the note at its store call.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use super::store::SearchQuery;
use serde_json::{json, Value};
use vale_agent_core::ToolDef;

/// Ceiling on `memory_list`. The same 50 `memory_search` has always used — a list that can
/// return every record's full content in one result is a transport problem, not a feature.
const MAX_LIST_LIMIT: u64 = 50;

use crate::plugins::tool_error;

use super::sanitize::sanitize;
use super::store::{clean_run_id, MemoryLimits, MemoryRecord, MemoryStore};

/// Current client source for writes.
///
/// SOLID R109: this is ALWAYS `"unknown"` today — see `set_source`.
static SOURCE: LazyLock<std::sync::Mutex<String>> =
    LazyLock::new(|| std::sync::Mutex::new("unknown".to_string()));

/// Set the writing-client identity.
///
/// NOT WIRED (SOLID R109): this has no caller anywhere in the repo, so
/// `SOURCE` keeps its `"unknown"` initializer and every record written through
/// `memory_save` is stamped `"unknown"` — the identity capture described in
/// this module's header does not actually happen. Recorded rather than
/// repaired because wiring it is a BEHAVIOUR change, not a refactor: it needs
/// a product decision about what identity to record (the MCP client's
/// `clientInfo.name`? the device-local transport?) and where in the handshake
/// to take it. The gap is pinned by
/// `plugins::memory::tests::records_are_stamped_unknown_until_set_source_is_wired`
/// so it cannot be mistaken for a working feature again.
pub fn set_source(source: &str) {
    *SOURCE.lock().unwrap_or_else(|p| p.into_inner()) = source.to_string();
}

/// Mint a new record id: `m-<unix_ts>-<rand6>`.
fn mint_id() -> String {
    // Seconds+nanos+counter: the old ts+counter-only form collided when an
    // update-swap restarted the process within the same second — both ids
    // landed identical and load's last-wins SILENTLY ERASED the earlier
    // entry (memory store review #9).
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst) % 1_000_000;
    format!("m-{}-{:09}-{n:06}", d.as_secs(), d.subsec_nanos())
}

fn source_now() -> String {
    SOURCE.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Build the memory plugin's tool set over a shared store.
pub fn build(store: Arc<MemoryStore>) -> Vec<ToolDef> {
    vec![
        tool_save(store.clone()),
        tool_search(store.clone()),
        tool_list(store.clone()),
        tool_update(store.clone()),
        tool_delete(store.clone()),
        tool_export(store),
    ]
}

/// Failure envelope shared by memory_update / memory_delete — the same
/// wording lets AI clients pattern-match one recovery path ("unknown
/// id" → re-search before retrying).
fn unknown_id_error(id: &str) -> Value {
    tool_error(format!("unknown id: {id}"))
}

fn tool_save(store: Arc<MemoryStore>) -> ToolDef {
    ToolDef::new(
        "memory_save",
        "Save a knowledge entry to the device-local memory store, shared across all AI clients and sessions on this device. Title is required and should be a short unique summary; content is the knowledge body (sanitized: credential-shaped values are redacted); tags help later discovery; namespace defaults to 'shared'. Returns the new entry id. Pass the id run_begin gave you as run_id so this entry is attributable to the execution that learned it; omit it (never send a placeholder) when you are not working inside a declared run.",
        json!({
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short unique summary (required)."},
                "content": {"type": "string", "description": "Knowledge body. Credential-shaped values are redacted."},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional discovery tags."},
                "namespace": {"type": "string", "description": "Optional namespace; default 'shared'."},
                "run_id": {"type": "string", "description": "Optional: the id returned by run_begin, naming the execution that produced this knowledge. It is what joins what you saved to what you ran, so pass the id back verbatim when you save mid-run. Omit the parameter if you did not declare a run."}
            },
            "required": ["title", "content"]
        }),
        move |params: Value| {
            let store = store.clone();
            async move {
                let title = params.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if title.trim().is_empty() {
                    return Ok(tool_error("title is required"));
                }
                if content.trim().is_empty() {
                    return Ok(tool_error("content is required"));
                }
                let tags: Vec<String> = params
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|t| t.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                let namespace = params
                    .get("namespace")
                    .and_then(|v| v.as_str())
                    .unwrap_or("shared")
                    .to_string();
                // Memory audit MEDIUM: namespace was NEVER sanitized — a secret
                // in namespace (password=secret) persisted raw and rode out
                // through search/list/export. Sanitize like title/content/tags.
                let namespace = sanitize(&namespace);
                // The RUN this knowledge was learned in, when the client
                // declared one — read the way `terminal_execute`,
                // `terminal_plan` and `browser_run_script` read the same
                // parameter, with the normalization owned by the store
                // (`clean_run_id`: trimmed, byte-capped on a char boundary,
                // blank → absent). An attribute of the record and nothing
                // more; see `crate::runs` for the rule that governs it.
                let run_id = clean_run_id(params.get("run_id").and_then(|v| v.as_str()));
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let rec = MemoryRecord {
                    id: mint_id(),
                    // the sanitizer used to see ONLY content — a secret in
                    // the title or a tag persisted raw and rode out through
                    // search/list/export (memory store review #5).
                    title: sanitize(&title),
                    content: sanitize(&content),
                    tags: tags.iter().map(|t| sanitize(t)).collect(),
                    namespace,
                    source: source_now(),
                    run_id,
                    created_at: now,
                    updated_at: now,
                    deleted: false,
                };
                // A RECORD THAT DID NOT REACH DISK IS NOT A SUCCESSFUL SAVE. The append's
                // failure used to be discarded, so `ok:true` was returned for a record that
                // lived only in memory and vanished at the next restart.
                let Some(id) = store.insert(rec) else {
                    return Ok(json!({
                        "ok": false,
                        "error": "the record could not be written to disk; it was NOT saved",
                        "hint": "check free space and that the memory directory is writable",
                    }));
                };
                Ok(json!({"ok": true, "id": id}))
            }
        },
    )
}

fn tool_search(store: Arc<MemoryStore>) -> ToolDef {
    ToolDef::new(
        "memory_search",
        "Search the device-local memory store (shared across clients/sessions) by case-insensitive substring over title, content, and tags. Returns entries newest-first with content truncated to a 4KB snippet. Use before starting work to recall prior knowledge, and after work to confirm what was stored.",
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search text (required)."},
                "namespace": {"type": "string", "description": "Optional namespace filter."},
                "tag": {"type": "string", "description": "Optional exact tag filter (case-insensitive). Without it, a tag the caller sends is IGNORED and the unfiltered results look filtered."},
                "limit": {"type": "integer", "description": "Max results (default 20, max 50)."}
            },
            "required": ["query"]
        }),
        move |params: Value| {
            let store = store.clone();
            async move {
                let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if query.trim().is_empty() {
                    return Ok(tool_error("query is required"));
                }
                let namespace = params.get("namespace").and_then(|v| v.as_str());
                // DECLARED AND READ. The panel has sent `tag` since round 161 and
                // this handler dropped it on the floor: a filtered search returned
                // everything, presented as though the filter had been applied.
                // The store could filter by tag all along.
                let tag = params.get("tag").and_then(|v| v.as_str());
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(20)
                    .min(50) as usize;
                let hits = store.search(SearchQuery {
                    text: &query,
                    namespace,
                    tag,
                    limit,
                });
                Ok(json!({"ok": true, "results": hits}))
            }
        },
    )
}

fn tool_list(store: Arc<MemoryStore>) -> ToolDef {
    ToolDef::new(
        "memory_list",
        "List memory entries (newest-first), optionally filtered by namespace and tag. Use to enumerate what is stored on this device.",
        json!({
            "type": "object",
            "properties": {
                "namespace": {"type": "string", "description": "Optional namespace filter."},
                "tag": {"type": "string", "description": "Optional tag filter."},
                "limit": {"type": "integer", "description": "Max results (default 50)."},
                "include_deleted": {"type": "boolean", "description": "Include soft-deleted entries (default false)."}
            }
        }),
        move |params: Value| {
            let store = store.clone();
            async move {
                let namespace = params.get("namespace").and_then(|v| v.as_str());
                let tag = params.get("tag").and_then(|v| v.as_str());
                // CLAMPED, like `memory_search` already does at 50. `limit` had NO ceiling,
                // so `{"limit": 10000000}` returned every record's FULL content in one
                // result — up to ~320 MB from a single call, with the whole store cloned.
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(50)
                    .min(MAX_LIST_LIMIT) as usize;
                let include_deleted = params.get("include_deleted").and_then(|v| v.as_bool()).unwrap_or(false);
                let rows = store.list(namespace, tag, limit, include_deleted);
                Ok(json!({"ok": true, "results": rows}))
            }
        },
    )
}

fn tool_update(store: Arc<MemoryStore>) -> ToolDef {
    ToolDef::new(
        "memory_update",
        "Update an existing memory entry (by id). Provide any subset of title/content/tags/namespace; set deleted=false to restore a soft-deleted entry. Returns success or an error when the id is unknown.",
        json!({
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Entry id (required)."},
                "title": {"type": "string"},
                "content": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
                "namespace": {"type": "string"},
                "deleted": {"type": "boolean", "description": "Set true to soft-delete; false to restore."}
            },
            "required": ["id"]
        }),
        move |params: Value| {
            let store = store.clone();
            async move {
                let id = params.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if id.is_empty() {
                    return Ok(tool_error("id is required"));
                }
                let title = params.get("title").and_then(|v| v.as_str()).map(sanitize)
                    // empty-string title means "clear"? the store treats
                    // Some("") as a real update; keep rejecting it loudly.
                    .filter(|t| !t.trim().is_empty());
                let content = params.get("content").and_then(|v| v.as_str()).map(sanitize);
                let tags = params
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|t| t.as_str().map(|s| sanitize(s.to_string().as_str()))).collect());
                let namespace = params.get("namespace").and_then(|v| v.as_str()).map(sanitize);
                let deleted = params.get("deleted").and_then(|v| v.as_bool());
                // NO run_id parameter, on purpose. An edit revises the content;
                // it does not re-attribute the knowledge, so the run that
                // produced it survives (the store clones the record and writes
                // only the fields above — the same treatment `source` gets, and
                // pinned by `update_preserves_an_existing_run`). Accepting one
                // here would let a later run silently overwrite the provenance
                // on the line a reader ends up seeing, which is the one thing
                // the append-only, last-wins JSONL cannot undo.
                let ok = store.update(&id, title, content, tags, namespace, deleted);
                if ok {
                    Ok(json!({"ok": true, "id": id}))
                } else {
                    Ok(unknown_id_error(&id))
                }
            }
        },
    )
}

fn tool_delete(store: Arc<MemoryStore>) -> ToolDef {
    ToolDef::new(
        "memory_delete",
        "Soft-delete a memory entry by id (it stays recoverable via memory_update deleted=false until compaction). Returns success or an error when the id is unknown.",
        json!({
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Entry id (required)."}
            },
            "required": ["id"]
        }),
        move |params: Value| {
            let store = store.clone();
            async move {
                let id = params.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if id.is_empty() {
                    return Ok(tool_error("id is required"));
                }
                if store.delete(&id) {
                    Ok(json!({"ok": true, "id": id, "deleted": true}))
                } else {
                    Ok(unknown_id_error(&id))
                }
            }
        },
    )
}

fn tool_export(store: Arc<MemoryStore>) -> ToolDef {
    ToolDef::new(
        "memory_export",
        "Export all memory entries (including soft-deleted, flagged) as JSONL text — for backup, migration, or human review. Optionally scoped to a namespace.",
        json!({
            "type": "object",
            "properties": {
                "namespace": {"type": "string", "description": "Optional namespace filter."}
            }
        }),
        move |params: Value| {
            let store = store.clone();
            async move {
                let namespace = params.get("namespace").and_then(|v| v.as_str());
                let text = store.export(namespace);
                Ok(json!({"ok": true, "export": text, "lines": text.lines().count()}))
            }
        },
    )
}

/// MemoryStore construction helper (used by the plugin and tests).
pub fn open_store(dir: std::path::PathBuf, limits: MemoryLimits) -> Arc<MemoryStore> {
    Arc::new(MemoryStore::new(dir, limits))
}

#[cfg(test)]
mod dispatch_tests {
    //! SOLID Round-64: the dispatch layer (param extraction, validation
    //! envelopes, sanitization at the tool boundary, unknown-id wording)
    //! had zero pins — store.rs covers the store, e2e covers live devices,
    //! but nothing proved the six ToolDef handlers translate between the
    //! two. Temp-dir store per test; handlers run through the real registry
    //! builders exactly as production dispatches them.
    use super::*;

    fn test_store(tag: &str) -> (Arc<MemoryStore>, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("vale-mem-dispatch-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (open_store(dir.clone(), MemoryLimits::default()), dir)
    }

    fn tool<'a>(tools: &'a [ToolDef], name: &str) -> &'a ToolDef {
        tools
            .iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("missing tool: {name}"))
    }

    #[tokio::test]
    async fn save_search_update_delete_export_roundtrip() {
        let (store, dir) = test_store("roundtrip");
        let tools = build(store);
        let save = tool(&tools, "memory_save");
        let out = save
            .handler
            .call(json!({"title": "deploy notes", "content": "restart after update", "tags": ["ops"]}))
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        let id = out["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("m-"), "server-minted id shape: {id}");

        let hits = tool(&tools, "memory_search")
            .handler
            .call(json!({"query": "restart"}))
            .await
            .unwrap();
        assert_eq!(hits["ok"], true);
        assert_eq!(hits["results"].as_array().unwrap().len(), 1);

        let upd = tool(&tools, "memory_update")
            .handler
            .call(json!({"id": id.clone(), "content": "restart after update v2"}))
            .await
            .unwrap();
        assert_eq!(upd["ok"], true);
        assert_eq!(upd["id"], id.as_str());

        let list = tool(&tools, "memory_list")
            .handler
            .call(json!({}))
            .await
            .unwrap();
        assert_eq!(list["results"].as_array().unwrap().len(), 1);

        let exp = tool(&tools, "memory_export")
            .handler
            .call(json!({}))
            .await
            .unwrap();
        assert_eq!(exp["ok"], true);
        assert_eq!(exp["lines"], 1);
        assert!(exp["export"].as_str().unwrap().contains(&id));

        let del = tool(&tools, "memory_delete")
            .handler
            .call(json!({"id": id}))
            .await
            .unwrap();
        assert_eq!(del["deleted"], true);
        let gone = tool(&tools, "memory_list")
            .handler
            .call(json!({}))
            .await
            .unwrap();
        assert_eq!(
            gone["results"].as_array().unwrap().len(),
            0,
            "soft-deleted hidden by default"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn save_validates_title_and_content_as_ok_envelopes() {
        // Validation failures are Ok({ok:false}) values, NOT handler errors —
        // the MCP layer surfaces them as tool results, never transport errors.
        let (store, dir) = test_store("validate");
        let tools = build(store);
        let save = tool(&tools, "memory_save");
        for params in [
            json!({"content": "x"}),
            json!({"title": "x"}),
            json!({"title": " ", "content": "x"}),
        ] {
            let out = save.handler.call(params).await.unwrap();
            assert_eq!(out["ok"], false, "missing/blank field rejected");
        }
        let search = tool(&tools, "memory_search");
        let out = search.handler.call(json!({})).await.unwrap();
        assert_eq!(out["ok"], false, "missing query rejected as value");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn save_sanitizes_key_shaped_title_before_it_is_searchable() {
        // Review #5 class at the dispatch boundary: a secret-shaped title
        // (key=value form, the shape the sanitizer redacts) must redact
        // before persistence — bare prose stays verbatim by design (see
        // sanitize.rs: no separator means no key boundary).
        let (store, dir) = test_store("sanitize");
        let tools = build(store);
        let out = tool(&tools, "memory_save")
            .handler
            .call(json!({"title": "token=abc123hunter", "content": "plain body"}))
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        let hits = tool(&tools, "memory_search")
            .handler
            .call(json!({"query": "token"}))
            .await
            .unwrap();
        let found = &hits["results"].as_array().unwrap()[0];
        let title = found["title"].as_str().unwrap();
        assert!(
            !title.contains("abc123hunter"),
            "secret redacted, got: {title}"
        );
        assert!(title.contains("<redacted>"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (a) A run id on `memory_save`'s params lands on the record and comes
    /// back out of ALL THREE read paths.
    ///
    /// Stored provenance that only one query surfaces is a half-answer: the
    /// point of the field is to join "what I ran" to "what I learned", and the
    /// knowledge is reached through search (recall), list (enumeration) and
    /// export (the backup/audit path). `export` matters most of the three — a
    /// field the export drops is a field that does not survive a round trip.
    #[tokio::test]
    async fn a_saved_run_id_reads_back_through_list_search_and_export() {
        let (store, dir) = test_store("runid");
        let tools = build(store);
        let saved = tool(&tools, "memory_save")
            .handler
            .call(json!({
                "title": "psu notes",
                "content": "the reboot loop was the psu",
                "run_id": "run-1000-abc123"
            }))
            .await
            .unwrap();
        assert_eq!(saved["ok"], true);

        let list = tool(&tools, "memory_list")
            .handler
            .call(json!({}))
            .await
            .unwrap();
        assert_eq!(
            list["results"][0]["run_id"], "run-1000-abc123",
            "list must surface the run that produced the entry"
        );
        let hits = tool(&tools, "memory_search")
            .handler
            .call(json!({"query": "psu"}))
            .await
            .unwrap();
        assert_eq!(
            hits["results"][0]["run_id"], "run-1000-abc123",
            "search must surface the run"
        );
        let exp = tool(&tools, "memory_export")
            .handler
            .call(json!({}))
            .await
            .unwrap();
        assert!(
            exp["export"]
                .as_str()
                .unwrap()
                .contains("\"run_id\":\"run-1000-abc123\""),
            "export is the backup path — the run must survive it: {}",
            exp["export"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (b) A save with NO run id acquires none — and the KEY is absent from the
    /// stored line, not present-and-null.
    ///
    /// A fabricated run is worse than a missing one: it reads as evidence that
    /// an execution produced this record, and a reader grouping by run id would
    /// file it under work that had nothing to do with it.
    #[tokio::test]
    async fn a_save_without_a_run_id_records_no_run_at_all() {
        let (store, dir) = test_store("norunid");
        let tools = build(store);
        let saved = tool(&tools, "memory_save")
            .handler
            .call(json!({"title": "phone note", "content": "not from a run"}))
            .await
            .unwrap();
        assert_eq!(saved["ok"], true);

        let list = tool(&tools, "memory_list")
            .handler
            .call(json!({}))
            .await
            .unwrap();
        assert!(
            list["results"][0].get("run_id").is_none(),
            "no run declared → no run_id on the wire, got {}",
            list["results"][0]
        );
        let raw = std::fs::read_to_string(dir.join("memory.jsonl")).unwrap();
        assert!(
            !raw.contains("run_id"),
            "the stored line must not carry the key at all: {raw}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (d) An over-long id is CAPPED on a char boundary (and the save still
    /// succeeds), while a blank one is ABSENT — the normalization
    /// `terminal_execute` and `browser_run_script` apply to the same string.
    #[tokio::test]
    async fn an_overlong_or_blank_run_id_is_normalized_at_the_tool_boundary() {
        use crate::plugins::memory::store::RUN_ID_MAX_BYTES;
        let (store, dir) = test_store("runidcap");
        let tools = build(store);
        let save = tool(&tools, "memory_save");
        // Every char is 3 bytes, so a naive byte cut lands inside 汉.
        let huge = "汉".repeat(400);
        let out = save
            .handler
            .call(json!({"title": "huge", "content": "b", "run_id": huge}))
            .await
            .unwrap();
        assert_eq!(out["ok"], true, "an over-long id must not fail the save");
        let list = tool(&tools, "memory_list")
            .handler
            .call(json!({}))
            .await
            .unwrap();
        let stored = list["results"][0]["run_id"].as_str().unwrap().to_string();
        assert!(
            stored.len() <= RUN_ID_MAX_BYTES,
            "capped, got {} bytes",
            stored.len()
        );
        assert_eq!(
            stored.chars().count() * 3,
            stored.len(),
            "the cap must land on a char boundary, not inside 汉"
        );

        let out = save
            .handler
            .call(json!({"title": "blank", "content": "b", "run_id": "   "}))
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        let list = tool(&tools, "memory_list")
            .handler
            .call(json!({}))
            .await
            .unwrap();
        let blank = list["results"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["title"] == "blank")
            .expect("the blank-id record");
        assert!(
            blank.get("run_id").is_none(),
            "a blank id means \"no run\", not a run whose name is empty"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn update_delete_unknown_id_share_one_envelope() {
        let (store, dir) = test_store("unknown");
        let tools = build(store);
        for (name, params) in [
            ("memory_update", json!({"id": "m-nope", "content": "x"})),
            ("memory_delete", json!({"id": "m-nope"})),
        ] {
            let out = tool(&tools, name).handler.call(params).await.unwrap();
            assert_eq!(out, tool_error("unknown id: m-nope"), "{name} envelope");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
