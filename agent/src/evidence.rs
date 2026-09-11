//! The AI-evidence feed — ONE owner for the `pwout` artifact contract.
//!
//! Two plugins WRITE here (the playwright plugin's `browser_run_script`, and
//! the mcp-client tools' action/screenshot recording) and `web/mod.rs` READS
//! it for `/api/browser/{actions,pwshots,pwshot}`. Before this module existed
//! the JSONL shape, the open/append pair and the push event each lived in more
//! than one copy and nothing owned the writer↔reader contract: the mcp-client
//! carried a private append helper, the playwright tool re-implemented the
//! same open/append inline, the refresh event was a `OnceLock` in the
//! mcp-client (so a second producer could not push), and a shape change had to
//! be mirrored by hand in the reader.
//!
//! Layout (`paths::evidence_dir()`, i.e. `DataDir\pwout`):
//!   * `actions.jsonl` — one JSON object per line, oldest FIRST; readers
//!     reverse. Producers never rewrite the file (append-only timeline).
//!   * `*.png` — screenshots the Evidence drawer lists and serves by basename.
//!   * `pwai_*.js` — the script that produced a `browser_run_script` action.
//!     Also fed's own artifacts (see [`owns`]), so they are bounded with it.
//!
//! ## Retention (why this module deletes, and why by AGE)
//!
//! This feed was the only durable record on the device with NO bound: a
//! screenshot per action plus a line per action, forever, on a box nobody
//! watches. Every sibling record already had one — the memory store
//! (`max_entries`/`max_bytes`/`retention_days`), the session audit trail
//! (`prune_stale(30)`), `agent.log` (1 MB × 3), `mcp_diag.log` (1 MB) — so the
//! bound belongs here, in the module that already owns the feed, rather than in
//! a new `retention.rs` (a shared primitive needs a second REAL consumer before
//! it is promoted; see the repo's PROMOTION rule).
//!
//! THE BOUND IS AGE, NOT SIZE, and that is a correctness property rather than a
//! style choice. A size trigger fires exactly when a long operation has produced
//! the most evidence — the batch job that just took 400 screenshots is the one
//! that trips it — so it deletes the MOST RECENT material first, which is
//! precisely the material that explains what the AI is doing right now. Worse,
//! under sustained work a size trigger deletes continuously, so the drawer's
//! newest entries would churn while the operator is reading them. An age bound
//! is monotone (today's evidence is never a candidate), predictable ("a month"),
//! and it degrades in the safe direction: a burst of evidence costs disk and
//! keeps its explanation.
//!
//! ## The in-flight guarantee
//!
//! A prune that removes the screenshot an in-flight action JUST wrote is worse
//! than a full disk, so the rule is structural rather than a promise about the
//! window: [`prune`] never removes anything younger than
//! [`MIN_RETENTION_DAYS`] (1 day), whatever the config says — a
//! `retention: {evidence_days: 0}` typo, a caller that skips
//! `RetentionConfig::effective`, or a future re-wiring cannot produce a cutoff
//! closer to now than yesterday. And every MUTATION of the feed (the append and
//! the prune) holds [`FEED_LOCK`], so a prune can never interleave with a
//! producer mid-append — the shape that made the session trail's own trim
//! orphan a live writer's handle.
//!
//! Every function takes its directory EXPLICITLY instead of reaching for the
//! global `paths::evidence_dir()`: the contract stays unit-testable against a
//! temp dir, and `paths.rs` keeps its position as the single resolution point
//! for where the feed lives.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde_json::Value;
use vale_agent_core::EventBus;

/// Action-timeline filename inside the evidence dir.
pub(crate) const ACTIONS_FILE: &str = "actions.jsonl";

/// Push-event name panels listen for so the Evidence drawer refreshes
/// event-driven instead of polling `actions.jsonl` (round-252).
pub(crate) const ACTIONS_CHANGED_EVENT: &str = "browser-actions-changed";

pub(crate) fn actions_path(dir: &Path) -> PathBuf {
    dir.join(ACTIONS_FILE)
}

/// Append ONE action-timeline line. Best-effort by design: the feed is
/// observability, so a missing dir / unwritable file must never fail the tool
/// call that produced the action (the caller creates the dir when it needs
/// other evidence artifacts anyway).
///
/// THE TIMESTAMP IS A PARAMETER, IN MILLISECONDS, and that is deliberate.
/// This feed's `ts` is milliseconds while the terminal audit trail's `ts` is
/// SECONDS — the same field name carrying two units, which is exactly the
/// silent-merge hazard `unix_now`/`now_millis` were pinned against in R115
/// ("one word apart, 1000x apart in value"). Sorting the two feeds together by
/// `ts` would put every browser action ~50 years in the future while looking
/// perfectly ordered.
///
/// So the unit lives in the SIGNATURE, where a caller cannot miss it, and this
/// writer stamps BOTH names from that one number:
///
///   `ts`     — milliseconds (legacy name, kept: the panel's evidence drawer
///              feeds it to `new Date(...)`, which expects ms)
///   `ts_ms`  — milliseconds, EXPLICIT. The merge reads only this.
///
/// A caller therefore cannot introduce a seconds value without the argument
/// name contradicting it at the call site.
pub(crate) fn append_action_line(dir: &Path, ts_ms: u64, action: &Value) {
    use std::io::Write;
    let mut v = action.clone();
    if let Some(o) = v.as_object_mut() {
        o.insert("ts".into(), Value::from(ts_ms));
        o.insert("ts_ms".into(), Value::from(ts_ms));
    }
    // Held across open+write+close (the handle is per call, so the whole
    // operation is the critical section) — this is what makes it safe for
    // `prune` to REPLACE the file by rename: without the lock the record could
    // land in the orphaned inode. See FEED_LOCK.
    let _guard = FEED_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(actions_path(dir))
    {
        let _ = writeln!(f, "{v}");
    }
}

/// Newest-first action timeline, capped at `limit` records. A torn final line
/// (agent killed mid-write) parses as garbage and is SKIPPED rather than
/// failing the whole feed.
pub(crate) fn recent_actions(dir: &Path, limit: usize) -> Vec<Value> {
    let mut actions: Vec<Value> = Vec::new();
    if let Ok(contents) = std::fs::read_to_string(actions_path(dir)) {
        for line in contents.lines().rev().take(limit) {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                actions.push(v);
            }
        }
    }
    actions
}

/// Screenshot entries in the evidence dir, NEWEST first, capped at `limit`.
/// Only `.png` files count — the dir also holds per-run scripts and the
/// browser helper, which are not evidence.
pub(crate) fn list_shots(dir: &Path, limit: usize) -> Vec<Value> {
    let mut shots: Vec<Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".png") {
                continue;
            }
            let meta = e.metadata().ok();
            let mtime_ms = meta.as_ref().map(mtime_ms).unwrap_or(0);
            shots.push(serde_json::json!({
                "name": name,
                "mtime_ms": mtime_ms,
                "size": meta.map(|m| m.len()).unwrap_or(0),
            }));
        }
    }
    shots.sort_by(|a, b| b["mtime_ms"].as_u64().cmp(&a["mtime_ms"].as_u64()));
    shots.truncate(limit);
    shots
}

/// `/api/browser/pwshot?name=` guard: a bare basename, nothing that could walk
/// out of the evidence dir.
pub(crate) fn shot_name_is_safe(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && !name.contains("..")
}

// ── retention (the feed's age bound) ─────────────────────────

/// Serializes every MUTATION of the feed: the append and the prune.
///
/// The readers ([`recent_actions`], [`list_shots`]) deliberately do NOT take it
/// — they open the path fresh on each call, and the prune's rewrite is atomic,
/// so a reader sees the old file or the new one and never a torn one. The
/// mutex exists for the pair that cannot be made atomic with each other: the
/// prune's rename installs a NEW inode, so an append holding a handle opened
/// before it would keep succeeding against the orphaned one and its record
/// would vanish. That is the round-116 incident (`session_log` lost a live
/// session's tail exactly that way), and one mutex is the whole fix.
static FEED_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Hard floor on the evidence window, in days, independent of configuration.
///
/// The in-flight guarantee (see the module header): whatever a caller passes,
/// the cutoff is never closer to now than yesterday, so a screenshot an action
/// just wrote — or the `pwai_*.js` script a run is executing right now — can
/// never be a deletion candidate. A window this module would otherwise honour
/// is therefore clamped UP, never down.
pub(crate) const MIN_RETENTION_DAYS: u64 = 1;

/// What one prune removed, per artifact class.
///
/// Returned rather than logged HERE because this module has no business
/// choosing the device's log destination: the boot glue that resolved the real
/// directory reports it (the `prune_stale` precedent — the owner returns a
/// count, the caller narrates it). It is a struct rather than a `usize` because
/// "pruned 412" cannot tell an operator whether the AI's screenshots or its
/// action timeline was shortened, and those answer different questions.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Pruned {
    /// Screenshots (`*.png`) removed.
    pub shots: usize,
    /// Per-run scripts (`pwai_*.js`) removed.
    pub scripts: usize,
    /// `actions.jsonl` lines removed.
    pub action_lines: usize,
}

/// Does this module OWN the file with this name — may the prune delete it?
///
/// Three shapes and nothing else: the screenshots the drawer serves, the
/// per-run scripts `browser_run_script` writes beside them, and the action
/// timeline (handled separately, since it is trimmed by LINE rather than
/// removed).
///
/// Everything else in the directory is LEFT ALONE, and the conservative
/// direction is deliberate: the dir also holds `vale-browser-helper.js`, which
/// `ensure_browser_helper` rewrites on content drift and which is therefore
/// REGENERATED rather than accumulated, plus whatever an operator drops in. A
/// name-shape rule cannot eat a file this module never created, which a
/// "delete everything older than N days" rule would.
fn owns(name: &str) -> bool {
    name.ends_with(".png") || (name.starts_with("pwai_") && name.ends_with(".js"))
}

/// Remove the feed's artifacts older than `max_age_days` and trim
/// `actions.jsonl` to the same window. Returns what was removed.
///
/// `now_ms` is a parameter rather than a clock read so the boundary is
/// testable exactly (the same discipline `append_action_line`'s `ts_ms` follows).
///
/// The window is `max(MIN_RETENTION_DAYS, max_age_days)` — see the module
/// header for why the floor exists.
///
/// Two decisions inside that a reader should not have to reverse-engineer:
///
///   * A file whose mtime cannot be read is KEPT. An unknown age is not an old
///     age, and the failure mode of guessing wrong is destroyed evidence.
///   * `actions.jsonl` is filtered by each record's own `ts_ms`, not by the
///     file's mtime — the file is appended to forever, so its mtime is always
///     "now" and can never age out. A line that does not parse is KEPT for the
///     same reason as an unreadable mtime; [`recent_actions`] already skips
///     such a line when reading.
pub(crate) fn prune(dir: &Path, max_age_days: u64, now_ms: u64) -> Pruned {
    let mut out = Pruned::default();
    let _guard = FEED_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let days = max_age_days.max(MIN_RETENTION_DAYS);
    let cutoff_ms = now_ms.saturating_sub(days.saturating_mul(86_400_000));
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().to_string();
            if !owns(&name) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            // A DIRECTORY named `foo.png` is not an artifact. Removing it
            // would fail anyway; skipping keeps the counts honest.
            if meta.is_dir() {
                continue;
            }
            // `mtime_ms` is 0 when the stamp is unreadable, and 0 < cutoff is
            // true for every real cutoff — hence the explicit guard rather
            // than a comparison that would delete on a read error.
            let mtime = mtime_ms(&meta);
            if mtime == 0 || mtime >= cutoff_ms {
                continue;
            }
            if std::fs::remove_file(e.path()).is_ok() {
                if name.ends_with(".png") {
                    out.shots += 1;
                } else {
                    out.scripts += 1;
                }
            }
        }
    }
    out.action_lines = trim_actions(&actions_path(dir), cutoff_ms);
    out
}

/// Drop the `actions.jsonl` records older than `cutoff_ms`, oldest-first.
///
/// The file's on-disk FORMAT is untouched: whole lines are dropped and the
/// survivors keep their exact bytes, so every reader — `recent_actions`, the
/// operation timeline's merge, an external `tail` — keeps working. This is not
/// a new format, it is a shorter one.
///
/// The rewrite is atomic and the caller holds [`FEED_LOCK`], which is exactly
/// the precondition [`crate::jsonl::rewrite_atomically`] documents.
fn trim_actions(path: &Path, cutoff_ms: u64) -> usize {
    let Ok(content) = std::fs::read_to_string(path) else {
        return 0;
    };
    let mut kept = String::with_capacity(content.len());
    let mut dropped = 0usize;
    for line in content.lines() {
        let old = match serde_json::from_str::<Value>(line) {
            Ok(v) => v
                .get("ts_ms")
                .and_then(|t| t.as_u64())
                .is_some_and(|ts| ts < cutoff_ms),
            // Unparseable: KEEP (see `prune`'s notes).
            Err(_) => false,
        };
        if old {
            dropped += 1;
            continue;
        }
        kept.push_str(line);
        kept.push('\n');
    }
    if dropped == 0 {
        // Nothing to do — and deliberately no write, so a prune that removed
        // nothing does not touch the file's mtime or repair a torn tail as a
        // side effect of a no-op.
        return 0;
    }
    if crate::jsonl::rewrite_atomically(path, &kept).is_err() {
        return 0;
    }
    dropped
}

/// A file's modification time in unix milliseconds; 0 when it cannot be read.
///
/// 0 is the "unknown" sentinel both callers guard on ([`prune`] keeps the file,
/// [`list_shots`] reports it) — it is not a claim that the file is from 1970.
fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── event-driven refresh (round-252) ─────────────────────────

/// Module-level event bus, installed ONCE at plugin registration (the registry
/// owns the real bus; the feed's producers are plain tool closures with no
/// handle on it). Producers emit [`ACTIONS_CHANGED_EVENT`] after recording.
static ACTIONS_BUS: OnceLock<Arc<dyn EventBus>> = OnceLock::new();

pub(crate) fn set_bus(bus: Arc<dyn EventBus>) {
    let _ = ACTIONS_BUS.set(bus);
}

/// Tell panels the evidence feed changed. A no-op before registration — the
/// feed itself is written either way, panels just fall back to polling.
pub(crate) fn notify_changed() {
    notify_changed_on(ACTIONS_BUS.get().map(|b| b.as_ref()));
}

/// The emit decision, split out so the push contract is unit-pinned without
/// touching the process-global bus.
fn notify_changed_on(bus: Option<&dyn EventBus>) {
    if let Some(bus) = bus {
        bus.emit_term_output(serde_json::json!({ "ev": ACTIONS_CHANGED_EVENT }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vale_agent_core::AppEventBus;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vale-evidence-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("temp dir");
        d
    }

    #[test]
    fn append_writes_oldest_first_and_reads_newest_first() {
        let dir = tmp_dir("roundtrip");
        for i in 1..=3 {
            append_action_line(&dir, crate::now_millis(), &serde_json::json!({ "n": i }));
        }
        // On-disk order is the append order (oldest first) — the contract
        // producers and any external tail-reader rely on.
        let raw = std::fs::read_to_string(actions_path(&dir)).expect("actions file");
        assert_eq!(raw.lines().count(), 3);
        assert!(raw.lines().next().unwrap().contains("\"n\":1"));
        // The reader flips it for the panel.
        let got = recent_actions(&dir, 10);
        let ns: Vec<i64> = got.iter().filter_map(|v| v["n"].as_i64()).collect();
        assert_eq!(ns, vec![3, 2, 1]);
    }

    #[test]
    fn recent_actions_caps_and_skips_torn_lines() {
        let dir = tmp_dir("caps");
        std::fs::write(
            actions_path(&dir),
            "not json\n{\"a\":1}\n{\"torn\":\n{\"b\":2}\n",
        )
        .expect("seed");
        // Newest-first scan of the last three lines: {"b":2}, torn, {"a":1}.
        let got = recent_actions(&dir, 3);
        assert_eq!(got.len(), 2, "the torn line must be skipped: {got:?}");
        assert_eq!(got[0]["b"], 2);
        assert_eq!(got[1]["a"], 1);
        // Cap applies before parsing — only the newest record survives.
        let capped = recent_actions(&dir, 1);
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0]["b"], 2);
    }

    #[test]
    fn recent_actions_missing_file_is_empty() {
        let dir = tmp_dir("empty");
        assert!(recent_actions(&dir, 50).is_empty());
    }

    #[test]
    fn append_into_a_missing_dir_is_best_effort() {
        let dir = std::env::temp_dir().join(format!("vale-evidence-absent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        append_action_line(&dir, crate::now_millis(), &serde_json::json!({ "n": 1 }));
        assert!(
            !actions_path(&dir).exists(),
            "no dir is created and no panic is raised"
        );
    }

    #[test]
    fn list_shots_keeps_only_png_and_sorts_newest_first() {
        let dir = tmp_dir("shots");
        std::fs::write(dir.join("old.png"), b"a").expect("old shot");
        std::fs::write(dir.join("new.png"), b"bb").expect("new shot");
        std::fs::write(dir.join("helper.js"), b"//").expect("non-png");
        std::fs::write(dir.join("notes.txt"), b"x").expect("non-png");
        // Explicit mtimes: same-second creations would otherwise tie and make
        // the ordering assertion depend on read_dir order.
        let base =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let f = std::fs::File::options()
            .write(true)
            .open(dir.join("old.png"))
            .expect("open old");
        f.set_modified(base).expect("set old mtime");
        let f = std::fs::File::options()
            .write(true)
            .open(dir.join("new.png"))
            .expect("open new");
        f.set_modified(base + std::time::Duration::from_secs(60))
            .expect("set new mtime");
        drop(f);

        let shots = list_shots(&dir, 40);
        let names: Vec<&str> = shots.iter().filter_map(|v| v["name"].as_str()).collect();
        assert_eq!(names, vec!["new.png", "old.png"]);
        assert_eq!(shots[0]["size"], 2);
        assert_eq!(shots[1]["size"], 1);
        assert_eq!(
            shots[1]["mtime_ms"].as_u64(),
            Some(1_700_000_000_000),
            "mtime_ms is unix milliseconds"
        );
        // Cap keeps the newest entries.
        let capped = list_shots(&dir, 1);
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0]["name"], "new.png");
    }

    #[test]
    fn list_shots_missing_dir_is_empty() {
        let dir = std::env::temp_dir().join(format!("vale-evidence-nodir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(list_shots(&dir, 40).is_empty());
    }

    #[test]
    fn shot_name_guard_rejects_traversal_shapes() {
        // The security contract of /api/browser/pwshot: basename only.
        for bad in [
            "",
            "..",
            "../x.png",
            "a/b.png",
            "a\\b.png",
            "..\\x.png",
            "a..b",
        ] {
            assert!(!shot_name_is_safe(bad), "{bad:?} must be rejected");
        }
        for ok in ["shot.png", "pwai_1_2_3-00.png", "mcp-page.png"] {
            assert!(shot_name_is_safe(ok), "{ok:?} must be served");
        }
    }

    #[test]
    fn notify_changed_pushes_the_panel_event() {
        let bus = AppEventBus::new();
        let mut rx = bus.subscribe_term_output();
        notify_changed_on(Some(&bus));
        assert_eq!(
            rx.try_recv().expect("the push must reach subscribers"),
            serde_json::json!({ "ev": ACTIONS_CHANGED_EVENT })
        );
    }

    #[test]
    fn notify_changed_without_a_bus_is_a_noop() {
        notify_changed_on(None);
    }

    // ── retention ────────────────────────────────────────────

    /// A file with an explicit mtime, so age is a fact rather than a sleep.
    fn seed(dir: &Path, name: &str, mtime_ms: u64) {
        let p = dir.join(name);
        std::fs::write(&p, b"x").expect("seed");
        let f = std::fs::File::options().write(true).open(&p).expect("open");
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(mtime_ms))
            .expect("set mtime");
        drop(f);
    }

    /// A fixed "now" for the whole retention group, so the boundary assertions
    /// are exact instead of drifting with the wall clock.
    const NOW: u64 = 1_800_000_000_000;
    const DAY_MS: u64 = 86_400_000;

    /// (a) The window is enforced: old artifacts go, fresh ones stay.
    ///
    /// Both owned classes are covered — a screenshot AND the `pwai_*.js` script
    /// that produced it — because a prune that bounded only the PNGs would
    /// leave the directory growing forever at 2 KB a run while every test on
    /// the screenshots stayed green.
    #[test]
    fn prune_removes_old_artifacts_and_keeps_fresh_ones() {
        let dir = tmp_dir("prune-age");
        seed(&dir, "old.png", NOW - 40 * DAY_MS);
        seed(&dir, "fresh.png", NOW - 2 * DAY_MS);
        seed(&dir, "old-script.js", NOW - 40 * DAY_MS);
        seed(&dir, "pwai_old.js", NOW - 40 * DAY_MS);
        seed(&dir, "pwai_fresh.js", NOW - 2 * DAY_MS);

        let removed = prune(&dir, 30, NOW);

        assert_eq!(
            removed,
            Pruned {
                shots: 1,
                scripts: 1,
                action_lines: 0
            },
            "exactly the two 40-day-old owned artifacts, per class"
        );
        assert!(!dir.join("old.png").exists());
        assert!(!dir.join("pwai_old.js").exists());
        assert!(dir.join("fresh.png").exists(), "inside the window");
        assert!(dir.join("pwai_fresh.js").exists());
        assert!(
            dir.join("old-script.js").exists(),
            "`old-script.js` is NOT `pwai_*.js` — only the feed's own per-run \
             script names are ever removed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The boundary is the WINDOW, and it is exclusive: a file exactly at the
    /// cutoff is kept (age == window is not "older than the window"), one
    /// millisecond past it is removed. Without this the rule would be "≈30
    /// days" and a mutation to `<=`/`>=` would pass every other test here.
    #[test]
    fn prune_boundary_is_exactly_the_window() {
        let dir = tmp_dir("prune-boundary");
        seed(&dir, "at-cutoff.png", NOW - 30 * DAY_MS);
        seed(&dir, "one-ms-past.png", NOW - 30 * DAY_MS - 1);

        let removed = prune(&dir, 30, NOW);

        assert_eq!(removed.shots, 1);
        assert!(
            dir.join("at-cutoff.png").exists(),
            "the boundary is exclusive — same semantics as \
             session_log::prune_stale's `age > max_age`"
        );
        assert!(!dir.join("one-ms-past.png").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (b) THE BOUND IS AGE, NOT COUNT.
    ///
    /// A browser-heavy burst — 400 screenshots taken minutes ago — must survive
    /// a prune in full. This is the requirement's whole point: a size- or
    /// count-triggered policy fires hardest exactly when the most evidence
    /// exists, so it would delete this burst, and the burst is the record of
    /// what the AI just did.
    #[test]
    fn a_large_burst_of_recent_evidence_survives() {
        let dir = tmp_dir("prune-burst");
        for i in 0..400 {
            seed(&dir, &format!("burst-{i:03}.png"), NOW - (i as u64) * 1_000);
        }

        let removed = prune(&dir, 30, NOW);

        assert_eq!(
            (removed.shots, removed.scripts, removed.action_lines),
            (0, 0, 0),
            "nothing in the burst may be removed"
        );
        let left = std::fs::read_dir(&dir).unwrap().flatten().count();
        assert_eq!(
            left, 400,
            "every one of the 400 recent shots must still be on disk — an \
             age-bounded prune cannot prefer a large recent burst for deletion"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (c) Files this module does not own are NEVER touched, whatever their
    /// age — pinned rather than assumed, because "delete everything old in this
    /// directory" is the obvious-looking implementation and it would eat the
    /// regenerable helper plus anything an operator parked there.
    #[test]
    fn prune_never_touches_a_file_the_feed_does_not_own() {
        let dir = tmp_dir("prune-foreign");
        seed(&dir, "vale-browser-helper.js", NOW - 400 * DAY_MS);
        seed(&dir, "notes.txt", NOW - 400 * DAY_MS);
        seed(&dir, "old.PNG", NOW - 400 * DAY_MS);
        seed(&dir, "pwai_but_not_a_script.txt", NOW - 400 * DAY_MS);
        std::fs::create_dir_all(dir.join("shot.png")).expect("dir named like a shot");
        seed(&dir, "doomed.png", NOW - 400 * DAY_MS);

        let removed = prune(&dir, 30, NOW);

        assert_eq!(removed.shots, 1, "only the one real owned artifact");
        for kept in [
            "vale-browser-helper.js",
            "notes.txt",
            "old.PNG",
            "pwai_but_not_a_script.txt",
        ] {
            assert!(
                dir.join(kept).exists(),
                "{kept} is not a feed artifact and must survive any window"
            );
        }
        assert!(
            dir.join("shot.png").is_dir(),
            "a DIRECTORY named `shot.png` is not a screenshot"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (d) THE IN-FLIGHT GUARANTEE.
    ///
    /// `max_age_days = 0` is the degenerate policy a typo (or a future caller
    /// that skips `RetentionConfig::effective`) produces, and it must still not
    /// remove what this session just wrote. The floor is what makes that
    /// structural instead of a promise about the configured window.
    #[test]
    fn prune_never_removes_the_current_sessions_evidence() {
        let dir = tmp_dir("prune-inflight");
        // Written "just now", by the run that is still going.
        seed(&dir, "just-written.png", NOW - 5_000);
        seed(&dir, "pwai_just-written.js", NOW - 5_000);
        append_action_line(&dir, NOW - 5_000, &serde_json::json!({ "n": 1 }));

        let removed = prune(&dir, 0, NOW);

        assert_eq!(
            (removed.shots, removed.scripts, removed.action_lines),
            (0, 0, 0),
            "a zero-day window (a typo, or a caller that skipped effective()) \
             must not empty the feed — the live action's own screenshot is in \
             there"
        );
        assert!(dir.join("just-written.png").exists());
        assert!(dir.join("pwai_just-written.js").exists());
        assert_eq!(
            recent_actions(&dir, 10).len(),
            1,
            "the action line describing that screenshot must survive with it"
        );

        // ...and the floor is a FLOOR, not an off switch: yesterday's evidence
        // is still pruned under the same degenerate config, which is what
        // separates this from "never prune at all".
        seed(&dir, "yesterday.png", NOW - 2 * DAY_MS);
        let removed = prune(&dir, 0, NOW);
        assert_eq!(removed.shots, 1);
        assert!(!dir.join("yesterday.png").exists());
        assert!(dir.join("just-written.png").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `actions.jsonl` ages out by each record's OWN stamp, whole lines only.
    ///
    /// The file's mtime can never age it (it is appended to forever, so it is
    /// always "now"), which is why the timeline needs per-record stamps while
    /// the screenshots use mtime. The surviving lines must be BYTE-IDENTICAL —
    /// readers and external tailers depend on the on-disk shape.
    #[test]
    fn prune_trims_the_action_timeline_by_record_stamp_only() {
        let dir = tmp_dir("prune-actions");
        std::fs::write(
            actions_path(&dir),
            format!(
                "{{\"n\":1,\"ts_ms\":{}}}\n\
                 {{\"n\":2,\"ts_ms\":{}}}\n\
                 not json\n\
                 {{\"n\":3,\"ts_ms\":{}}}\n",
                NOW - 40 * DAY_MS,
                NOW - 2 * DAY_MS,
                NOW - 40 * DAY_MS
            ),
        )
        .expect("seed");

        let removed = prune(&dir, 30, NOW);

        assert_eq!(removed.action_lines, 2);
        let raw = std::fs::read_to_string(actions_path(&dir)).expect("read");
        assert_eq!(
            raw,
            format!("{{\"n\":2,\"ts_ms\":{}}}\nnot json\n", NOW - 2 * DAY_MS),
            "the fresh record and the unparseable one are kept VERBATIM — an \
             unknown age is not an old age, and dropping the second line would \
             destroy a record merely because it could not be read"
        );
        // The reader still folds the survivors newest-first.
        let got = recent_actions(&dir, 10);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["n"], 2);
        // No temp residue from the atomic rewrite.
        assert!(!actions_path(&dir).with_extension("jsonl.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The timeline is only rewritten when something actually aged out.
    ///
    /// A no-op prune must not touch the file: rewriting it would bump its
    /// mtime and silently "repair" a torn tail, so a prune that deleted nothing
    /// would still be a mutation of the audit record.
    #[test]
    fn a_prune_with_nothing_to_do_does_not_rewrite_the_timeline() {
        let dir = tmp_dir("prune-noop");
        std::fs::write(
            actions_path(&dir),
            format!("{{\"n\":1,\"ts_ms\":{}}}\n", NOW - 1_000),
        )
        .expect("seed");
        let torn = "{\"torn\":";
        std::fs::write(actions_path(&dir), format!("{torn}\n")).expect("torn seed");

        assert_eq!(prune(&dir, 30, NOW), Pruned::default());
        assert_eq!(
            std::fs::read_to_string(actions_path(&dir)).expect("read"),
            format!("{torn}\n"),
            "untouched byte for byte"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A missing directory is a no-op, not an error — the prune runs at boot
    /// on devices that have never taken a screenshot.
    #[test]
    fn prune_on_a_missing_dir_is_a_noop() {
        let dir =
            std::env::temp_dir().join(format!("vale-evidence-noprune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(prune(&dir, 30, NOW), Pruned::default());
    }

    /// The mutex is not decorative: an append concurrent with a prune's
    /// REWRITE must never be lost.
    ///
    /// This is the round-116 shape — a rewrite that renames a NEW inode over a
    /// path while another writer holds (or is opening) a handle on the old one,
    /// so that write succeeds and lands nowhere. The writer interleaves an
    /// already-expired record with a live one, so EVERY prune call has
    /// something to drop and therefore always performs the rename; the live
    /// records are what must all survive.
    ///
    /// The pruner yields between passes and waits for the writer to reach a
    /// target, so the test measures the LOCK rather than the scheduler: a busy
    /// pruning thread would otherwise starve the writer and the "did it even
    /// run" assertion would fail on a machine-dependent number.
    #[test]
    fn appends_racing_a_prune_are_never_lost() {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::Arc;

        const TARGET: u64 = 100;

        let dir = std::env::temp_dir().join(format!("vale-evidence-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");

        let stop = Arc::new(AtomicBool::new(false));
        let written = Arc::new(AtomicU64::new(0));
        let writer = {
            let (dir, stop, written) = (dir.clone(), stop.clone(), written.clone());
            std::thread::spawn(move || {
                let mut n = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    // Expired: guarantees the next prune rewrites the file.
                    append_action_line(
                        &dir,
                        NOW - 400 * DAY_MS,
                        &serde_json::json!({ "kind": "old", "n": n }),
                    );
                    // Live: must be there when the dust settles.
                    append_action_line(
                        &dir,
                        NOW - 1_000,
                        &serde_json::json!({ "kind": "fresh", "n": n }),
                    );
                    n += 1;
                    written.store(n, Ordering::Relaxed);
                }
                n
            })
        };
        // Prune until the writer has been round the loop TARGET times. The
        // short back-off matters: without it the pruner starves the writer on
        // an unfair mutex, the writer never reaches TARGET, and the test
        // measures the scheduler instead of the lock.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while written.load(Ordering::Relaxed) < TARGET && std::time::Instant::now() < deadline {
            let _ = prune(&dir, 30, NOW);
            std::thread::yield_now();
            std::thread::sleep(std::time::Duration::from_micros(200));
        }
        stop.store(true, Ordering::Relaxed);
        let n = writer.join().expect("writer thread");
        assert!(
            n >= TARGET,
            "the writer only managed {n} passes — the pruner starved it, so \
             this run says nothing about the lock"
        );
        // The final state, with no writer left to add more.
        let _ = prune(&dir, 30, NOW);

        let lines = std::fs::read_to_string(actions_path(&dir)).expect("read");
        let parsed: Vec<Value> = lines
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .collect();
        assert_eq!(
            parsed.iter().filter(|v| v["kind"] == "old").count(),
            0,
            "every expired record aged out"
        );
        assert_eq!(
            parsed.iter().filter(|v| v["kind"] == "fresh").count() as u64,
            n,
            "every concurrent append must survive the rewrite — a lost record \
             here is the orphaned-inode bug the session trail already paid for"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
