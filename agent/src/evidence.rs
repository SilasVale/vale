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
pub(crate) fn append_action_line(dir: &Path, line: &impl std::fmt::Display) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(actions_path(dir))
    {
        let _ = writeln!(f, "{line}");
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
            let mtime_ms = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0)
                })
                .unwrap_or(0);
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
            append_action_line(&dir, &serde_json::json!({ "n": i }));
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
        append_action_line(&dir, &serde_json::json!({ "n": 1 }));
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
}
