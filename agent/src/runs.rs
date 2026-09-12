//! RUNS — one AI execution's identity, so its terminal commands and its browser
//! actions can be told apart from another AI's, and from the same AI's later work.
//!
//! ## Why an id is needed at all
//!
//! The device's model is "possession of the token IS the device identity"
//! (`web/panel.rs`), so the token distinguishes devices, not callers. Everything
//! closer to a caller turned out to be unusable:
//!
//!   * `peer_info` (the MCP handshake's `clientInfo`) is a SOFTWARE constant —
//!     dsh sends the hard-coded literal `dsh-mcp-client / 0.0.1`, identical for
//!     every session it ever runs;
//!   * the MCP-native `Mcp-Session-Id` is not implemented by the console gateway,
//!     and dsh keeps ONE long-lived connection anyway, so it would span every
//!     conversation that connection serves;
//!   * the token is per-device, so two clients sharing it are indistinguishable.
//!
//! So the identity is MINTED HERE, per execution: `run_begin` hands out an id, the
//! work carries it, `run_end` closes it. The granularity is one execution, which
//! is what "the same AI's operation" actually means.
//!
//! ## A LABEL, NEVER A CREDENTIAL
//!
//! A `run_id` is supplied by the client and is therefore SELF-REPORTED — exactly
//! like `intent`, `considered` and `plan_step`. It may be recorded, displayed and
//! grouped on. It must NEVER gate anything: no authorization, no capability
//! check, no rate limit. Anyone holding the device token can already do anything
//! the device permits, so an id cannot add or remove authority — but the moment
//! someone reads it as proof of identity, a self-reported string becomes a
//! security hole. That rule is the reason this paragraph exists, and
//! `run_id_is_never_a_credential` pins it in the core error table's spirit:
//! nothing in this module returns an authorization decision.
//!
//! ## File-backed, with no shared mutable state
//!
//! Runs are an append-only log beside the other device records, read through a
//! directory PARAMETER — the same shape as `evidence.rs`. That is deliberate:
//!
//!   * the PRODUCERS (`terminal_execute`, `terminal_plan`, `browser_run_script`,
//!     `mcp_client_call`, `memory_save`) only need to STAMP the id the client
//!     gave them. They never look a run up, so they need no access to a registry
//!     and none of them gains a dependency on this module's internals.
//!
//!     That list is a CLAIM ABOUT THE TREE, and it was wrong twice over when it
//!     was first written: it named `memory_save`, which stamped nothing, and
//!     omitted `terminal_plan`, which does. Corrected here after a scout checked
//!     it rather than trusting it — the same "documented feature does not exist"
//!     class as R109's `set_source`. Either make the claim true or stop making
//!     it: a reader who trusts a producer list will look for a field that is not
//!     there, or fail to look for one that is.
//!   * no process-global accessor means no repeat of the `JobsMap` incident,
//!     where a global let the background waiter write one map while readers read
//!     another and completion was never observed;
//!   * the record survives a restart, which an in-memory set would not.
//!
//! `run_begin` therefore needs no locking to be correct: the id embeds a
//! millisecond stamp plus randomness, so two simultaneous begins cannot collide
//! even across processes.
//!
//! ## Retention — the log has a bound now, and it is AGE
//!
//! `runs.jsonl` was append-only FOREVER: [`recent`] caps only what it READS, so
//! the file itself grew one line per begin and one per end with nothing to stop
//! it. [`trim`] is the bound, and it lives here for the same reason the
//! evidence prune lives in `evidence.rs` — this module is already the log's one
//! owner, and a new `retention.rs` would be a shared primitive with one
//! consumer (the repo's PROMOTION rule).
//!
//! The bound is AGE rather than SIZE because a size trigger fires exactly when
//! a long execution has produced the most records — i.e. it deletes the run
//! that is HAPPENING, which is the one an operator is looking at. See
//! `evidence.rs`'s header for the full argument; the two records make the same
//! choice for the same reason.
//!
//! The default window is longer than the evidence feed's
//! (`DEFAULT_RUNS_RETENTION_DAYS` in vale-command-core): this file is the INDEX
//! of that evidence, and dropping the index while the actions it brackets
//! survive would be backwards.

use serde_json::{json, Value};
use std::path::Path;
use std::sync::Mutex;

/// The runs log, beside the sessions and evidence directories.
pub(crate) const RUNS_FILE: &str = "runs.jsonl";

/// Longest label we keep, in bytes. A label is a line, not a paragraph.
const LABEL_MAX_BYTES: usize = 200;

pub(crate) fn runs_path(dir: &Path) -> std::path::PathBuf {
    dir.join(RUNS_FILE)
}

/// Mint a new run id and append its `run/begin` record. Returns the id.
///
/// The id is `<ts_ms>-<rand>`: the stamp makes it sortable and human-readable in
/// a log, the randomness makes it unique without a lock (see the module header).
pub(crate) fn begin(dir: &Path, label: Option<&str>, goal: Option<&str>) -> String {
    let ts_ms = crate::now_millis();
    let id = format!("run-{ts_ms}-{:06x}", rand24());
    append(
        dir,
        &json!({
            "kind": "run/begin",
            "run_id": id,
            "ts_ms": ts_ms,
            "label": clean(label),
            // The operator's objective, when the client knows it. NOT the same
            // thing as the run: one goal can span several runs (a retry after a
            // failure), and a run can have no goal at all (poking around). Kept
            // as a field rather than merged into the id so the two stay
            // distinguishable.
            "goal": clean(goal),
        }),
    );
    id
}

/// Append the `run/end` record. `outcome` is free text ("done", "failed"), kept
/// short; an absent outcome means the client did not say.
pub(crate) fn end(dir: &Path, run_id: &str, outcome: Option<&str>) {
    append(
        dir,
        &json!({
            "kind": "run/end",
            // Capped, unlike `begin`'s device-minted id: this one comes from the
            // CLIENT, so it gets the same byte cap as every other client-supplied
            // string in this crate. Without it a 10 MB id lands verbatim — and
            // the log is append-only, so the line could never be repaired.
            "run_id": clip_id(run_id),
            "ts_ms": crate::now_millis(),
            "outcome": clean(outcome),
        }),
    );
}

/// Was this id ever MINTED — is there a `run/begin` for it?
///
/// Reported to the caller and nothing else. `run_end` accepts an unknown id on
/// purpose: it is a label, and the log is best-effort (see the module header),
/// so an id without a begin is a legitimate record of a client that closed
/// something it never opened. Turning this into a gate is precisely the
/// credential trap the header forbids.
///
/// Streams the file rather than going through [`recent`]: this scan wants
/// short-circuiting and does not want to materialise an unbounded log.
pub(crate) fn known(dir: &Path, run_id: &str) -> bool {
    let Some(contents) = crate::jsonl::read_lossy(&runs_path(dir)) else {
        return false;
    };
    contents.lines().any(|l| {
        let Ok(v) = serde_json::from_str::<Value>(l) else {
            return false;
        };
        v.get("kind").and_then(|k| k.as_str()) == Some("run/begin")
            && v.get("run_id").and_then(|x| x.as_str()) == Some(run_id)
    })
}

/// A client-supplied id, trimmed and byte-capped on a char boundary.
fn clip_id(s: &str) -> String {
    crate::text::clip(s.trim(), LABEL_MAX_BYTES).to_string()
}

/// The most recent run boundaries, oldest first. Used by the operation timeline
/// to bracket a run and by the panel to group by it.
pub(crate) fn recent(dir: &Path, limit: usize) -> Vec<Value> {
    let Some(contents) = crate::jsonl::read_lossy(&runs_path(dir)) else {
        return Vec::new();
    };
    let mut out: Vec<Value> = contents
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();
    if out.len() > limit {
        out.drain(..out.len() - limit);
    }
    out
}

/// Trimmed, capped, and `None` when blank.
///
/// Blank becomes ABSENT rather than an empty string, the same discipline the
/// goal, plan and intent fields follow: a reader must be able to tell "the client
/// said nothing" from "the client said something empty", and collapsing them
/// keeps every downstream consumer from having to handle two kinds of nothing.
///
/// NOTE for anyone reading this module's OUTPUT: `json!` renders `None` as
/// `null`, so the JSONL — and [`recent`], which passes it straight through —
/// carries `"label": null` rather than omitting the key. That satisfies the rule
/// above (a reader distinguishes null from `""`) but NOT the stronger shape the
/// session audit trail uses, where `skip_serializing_if` omits the key outright.
/// Both read as "absent" to a careful consumer; only one is absent to a
/// key-existence check. Every consumer must therefore treat null, missing AND
/// blank alike — the panel's `groupOperation` does, pinned by its own test.
fn clean(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| crate::text::clip(s, LABEL_MAX_BYTES).to_string())
}

/// 24 random bits, hex. Small and non-cryptographic on purpose: this
/// disambiguates ids minted in the same millisecond, it does not protect
/// anything (a run_id is a label — see the module header).
fn rand24() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(crate::now_millis());
    h.write_u32(std::process::id());
    (h.finish() & 0x00ff_ffff) as u32
}

/// Best-effort append: the runs log is observability, so an unwritable path must
/// never fail the tool call that produced the record (same contract as the
/// evidence feed).
fn append(dir: &Path, rec: &Value) {
    use std::io::Write;
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    // Held across open+write+close — the same discipline (and the same reason)
    // as `evidence::FEED_LOCK`: the trim REPLACES this file by rename, so an
    // append that raced it would succeed against an orphaned inode and vanish.
    let _guard = RUNS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(runs_path(dir))
    {
        // TORN-TAIL REPAIR ONLY — no version header.
        //
        // `crate::jsonl::prepare_append` does two things: write a header into a
        // fresh file, and terminate a torn final line. This log wants only the
        // second. Adding a header would put a record with no `run_id` at the
        // head of the file, and `recent` returns every parseable line — so the
        // header would surface as a phantom entry to `/api/operation` and every
        // other reader of the timeline. Verified: adding it failed four
        // existing tests with a record count one too high.
        //
        // The torn tail is the part that matters: a crash mid-write leaves a
        // fragment with no trailing newline, the next append FUSES onto it, and
        // two records become one unparseable line. `session_log` and the memory
        // store have guarded against that since round 111; runs.rs never did,
        // which made it the ONE append-only log in the crate without the rule.
        //
        // Found by the abandon-pass test below: it appends onto a deliberately
        // torn log and then cannot read back the record it just wrote — the
        // orphan was found, closed, and the closure was invisible.
        if crate::jsonl::has_torn_tail(&runs_path(dir)).unwrap_or(false) {
            let _ = f.write_all(b"\n");
        }
        let _ = writeln!(f, "{rec}");
    }
}

// ── retention ────────────────────────────────────────────────

/// Serializes every mutation of the log: the append and the trim. Readers do
/// not take it — the trim is atomic, so a reader sees the old file or the new
/// one. See [`crate::jsonl::rewrite_atomically`] for the incident behind it.
static RUNS_LOCK: Mutex<()> = Mutex::new(());

/// Hard floor on the window, in days, independent of configuration — the same
/// in-flight guarantee the evidence feed carries, for the same reason: a
/// `retention: {runs_days: 0}` typo (or a caller that skipped
/// `RetentionConfig::effective`) must not be able to drop the run that is
/// running right now.
pub(crate) const MIN_RETENTION_DAYS: u64 = 1;

/// What one trim removed.
///
/// A count of DELETIONS only: what survived is readable from the file, and a
/// field nobody reports is a field that drifts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Trimmed {
    /// Records dropped from `runs.jsonl`.
    pub records: usize,
}

/// Drop the records older than `max_age_days` (floored at
/// [`MIN_RETENTION_DAYS`]). Returns what was removed.
///
/// The window is `max(MIN_RETENTION_DAYS, max_age_days)`, and `now_ms` is a
/// parameter so the boundary is testable exactly.
///
/// WHAT THIS DOES NOT DO, stated rather than implied: records are filtered one
/// at a time by their own `ts_ms`, so a `run/begin` and its `run/end` that
/// straddle the cutoff can part company. That leaves an `run/end` naming an id
/// with no begin — which this module ALREADY treats as a legitimate shape (see
/// [`known`]: "an id without a begin is a legitimate record of a client that
/// closed something it never opened"), and [`recent`] passes it through
/// unharmed. Keeping whole pairs would mean the retention window depended on
/// which runs happened to straddle it, which is worse than a stale end record.
///
/// A line that does not parse is KEPT: an unknown age is not an old age, and
/// the failure mode of guessing is destroyed history. [`recent`] already skips
/// such a line when reading, so keeping it costs nothing but bytes.
/// Close every run the process left open. Returns how many were closed.
///
/// `end` has exactly ONE caller — the `run_end` tool — so nothing closes a run
/// when the agent dies with one in flight. The restarts that do that are the
/// ordinary ones: the 60 s watchdog, a crash, and `vale update` (which kills the
/// agent BY DESIGN). A run killed mid-flight therefore stays "open" forever, and
/// after a day an abandoned run is indistinguishable from a live one — the panel
/// says exactly that today ("no end recorded ... the client may have stopped, or
/// the agent may have restarted", `panel-react/src/lib/runs.ts`).
///
/// This is the run-family sibling of the `abandoned` approval event: same loss,
/// same restarts, one event family over.
///
/// TWO RULES, both learned the hard way elsewhere in this crate:
///   * only a `run/begin` with NO `run/end` is closed. An id may appear many
///     times, so this is counted per id, not per line.
///   * it is IDEMPOTENT by construction: it appends `run/end`, and the next pass
///     sees the run as closed. Without that, every boot would append another
///     record (the trap the approval arm hit in round 18).
///
/// `outcome` is free text and the caller supplies it, because WHY a run stopped
/// is something this function cannot know — it only knows nobody said.
pub(crate) fn abandon_open_runs(dir: &Path, outcome: &str) -> usize {
    // NO LOCK HERE, and that is deliberate: `append` already takes `RUNS_LOCK`
    // across open+write+close, so holding it around the whole pass would be a
    // SELF-DEADLOCK — the first `end()` below would block on a lock this thread
    // already owns, and the test hung for 60 s proving it.
    //
    // Losing the outer lock costs nothing, because this pass does not need to be
    // atomic: each `end()` is individually atomic, and a run that begins WHILE
    // the pass runs is either seen by the read (and closed, which is correct —
    // the process is restarting) or not seen (and stays legitimately open). The
    // next boot closes it if it was really abandoned.
    let Some(contents) = crate::jsonl::read_lossy(&runs_path(dir)) else {
        return 0; // no log: nothing was ever begun.
    };
    // Unreadable lines are skipped, never fatal — the same stance `trim` and
    // `known` take, and the reason a torn final line cannot stop boot.
    let mut open: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in contents.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(id) = v.get("run_id").and_then(|r| r.as_str()) else {
            continue;
        };
        match v.get("kind").and_then(|k| k.as_str()) {
            Some("run/begin") => {
                if seen.insert(id.to_string()) {
                    open.push(id.to_string());
                }
            }
            Some("run/end") => {
                open.retain(|o| o != id);
            }
            _ => {}
        }
    }
    if open.is_empty() {
        return 0;
    }
    // Appended through the module's own writer, so the client-id cap and the
    // file-header hygiene stay in ONE place.
    for id in &open {
        end(dir, id, Some(outcome));
    }
    open.len()
}

pub(crate) fn trim(dir: &Path, max_age_days: u64, now_ms: u64) -> Trimmed {
    let mut out = Trimmed::default();
    let _guard = RUNS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let days = max_age_days.max(MIN_RETENTION_DAYS);
    let cutoff_ms = now_ms.saturating_sub(days.saturating_mul(86_400_000));
    let Some(contents) = crate::jsonl::read_lossy(&runs_path(dir)) else {
        return out;
    };
    let mut kept = String::with_capacity(contents.len());
    for line in contents.lines() {
        let old = match serde_json::from_str::<Value>(line) {
            Ok(v) => v
                .get("ts_ms")
                .and_then(|t| t.as_u64())
                .is_some_and(|ts| ts < cutoff_ms),
            Err(_) => false,
        };
        if old {
            out.records += 1;
            continue;
        }
        kept.push_str(line);
        kept.push('\n');
    }
    if out.records == 0 {
        // Nothing aged out: leave the file alone rather than rewriting it (a
        // no-op write would bump its mtime for no reason).
        return out;
    }
    if crate::jsonl::rewrite_atomically(&runs_path(dir), &kept).is_err() {
        // The file is untouched by a failed rewrite; report nothing removed so
        // a caller never logs a deletion that did not happen.
        return Trimmed::default();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("vale-runs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// ONE TORN MULTI-BYTE CHARACTER MUST NOT ERASE THE RUN LOG.
    ///
    /// `known`, `recent`, `trim` and the boot recovery arm all read this file
    /// with `read_to_string`, which rejects the WHOLE file on invalid UTF-8 —
    /// and a multi-byte character cut in half by a kill is exactly what a crash
    /// leaves. One damaged byte made `known` answer false for a run that is
    /// recorded, `recent` answer empty, and boot recovery close nothing.
    ///
    /// The four readers now share `jsonl::read_lossy` with the rest of the
    /// family, so the damaged line becomes a line that does not PARSE — which
    /// every one of them already skips — instead of a file that cannot be read.
    #[test]
    fn one_damaged_byte_does_not_erase_the_run_log() {
        let d = dir("lossy");
        std::fs::create_dir_all(&d).expect("mkdir");
        let id = begin(&d, Some("did a thing"), None);
        // A 2-byte character truncated to its first byte, then a real record.
        let mut raw = std::fs::read(runs_path(&d)).expect("read");
        raw.extend_from_slice(b"{\"run_id\":\"caf\xc3");
        raw.extend_from_slice(b"\n");
        std::fs::write(runs_path(&d), &raw).expect("write");

        assert!(
            known(&d, &id),
            "the run IS recorded — one damaged byte must not deny it"
        );
        assert!(
            !recent(&d, 10).is_empty(),
            "and the log must not read as empty"
        );
    }

    /// A run that died with the process gets a terminal record.
    ///
    /// `end` has exactly ONE caller — the `run_end` tool. Nothing closes an open
    /// run at boot, and the restarts that strand one are the ordinary ones: the
    /// 60 s watchdog, a crash, and `vale update`, which kills the agent BY
    /// DESIGN. So a run killed mid-flight stays "open" forever, and the panel
    /// says so in as many words ("no end recorded ... the client may have
    /// stopped, or the agent may have restarted" — lib/runs.ts).
    ///
    /// This is the same loss round 18 closed for approval questions, in the
    /// sibling event family: after a restart, a run that stopped because the
    /// device went down must not look like one that is still going.
    #[test]
    fn abandon_open_runs_closes_what_the_process_left_open() {
        let d = dir("abandon");
        let finished = begin(&d, Some("finished"), None);
        end(&d, &finished, Some("done"));
        let orphan = begin(&d, Some("orphan"), None);
        // A second open run, to prove the pass closes EVERY orphan, not one.
        let orphan2 = begin(&d, Some("orphan2"), None);

        let closed = abandon_open_runs(&d, "device restarted");
        assert_eq!(closed, 2, "both orphans must be closed: {closed}");

        let recs = recent(&d, 20);
        let ends: Vec<&serde_json::Value> = recs
            .iter()
            .filter(|r| r["kind"] == "run/end" && r["outcome"] == "device restarted")
            .collect();
        assert_eq!(ends.len(), 2, "one terminal record per orphan");
        let ended: Vec<String> = ends
            .iter()
            .map(|r| r["run_id"].as_str().unwrap().to_string())
            .collect();
        assert!(
            ended.contains(&orphan) && ended.contains(&orphan2),
            "by id: {ended:?}"
        );

        // The already-finished run keeps its own outcome — the pass must not
        // re-close it or overwrite what the client reported.
        let done: Vec<&serde_json::Value> = recs
            .iter()
            .filter(|r| r["run_id"] == finished.as_str() && r["kind"] == "run/end")
            .collect();
        assert_eq!(done.len(), 1, "a closed run is not closed again");
        assert_eq!(done[0]["outcome"], "done", "and its outcome is untouched");

        // IDEMPOTENT, or every boot appends another record (round 18's lesson).
        assert_eq!(
            abandon_open_runs(&d, "device restarted"),
            0,
            "a second pass finds nothing open"
        );
    }

    /// A log that is absent or unreadable is not an error — the runs log is
    /// best-effort everywhere else, and boot must never fail on it.
    #[test]
    fn abandon_open_runs_tolerates_a_missing_or_torn_log() {
        let d = dir("abandon-missing");
        assert_eq!(
            abandon_open_runs(&d, "device restarted"),
            0,
            "no file, no panic"
        );

        // A torn final line must not abort the pass: every OTHER record is
        // still readable, so the orphan before it is still found.
        let id = begin(&d, Some("before-tear"), None);
        let p = runs_path(&d);
        let mut raw = std::fs::read_to_string(&p).unwrap();
        raw.push_str("{\"kind\":\"run/be");
        std::fs::write(&p, raw).unwrap();
        // NOTE: the torn line has NO trailing newline, exactly as a crash
        // mid-`write` leaves it. Appending straight onto it FUSES the new record
        // into the fragment — the round-111 defect, one file over — so the
        // `run/end` this pass writes would be unreadable. `append` repairs the
        // torn tail first (`jsonl::prepare_append`), which is why the assertion
        // below can hold at all.
        assert_eq!(
            abandon_open_runs(&d, "device restarted"),
            1,
            "found the orphan"
        );
        assert!(recent(&d, 20)
            .iter()
            .any(|r| r["run_id"] == id.as_str() && r["kind"] == "run/end"));
    }

    /// A run is minted, labelled, and closable — readable back in order.
    #[test]
    fn a_run_is_begun_labelled_and_ended() {
        let d = dir("basic");
        let id = begin(&d, Some("  provision the ONU  "), Some("get it online"));
        assert!(id.starts_with("run-"), "id shape: {id}");

        end(&d, &id, Some("done"));

        let recs = recent(&d, 10);
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0]["kind"], "run/begin");
        assert_eq!(
            recs[0]["label"], "provision the ONU",
            "the label is trimmed"
        );
        assert_eq!(recs[0]["goal"], "get it online");
        assert_eq!(recs[1]["kind"], "run/end");
        assert_eq!(recs[1]["run_id"], id, "the end names the same run");
        assert_eq!(recs[1]["outcome"], "done");
    }

    /// Ids minted in the SAME millisecond must differ.
    ///
    /// The stamp alone would collide, and two runs sharing an id would silently
    /// merge one AI's work into another's — the exact confusion the id exists to
    /// prevent.
    #[test]
    fn two_runs_in_the_same_millisecond_are_distinct() {
        let d = dir("unique");
        let ids: Vec<String> = (0..50).map(|_| begin(&d, None, None)).collect();
        let mut uniq = ids.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), ids.len(), "every minted id must be unique");
        // All in the same millisecond is the point of the test.
        let stamps: std::collections::HashSet<u64> = recent(&d, 100)
            .iter()
            .filter_map(|r| r["ts_ms"].as_u64())
            .collect();
        assert!(stamps.len() <= ids.len(), "sanity: stamps are milliseconds");
    }

    /// A blank label is ABSENT, not an empty string.
    #[test]
    fn blank_label_and_goal_are_absent() {
        let d = dir("blank");
        begin(&d, Some("   "), Some(""));
        let r = recent(&d, 1).remove(0);
        assert!(r.get("label").is_none() || r["label"].is_null());
        assert!(r.get("goal").is_none() || r["goal"].is_null());
        // And an omitted one likewise.
        let d2 = dir("omitted");
        begin(&d2, None, None);
        let r2 = recent(&d2, 1).remove(0);
        assert!(r2["label"].is_null());
    }

    /// A long label is capped on a char boundary.
    #[test]
    fn a_long_label_is_capped_on_a_char_boundary() {
        let d = dir("cap");
        // Every char is 3 bytes, so a byte cut lands mid-character.
        begin(&d, Some(&"汉".repeat(400)), None);
        let label = recent(&d, 1).remove(0)["label"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            label.len() <= LABEL_MAX_BYTES,
            "capped, got {}",
            label.len()
        );
        assert_eq!(
            label.chars().count() * 3,
            label.len(),
            "the cap must land on a char boundary, not inside 汉"
        );
    }

    /// `limit` keeps the NEWEST records, and an absent directory is empty.
    #[test]
    fn limit_keeps_the_newest_and_a_missing_dir_is_empty() {
        let d = dir("limit");
        for _ in 0..5 {
            begin(&d, Some("x"), None);
        }
        assert_eq!(recent(&d, 2).len(), 2);
        assert!(recent(std::path::Path::new("/nonexistent-vale-runs"), 5).is_empty());
    }

    /// THE WIRE SHAPE of an absent label/goal/outcome, pinned rather than
    /// assumed.
    ///
    /// The module's rule is "blank becomes ABSENT", and a reader naturally takes
    /// that to mean the KEY is gone — the session audit trail works exactly that
    /// way (`skip_serializing_if`). It is not: `json!` cannot skip, so the key is
    /// present with a `null` value. That difference is invisible to a careful
    /// consumer (null, missing and blank all mean "no label") and decisive to a
    /// careless one (`"label" in record` is true; `Object.keys().length` counts
    /// it). It was found by a PANEL reader going looking for the absent-key shape
    /// the docs implied, so it is pinned here: a future switch to true omission
    /// must be a deliberate act that also updates this test and the consumers.
    #[test]
    fn an_absent_label_is_a_null_value_not_a_missing_key() {
        let d = dir("wireshape");
        begin(&d, None, None);
        let rec = recent(&d, 1).remove(0);

        assert!(
            rec.get("label").is_some(),
            "the key is PRESENT (with a null value) — see this test's doc comment"
        );
        assert!(rec["label"].is_null(), "and its value is null, not \"\"");
        assert!(rec["goal"].is_null());
        // The distinction that matters to a consumer either way: null is NOT an
        // empty string, so "said nothing" and "said something empty" stay apart.
        assert_ne!(rec["label"], serde_json::json!(""));
    }

    /// NO AUTHORIZATION SURFACE. The module exposes mint/end/read and nothing
    /// else — this test exists so a future addition has to delete it deliberately.
    ///
    /// A run_id is self-reported; making it a credential would turn a label into
    /// a vulnerability. The assertion is a source scan because the property is
    /// about the API's SHAPE, not its behaviour on one input.
    #[test]
    fn run_id_is_never_a_credential() {
        let src = include_str!("runs.rs");
        let production = src.split("#[cfg(test)]").next().unwrap();
        for forbidden in [
            "fn authorize",
            "fn allows",
            "fn can_",
            "fn check_permission",
        ] {
            assert!(
                !production.contains(forbidden),
                "runs.rs must expose no authorization decision ({forbidden} found) — \
                 a run_id is self-reported and must never gate anything"
            );
        }
        assert!(
            production.contains("LABEL, NEVER A CREDENTIAL"),
            "the label-not-credential rule must stay stated in the module header, \
             because it is the thing a future reader is most likely to violate"
        );
    }

    /// THE REPO-WIDE HALF of the rule above.
    ///
    /// The scan above only sees this file, and this file is not where the rule
    /// can be broken: the damage would be a CALLER comparing a run id, or the
    /// auth gate learning to read one. Both live outside it. So this walks
    /// `src/` and asserts the two things that would make a self-reported string
    /// into a security boundary:
    ///
    ///   1. `check_auth` / `TokenGate` never mention `run_id` — the device has
    ///      ONE token and possession of it IS the identity (`web/panel.rs`), so
    ///      an id must never participate in that decision;
    ///   2. no line mentions `run_id` AND an authorization verb.
    ///
    /// Deliberately a LINE scan with a stated limit: it cannot see a decision
    /// spread across lines or reached indirectly. It is a tripwire on the
    /// obvious shapes, not a proof.
    #[test]
    fn no_caller_derives_authority_from_a_run_id() {
        let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        collect_rs(&src_dir, &mut files);
        assert!(
            files.len() > 20,
            "the scanner found {} files — it is looking in the wrong place, and a \
             scan over nothing passes trivially",
            files.len()
        );

        // Words that mark a line as an AUTHORIZATION decision. Deliberately
        // over-broad: this is a tripwire, and a false positive costs a rewrite
        // of one comment line while a false negative costs the rule.
        //
        // `gate` and `authoriz` were added after an adversarial reviewer planted
        // `let _gate = run_id == "x"` — a real decision the original list had no
        // word for. Equality is NOT banned outright, because `known()` below
        // legitimately compares an id; what is banned is a run_id near a word
        // that says the comparison decides something.
        const VERBS: &[&str] = &[
            "authorize",
            "authorised",
            "authorized",
            "authoriz",
            "is_allowed",
            "allowed",
            "permission",
            "capability",
            "check_auth",
            "timing_safe_eq",
            "rate_limit",
            "deny",
            "gate",
            "forbid",
        ];

        for path in &files {
            let Ok(text) = std::fs::read_to_string(path) else {
                continue;
            };
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // The gate itself must not know the concept exists.
            if name == "mod.rs" && text.contains("fn check_auth") {
                let body = text
                    .split("fn check_auth")
                    .nth(1)
                    .and_then(|t| {
                        t.split("\nasync fn ")
                            .next()
                            .or_else(|| t.split("\nfn ").next())
                    })
                    .unwrap_or("");
                assert!(
                    !body.contains("run_id"),
                    "{name}: check_auth must NEVER read a run_id — the device has one \
                     token and possession of it IS the identity; a self-reported string \
                     can only ever subtract safety"
                );
            }
            // Only production lines: a test may legitimately name both in order
            // to PROVE they are unrelated.
            let production = production_prefix(&text);
            for (i, line) in production.lines().enumerate() {
                // COMMENTS ARE SKIPPED, and the first run of this scanner is why:
                // it flagged the doc comment that says a run_id must "never
                // authorize" anything — the rule's own statement of itself. A
                // comment makes no decision, and the prose that WARNS against
                // the mistake is exactly what should be allowed to name it. The
                // limit that buys: a commented-out violation is not caught. That
                // is the right trade — dead prose gates nothing.
                if is_comment_line(line) {
                    continue;
                }
                let l = line.to_ascii_lowercase();
                if !l.contains("run_id") {
                    continue;
                }
                for v in VERBS {
                    assert!(
                        !l.contains(v),
                        "{}:{} mentions `run_id` and `{v}` in CODE — a run_id is \
                         self-reported and must never gate anything. If this is \
                         genuinely unrelated, rewrite the line so the rule stays \
                         scannable.\n  {line}",
                        path.display(),
                        i + 1
                    );
                }
            }
        }
    }

    /// Is this source line a comment (or blank)? Both `//` and the doc forms
    /// `///` / `//!` start with `//`, so one test covers all three.
    fn is_comment_line(line: &str) -> bool {
        let t = line.trim_start();
        t.is_empty() || t.starts_with("//")
    }

    /// The PRODUCTION part of a source file: everything before its first TEST
    /// MODULE.
    ///
    /// Not `text.split("#[cfg(test)]")` — and the difference is the whole point
    /// of this function. That naive split cuts at the first cfg(test)
    /// ATTRIBUTE, and four files in this crate carry `#[cfg(test)]` on a single
    /// mid-file helper item hundreds of lines before their `mod tests` block
    /// (`plugins/terminal/mod.rs`, `web/sse.rs`, `tools/terminal/secrets.rs`,
    /// `tools/terminal/connections.rs`). The scanner therefore stopped early and
    /// skipped real production code while reporting a clean sweep.
    ///
    /// Found by an adversarial reviewer measuring the scan's COVERAGE instead of
    /// trusting its verdict — which is the same lesson as the gate itself: a
    /// check that cannot see the code it is checking is not a check.
    fn production_prefix(text: &str) -> &str {
        let lines: Vec<&str> = text.split_inclusive('\n').collect();
        for (i, line) in lines.iter().enumerate() {
            // A test module is `mod tests`, whatever attribute precedes it.
            if !line.trim_start().starts_with("mod tests") {
                continue;
            }
            // Walk back over the attributes attached to it; the production
            // region ends where the cfg attribute begins.
            for j in (0..i).rev() {
                let t = lines[j].trim();
                if t.is_empty() || t.starts_with("//") {
                    continue;
                }
                if t.starts_with("#[cfg(") {
                    let off: usize = lines[..j].iter().map(|l| l.len()).sum();
                    return &text[..off];
                }
                break;
            }
        }
        text
    }

    /// The scanner's own self-check: it must SEE production code that follows a
    /// single mid-file `#[cfg(test)]` item.
    ///
    /// Without this, "the scan is clean" and "the scan stopped after 100 lines"
    /// are the same result. A gate with no self-check is not a gate.
    #[test]
    fn the_scan_covers_production_code_after_a_mid_file_cfg_test() {
        let fixture = "\
fn production_before() {}
#[cfg(test)]
fn a_helper_only_compiled_in_tests() {}
fn production_AFTER_the_attribute() {}
#[cfg(test)]
mod tests {
    fn t() {}
}
";
        let scanned = production_prefix(fixture);
        assert!(
            scanned.contains("production_AFTER_the_attribute"),
            "the naive split at the first cfg(test) hid this line — which is \
             exactly the hole four real files had"
        );
        assert!(
            !scanned.contains("fn t() {}"),
            "the test module itself must stay out of the scan"
        );

        // And the real tree: the helper must actually reach the end of the
        // files that carry a mid-file cfg(test) item.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for rel in [
            "plugins/terminal/mod.rs",
            "web/sse.rs",
            "tools/terminal/secrets.rs",
            "tools/terminal/connections.rs",
        ] {
            let text = std::fs::read_to_string(root.join(rel)).unwrap();
            let naive = text.split("#[cfg(test)]").next().unwrap();
            let fixed = production_prefix(&text);
            assert!(
                fixed.len() > naive.len(),
                "{rel}: the fix must scan MORE than the naive split — if these \
                 are equal, the mid-file cfg(test) item moved and this test's \
                 premise is stale"
            );
            assert!(
                fixed.len() >= text.rfind("mod tests").map(|_| 0).unwrap_or(0),
                "{rel}: sanity"
            );
        }
    }

    /// Every `.rs` under `src/`, recursively. `mod.rs` files are included: the
    /// auth gate lives in one of them.
    fn collect_rs(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_rs(&p, out);
            } else if p.extension().and_then(|x| x.to_str()) == Some("rs") {
                out.push(p);
            }
        }
    }

    /// `run_end` accepts an id it has never seen, and SAYS SO rather than
    /// guessing or refusing.
    ///
    /// Three properties in one, all of them consequences of the module's header:
    /// the log is best-effort so an unregistered id must still be recorded; the
    /// answer must not become a gate; and the log is append-only, so a forged end
    /// can never rewrite history.
    #[test]
    fn an_unregistered_id_is_recorded_and_reported_but_never_refused() {
        let d = dir("unknown");
        let real = begin(&d, Some("real run"), None);
        let before = std::fs::read_to_string(runs_path(&d)).unwrap();

        assert!(!known(&d, "run-that-was-never-begun"), "not minted here");
        assert!(known(&d, &real), "minted here");

        end(&d, "run-that-was-never-begun", Some("done"));

        let after = std::fs::read_to_string(runs_path(&d)).unwrap();
        assert_eq!(
            after.matches('\n').count(),
            before.matches('\n').count() + 1,
            "the unknown end is APPENDED — exactly one line, nothing rewritten"
        );
        assert!(
            after.starts_with(&before),
            "every earlier byte must be untouched: append-only is what makes a \
             forged end inert rather than a way to rewrite history"
        );
        assert_eq!(
            recent(&d, 10).last().unwrap()["run_id"],
            "run-that-was-never-begun",
            "the record of the unknown id survives — the log is best-effort"
        );
    }

    /// A client-supplied id is CAPPED, like every other remote string here.
    ///
    /// `begin` mints its own short id, but `end` takes the client's word for it.
    /// Uncapped, a 10 MB id lands verbatim — and the log is append-only, so the
    /// damage is permanent and rides every read of it.
    #[test]
    fn an_oversized_client_id_is_capped_on_a_char_boundary() {
        let d = dir("capid");
        let huge = "汉".repeat(5_000);
        end(&d, &huge, None);

        let rec = recent(&d, 1).remove(0);
        let id = rec["run_id"].as_str().unwrap();
        assert!(
            id.len() <= LABEL_MAX_BYTES,
            "the id must be capped, got {} bytes",
            id.len()
        );
        assert_eq!(
            id.chars().count() * 3,
            id.len(),
            "the cap must land on a char boundary — a naive byte slice panics here"
        );
    }

    // ── retention ────────────────────────────────────────────

    /// A fixed "now" so the boundary assertions are exact rather than drifting
    /// with the wall clock, plus a helper that writes a record with a chosen
    /// stamp (the module's own writers always stamp NOW, which is useless for
    /// testing a window).
    const NOW: u64 = 1_800_000_000_000;
    const DAY_MS: u64 = 86_400_000;

    fn seed(d: &std::path::Path, run_id: &str, ts_ms: u64) {
        append(
            d,
            &json!({ "kind": "run/begin", "run_id": run_id, "ts_ms": ts_ms,
                     "label": null, "goal": null }),
        );
    }

    /// Old records go, fresh ones stay, and the survivors are byte-identical.
    ///
    /// The wire shape is the point of the last assertion: readers (the panel's
    /// grouping, `/api/operation`, `known`) parse these lines, so a trim that
    /// reformatted them would be a format change wearing a retention change's
    /// clothes.
    #[test]
    fn trim_removes_old_records_and_keeps_fresh_ones() {
        let d = dir("trim-age");
        seed(&d, "run-old", NOW - 120 * DAY_MS);
        seed(&d, "run-fresh", NOW - 2 * DAY_MS);
        let before = std::fs::read_to_string(runs_path(&d)).expect("seed read");

        let out = trim(&d, 90, NOW);

        assert_eq!(out.records, 1, "only the 120-day-old record");
        let after = std::fs::read_to_string(runs_path(&d)).expect("read");
        let fresh_line = before.lines().nth(1).expect("second seeded line");
        assert_eq!(
            after,
            format!("{fresh_line}\n"),
            "the surviving record keeps its EXACT bytes — a reader depends on \
             this shape, so retention may drop lines but never reformat them"
        );
        assert_eq!(recent(&d, 10).len(), 1);
        assert!(!known(&d, "run-old"));
        assert!(known(&d, "run-fresh"));
        assert!(!runs_path(&d).with_extension("jsonl.tmp").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The boundary is the WINDOW and it is exclusive, mirroring
    /// `session_log::prune_stale`'s `age > max_age`: a record exactly at the
    /// cutoff survives.
    #[test]
    fn trim_boundary_is_exactly_the_window() {
        let d = dir("trim-boundary");
        seed(&d, "at-cutoff", NOW - 90 * DAY_MS);
        seed(&d, "one-ms-past", NOW - 90 * DAY_MS - 1);

        let out = trim(&d, 90, NOW);

        assert_eq!(out.records, 1);
        assert!(known(&d, "at-cutoff"), "the boundary is exclusive");
        assert!(!known(&d, "one-ms-past"));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// (b) AGE, NOT COUNT: a busy period's records all survive.
    #[test]
    fn a_burst_of_recent_runs_survives_any_window() {
        let d = dir("trim-burst");
        for i in 0..500 {
            seed(&d, &format!("run-{i}"), NOW - i);
        }

        assert_eq!(trim(&d, 90, NOW), Trimmed { records: 0 });
        assert_eq!(
            recent(&d, 1_000).len(),
            500,
            "AGE, not count: 500 recent runs must all survive"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The in-flight guarantee: a zero-day window cannot drop the run that is
    /// running now — and it is a floor, not an off switch, so yesterday's
    /// records still age out under the same degenerate config.
    #[test]
    fn trim_never_removes_the_run_that_is_in_flight() {
        let d = dir("trim-inflight");
        // `begin` stamps with the REAL clock, so this test's "now" must be the
        // real clock too — the fixed NOW the seeded tests use is a synthetic
        // instant far in the future and would age the live run out on paper.
        //
        // And it is five seconds LATER than the stamp, deliberately: with
        // `now == stamp` the record survives a zero-day window for the trivial
        // reason that `ts < now` is false, so the assertion would ALSO hold
        // with the floor deleted — a pin that cannot fail. Five seconds in
        // makes the floor the only thing keeping it.
        let live = begin(&d, Some("still going"), None);
        let now = crate::now_millis() + 5_000;

        assert_eq!(
            trim(&d, 0, now).records,
            0,
            "a zero-day window (a typo, or a caller that skipped effective()) \
             must not drop the run that is happening right now"
        );
        assert!(known(&d, &live), "the live run's begin is still on disk");
        assert_eq!(recent(&d, 10).len(), 1);

        // The floor is a FLOOR: record yesterday's run and it is gone.
        seed(&d, "run-yesterday", now - 2 * DAY_MS);
        let out = trim(&d, 0, now);
        assert_eq!(
            out.records, 1,
            "the floor bounds the window, it does not \
                                    disable the trim"
        );
        assert!(known(&d, &live));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// An unparseable line is KEPT: its age is unknown, and guessing costs
    /// history. `recent` already skips it when reading.
    #[test]
    fn trim_keeps_lines_it_cannot_read() {
        let d = dir("trim-unparsed");
        let path = runs_path(&d);
        std::fs::create_dir_all(&d).expect("dir");
        std::fs::write(
            &path,
            "{\"garbage\":\n{\"kind\":\"run/begin\",\"run_id\":\"r\",\"ts_ms\":1}\n",
        )
        .expect("seed");

        let out = trim(&d, 30, NOW);

        assert_eq!(out.records, 1, "only the parseable ancient record");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "{\"garbage\":\n",
            "the unreadable line survives verbatim"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A missing log is a no-op (the trim runs at boot on devices that have
    /// never begun a run).
    #[test]
    fn trim_on_a_missing_log_is_a_noop() {
        let d = std::env::temp_dir().join(format!("vale-runs-notrim-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert_eq!(trim(&d, 30, NOW), Trimmed::default());
    }

    /// A trim's rewrite must not lose a record appended while it runs — the
    /// same orphaned-inode hazard `evidence` guards with its own mutex, so the
    /// two owners are pinned the same way.
    #[test]
    fn appends_racing_a_trim_are_never_lost() {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::Arc;

        const TARGET: u64 = 100;

        let d = std::env::temp_dir().join(format!("vale-runs-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("dir");

        let stop = Arc::new(AtomicBool::new(false));
        let written = Arc::new(AtomicU64::new(0));
        let writer = {
            let (d, stop, written) = (d.clone(), stop.clone(), written.clone());
            std::thread::spawn(move || {
                let mut n = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    // Expired: guarantees the next trim rewrites the file.
                    seed(&d, &format!("old-{n}"), NOW - 400 * DAY_MS);
                    seed(&d, &format!("fresh-{n}"), NOW - 1_000);
                    n += 1;
                    written.store(n, Ordering::Relaxed);
                }
                n
            })
        };
        // A short back-off between passes: without it the trimming thread
        // starves the writer on an unfair mutex, the writer never reaches
        // TARGET, and the test measures the scheduler instead of the lock.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while written.load(Ordering::Relaxed) < TARGET && std::time::Instant::now() < deadline {
            let _ = trim(&d, 90, NOW);
            std::thread::yield_now();
            std::thread::sleep(std::time::Duration::from_micros(200));
        }
        stop.store(true, Ordering::Relaxed);
        let n = writer.join().expect("writer thread");
        assert!(
            n >= TARGET,
            "the writer only managed {n} passes — the trimmer starved it, so \
             this run says nothing about the lock"
        );
        let _ = trim(&d, 90, NOW);

        let text = std::fs::read_to_string(runs_path(&d)).expect("read");
        // Counted through the PARSER, not `str::matches`: without the lock a
        // lost write can fuse two records into one unparseable line, and a
        // substring count would then still "find" a run that no reader can see.
        let parsed: Vec<Value> = text
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .collect();
        let with_prefix = |p: &str| {
            parsed
                .iter()
                .filter(|v| v["run_id"].as_str().is_some_and(|r| r.starts_with(p)))
                .count()
        };
        assert_eq!(with_prefix("old-"), 0, "every expired record aged out");
        assert_eq!(
            with_prefix("fresh-") as u64,
            n,
            "every concurrent append must survive the rewrite — a short count \
             is the orphaned-inode bug (or a fused line from a lost write) that \
             the session trail already paid for"
        );
        let _ = std::fs::remove_dir_all(&d);
    }
}
