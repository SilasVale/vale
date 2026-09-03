//! Memory MCP tools — device-local knowledge the AI curates across sessions
//! and clients. 6 tools: memory_save / memory_search / memory_list /
//! memory_update / memory_delete / memory_export.
//!
//! All tools operate on the shared MemoryStore (device-wide); `namespace`
//! optionally scopes a query/save. `source` is the writing client identity
//! captured at the transport (MCP handshake) — fallback "unknown".

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use serde_json::{json, Value};
use vale_agent_core::ToolDef;

use super::sanitize::sanitize;
use super::store::{MemoryLimits, MemoryRecord, MemoryStore};

/// Current client source for writes; set by the transport when known.
static SOURCE: LazyLock<std::sync::Mutex<String>> =
    LazyLock::new(|| std::sync::Mutex::new("unknown".to_string()));

/// Set the writing-client identity (called by the MCP layer on handshake).
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

fn tool_save(store: Arc<MemoryStore>) -> ToolDef {
    ToolDef::new(
        "memory_save",
        "Save a knowledge entry to the device-local memory store, shared across all AI clients and sessions on this device. Title is required and should be a short unique summary; content is the knowledge body (sanitized: credential-shaped values are redacted); tags help later discovery; namespace defaults to 'shared'. Returns the new entry id.",
        json!({
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short unique summary (required)."},
                "content": {"type": "string", "description": "Knowledge body. Credential-shaped values are redacted."},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional discovery tags."},
                "namespace": {"type": "string", "description": "Optional namespace; default 'shared'."}
            },
            "required": ["title", "content"]
        }),
        move |params: Value| {
            let store = store.clone();
            async move {
                let title = params.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if title.trim().is_empty() {
                    return Ok(json!({"ok": false, "error": "title is required"}));
                }
                if content.trim().is_empty() {
                    return Ok(json!({"ok": false, "error": "content is required"}));
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
                    created_at: now,
                    updated_at: now,
                    deleted: false,
                };
                let id = store.insert(rec);
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
                "limit": {"type": "integer", "description": "Max results (default 20, max 50)."}
            },
            "required": ["query"]
        }),
        move |params: Value| {
            let store = store.clone();
            async move {
                let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if query.trim().is_empty() {
                    return Ok(json!({"ok": false, "error": "query is required"}));
                }
                let namespace = params.get("namespace").and_then(|v| v.as_str());
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(20)
                    .min(50) as usize;
                let hits = store.search(&query, namespace, limit);
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
                let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
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
                    return Ok(json!({"ok": false, "error": "id is required"}));
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
                let ok = store.update(&id, title, content, tags, namespace, deleted);
                if ok {
                    Ok(json!({"ok": true, "id": id}))
                } else {
                    Ok(json!({"ok": false, "error": format!("unknown id: {id}")}))
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
                    return Ok(json!({"ok": false, "error": "id is required"}));
                }
                if store.delete(&id) {
                    Ok(json!({"ok": true, "id": id, "deleted": true}))
                } else {
                    Ok(json!({"ok": false, "error": format!("unknown id: {id}")}))
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
