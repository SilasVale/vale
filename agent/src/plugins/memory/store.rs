//! MemoryStore — device-local memory as append-only JSONL + in-memory index.
//!
//! Patterned after SessionLogger (append-only JSONL, best-effort writes) but
//! with a queryable in-memory index: records are loaded once at startup,
//! appended on save/update, soft-deleted (never physically removed until
//! compaction), and LRU-evicted when configured capacity is exceeded.
//!
//! File: `<install>/memory/memory.jsonl` (version header + one JSON record
//! per line). Thread-safe via a single std Mutex (recover_guard poison
//! policy); record count is small (user-curated knowledge), so a Mutex is
//! simpler and sufficient — no async locks needed.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use vale_agent_core::recover_guard;

/// Version header written as the first line of a fresh memory file.
const HEADER_TYPE: &str = "memory";
const HEADER_VERSION: u64 = 1;

/// Default single-content cap (bytes) — matches the tool-level 32KB cap.
pub const DEFAULT_MAX_CONTENT_BYTES: usize = 32 * 1024;
/// Default search snippet cap (bytes) returned to callers.
pub const DEFAULT_SNIPPET_BYTES: usize = 4 * 1024;

/// One memory record (one JSONL line).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryRecord {
    pub id: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_namespace")]
    pub namespace: String,
    /// Writing client identity: "claude-code" | "dsh" | "vale-desktop" | "unknown".
    #[serde(default = "default_source")]
    pub source: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub deleted: bool,
}

fn default_namespace() -> String {
    "shared".to_string()
}
fn default_source() -> String {
    "unknown".to_string()
}

impl MemoryRecord {
    /// The effective "id" used for ordering: latest-updated first.
    pub fn is_deleted(&self) -> bool {
        self.deleted
    }
}

/// Capacity policy (from config `memory:`), defaults when unset.
#[derive(Debug, Clone, Copy)]
pub struct MemoryLimits {
    pub max_entries: usize,
    pub max_bytes: usize,
    pub retention_days: Option<u64>,
}

impl Default for MemoryLimits {
    fn default() -> Self {
        Self { max_entries: 10_000, max_bytes: 64 * 1024 * 1024, retention_days: None }
    }
}

/// In-memory store over the JSONL file. All mutations go through the Mutex;
/// file appends are best-effort (a disk failure must not break queries).
pub struct MemoryStore {
    dir: PathBuf,
    limits: MemoryLimits,
    inner: Mutex<Inner>,
}

struct Inner {
    /// id → record (includes soft-deleted records until compaction).
    by_id: HashMap<String, MemoryRecord>,
    /// Ordered ids by updated_at desc (rebuilt lazily on query).
    order: Vec<String>,
    /// tag → ids (case-insensitive keys).
    tag_index: HashMap<String, HashSet<String>>,
    /// Total content bytes (for max_bytes eviction).
    total_bytes: usize,
    dirty: bool,
}

impl MemoryStore {
    /// Open (or create) the store under `dir` (e.g. `<install>/memory/`).
    pub fn new(dir: PathBuf, limits: MemoryLimits) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let store = Self {
            dir,
            limits,
            inner: Mutex::new(Inner {
                by_id: HashMap::new(),
                order: Vec::new(),
                tag_index: HashMap::new(),
                total_bytes: 0,
                dirty: false,
            }),
        };
        store.load();
        // stage-n: physically drop tombstones from the previous process —
        // the append-only JSONL would otherwise keep every soft-deleted
        // record forever (disk + memory growth with no reclaim path).
        store.compact();
        store
    }

    /// Path of the JSONL file.
    fn file_path(&self) -> PathBuf {
        self.dir.join("memory.jsonl")
    }

    /// Load records from disk at startup; rebuild index. Best-effort.
    fn load(&self) {
        let Ok(text) = std::fs::read_to_string(self.file_path()) else { return };
        let mut guard = recover_guard(&self.inner);
        let mut total = 0usize;
        for line in text.lines() {
            // Skip the version header.
            if line.contains("\"type\":\"memory\"") || line.contains("\"type\": \"memory\"") {
                continue;
            }
            let Ok(rec) = serde_json::from_str::<MemoryRecord>(line) else { continue };
            total += rec.content.len();
            guard.by_id.insert(rec.id.clone(), rec.clone());
            for tag in &rec.tags {
                let key = tag.to_lowercase();
                guard.tag_index.entry(key).or_default().insert(rec.id.clone());
            }
        }
        guard.total_bytes = total;
        // order is rebuilt lazily in list/search; mark dirty for the first
        // rebuild.
        guard.dirty = true;
    }

    /// Rebuild the ordered id list (updated_at desc; ties by id ascending).
    fn rebuild_order(&self) {
        let mut guard = recover_guard(&self.inner);
        if !guard.dirty {
            return;
        }
        let mut ids: Vec<String> = guard.by_id.keys().cloned().collect();
        ids.sort_by(|a, b| {
            let ra = &guard.by_id[a];
            let rb = &guard.by_id[b];
            // Newest first (updated_at desc); ties by id ascending for a
            // stable, deterministic query order.
            rb.updated_at.cmp(&ra.updated_at).then_with(|| a.cmp(b))
        });
        guard.order = ids;
        guard.dirty = false;
    }

    /// Append one line to the JSONL (best-effort).
    fn append_line(&self, line: &str) {
        use std::io::Write;
        let path = self.file_path();
        let mut f = match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            Ok(f) => f,
            Err(_) => return,
        };
        // Write version header on a fresh (empty) file.
        if f.metadata().map(|m| m.len() == 0).unwrap_or(false) {
            let _ = writeln!(
                f,
                "{}",
                serde_json::json!({ "type": HEADER_TYPE, "version": HEADER_VERSION })
            );
        }
        let _ = writeln!(f, "{line}");
    }

    /// Compact when tombstones dominate (≥ half of all records) — the eager
    /// reclaim keeps memory + JSONL bounded between restarts. Cheap: a
    /// single lock-free stats read first; the actual compact only runs when
    /// the threshold trips (stage-n).
    fn compact_if_tombstone_heavy(&self) {
        let guard = recover_guard(&self.inner);
        let total = guard.by_id.len();
        // Tiny stores keep tombstones restorable — the majority condition
        // (deleted*2 >= total) is meaningless for 1-3 records and the
        // soft-delete/restore contract must stay reliable there. From 4 up,
        // a majority of tombstones is a real reclaim signal.
        if total < 4 {
            return;
        }
        let deleted = guard.by_id.values().filter(|r| r.deleted).count();
        drop(guard);
        if deleted * 2 >= total {
            self.compact();
        }
    }

    /// Physically remove ALL soft-deleted records — from the in-memory index
    /// AND the JSONL (rewritten via a temp file + rename so an interrupted
    /// compact never truncates the store). The append-only file would
    /// otherwise grow forever with tombstones (stage-n; the header comment
    /// promised compaction but none existed).
    pub fn compact(&self) -> usize {
        let mut guard = recover_guard(&self.inner);
        let before = guard.by_id.len();
        // Drop deleted records from the index + tag index.
        let removed: Vec<String> = guard
            .by_id
            .iter()
            .filter(|(_, r)| r.deleted)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &removed {
            if let Some(rec) = guard.by_id.remove(id) {
                guard.total_bytes = guard.total_bytes.saturating_sub(rec.content.len());
                for tag in &rec.tags {
                    let key = tag.to_lowercase();
                    if let Some(set) = guard.tag_index.get_mut(&key) {
                        set.remove(id);
                        if set.is_empty() {
                            guard.tag_index.remove(&key);
                        }
                    }
                }
            }
        }
        if removed.is_empty() {
            return 0;
        }
        // Rewrite the JSONL with only the survivors (temp + rename).
        let path = self.file_path();
        let tmp = path.with_extension("jsonl.tmp");
        {
            use std::io::Write;
            let mut out = match std::fs::File::create(&tmp) {
                Ok(f) => f,
                Err(_) => return removed.len(), // index updated; disk rewrite best-effort
            };
            let _ = writeln!(
                out,
                "{}",
                serde_json::json!({ "type": HEADER_TYPE, "version": HEADER_VERSION })
            );
            let mut survivors: Vec<&MemoryRecord> = guard.by_id.values().collect();
            survivors.sort_by_key(|r| r.created_at);
            for rec in survivors {
                if let Ok(line) = serde_json::to_string(rec) {
                    let _ = writeln!(out, "{line}");
                }
            }
        }
        let _ = std::fs::rename(&tmp, &path);
        guard.dirty = true;
        tracing::info!("[vale-agent] memory compact: removed {removed_count} tombstone(s)", removed_count = removed.len());
        before.saturating_sub(guard.by_id.len())
    }

    /// Insert a new record; returns its id. Enforces content cap (truncate).
    pub fn insert(&self, mut rec: MemoryRecord) -> String {
        if rec.content.len() > DEFAULT_MAX_CONTENT_BYTES {
            rec.content = truncate_utf8(&rec.content, DEFAULT_MAX_CONTENT_BYTES);
        }
        rec.tags.retain(|t| !t.trim().is_empty());
        let id = rec.id.clone();
        let line = serde_json::to_string(&rec).unwrap_or_default();
        self.append_line(&line);
        {
            let mut guard = recover_guard(&self.inner);
            guard.total_bytes += rec.content.len();
            guard.by_id.insert(id.clone(), rec.clone());
            for tag in &rec.tags {
                guard.tag_index.entry(tag.to_lowercase()).or_default().insert(id.clone());
            }
            guard.dirty = true;
        }
        self.enforce_limits();
        self.compact_if_tombstone_heavy();
        id
    }

    /// Update an existing record's fields (title/content/tags/namespace).
    /// `deleted` may be set to false to restore a soft-deleted record.
    /// Returns false when the id is unknown.
    pub fn update(
        &self,
        id: &str,
        title: Option<String>,
        content: Option<String>,
        tags: Option<Vec<String>>,
        namespace: Option<String>,
        deleted: Option<bool>,
    ) -> bool {
        let now = unix_now();
        // Clone the current record out, mutate the clone, then write back —
        // avoids holding a mutable borrow across tag-index mutation.
        let mut rec = {
            let guard = recover_guard(&self.inner);
            match guard.by_id.get(id) {
                Some(r) => r.clone(),
                None => return false,
            }
        };
        if let Some(t) = title {
            rec.title = t;
        }
        if let Some(c) = content {
            rec.content = truncate_utf8(&c, DEFAULT_MAX_CONTENT_BYTES);
        }
        if let Some(ts) = tags {
            rec.tags = ts.into_iter().filter(|t| !t.trim().is_empty()).collect();
        }
        if let Some(ns) = namespace {
            rec.namespace = ns;
        }
        if let Some(d) = deleted {
            rec.deleted = d;
        }
        rec.updated_at = now;
        {
            let mut guard = recover_guard(&self.inner);
            guard.by_id.insert(id.to_string(), rec.clone());
            // Rebuild the tag index for this record.
            for set in guard.tag_index.values_mut() {
                set.remove(id);
            }
            for t in &rec.tags {
                guard.tag_index.entry(t.to_lowercase()).or_default().insert(id.to_string());
            }
            guard.dirty = true;
        }
        // Append the updated line (best-effort; index already updated).
        let line = serde_json::to_string(&rec).unwrap_or_default();
        self.append_line(&line);
        self.enforce_limits();
        // stage-n: tombstones reclaimed eagerly once they dominate — soft
        // deletes would otherwise accumulate in memory + JSONL forever
        // (only startup compaction cleaned them).
        self.compact_if_tombstone_heavy();
        true
    }

    /// Soft-delete a record; returns false when unknown.
    pub fn delete(&self, id: &str) -> bool {
        self.update(id, None, None, None, None, Some(true))
    }

    /// Look up one record (including soft-deleted when `include_deleted`).
    pub fn get(&self, id: &str, include_deleted: bool) -> Option<MemoryRecord> {
        let guard = recover_guard(&self.inner);
        let rec = guard.by_id.get(id)?;
        if !include_deleted && rec.deleted {
            return None;
        }
        Some(rec.clone())
    }

    /// Case-insensitive substring search over title+content+tags.
    /// Returns records ordered updated_at desc, content truncated to
    /// `snippet_bytes` for the wire.
    pub fn search(&self, query: &str, namespace: Option<&str>, limit: usize) -> Vec<MemoryRecord> {
        self.rebuild_order();
        // Multi-word AND matching: the query is split on whitespace and EVERY
        // term must appear in title/content/tags (order-independent). A bare
        // single word behaves exactly as before (substring match). This makes
        // "conpty exit bug" match entries containing all three terms instead
        // of requiring the literal string — a real recall improvement for
        // free-form queries.
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|t| t.to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        let guard = recover_guard(&self.inner);
        let mut out = Vec::new();
        for id in &guard.order {
            let rec = &guard.by_id[id];
            if rec.deleted {
                continue;
            }
            if let Some(ns) = namespace {
                if rec.namespace != ns {
                    continue;
                }
            }
            let hay = format!(
                "{} {} {}",
                rec.title.to_lowercase(),
                rec.content.to_lowercase(),
                rec.tags.join(" ").to_lowercase()
            );
            if terms.iter().all(|t| hay.contains(t.as_str())) {
                let mut r = rec.clone();
                r.content = truncate_utf8(&r.content, DEFAULT_SNIPPET_BYTES);
                out.push(r);
                if out.len() >= limit {
                    break;
                }
            }
        }
        out
    }

    /// List records (optionally by namespace/tag), updated_at desc.
    pub fn list(
        &self,
        namespace: Option<&str>,
        tag: Option<&str>,
        limit: usize,
        include_deleted: bool,
    ) -> Vec<MemoryRecord> {
        self.rebuild_order();
        let guard = recover_guard(&self.inner);
        let tag_key = tag.map(|t| t.to_lowercase());
        let mut out = Vec::new();
        for id in &guard.order {
            let rec = &guard.by_id[id];
            if !include_deleted && rec.deleted {
                continue;
            }
            if let Some(ns) = namespace {
                if rec.namespace != ns {
                    continue;
                }
            }
            if let Some(tk) = &tag_key {
                if !rec.tags.iter().any(|t| t.to_lowercase() == *tk) {
                    continue;
                }
            }
            out.push(rec.clone());
            if out.len() >= limit {
                break;
            }
        }
        out
    }

    /// Export all records (including soft-deleted, flagged) as JSONL text.
    pub fn export(&self, namespace: Option<&str>) -> String {
        self.rebuild_order();
        let guard = recover_guard(&self.inner);
        let mut lines = Vec::new();
        for id in &guard.order {
            let rec = &guard.by_id[id];
            if let Some(ns) = namespace {
                if rec.namespace != ns {
                    continue;
                }
            }
            if let Ok(line) = serde_json::to_string(rec) {
                lines.push(line);
            }
        }
        lines.join("\n")
    }

    /// Count records (non-deleted).
    pub fn len(&self) -> usize {
        let guard = recover_guard(&self.inner);
        guard.by_id.values().filter(|r| !r.deleted).count()
    }

    /// Whether the store has no live (non-deleted) records.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Enforce capacity limits: LRU evict (soft-delete) oldest-updated first
    /// until under max_entries / max_bytes.
    fn enforce_limits(&self) {
        self.rebuild_order();
        let mut guard = recover_guard(&self.inner);
        let limits = self.limits;
        // Evict while over entry cap. The victim is the OLDEST non-deleted
        // record (smallest updated_at; ties by smallest id) — NOT the last
        // of `order`, which is newest-first for query display.
        while guard.by_id.values().filter(|r| !r.deleted).count() > limits.max_entries {
            let victim = guard
                .by_id
                .iter()
                .filter(|(_, r)| !r.deleted)
                .min_by(|(ia, ra), (ib, rb)| {
                    ra.updated_at.cmp(&rb.updated_at).then_with(|| ia.cmp(ib))
                })
                .map(|(id, _)| id.clone());
            match victim {
                Some(id) => {
                    if let Some(rec) = guard.by_id.get_mut(&id) {
                        rec.deleted = true;
                        rec.updated_at = unix_now();
                    }
                    guard.dirty = true;
                }
                None => break,
            }
        }
        // Evict while over byte cap (same oldest-first victim).
        while guard.total_bytes > limits.max_bytes {
            let victim = guard
                .by_id
                .iter()
                .filter(|(_, r)| !r.deleted)
                .min_by(|(ia, ra), (ib, rb)| {
                    ra.updated_at.cmp(&rb.updated_at).then_with(|| ia.cmp(ib))
                })
                .map(|(id, _)| id.clone());
            match victim {
                Some(id) => {
                    // Compute the new total BEFORE mutating the record, so we
                    // never hold a &mut into by_id while reading
                    // guard.total_bytes.
                    let content_len = guard.by_id.get(&id).map(|r| r.content.len()).unwrap_or(0);
                    let new_total = guard.total_bytes.saturating_sub(content_len);
                    if let Some(rec) = guard.by_id.get_mut(&id) {
                        rec.deleted = true;
                        rec.updated_at = unix_now();
                    }
                    guard.total_bytes = new_total;
                    guard.dirty = true;
                }
                None => break,
            }
        }
        // Retention days: soft-delete records older than retention_days.
        if let Some(days) = limits.retention_days {
            let cutoff = unix_now().saturating_sub(days * 86400);
            let ids: Vec<String> = guard
                .by_id
                .iter()
                .filter(|(_, r)| !r.deleted && r.updated_at < cutoff)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                if let Some(rec) = guard.by_id.get_mut(&id) {
                    rec.deleted = true;
                }
                guard.dirty = true;
            }
        }
    }
}

/// Truncate a string to `max` bytes at a UTF-8 char boundary (append "…").
fn truncate_utf8(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let cut = s.floor_char_boundary(max);
    format!("{}…", &s[..cut])
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique per-test directory (test name suffix) — concurrent `cargo test`
    /// threads would otherwise collide on one shared path.
    fn tmp_store(name: &str) -> (MemoryStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("vale-mem-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (MemoryStore::new(dir.clone(), MemoryLimits::default()), dir)
    }

    fn rec(title: &str, content: &str) -> MemoryRecord {
        MemoryRecord {
            id: format!("m-{}", title),
            title: title.to_string(),
            content: content.to_string(),
            tags: vec![],
            namespace: "shared".to_string(),
            source: "test".to_string(),
            created_at: unix_now(),
            updated_at: unix_now(),
            deleted: false,
        }
    }

    #[test]
    fn insert_and_get() {
        let (s, dir) = tmp_store("insert_get");
        let id = s.insert(rec("hello", "world"));
        assert_eq!(s.get(&id, false).unwrap().title, "hello");
        assert_eq!(s.len(), 1);
        // Persisted to file.
        let text = std::fs::read_to_string(dir.join("memory.jsonl")).unwrap();
        assert!(text.contains("hello"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reload_from_disk() {
        let (s, dir) = tmp_store("reload_from_disk");
        let id = s.insert(rec("persist", "content"));
        drop(s);
        let s2 = MemoryStore::new(dir.clone(), MemoryLimits::default());
        assert_eq!(s2.get(&id, false).unwrap().content, "content");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_matches_title_content_tags() {
        let (s, dir) = tmp_store("search_matches_title_content_tags");
        let mut a = rec("Alpha", "the quick brown fox");
        a.tags = vec!["net".to_string()];
        let _ = s.insert(a);
        let _ = s.insert(rec("Beta", "unrelated"));
        assert_eq!(s.search("quick", None, 10).len(), 1);
        assert_eq!(s.search("alpha", None, 10).len(), 1);
        assert_eq!(s.search("net", None, 10).len(), 1);
        assert_eq!(s.search("nope", None, 10).len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_multi_word_and_matching() {
        let (s, dir) = tmp_store("search_multi_word_and_matching");
        let mut a = rec("ConPTY exit", "shell exits hang the session until timeout");
        a.tags = vec!["windows".to_string(), "terminal".to_string()];
        let _ = s.insert(a);
        let _ = s.insert(rec("ConPTY resize", "window reflow handling"));
        // Two terms in different fields (title + content) → match (AND).
        assert_eq!(s.search("conpty exit", None, 10).len(), 1, "title+content AND");
        // Terms spanning title/tags → match.
        assert_eq!(s.search("conpty terminal", None, 10).len(), 1, "title+tag AND");
        // Order-independent.
        assert_eq!(s.search("exit conpty", None, 10).len(), 1, "reversed order");
        // One term missing → no match (AND semantics).
        assert_eq!(s.search("conpty resize", None, 10).len(), 1, "both words present in one rec");
        assert_eq!(s.search("conpty nope", None, 10).len(), 0, "missing term excludes");
        // Single word still works (backward compat).
        assert_eq!(s.search("hang", None, 10).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn soft_delete_and_restore() {
        let (s, dir) = tmp_store("soft_delete_and_restore");
        let id = s.insert(rec("doomed", "x"));
        assert!(s.delete(&id));
        assert!(s.get(&id, false).is_none());
        assert!(s.get(&id, true).is_some());
        assert!(s.update(&id, None, None, None, None, Some(false)));
        assert!(s.get(&id, false).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compact_physically_removes_tombstones() {
        let (s, dir) = tmp_store("compact_physically_removes_tombstones");
        // Insert 5 records, soft-delete 4 → tombstone-heavy. With the eager
        // reclaim (>=4 records, majority), the LAST delete's update() already
        // compacted 3 of the 4 tombstones; the explicit compact() call here
        // reclaims whatever remains (1) and must be idempotent after.
        let mut ids = Vec::new();
        for i in 0..5 {
            ids.push(s.insert(rec(&format!("r{i}"), &format!("content{i}"))));
        }
        for id in &ids[1..] {
            assert!(s.delete(id));
        }
        // Explicit compact is idempotent; whether the eager reclaim already
        // cleared the tombstones or this call does, the invariant is: no
        // deleted record remains queryable (even include_deleted).
        s.compact();
        // Survivors still queryable; tombstones gone even with include_deleted.
        assert!(s.get(&ids[0], false).is_some());
        for id in &ids[1..] {
            assert!(s.get(id, true).is_none(), "tombstone physically gone");
        }
        // Reload from disk — the rewritten JSONL has no tombstones either.
        let s2 = MemoryStore::new(dir.clone(), MemoryLimits::default());
        assert!(s2.get(&ids[0], false).is_some());
        assert!(s2.get(&ids[1], true).is_none(), "disk rewrite dropped tombstones");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn small_store_never_auto_compacts() {
        // <10 records: a single soft-delete must stay restorable (the eager
        // threshold guard protects the soft-delete/restore contract).
        let (s, dir) = tmp_store("small_store_never_auto_compacts");
        let id = s.insert(rec("only", "x"));
        s.delete(&id);
        assert!(s.get(&id, true).is_some(), "small store keeps tombstones restorable");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn eviction_by_entries() {
        // Use a dedicated dir with a 2-entry cap from the start (no double
        // store on one path — the previous version created a default store
        // and then a capped store over the SAME dir, corrupting the test).
        let dir = std::env::temp_dir().join(format!("vale-mem-test-evict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = MemoryStore::new(dir.clone(), MemoryLimits { max_entries: 2, ..Default::default() });
        let a = s.insert(rec("a", "1"));
        let b = s.insert(rec("b", "2"));
        let c = s.insert(rec("c", "3"));
        // max_entries=2: the newest (c) and (b) survive; the oldest (a) is
        // soft-deleted.
        assert!(s.get(&a, false).is_none(), "oldest entry must be evicted");
        assert!(s.get(&b, false).is_some(), "second entry survives");
        assert!(s.get(&c, false).is_some(), "newest entry survives");
        // Soft-deleted still present on disk + retrievable with include_deleted.
        assert!(s.get(&a, true).is_some(), "evicted entry stays soft-deleted");
        let _ = std::fs::remove_dir_all(&dir);
    }


    #[test]
    fn content_truncation() {
        let (s, dir) = tmp_store("content_truncation");
        let long = "x".repeat(DEFAULT_MAX_CONTENT_BYTES + 100);
        let id = s.insert(rec("t", &long));
        let rec = s.get(&id, false).unwrap();
        // Truncated to the cap with a "…" suffix (UTF-8 3 bytes).
        assert!(rec.content.len() <= DEFAULT_MAX_CONTENT_BYTES + 3, "content must be capped (got {})", rec.content.len());
        assert!(rec.content.ends_with('…'), "truncated content ends with ellipsis");
        assert!(!rec.content.contains(&"x".repeat(DEFAULT_MAX_CONTENT_BYTES + 1)), "long tail removed");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
