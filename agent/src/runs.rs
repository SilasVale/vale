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
//!   * the four PRODUCERS (`terminal_execute`, `browser_run_script`,
//!     `mcp_client_call`, `memory_save`) only need to STAMP the id the client
//!     gave them. They never look a run up, so they need no access to a registry
//!     and none of them gains a dependency on this module's internals;
//!   * no process-global accessor means no repeat of the `JobsMap` incident,
//!     where a global let the background waiter write one map while readers read
//!     another and completion was never observed;
//!   * the record survives a restart, which an in-memory set would not.
//!
//! `run_begin` therefore needs no locking to be correct: the id embeds a
//! millisecond stamp plus randomness, so two simultaneous begins cannot collide
//! even across processes.

use serde_json::{json, Value};
use std::path::Path;

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
    let Ok(contents) = std::fs::read_to_string(runs_path(dir)) else {
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
    let Ok(contents) = std::fs::read_to_string(runs_path(dir)) else {
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
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(runs_path(dir))
    {
        let _ = writeln!(f, "{rec}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("vale-runs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
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

        const VERBS: &[&str] = &[
            "authorize",
            "authorised",
            "authorized",
            "is_allowed",
            "permission",
            "capability",
            "check_auth",
            "timing_safe_eq",
            "rate_limit",
            "deny",
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
            let production = text.split("#[cfg(test)]").next().unwrap_or(&text);
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
}
