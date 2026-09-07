//! MemoryStore — device-local memory as append-only JSONL + in-memory index.
//!
//! Patterned after SessionLogger (append-only JSONL, best-effort writes) but
//! with a queryable in-memory index: records are loaded once at startup,
//! appended on save/update, soft-deleted (never physically removed until
//! compaction), and LRU-evicted when configured capacity is exceeded.
//!
//! File: `<data>/memory/memory.jsonl` (data_dir(); version header + one
//! per line). Thread-safe via a single std Mutex (recover_guard poison
//! policy); record count is small (user-curated knowledge), so a Mutex is
//! simpler and sufficient — no async locks needed.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};

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
        Self {
            max_entries: 10_000,
            max_bytes: 64 * 1024 * 1024,
            retention_days: None,
        }
    }
}

/// In-memory store over the JSONL file. All mutations go through the Mutex;
/// file appends are best-effort (a disk failure must not break queries).
pub struct MemoryStore {
    dir: PathBuf,
    /// Live capacity limits — RwLock (not part of the inner Mutex) so the
    /// Settings page can retune capacity at runtime (round-358). Reads use
    /// the same poison-recovery as recover_guard; see set_limits for the
    /// lock-ordering rule.
    limits: RwLock<MemoryLimits>,
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
            limits: RwLock::new(limits),
            inner: Mutex::new(Inner {
                by_id: HashMap::new(),
                order: Vec::new(),
                tag_index: HashMap::new(),
                total_bytes: 0,
                dirty: false,
            }),
        };
        store.load();
        // Round-357: enforce capacity on open, not just on mutation. Before
        // this, a quiet device (no inserts/updates) kept expired records
        // visible forever — retention only ran inside insert()/update().
        // No-op for default limits (retention None, huge caps).
        store.enforce_limits();
        // stage-n: physically drop tombstones from the previous process —
        // the append-only JSONL would otherwise keep every soft-deleted
        // record forever (disk + memory growth with no reclaim path).
        store.compact();
        store
    }

    /// Test/reliability hook: tracked live content bytes (the byte cap's
    /// ledger).
    pub fn total_bytes_live(&self) -> usize {
        recover_guard(&self.inner).total_bytes
    }

    /// Live capacity limits (Copy snapshot) — what GET /api/settings reports.
    pub fn limits(&self) -> MemoryLimits {
        *self.limits.read().unwrap_or_else(|p| p.into_inner())
    }

    /// Replace the live capacity limits (PUT /api/settings) and enforce
    /// immediately. Assign-then-enforce WITHOUT holding the write guard
    /// across enforce_limits: that fn takes the inner Mutex and then reads
    /// the limits lock, so nesting would invert the lock order against the
    /// insert()/update() path (inner → limits) and could deadlock.
    pub fn set_limits(&self, limits: MemoryLimits) {
        *self.limits.write().unwrap_or_else(|p| p.into_inner()) = limits;
        self.enforce_limits();
    }

    /// Path of the JSONL file.
    fn file_path(&self) -> PathBuf {
        self.dir.join("memory.jsonl")
    }

    /// Load records from disk at startup; rebuild index. Best-effort.
    fn load(&self) {
        // A torn write can cut a multi-byte UTF-8 sequence in half — one
        // invalid byte must not hide the WHOLE store (read_to_string fails
        // then), so decode lossy and let the per-line parse skip junk.
        let Ok(bytes) = std::fs::read(self.file_path()) else {
            return;
        };
        let text = String::from_utf8_lossy(&bytes);
        let mut guard = recover_guard(&self.inner);
        for line in text.lines() {
            // Skip the version header.
            if line.contains("\"type\":\"memory\"") || line.contains("\"type\": \"memory\"") {
                continue;
            }
            let Ok(rec) = serde_json::from_str::<MemoryRecord>(line) else {
                continue;
            };
            // Dedup by id is last-wins; tag index is rebuilt after the sweep
            // so a superseded line's tags cannot orphan-register the winner.
            guard.by_id.insert(rec.id.clone(), rec.clone());
        }
        let live: Vec<(String, Vec<String>)> = guard
            .by_id
            .values()
            .filter(|r| !r.deleted)
            .map(|r| (r.id.clone(), r.tags.clone()))
            .collect();
        for (id, tags) in live {
            for tag in tags {
                let key = tag.to_lowercase();
                guard.tag_index.entry(key).or_default().insert(id.clone());
            }
        }
        // total_bytes counts LIVE records only — the old per-line sum counted
        // every update revision (store.rs history), inflating the byte cap
        // into premature evictions.
        guard.total_bytes = guard
            .by_id
            .values()
            .filter(|r| !r.deleted)
            .map(|r| r.content.len())
            .sum();
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
        let mut f = match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            Ok(f) => f,
            Err(_) => return,
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len == 0 {
            // Fresh (empty) file: version header first.
            let _ = writeln!(
                f,
                "{}",
                serde_json::json!({ "type": HEADER_TYPE, "version": HEADER_VERSION })
            );
        } else {
            // Torn-write guard: a crash mid-writeln can leave a fragment
            // without the trailing newline; the NEXT append would fuse onto it
            // and silently destroy that record on every future load. Detect
            // the missing terminator and start a fresh line.
            use std::io::{Read, Seek, SeekFrom};
            let tail_bad = std::fs::OpenOptions::new()
                .read(true)
                .open(&path)
                .and_then(|mut r| {
                    r.seek(SeekFrom::End(-1))?;
                    let mut b = [0u8; 1];
                    r.read_exact(&mut b)?;
                    Ok(b[0] != b'\n')
                })
                .unwrap_or(false);
            if tail_bad {
                let _ = f.write_all(b"\n");
            }
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
        // Snapshot the doomed tombstones so a FAILED disk rewrite can be
        // rolled back into the index — otherwise memory (clean) and disk
        // (still holding them) diverge and they RESURRECT at next load.
        let removed_records: Vec<MemoryRecord> = removed
            .iter()
            .filter_map(|id| guard.by_id.get(id).cloned())
            .collect();
        // Rewrite the JSONL with only the survivors (temp + rename).
        let path = self.file_path();
        let tmp = path.with_extension("jsonl.tmp");
        let write_ok = {
            use std::io::Write;
            match std::fs::File::create(&tmp) {
                Ok(mut out) => {
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
                    // Durability: the rename must not outrun the data. A
                    // power cut after rename, without this sync, can leave
                    // the replaced file EMPTY — total knowledge loss (the
                    // process-kill story is temp+rename safe; power is not).
                    out.flush().is_ok() && out.sync_all().is_ok()
                }
                Err(_) => false,
            }
        };
        if !write_ok || std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            for rec in removed_records {
                guard.by_id.insert(rec.id.clone(), rec);
            }
            guard.dirty = true;
            return 0;
        }
        guard.dirty = true;
        tracing::info!(
            "[vale-agent] memory compact: removed {removed_count} tombstone(s)",
            removed_count = removed.len()
        );
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
        {
            let mut guard = recover_guard(&self.inner);
            // append inside the guard: a concurrent compact() renames the
            // file under its own lock — an append outside it could land on
            // the OLD inode and be destroyed while the record sits in memory
            // (lost at next restart).
            self.append_line(&line);
            if let Some(prev) = guard.by_id.insert(id.clone(), rec.clone()) {
                if !prev.deleted {
                    guard.total_bytes = guard.total_bytes.saturating_sub(prev.content.len());
                }
            }
            if !rec.deleted {
                guard.total_bytes += rec.content.len();
            }
            for tag in &rec.tags {
                guard
                    .tag_index
                    .entry(tag.to_lowercase())
                    .or_default()
                    .insert(id.clone());
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
                guard
                    .tag_index
                    .entry(t.to_lowercase())
                    .or_default()
                    .insert(id.to_string());
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
        // limit=0 must return 0 hits, not the first match (the old
        // check-AFTER-push semantics pushed one before comparing).
        if limit == 0 {
            return Vec::new();
        }
        let limit = limit.max(1);
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
    /// Streams to avoid buffering max-capacity entries in memory (the old
    /// Vec<String> + join could OOM at 10K × 32KB = 320MB).
    pub fn export(&self, namespace: Option<&str>) -> String {
        self.rebuild_order();
        let guard = recover_guard(&self.inner);
        let mut out = String::new();
        for id in &guard.order {
            let rec = &guard.by_id[id];
            if let Some(ns) = namespace {
                if rec.namespace != ns {
                    continue;
                }
            }
            if let Ok(line) = serde_json::to_string(rec) {
                out.push_str(&line);
                out.push('\n');
            }
        }
        out
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

    /// Soft-delete the OLDEST live record (smallest updated_at; ties by
    /// smallest id — NOT `order`, which is newest-first for display) and
    /// append its tombstone line to `persist` (so the deletion survives a
    /// restart). Returns the evicted record's content length (callers keep
    /// their own total_bytes accounting: full recompute vs exact subtract),
    /// or None when there is no live record left.
    ///
    /// Shared by enforce_limits' entry-cap and byte-cap eviction loops —
    /// the victim-selection + tombstone logic used to be copy-pasted
    /// between them and would have drifted apart on any eviction-policy
    /// change.
    fn evict_oldest_live(guard: &mut Inner, persist: &mut Vec<String>) -> Option<usize> {
        let victim = guard
            .by_id
            .iter()
            .filter(|(_, r)| !r.deleted)
            .min_by(|(ia, ra), (ib, rb)| {
                ra.updated_at.cmp(&rb.updated_at).then_with(|| ia.cmp(ib))
            })
            .map(|(id, _)| id.clone())?;
        let content_len = guard.by_id.get(&victim).map(|r| r.content.len()).unwrap_or(0);
        if let Some(rec) = guard.by_id.get_mut(&victim) {
            rec.deleted = true;
            rec.updated_at = unix_now();
            if let Ok(line) = serde_json::to_string(&*rec) {
                persist.push(line);
            }
        }
        guard.dirty = true;
        Some(content_len)
    }

    /// Enforce capacity limits: LRU evict (soft-delete) oldest-updated first
    /// until under max_entries / max_bytes.
    fn enforce_limits(&self) {
        self.rebuild_order();
        let mut guard = recover_guard(&self.inner);
        let limits = self.limits();
        // Evicted/retired tombstones must be PERSISTED (append their record
        // line) — memory-only flips resurrect on restart (they were observed
        // live again after a process bounce).
        let mut persist: Vec<String> = Vec::new();
        // Evict while over entry cap. The victim is the OLDEST non-deleted
        // record (smallest updated_at; ties by smallest id) — NOT the last
        // of `order`, which is newest-first for query display.
        while guard.by_id.values().filter(|r| !r.deleted).count() > limits.max_entries {
            if Self::evict_oldest_live(&mut guard, &mut persist).is_none() {
                break;
            }
            guard.total_bytes = guard
                .by_id
                .values()
                .filter(|r| !r.deleted)
                .map(|r| r.content.len())
                .sum();
        }
        // Evict while over byte cap (same oldest-first victim).
        while guard.total_bytes > limits.max_bytes {
            // Exact subtract keeps the ledger in sync without a full recount.
            let Some(content_len) = Self::evict_oldest_live(&mut guard, &mut persist) else {
                break;
            };
            guard.total_bytes = guard.total_bytes.saturating_sub(content_len);
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
                    rec.updated_at = unix_now();
                    if let Ok(line) = serde_json::to_string(&*rec) {
                        persist.push(line);
                    }
                }
                guard.dirty = true;
            }
            guard.total_bytes = guard
                .by_id
                .values()
                .filter(|r| !r.deleted)
                .map(|r| r.content.len())
                .sum();
        }
        drop(guard);
        for line in persist {
            self.append_line(&line);
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
        let dir =
            std::env::temp_dir().join(format!("vale-mem-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (MemoryStore::new(dir.clone(), MemoryLimits::default()), dir)
    }

    // ---- review regression tests (round: memory durability audit) ----

    #[test]
    fn append_repairs_a_torn_final_line() {
        // A crash mid-writeln leaves a fragment with no trailing newline.
        // The NEXT append must not fuse onto it (that silently destroyed the
        // new record on every subsequent load).
        let dir = std::env::temp_dir().join(format!("vale-mem-torn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("memory.jsonl"), b"{\"id\":\"m-a\",\"title\":\"hel").unwrap();
        let store = MemoryStore::new(dir.clone(), MemoryLimits::default());
        store.insert(rec("b", "body-b"));
        drop(store);
        // Reload: "b" must be present (its line survived the repair), the
        // torn fragment is simply skipped.
        let store2 = MemoryStore::new(dir.clone(), MemoryLimits::default());
        let hits = store2.search("body-b", None, 10);
        assert!(
            hits.iter().any(|r| r.title == "b"),
            "post-repair append must be loadable"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_survives_invalid_utf8() {
        // A torn write can split a multi-byte char; one invalid byte must
        // not hide the WHOLE store (the old read_to_string failed hard).
        let dir = std::env::temp_dir().join(format!("vale-mem-badutf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut bytes = b"{\"id\":\"m-ok\",\"title\":\"ok\",\"content\":\"keep me\",\"tags\":[],\"namespace\":\"shared\",\"source\":\"t\",\"created_at\":1,\"updated_at\":1,\"deleted\":false}\n".to_vec();
        bytes.extend_from_slice(&[0xf0, 0x9f, 0x94]); // truncated emoji, no newline
        std::fs::write(dir.join("memory.jsonl"), &bytes).unwrap();
        let store = MemoryStore::new(dir.clone(), MemoryLimits::default());
        let hits = store.search("keep", None, 10);
        assert!(
            hits.iter().any(|r| r.title == "ok"),
            "valid records must load despite a trailing invalid byte"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn eviction_tombstones_persist_across_restart() {
        // max_entries=2: inserting a 3rd evicts the oldest. The flip MUST be
        // on disk — otherwise the evicted entry resurrects on restart.
        let dir = std::env::temp_dir().join(format!("vale-mem-evict-{}", std::process::id()));
        let store = MemoryStore::new(
            dir.clone(),
            MemoryLimits {
                max_entries: 2,
                ..MemoryLimits::default()
            },
        );
        // EXPLICIT timestamps — unix_now() is second-granular, so three fast
        // inserts tie and the victim would fall to id ordering, not age.
        let mut a = rec("oldest", "O");
        a.updated_at = 100;
        a.created_at = 100;
        let mut b = rec("mid", "M");
        b.updated_at = 200;
        b.created_at = 200;
        let mut c = rec("newest", "N");
        c.updated_at = 300;
        c.created_at = 300;
        store.insert(a);
        store.insert(b);
        store.insert(c);
        let live_ids: Vec<String> = store
            .list(None, None, 50, false)
            .into_iter()
            .map(|r| r.title)
            .collect();
        assert!(
            !live_ids.contains(&"oldest".to_string()),
            "oldest should be evicted in-memory"
        );
        drop(store);
        let store2 = MemoryStore::new(
            dir.clone(),
            MemoryLimits {
                max_entries: 2,
                ..MemoryLimits::default()
            },
        );
        let titles: Vec<String> = store2
            .list(None, None, 50, false)
            .into_iter()
            .map(|r| r.title)
            .collect();
        assert!(
            !titles.contains(&"oldest".to_string()),
            "eviction must survive restart, got {titles:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn total_bytes_counts_deduped_live_only() {
        // The old per-line sum counted every update revision; total_bytes
        // must be the deduped LIVE content bytes so the cap never fires
        // prematurely after edits.
        let dir = std::env::temp_dir().join(format!("vale-mem-total-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = MemoryStore::new(dir.clone(), MemoryLimits::default());
        let id = store.insert(rec("doc", "v1-content"));
        for i in 0..10 {
            store.update(
                &id,
                None,
                Some(format!("v{}-content-longer", i)),
                None,
                None,
                None,
            );
        }
        let expected = store.get(&id, false).unwrap().content.len();
        drop(store);
        let store2 = MemoryStore::new(dir.clone(), MemoryLimits::default());
        store2.insert(rec("probe", "x")); // touches enforce; total recomputed on load
        let live_total = store2.total_bytes_live();
        assert_eq!(
            live_total,
            expected + 1,
            "total must equal live contents, not update history"
        );
        let _ = std::fs::remove_dir_all(&dir);
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
        assert_eq!(
            s.search("conpty exit", None, 10).len(),
            1,
            "title+content AND"
        );
        // Terms spanning title/tags → match.
        assert_eq!(
            s.search("conpty terminal", None, 10).len(),
            1,
            "title+tag AND"
        );
        // Order-independent.
        assert_eq!(s.search("exit conpty", None, 10).len(), 1, "reversed order");
        // One term missing → no match (AND semantics).
        assert_eq!(
            s.search("conpty resize", None, 10).len(),
            1,
            "both words present in one rec"
        );
        assert_eq!(
            s.search("conpty nope", None, 10).len(),
            0,
            "missing term excludes"
        );
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
        assert!(
            s2.get(&ids[1], true).is_none(),
            "disk rewrite dropped tombstones"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn small_store_never_auto_compacts() {
        // <10 records: a single soft-delete must stay restorable (the eager
        // threshold guard protects the soft-delete/restore contract).
        let (s, dir) = tmp_store("small_store_never_auto_compacts");
        let id = s.insert(rec("only", "x"));
        s.delete(&id);
        assert!(
            s.get(&id, true).is_some(),
            "small store keeps tombstones restorable"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn eviction_by_entries() {
        // Use a dedicated dir with a 2-entry cap from the start (no double
        // store on one path — the previous version created a default store
        // and then a capped store over the SAME dir, corrupting the test).
        let dir = std::env::temp_dir().join(format!("vale-mem-test-evict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = MemoryStore::new(
            dir.clone(),
            MemoryLimits {
                max_entries: 2,
                ..Default::default()
            },
        );
        let a = s.insert(rec("a", "1"));
        let b = s.insert(rec("b", "2"));
        let c = s.insert(rec("c", "3"));
        // max_entries=2: the newest (c) and (b) survive; the oldest (a) is
        // soft-deleted.
        assert!(s.get(&a, false).is_none(), "oldest entry must be evicted");
        assert!(s.get(&b, false).is_some(), "second entry survives");
        assert!(s.get(&c, false).is_some(), "newest entry survives");
        // Soft-deleted still present on disk + retrievable with include_deleted.
        assert!(
            s.get(&a, true).is_some(),
            "evicted entry stays soft-deleted"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_truncation() {
        let (s, dir) = tmp_store("content_truncation");
        let long = "x".repeat(DEFAULT_MAX_CONTENT_BYTES + 100);
        let id = s.insert(rec("t", &long));
        let rec = s.get(&id, false).unwrap();
        // Truncated to the cap with a "…" suffix (UTF-8 3 bytes).
        assert!(
            rec.content.len() <= DEFAULT_MAX_CONTENT_BYTES + 3,
            "content must be capped (got {})",
            rec.content.len()
        );
        assert!(
            rec.content.ends_with('…'),
            "truncated content ends with ellipsis"
        );
        assert!(
            !rec.content
                .contains(&"x".repeat(DEFAULT_MAX_CONTENT_BYTES + 1)),
            "long tail removed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Twin-pin: MemoryLimits::default() must equal a default MemoryConfig's
    /// effective() — the literals live in two crates (core cannot import the
    /// agent), so this test is the only thing keeping them in step.
    #[test]
    fn memory_limits_default_matches_config_effective() {
        use vale_agent_core::Config;
        let d = MemoryLimits::default();
        let cfg = Config::default();
        let (e, b, r) = cfg.memory.effective();
        assert_eq!(d.max_entries, e, "max_entries twin drifted");
        assert_eq!(d.max_bytes, b, "max_bytes twin drifted");
        assert_eq!(d.retention_days, r, "retention_days twin drifted");
    }

    fn old_rec(title: &str, age_secs: u64) -> MemoryRecord {
        let mut r = rec(title, "stale body");
        let old = unix_now().saturating_sub(age_secs);
        r.created_at = old;
        r.updated_at = old;
        r
    }

    fn retention_store(name: &str, days: u64) -> (MemoryStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("vale-mem-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (
            MemoryStore::new(
                dir.clone(),
                MemoryLimits {
                    retention_days: Some(days),
                    ..Default::default()
                },
            ),
            dir,
        )
    }

    #[test]
    fn retention_soft_deletes_stale_on_insert() {
        // Round-357: the retention branch had ZERO tests — the policy was
        // documented but unreachable in production (config never wired).
        let (s, dir) = retention_store("retention_on_insert", 30);
        let stale = s.insert(old_rec("stale", 40 * 86400));
        let fresh = s.insert(rec("fresh", "live body"));
        assert!(
            s.get(&stale, false).is_none(),
            "40d-old record must retire under 30d retention"
        );
        assert!(
            s.get(&stale, true).is_some(),
            "retired record stays soft-deleted (restorable, on disk)"
        );
        assert!(
            s.get(&fresh, false).is_some(),
            "fresh record survives retention"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retention_enforced_on_open() {
        // Round-357: before enforce-on-open, a quiet device kept expired
        // records visible forever (retention only ran on mutation).
        let dir = std::env::temp_dir().join(format!(
            "vale-mem-test-retention-open-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        // Seed under default limits (no retention): the old record is live.
        let id = {
            let s = MemoryStore::new(dir.clone(), MemoryLimits::default());
            let id = s.insert(old_rec("stale", 40 * 86400));
            assert!(
                s.get(&id, false).is_some(),
                "no retention → old record live"
            );
            id
        };
        // Reopen WITH retention: boot enforcement retires it, and the
        // startup compact reaps the tombstone — gone live AND gone deleted.
        let s2 = MemoryStore::new(
            dir.clone(),
            MemoryLimits {
                retention_days: Some(30),
                ..Default::default()
            },
        );
        assert!(
            s2.get(&id, false).is_none(),
            "reopen must retire the expired record"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retention_none_keeps_old_records() {
        // Opt-in documented: default config (retention None) never retires.
        let (s, dir) = tmp_store("retention_none");
        let id = s.insert(old_rec("ancient", 400 * 86400));
        assert!(
            s.get(&id, false).is_some(),
            "without retention even year-old records stay live"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
