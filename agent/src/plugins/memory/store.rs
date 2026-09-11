//! MemoryStore — device-local memory as append-only JSONL + in-memory index.
//!
//! Patterned after SessionLogger (append-only JSONL, best-effort writes) but
//! with a queryable in-memory index: records are loaded once at startup,
//! appended on save/update, soft-deleted (never physically removed until
//! compaction), and evicted OLDEST-WRITTEN FIRST when configured capacity is
//! exceeded. Not "LRU": reads never touch `updated_at`, so a record that is
//! read constantly but never edited is evicted on the same schedule as one
//! nobody has touched. The name was wrong for as long as the mechanism has
//! existed; the mechanism is fine, the label was not.
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
/// Longest `run_id` kept on a record, in bytes — the same budget
/// `session_log::RUN_ID_MAX_BYTES` gives the same string (a minted id is ~30
/// bytes; the headroom is for a client handing back something larger).
pub const RUN_ID_MAX_BYTES: usize = 200;

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
    /// Writing client identity, when one is known.
    ///
    /// The intended values are `"claude-code"` / `"dsh"` / `"vale-desktop"`,
    /// but see `tools::set_source` — NOTHING sets it today, so records written
    /// through `memory_save` are stamped `"unknown"` (pinned by
    /// `plugins::memory::tests::records_are_stamped_unknown_until_set_source_is_wired`).
    /// Records that already carry a source keep it: `update` clones the
    /// stored record and never touches this field.
    #[serde(default = "default_source")]
    pub source: String,
    /// The RUN that produced this record, as declared by the client through
    /// `run_begin` — the join key between this knowledge and the execution
    /// (its terminal commands, its browser actions) that learned it.
    ///
    /// ABSENT, never a sentinel: `None` means "the client declared no run", and
    /// the key is then omitted from the JSONL outright
    /// (`skip_serializing_if`) — the shape `session_log::SessionEvent` gives
    /// the same field. A record written before this field existed therefore
    /// loads unchanged and reads as UNATTRIBUTED, never as a run it never had.
    ///
    /// `#[serde(default)]` follows this struct's pattern for a field added after
    /// the format shipped. MEASURED, not assumed: serde already defaults a
    /// missing `Option` field to `None` without it (deleting the attribute
    /// leaves every test green), so it states the intent and keeps the
    /// guarantee if this type ever stops being an `Option` — it is not, today,
    /// what makes an old record load.
    ///
    /// Deliberately NOT modelled on [`Self::source`]'s `"unknown"` sentinel,
    /// even though both fields are provenance: a sentinel here would be a
    /// fabricated run id that every reader could group by, which reads as an
    /// execution when there was none. See `crate::runs` for the rule that
    /// governs a run id everywhere in this crate; it is recorded, displayed and
    /// grouped on, and it decides nothing.
    ///
    /// Written by `memory_save` only. `update` clones the stored record and
    /// never touches this field — the run that WROTE the content is the one
    /// that produced the knowledge, and a later edit must not restamp it (the
    /// same treatment [`Self::source`] gets, pinned beside it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
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

/// Normalize a client-supplied `run_id` for [`MemoryRecord::run_id`]: trimmed,
/// byte-capped on a char boundary, and `None` when absent or blank.
///
/// ONE owner for the rule, so the tool boundary and every test agree on it, and
/// identical to the discipline `runs::end`, `session_log::command_start_run`
/// and `browser_run_script` already apply to the same string: it arrives from a
/// remote client and then rides every later read, so it is bounded; and a blank
/// value means "the client declared no run" rather than a run named `""` (see
/// `runs`'s header: a reader must be able to tell "said nothing" from "said
/// something empty"). Over-long is CAPPED, never rejected — losing the whole
/// record over a long id would trade knowledge for a grouping key.
pub fn clean_run_id(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| crate::text::clip(s, RUN_ID_MAX_BYTES).to_string())
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
/// Namespace filter shared by the search/list/export scan loops (they
/// used to each inline the same if-let pair).
fn ns_matches(rec: &MemoryRecord, namespace: Option<&str>) -> bool {
    match namespace {
        None => true,
        Some(ns) => rec.namespace == ns,
    }
}

/// Mark a record soft-deleted and enqueue its tombstone JSONL line —
/// shared by the eviction and retention paths (same write used to be
/// inlined at both sites).
fn tombstone(rec: &mut MemoryRecord, persist: &mut Vec<String>) {
    rec.deleted = true;
    rec.updated_at = crate::unix_now();
    if let Ok(line) = serde_json::to_string(&*rec) {
        persist.push(line);
    }
}

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
        Self::recount_total_bytes(&mut guard);
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
        // Crash-safety rules (version header on a fresh file, torn-final-line
        // repair) are owned by crate::jsonl — see its header for the
        // fused-record incident that motivated them.
        let _ = crate::jsonl::prepare_append(
            &mut f,
            &path,
            &serde_json::json!({ "type": HEADER_TYPE, "version": HEADER_VERSION }),
        );
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
                Self::ledger_adjust(&mut guard, Some(&rec), None);
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
                Self::ledger_adjust(&mut guard, Some(&prev), Some(&rec));
            } else {
                Self::ledger_adjust(&mut guard, None, Some(&rec));
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
    ///
    /// `source` and `run_id` are NOT parameters and never change here: the
    /// record is cloned and only the listed fields are written, so the writing
    /// client and the run that produced the content survive an edit (both are
    /// pinned — see `plugins::memory::tests`).
    pub fn update(
        &self,
        id: &str,
        title: Option<String>,
        content: Option<String>,
        tags: Option<Vec<String>>,
        namespace: Option<String>,
        deleted: Option<bool>,
    ) -> bool {
        let now = crate::unix_now();
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
            let prev = guard.by_id.insert(id.to_string(), rec.clone());
            // The ledger moves with the record, through its one owner.
            Self::ledger_adjust(&mut guard, prev.as_ref(), Some(&rec));
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
            if !ns_matches(rec, namespace) {
                continue;
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
            if !ns_matches(rec, namespace) {
                continue;
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
            if !ns_matches(rec, namespace) {
                continue;
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

    /// THE `total_bytes` INVARIANT, in one place: the ledger equals the sum of
    /// `content.len()` over records where `!deleted`.
    ///
    /// Every mutation that replaces one record with another (or removes one)
    /// goes through here, so no write path can forget. `insert` and `compact`
    /// used to subtract-and-add by hand and `update` did neither — which is the
    /// whole defect: an edit that grew content UNDERCOUNTED (the byte cap
    /// silently stopped being enforced), while a soft-delete kept counting the
    /// removed content so the ledger OVERCOUNTED and `enforce_limits` evicted
    /// LIVE records to make room for a phantom.
    ///
    /// `update()` is not a side path: every edit goes through it, and so does
    /// every soft-delete (`delete()` simply delegates to it).
    fn ledger_adjust(guard: &mut Inner, prev: Option<&MemoryRecord>, next: Option<&MemoryRecord>) {
        let before = prev.filter(|r| !r.deleted).map_or(0, |r| r.content.len());
        let after = next.filter(|r| !r.deleted).map_or(0, |r| r.content.len());
        guard.total_bytes = guard.total_bytes.saturating_sub(before) + after;
    }

    /// Recompute total_bytes from LIVE records only (the old per-line sum
    /// counted every update revision, inflating the byte cap into premature
    /// evictions). Shared by load, the entry-cap eviction loop and the
    /// retention sweep — three copies used to inline this expression.
    fn recount_total_bytes(guard: &mut Inner) {
        guard.total_bytes = guard
            .by_id
            .values()
            .filter(|r| !r.deleted)
            .map(|r| r.content.len())
            .sum();
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
            .min_by(|(ia, ra), (ib, rb)| ra.updated_at.cmp(&rb.updated_at).then_with(|| ia.cmp(ib)))
            .map(|(id, _)| id.clone())?;
        let content_len = guard
            .by_id
            .get(&victim)
            .map(|r| r.content.len())
            .unwrap_or(0);
        if let Some(rec) = guard.by_id.get_mut(&victim) {
            tombstone(rec, persist);
        }
        guard.dirty = true;
        Some(content_len)
    }

    /// Enforce capacity limits: soft-delete the OLDEST-WRITTEN first
    /// (`updated_at`; reads do not move it, so this is not LRU)
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
            Self::recount_total_bytes(&mut guard);
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
            let cutoff = crate::unix_now().saturating_sub(days * 86400);
            let ids: Vec<String> = guard
                .by_id
                .iter()
                .filter(|(_, r)| !r.deleted && r.updated_at < cutoff)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                if let Some(rec) = guard.by_id.get_mut(&id) {
                    tombstone(rec, &mut persist);
                }
                guard.dirty = true;
            }
            Self::recount_total_bytes(&mut guard);
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
    // Boundary decision owned by crate::text (SOLID R105); the "…" marker is
    // this caller's wording.
    format!("{}…", crate::text::clip(s, max))
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

    /// The byte ledger must be right IN PROCESS, not only after a reload.
    ///
    /// `total_bytes` is what `enforce_limits` reads for `max_bytes` eviction.
    /// `insert()` maintains it, `load()` recomputes it — but `update()` did
    /// neither, and `update()` is the path every EDIT and every SOFT-DELETE
    /// takes. Two consequences, in opposite directions:
    ///
    ///   * an edit that grows content UNDERCOUNTS, so the byte cap silently
    ///     stops being enforced (the device exceeds the limit the operator set);
    ///   * a soft-delete keeps counting the removed content, so the ledger
    ///     OVERCOUNTS and enforce evicts LIVE records to make room for a
    ///     figure that is too high.
    ///
    /// The pre-existing `total_bytes_counts_deduped_live_only` cannot see
    /// either: it DROPS AND REOPENS the store before asserting, and the reopen
    /// runs `recount_total_bytes` — its own comment says "total recomputed on
    /// load". So the in-process ledger was asserted nowhere, and no production
    /// reader existed to notice (`total_bytes_live` had one caller: that test).
    #[test]
    fn update_keeps_the_byte_ledger_honest_without_a_reload() {
        let dir = std::env::temp_dir().join(format!("vale-mem-ledger-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = MemoryStore::new(dir.clone(), MemoryLimits::default());
        let id = store.insert(rec("doc", "abc"));
        assert_eq!(store.total_bytes_live(), 3, "insert maintains it");

        // An edit that GROWS the content must raise the ledger with it.
        store.update(&id, None, Some("abcdefghij".into()), None, None, None);
        assert_eq!(
            store.total_bytes_live(),
            10,
            "an edit must move the ledger — otherwise the byte cap is measured \
             against a figure that is too LOW and stops being enforced"
        );

        // An edit that SHRINKS it must lower the ledger.
        store.update(&id, None, Some("ab".into()), None, None, None);
        assert_eq!(
            store.total_bytes_live(),
            2,
            "shrinking an edit lowers it too"
        );

        // A SOFT-DELETE removes the content from the live total. Leaving it in
        // is what makes enforce evict live records for a phantom.
        store.update(&id, None, None, None, None, Some(true));
        assert_eq!(
            store.total_bytes_live(),
            0,
            "a soft-deleted record's bytes must leave the live ledger"
        );

        // Editing a record that is ALREADY deleted must not move the ledger.
        // Its bytes left the live total when it was tombstoned, so they must
        // not be subtracted AGAIN. Reachable from the wire: `memory_update`
        // passes its id straight to `update()`, which looks the record up
        // whether or not it is deleted.
        //
        // A SECOND LIVE record is load-bearing here. With the ledger at 0 the
        // stale subtraction is absorbed by `saturating_sub` and the mistake is
        // invisible — mutation testing proved it: counting the `prev` term
        // regardless of its deleted flag left the suite GREEN until a live
        // record made the over-subtraction observable.
        let bystander = store.insert(rec("bystander", "0123456789")); // 10 live bytes
        store.update(&id, None, None, None, None, Some(false)); // restore: +2
        assert_eq!(store.total_bytes_live(), 12, "2 restored + 10 bystander");

        store.update(&id, None, None, None, None, Some(true)); // tombstone: -2
        assert_eq!(store.total_bytes_live(), 10, "only the bystander is live");

        store.update(
            &id,
            None,
            Some("edited while deleted".into()),
            None,
            None,
            None,
        );
        assert_eq!(
            store.total_bytes_live(),
            10,
            "editing a TOMBSTONE must not move the live ledger — subtracting its \
             bytes a second time steals them from the live record"
        );

        // And the bystander is genuinely still there, not just still counted.
        assert!(
            store.get(&bystander, false).is_some(),
            "the bystander survives"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The same defect, seen the way an operator would: a LIVE record
    /// disappears because a DELETED one is still being counted.
    #[test]
    fn a_soft_delete_does_not_get_live_records_evicted() {
        let dir = std::env::temp_dir().join(format!("vale-mem-evict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let limits = MemoryLimits {
            max_entries: 100,
            max_bytes: 20,
            retention_days: None,
        };
        let store = MemoryStore::new(dir.clone(), limits);
        let a = store.insert(rec("keeper", "12345678")); // 8 bytes
        let b = store.insert(rec("doomed", "12345678")); // 16 total
        assert_eq!(store.total_bytes_live(), 16);

        // B is soft-deleted. Real live usage is now 8, well under the cap.
        store.update(&b, None, None, None, None, Some(true));

        // Room for one more 8-byte record with 4 bytes to spare.
        store.insert(rec("later", "12345678"));

        assert!(
            store.get(&a, false).is_some(),
            "the keeper must survive: real live usage is 16 of 20.              It was evicted because the DELETED record was still counted,              making the ledger read 24 and pushing enforce over the cap."
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
            run_id: None,
            created_at: crate::unix_now(),
            updated_at: crate::unix_now(),
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

    // ── run provenance (`run_id`) ────────────────────────────

    /// (a)+(d) The run id round-trips through the FILE (not just the in-memory
    /// index), and an over-long one is CAPPED on a char boundary rather than
    /// rejected or sliced mid-character.
    #[test]
    fn a_run_id_round_trips_and_is_capped_on_a_char_boundary() {
        let (s, dir) = tmp_store("run_id_round_trip");
        let mut stamped = rec("from a run", "learned mid-execution");
        stamped.run_id = clean_run_id(Some("  run-1000-abc123  "));
        let id = s.insert(stamped);
        assert_eq!(
            s.get(&id, false).unwrap().run_id.as_deref(),
            Some("run-1000-abc123"),
            "the id is trimmed on the way in and readable back"
        );
        drop(s);
        let s2 = MemoryStore::new(dir.clone(), MemoryLimits::default());
        assert_eq!(
            s2.get(&id, false).unwrap().run_id.as_deref(),
            Some("run-1000-abc123"),
            "the run must survive the JSONL, not only the index"
        );

        // Every char is 3 bytes, so a byte cut lands inside 汉.
        let mut huge = rec("huge id", "body");
        huge.run_id = clean_run_id(Some(&"汉".repeat(5_000)));
        let huge_id = s2.insert(huge);
        let stored = s2.get(&huge_id, false).unwrap().run_id.unwrap();
        assert!(
            stored.len() <= RUN_ID_MAX_BYTES,
            "capped, got {}",
            stored.len()
        );
        assert_eq!(
            stored.chars().count() * 3,
            stored.len(),
            "the cap must land on a char boundary, not inside 汉"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (b) No run declared means NO run on the record — and no key on disk at
    /// all, rather than a null or an empty string.
    ///
    /// A blank value is treated as ABSENT (the rule `runs.rs` states for the
    /// same string): "the client said nothing" and "the client said something
    /// empty" must not collapse into a third thing that a reader could group
    /// by as if an execution had produced this record.
    #[test]
    fn an_absent_or_blank_run_id_leaves_no_key_at_all() {
        let (s, dir) = tmp_store("run_id_absent");
        let id = s.insert(rec("no run", "body"));
        assert!(s.get(&id, false).unwrap().run_id.is_none());
        assert_eq!(clean_run_id(None), None);
        assert_eq!(clean_run_id(Some("")), None);
        assert_eq!(clean_run_id(Some("   \t ")), None);
        // The stored line omits the key outright (`skip_serializing_if`), which
        // is what makes "no run" indistinguishable from an old record — and
        // distinguishable from `""`, which would be a run with a blank name.
        let raw = std::fs::read_to_string(dir.join("memory.jsonl")).unwrap();
        assert!(
            !raw.contains("run_id"),
            "an unattributed record must carry no run_id key: {raw}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (c) A record written by the OLD format — no `run_id` key on disk —
    /// still loads, and reads as UNATTRIBUTED.
    ///
    /// The fixture is written BY HAND, byte for byte, because the whole point
    /// is the shape a pre-`run_id` build produced. Serializing a current
    /// `MemoryRecord` would emit today's shape and the test would silently stop
    /// testing the old format — the "fixture built from the code under test"
    /// trap.
    #[test]
    fn an_old_format_record_without_a_run_id_key_still_loads() {
        let dir = std::env::temp_dir().join(format!("vale-mem-oldfmt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fixture = concat!(
            "{\"type\":\"memory\",\"version\":1}\n",
            "{\"id\":\"m-old\",\"title\":\"before runs\",\"content\":\"kept\",",
            "\"tags\":[\"t\"],\"namespace\":\"shared\",\"source\":\"unknown\",",
            "\"created_at\":1,\"updated_at\":2,\"deleted\":false}\n"
        );
        std::fs::write(dir.join("memory.jsonl"), fixture).unwrap();

        let store = MemoryStore::new(dir.clone(), MemoryLimits::default());
        let old = store
            .get("m-old", false)
            .expect("old-format record must load");
        assert_eq!(old.title, "before runs");
        assert_eq!(old.content, "kept");
        assert_eq!(old.tags, vec!["t".to_string()]);
        assert_eq!(
            old.run_id, None,
            "a record written before the field existed has no run — and must \
             not acquire a fabricated one"
        );
        // The field must not leak into an export either: an unattributed record
        // exports the same shape it was written with.
        let exported = store.export(None);
        assert!(exported.contains("\"m-old\""), "exported: {exported}");
        assert!(
            !exported.contains("run_id"),
            "an old record must export without the key: {exported}"
        );
        // A mixed log — the old line plus a newly written one — parses whole.
        store.insert(rec("after", "new body"));
        drop(store);
        let reopened = MemoryStore::new(dir.clone(), MemoryLimits::default());
        assert!(reopened.get("m-old", false).is_some());
        assert_eq!(reopened.len(), 2, "both generations of record load");
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

    /// The restore guarantee holds BELOW the eager-compaction threshold — and
    /// only there. This test used to claim "<10 records", which the code has
    /// never done: `compact_if_tombstone_heavy` returns early only below 4, so
    /// for 4-9 records a tombstone majority physically destroys them. The old
    /// name and comment described a guarantee four times wider than the real
    /// one, and the test used ONE record, so it could never tell the
    /// difference. Both halves are pinned now: restorable below the threshold,
    /// and — the part nobody wrote down — NOT restorable above it.
    #[test]
    fn tombstones_are_restorable_only_below_the_compaction_threshold() {
        let (s, dir) = tmp_store("tombstone_restore_threshold");
        // 3 records (below the threshold of 4): a delete stays restorable.
        let ids: Vec<String> = (0..3)
            .map(|i| s.insert(rec(&format!("small{i}"), "x")))
            .collect();
        s.delete(&ids[0]);
        assert!(
            s.get(&ids[0], true).is_some(),
            "below the threshold a tombstone must stay restorable"
        );
        let _ = std::fs::remove_dir_all(&dir);

        // 4 records, then a tombstone MAJORITY: compaction fires and the
        // record is GONE — not merely hidden. This is the behaviour the
        // removed "<10 records" claim denied, and `memory_delete`'s promise of
        // "recoverable ... until compaction" is true only in this sense.
        let (s2, dir2) = tmp_store("tombstone_compacts_at_four");
        let ids2: Vec<String> = (0..4)
            .map(|i| s2.insert(rec(&format!("big{i}"), "x")))
            .collect();
        s2.delete(&ids2[0]);
        s2.delete(&ids2[1]); // 2 of 4 deleted => majority
        assert!(
            s2.get(&ids2[0], true).is_none(),
            "at or above the threshold a tombstone majority compacts — the \
             record is physically gone, so `include_deleted` cannot return it"
        );
        let _ = std::fs::remove_dir_all(&dir2);
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
        let old = crate::unix_now().saturating_sub(age_secs);
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
