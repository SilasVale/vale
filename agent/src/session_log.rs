//! Session audit log — append-only JSONL per terminal session.
//!
//! Boundary (architecture review 2026-09-06): a FOUNDATION module consumed by
//! every terminal tool path (exec/sessions/connections via the plugin ctx) —
//! correctly layered, heavily hardened (round-54/56/58/59/68/98/99 + stage-n
//! retention/clock-jump guards, each with tests), no structural change
//! warranted. Content policy: commands and output are recorded verbatim (the
//! audit trail's purpose is to reconstruct what ran) with 4 KiB caps; secrets
//! pasted INTO a command line are therefore in the trail by design — the
//! files live on the device under the ACL-restricted install dir and are
//! pruned at 30 days.
//!
//! Every terminal command on a device is recorded as an event stream
//! (`<install>/sessions/<sid>.jsonl`): command/start → output chunks →
//! command/end. On agent restart the logger replays each file and appends a
//! synthetic `command/end { reason: interrupted }` for any command that never
//! finished — an audit trail for device-control compliance, and the panel
//! can show "interrupted — may still be running on the device" instead of
//! pretending the command vanished with the process (round-54, dsh event
//! sourcing: the append-only log is the source of truth).
//!
//! Writes are best-effort by design — a log failure must never block or
//! break the terminal itself.

use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

/// Closed-session log trim: keep the version header + this many trailing
/// audit lines (round-98 — a closed session's file grew unbounded).
const MAX_CLOSED_LOG_LINES: usize = 2000;

/// Longest command line we keep, in bytes.
///
/// Existed as a literal 4096 in the plain path for the reason recorded there (a
/// multi-MB one-liner rode the trail forever and forced a multi-MB read at
/// close); named now that a SECOND entry point needs the same rule, because two
/// copies of a cap is how one of them drifts.
const COMMAND_MAX_BYTES: usize = 4096;

/// Both audit stamps, derived from ONE elapsed-since-epoch reading.
///
/// A pure function of a `Duration` on purpose. The first version of this
/// stamped the pair inline from one `SystemTime::now()`, and the pin that was
/// supposed to prove it ("do they describe the same instant?") PASSED a mutant
/// that called the clock TWICE — two reads nanoseconds apart land in the same
/// second essentially always, so the assertion could not see the difference.
/// A probabilistic pin for a structural claim is not a pin.
///
/// Taking the duration as an argument makes the claim checkable exactly: a
/// duration that straddles a second boundary proves both stamps come from the
/// same value, because no pair of separate reads could produce that pair.
fn stamps_from(d: std::time::Duration) -> (u64, u64) {
    (d.as_secs(), d.as_millis() as u64)
}

/// Apply the command cap with its truncation notice. ONE rule for both entry
/// points — the plain log and the intent-carrying one — so a command cannot ride
/// the trail uncapped just because of which method the caller happened to use.
fn cap_command(command: &str) -> String {
    if command.len() > COMMAND_MAX_BYTES {
        let cut = crate::text::boundary_at_or_below(command, COMMAND_MAX_BYTES);
        format!(
            "{}…[truncated {} bytes]",
            &command[..cut],
            command.len() - cut
        )
    } else {
        command.to_string()
    }
}

/// Longest `intent` we keep, in bytes — an objective sentence, not an essay.
const INTENT_MAX_BYTES: usize = 512;
/// Most alternatives we keep per command. The decision tree's branching factor:
/// beyond a handful a reader is looking at a list, not a choice.
const CONSIDERED_MAX: usize = 8;
/// Longest single alternative, in bytes — a button label, not a paragraph.
const CONSIDERED_ITEM_MAX_BYTES: usize = 160;
/// Longest `run_id` we keep, in bytes. A minted id is ~30 bytes; this is
/// generous headroom for a client that hands back something larger, and it is
/// a CAP rather than a rejection because the run is an attribute of the
/// command, not a condition for running it.
const RUN_ID_MAX_BYTES: usize = 200;

/// Stream-trim a session JSONL: keep the version header + the LAST
/// command/start (recovery needs it to detect an interrupted command) and
/// everything after it; if that's still over the cap, keep the most recent
/// lines BUT never drop the last command/start (round-100: the previous
/// cap drain removed it when the final command produced >2000 events —
/// the exact R98 bug R99 claimed to fix). Memory-bounded: on seeing a NEW
/// command/start, everything before it is drained immediately (round-100:
/// the previous version retained everything after the FIRST start, still
/// O(file size) at close).
fn trim_file(path: &std::path::Path) {
    use std::io::{BufRead, BufReader, BufWriter, Write as _};
    let Ok(file) = std::fs::File::open(path) else {
        return;
    };
    let mut reader = BufReader::new(file);
    let mut header = String::new();
    let _ = reader.read_line(&mut header); // version header (may be empty)
                                           // tail = the last command/start + everything after it (rolling).
    let mut tail: Vec<String> = Vec::new();
    let mut have_start = false;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if line.contains("\"command/start\"") {
                    // A NEW start: everything before it is older history —
                    // drain immediately (bounds memory; only the last
                    // start window + rolling tail are retained).
                    if have_start {
                        tail.clear();
                    }
                    have_start = true;
                }
                tail.push(line.clone());
                // Cap: keep the last MAX lines BUT always retain the last
                // command/start (drop from the head only while the start
                // is still in the window).
                if tail.len() > MAX_CLOSED_LOG_LINES + 1 {
                    let drop = tail.len() - (MAX_CLOSED_LOG_LINES + 1);
                    // Never drop line 0 while it is the start.
                    if !(have_start
                        && tail[0].contains("\"command/start\"")
                        && drop > 0
                        && tail.len() > drop)
                    {
                        tail.drain(..drop);
                    } else if have_start && tail[0].contains("\"command/start\"") {
                        // Start at head: keep it, drop from index 1.
                        tail.drain(1..1 + drop);
                    } else {
                        tail.drain(..drop);
                    }
                }
            }
            Err(_) => break,
        }
    }
    if tail.is_empty() {
        return;
    }
    // round-116: atomic trim — File::create truncates the file to zero and
    // rewrites in place; a crash (Windows service kill, power loss) between
    // truncate and rewrite destroyed the WHOLE session audit tail (and the
    // recovery marker). Write the trimmed tail to a temp file in the same
    // dir, flush+sync, then rename over the original (atomic on Windows).
    let tmp = path.with_extension("jsonl.tmp");
    let res = (|| -> std::io::Result<()> {
        let mut out = std::fs::File::create(&tmp)?;
        {
            let mut w = BufWriter::new(&mut out);
            w.write_all(header.as_bytes())?;
            for l in &tail {
                w.write_all(l.as_bytes())?;
            }
            w.flush()?;
        }
        out.sync_all()?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// One audit event for a session. `seq` is per-session monotonic; `ts` is
/// unix seconds. Optional fields are omitted when absent (compact JSONL).
#[derive(Debug, Clone, Serialize)]
pub struct SessionEvent {
    pub seq: u64,
    pub ts: u64,
    /// The SAME instant as `ts`, in MILLISECONDS (round-12).
    ///
    /// `ts` is seconds here and MILLISECONDS in the browser's actions.jsonl —
    /// one field name, two units, which is the silent-merge hazard this crate
    /// already pinned helpers against in R115. A merged operation timeline must
    /// therefore never sort on `ts`; it sorts on `ts_ms`, whose name states its
    /// unit.
    ///
    /// Both are stamped from ONE clock read in `log()` (below), so they cannot
    /// drift apart: `ts_ms / 1000` always equals `ts`. Pinned by
    /// `ts_and_ts_ms_come_from_one_clock_read`.
    pub ts_ms: u64,
    pub kind: String, // "command/start" | "output" | "command/end" | "status"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// command/end only: wall-clock duration of the command in ms (round-58).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// command/start only: WHY the agent ran this, in its own words.
    ///
    /// Supplied by the AI client through `terminal_execute`. Optional because
    /// most clients will not send it for a while — and the view has to be honest
    /// about the difference between "no reason given" and "no reason needed".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    /// command/start only: the 1-based PLAN step this command advances.
    ///
    /// The linkage that turns a plan into something checkable. Without it a reader
    /// has a plan and a command list and no way to tell which step — if any — a
    /// given command was serving, so "the plan was followed" is unfalsifiable.
    /// Recorded as a NUMBER rather than the step text: the text lives on the plan
    /// event, and copying it here would let the two drift.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_step: Option<u32>,
    /// command/start only: the alternatives the agent says it passed over.
    ///
    /// The half of the decision tree that does not exist in a command log. This
    /// field is where it finally becomes real: an audit trail records what
    /// happened, and this records what did not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub considered: Option<Vec<String>>,
    /// command/start only: the RUN this command belonged to, as declared by the
    /// client through `run_begin`.
    ///
    /// A run is one AI EXECUTION (see `crate::runs`). It is recorded here as an
    /// ATTRIBUTE, never as an identity: the device has one token and possession
    /// of it IS the identity, so this string can only ever describe work, never
    /// authorize it. `run_id_is_never_a_credential` pins that rule at its source.
    ///
    /// Stored verbatim-but-bounded: the client supplies it, so it is trimmed and
    /// byte-capped by the same discipline as `intent` above — an uncapped remote
    /// string riding every audit read is a remote memory amplifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

impl SessionEvent {
    pub fn command_start(seq: u64, command: &str) -> Self {
        Self::command_start_with(seq, command, None, None)
    }

    /// As [`SessionEvent::command_start`], with the agent's stated reasoning.
    ///
    /// `intent` and `considered` are TRIMMED and CAPPED here rather than at the
    /// call site: they arrive from a remote client, they ride every audit read,
    /// and an uncapped one would be a remote memory amplifier. A blank intent is
    /// stored as `None` — "the client sent an empty string" and "the client sent
    /// nothing" mean the same thing to a reader, and collapsing them keeps the
    /// view from having to distinguish two kinds of absent.
    pub fn command_start_with(
        seq: u64,
        command: &str,
        intent: Option<&str>,
        considered: Option<&[String]>,
    ) -> Self {
        Self::command_start_full(seq, command, intent, considered, None)
    }

    /// As [`SessionEvent::command_start_with`], plus the plan step it advances.
    pub fn command_start_full(
        seq: u64,
        command: &str,
        intent: Option<&str>,
        considered: Option<&[String]>,
        plan_step: Option<u32>,
    ) -> Self {
        Self::command_start_run(seq, command, intent, considered, plan_step, None)
    }

    /// As [`SessionEvent::command_start_full`], plus the RUN it belongs to.
    ///
    /// One more argument rather than a builder: every existing caller keeps a
    /// compiling signature, and the run is the last thing the trail learned.
    /// `run_id` is trimmed and byte-capped like `intent` — it arrives from the
    /// same remote client.
    pub fn command_start_run(
        seq: u64,
        command: &str,
        intent: Option<&str>,
        considered: Option<&[String]>,
        plan_step: Option<u32>,
        run_id: Option<&str>,
    ) -> Self {
        Self {
            seq,
            ts: crate::unix_now(),
            ts_ms: crate::now_millis(),
            kind: "command/start".into(),
            command: Some(command.to_string()),
            text: None,
            exit_code: None,
            reason: None,
            status: None,
            duration_ms: None,
            // Zero is not a valid step (the plan is 1-based), so a 0 reads as
            // ABSENT rather than as "step zero" — the alternative is a numbering
            // that silently disagrees with what the operator sees.
            plan_step: plan_step.filter(|n| *n > 0),
            intent: intent
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| crate::text::clip(s, INTENT_MAX_BYTES).to_string()),
            considered: considered
                .map(|c| {
                    c.iter()
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .take(CONSIDERED_MAX)
                        .map(|s| crate::text::clip(s, CONSIDERED_ITEM_MAX_BYTES).to_string())
                        .collect::<Vec<_>>()
                })
                .filter(|c: &Vec<String>| !c.is_empty()),
            run_id: run_id
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| crate::text::clip(s, RUN_ID_MAX_BYTES).to_string()),
        }
    }
    pub fn output(seq: u64, text: String) -> Self {
        Self {
            seq,
            ts: crate::unix_now(),
            ts_ms: crate::now_millis(),
            kind: "output".into(),
            command: None,
            text: Some(text),
            exit_code: None,
            reason: None,
            status: None,
            duration_ms: None,
            plan_step: None,
            intent: None,
            considered: None,
            run_id: None,
        }
    }
    pub fn command_end(seq: u64, exit_code: Option<i32>, reason: Option<&str>) -> Self {
        Self {
            seq,
            ts: crate::unix_now(),
            ts_ms: crate::now_millis(),
            kind: "command/end".into(),
            command: None,
            text: None,
            exit_code,
            reason: reason.map(|s| s.to_string()),
            status: None,
            duration_ms: None,
            plan_step: None,
            intent: None,
            considered: None,
            run_id: None,
        }
    }
    pub fn status(seq: u64, status: &str) -> Self {
        Self {
            seq,
            ts: crate::unix_now(),
            ts_ms: crate::now_millis(),
            kind: "status".into(),
            command: None,
            text: None,
            exit_code: None,
            reason: None,
            status: Some(status.to_string()),
            duration_ms: None,
            plan_step: None,
            intent: None,
            considered: None,
            run_id: None,
        }
    }

    /// The agent declared, revised or cleared its PLAN.
    ///
    /// A distinct kind from `goal` because the two are declared by different
    /// parties and answer different questions — the operator's objective versus
    /// the agent's intended sequence. A reader comparing them can see a run
    /// diverge from what was asked for, which is the whole point of recording
    /// both.
    ///
    /// `text` carries the numbered plan, one step per line, and is ABSENT when the
    /// plan was cleared — the same absent-vs-empty discipline as `goal`, so a
    /// withdrawn plan cannot read as a blank one.
    pub fn plan(seq: u64, steps: &[String]) -> Self {
        let text = if steps.is_empty() {
            None
        } else {
            Some(
                steps
                    .iter()
                    .enumerate()
                    .map(|(i, s)| format!("{}. {}", i + 1, s))
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        };
        Self {
            seq,
            ts: crate::unix_now(),
            ts_ms: crate::now_millis(),
            kind: "plan".into(),
            command: None,
            text,
            exit_code: None,
            reason: None,
            // How many steps, so a reader can tell a revision from a
            // re-declaration without counting lines.
            status: Some(steps.len().to_string()),
            duration_ms: None,
            plan_step: None,
            intent: None,
            considered: None,
            run_id: None,
        }
    }

    /// A change to the session's APPROVAL posture — the gate armed or disarmed,
    /// a command family allowed or taken back, or a request decided.
    ///
    /// This exists because the trail had a hole that only showed up when the
    /// feature was driven for real: the HOLD was recorded, and the GOAL was
    /// recorded, but ARMING THE GATE left no trace at all. A reader of the audit
    /// trail therefore could not tell whether a command ran because the operator
    /// approved it, or because the gate was never on. Those are different
    /// histories and the evidence beat exists to tell them apart.
    ///
    /// `status` carries the action and `text` its subject, reusing the existing
    /// shape rather than adding fields:
    ///
    ///   action `armed` / `disarmed`   subject: none
    ///   action `granted` / `revoked`  subject: the command word ("" = all)
    ///   action `approved` / `refused` subject: the command that was decided
    pub fn approval(seq: u64, action: &str, subject: &str) -> Self {
        Self {
            seq,
            ts: crate::unix_now(),
            ts_ms: crate::now_millis(),
            kind: "approval".into(),
            command: None,
            // Absent rather than empty when there is no subject, so a reader can
            // tell "nothing to name" from "the subject was the empty string" —
            // the same distinction the revoke-all case depends on, where "" IS
            // the subject and means every grant.
            text: (!subject.is_empty()).then(|| crate::text::clip(subject, 512).to_string()),
            exit_code: None,
            reason: None,
            status: Some(action.to_string()),
            duration_ms: None,
            plan_step: None,
            intent: None,
            considered: None,
            run_id: None,
        }
    }

    /// The session's stated GOAL — what the operator asked for.
    ///
    /// Recorded in the trail for the same reason a handoff is: the live value
    /// lives on the session (and dies with it), but "this session was for X" is a
    /// statement about the past that a later reader needs. Without it, an audit
    /// trail answers "what ran" and never "what was it FOR", which is the
    /// question anyone returning to a finished session actually has.
    ///
    /// A distinct `kind`, like `control`, because it is orthogonal to the
    /// session's lifecycle: a goal can be set, replaced or cleared at any point
    /// without the session changing state.
    pub fn goal(seq: u64, text: &str) -> Self {
        Self {
            seq,
            ts: crate::unix_now(),
            ts_ms: crate::now_millis(),
            kind: "goal".into(),
            command: None,
            text: Some(text.to_string()),
            exit_code: None,
            reason: None,
            status: None,
            duration_ms: None,
            plan_step: None,
            intent: None,
            considered: None,
            run_id: None,
        }
    }

    /// Control handoff: `holder` is `"human"` or `"ai"`.
    ///
    /// A distinct `kind` rather than one more `status` value, on purpose. The
    /// `status` / `opened` / `closed` / `exited:N` vocabulary describes the
    /// SESSION's lifecycle; this describes WHO WAS DRIVING, a different axis
    /// that has to survive the session's own status changes. Folding a holder
    /// into `status` would also force `terminalStatus()` — which maps statuses
    /// onto terminal states — to learn to ignore a value that is not a state.
    ///
    /// This is the DURABLE half of the handoff, and it is the half that can be
    /// durable: the live hold is deliberately in-memory only (an agent restart
    /// releases it, so a crash cannot leave a device nobody can drive), but the
    /// fact that a person took the keyboard is a statement about the past. It is
    /// what lets a later reader of this file tell an AI-driven window from a
    /// human-driven one.
    pub fn control(seq: u64, holder: &str) -> Self {
        Self {
            seq,
            ts: crate::unix_now(),
            ts_ms: crate::now_millis(),
            kind: "control".into(),
            command: None,
            text: None,
            exit_code: None,
            reason: None,
            status: Some(holder.to_string()),
            duration_ms: None,
            plan_step: None,
            intent: None,
            considered: None,
            run_id: None,
        }
    }
}

/// One JSONL file per session under the log dir. Internal state is a mutex
/// so concurrent tools (drainer + execute) can log without serializing on
/// callers; file appends are atomic enough for line-level integrity (each
/// event is written in a single write()).
/// The per-session `seq` counters, SHARED BY EVERY INSTANCE.
///
/// `seq` is documented as per-session monotonic and consumers depend on it:
/// the panel uses it as a React key AND as its "nothing new" watermark, so a
/// repeat is a dropped event and a duplicated row at once.
///
/// It used to be per-INSTANCE (`SessionLogger::new` built a fresh map), and the
/// counter is only seeded from disk on FIRST use — so a long-lived logger's
/// counter went stale the moment any other instance wrote:
///
///   plugin: start   -> seq 1, counter now 1                     (disk: 1)
///   web:    asked   -> fresh logger seeds disk (1) -> seq 2     (disk: 1,2)
///   plugin: approved-> its counter is 1, so it hands out 2      <-- DUPLICATE
///
/// Deterministic, not racy: `sessions_logger()` builds a logger per web call,
/// so a gate question arriving after a command starts is enough to hit it.
/// Reproduced as `[1, 2, 2]` before this change.
///
/// ONE map for the whole process, keyed by dir+sid, is the fix — and it is the
/// POSITIVE form of the `JobsMap` lesson: that incident was two maps where
/// there should have been one, and a global whose whole job is to BE the one
/// map cannot repeat it. Tests are unaffected because they use distinct temp
/// dirs, which are part of the key.
static SEQ: std::sync::LazyLock<Mutex<HashMap<String, u64>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
pub struct SessionLogger {
    dir: PathBuf,
    /// Persistent per-session writers (round-58): batch output chunks, flush
    /// on command boundaries. Bounded — capped at the session count.
    files: std::sync::Arc<Mutex<HashMap<String, std::io::BufWriter<std::fs::File>>>>,
}

impl SessionLogger {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self {
            dir,
            files: std::sync::Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Directory holding the JSONL files (exposed for tests).
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Next per-session sequence number.
    ///
    /// SEEDED FROM THE FILE on this instance's first event for a session. The
    /// counter is per-instance and the writer opens in APPEND mode, so without
    /// seeding a SECOND logger writing to an existing session restarts at 1 and
    /// the file ends up with two `seq: 1` events. `SessionEvent` documents `seq`
    /// as "per-session monotonic" and readers order by it, so that is a broken
    /// record rather than a cosmetic duplicate.
    ///
    /// Not hypothetical: the long-lived logger inside the terminal plugin owns
    /// every write during normal operation, so the invariant held by accident.
    /// `api_session_control` builds a FRESH logger per request (the decision is
    /// made at the web layer, and the manager must not grow a dependency on the
    /// log), and it was the first writer to expose the assumption — the handoff
    /// and the hand-back both claimed seq 1, measured.
    ///
    /// Seeding costs one bounded file read per (instance, session): the audit
    /// file is trimmed to ~2000 lines at close, and the read happens once rather
    /// than per event.
    fn next_seq(&self, sid: &str) -> u64 {
        let mut seqs = SEQ.lock().unwrap_or_else(|p| p.into_inner());
        let n = seqs
            .entry(format!("{}\0{sid}", self.dir.display()))
            .or_insert_with(|| self.max_seq_on_disk(sid));
        *n += 1;
        *n
    }

    /// Highest `seq` already recorded for a session, or 0 when the file is
    /// absent/unreadable/empty. Reuses `read_events`, which already tolerates a
    /// torn tail and non-event lines.
    fn max_seq_on_disk(&self, sid: &str) -> u64 {
        self.read_events(sid).map(|(_, max)| max).unwrap_or(0)
    }

    /// Append one event for a session. Best-effort: a write error (disk
    /// full, read-only install dir) is logged via tracing, never surfaced —
    /// the terminal must keep working when the audit trail cannot.
    pub fn log(&self, sid: &str, ev: SessionEvent) {
        let seq = self.next_seq(sid);
        // ONE clock read for both stamps. The constructors each set `ts` too,
        // but stamping here — the single write path every event passes through —
        // is what makes the pair impossible to disagree: `ts` is derived from
        // the same instant as `ts_ms` rather than captured separately a few
        // microseconds earlier.
        let (ts, ts_ms) = stamps_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default(),
        );
        let ev = SessionEvent {
            seq,
            ts,
            ts_ms,
            ..ev
        };
        let line = serde_json::to_string(&ev).unwrap_or_default();
        // Per-session persistent writer (round-58): the old open→append→drop
        // per 4KiB chunk was 3 syscalls × 100-256 chunks/s × 16 sessions —
        // thousands of syscalls/s on the device CPU. The writer batches and
        // flushes on flush() (called at command/status boundaries by
        // log_command_end/log_status) or when the buffer fills.
        let mut f = self.files.lock().unwrap_or_else(|p| p.into_inner());
        // FD cap: only the explicit terminal_close path calls
        // close_session — the idle sweeper and MAX_SESSIONS eviction drop
        // sessions without closing their audit writers, so dead writers
        // would pile up here forever. Bound open writers: evict (flush +
        // drop) a stale entry when over budget. A live sid evicted early
        // transparently reopens in append mode below — no data loss, and
        // the map can never outgrow live sessions by more than the budget.
        const MAX_OPEN_WRITERS: usize = 64;
        if f.len() >= MAX_OPEN_WRITERS && !f.contains_key(sid) {
            if let Some(old) = f.keys().next().cloned() {
                if let Some(mut w) = f.remove(&old) {
                    let _ = std::io::Write::flush(&mut w);
                    tracing::warn!("[vale-agent] audit writer cap: evicted {old}");
                }
            }
        }
        // Fast path: a writer for this sid is already open. Otherwise open
        // (or fall back) and insert explicitly — or_insert_with cannot
        // degrade gracefully because its closure must return a writer.
        if !f.contains_key(sid) {
            let path = self.dir.join(format!("{sid}.jsonl"));
            match std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                Ok(mut file) => {
                    // Crash-safety rules (torn final line + version header on a
                    // fresh file) are owned by crate::jsonl — see its header
                    // for the fused-record incident that motivated them.
                    // Prepared on the raw File BEFORE the BufWriter wraps it, so
                    // nothing is buffered yet.
                    let _ = crate::jsonl::prepare_append(
                        &mut file,
                        &path,
                        &serde_json::json!({
                            "type": "session", "version": 1, "id": sid,
                            "createdAt": std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs()).unwrap_or(0),
                        }),
                    );
                    let w = std::io::BufWriter::new(file);
                    f.insert(sid.to_string(), w);
                }
                Err(_) => {
                    tracing::warn!("[vale-agent] session log open failed: {sid}");
                    // Unwritable fallback chain — best-effort by design (see
                    // log()'s never-surface contract): /dev/null on Unix, NUL
                    // on Windows (a File that discards), then a temp-dir
                    // parking file. If every filesystem is unwritable, DROP
                    // the event with a loud error + best-effort stderr —
                    // never panic: a log() call must not abort the agent.
                    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
                    let fall = |p: &std::path::Path| {
                        std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(p)
                    };
                    let fb = fall(std::path::Path::new(null)).or_else(|_| {
                        tracing::error!(
                            "[vale-agent] null-device fallback failed, parking audit in temp"
                        );
                        fall(&std::env::temp_dir().join(format!("vale-audit-fallback-{sid}.log")))
                    });
                    match fb {
                        Ok(nf) => {
                            f.insert(sid.to_string(), std::io::BufWriter::new(nf));
                        }
                        Err(e) => {
                            tracing::error!(
                                "[vale-agent] session audit has nowhere to write, dropping event for {sid}: {e}"
                            );
                            // Best-effort stderr: tracing alone may go
                            // nowhere in service context (no console/file).
                            eprintln!("[vale-agent] session audit has nowhere to write, dropping event for {sid}: {e}");
                            return;
                        }
                    }
                }
            }
        }
        let Some(writer) = f.get_mut(sid) else { return };
        use std::io::Write;
        let _ = writeln!(writer, "{line}");
        // Flush eagerly on command boundaries (command/end, status) so the
        // audit trail is durable at the points that matter; output chunks
        // ride the BufWriter until it fills or the next boundary. A crash
        // loses only the buffered tail, never a command skeleton (round-58).
        if ev.kind != "output" {
            let _ = writer.flush();
        }
    }

    /// Flush all session writers (called on shutdown paths if any).
    pub fn flush_all(&self) {
        use std::io::Write;
        let mut f = self.files.lock().unwrap_or_else(|p| p.into_inner());
        for w in f.values_mut() {
            let _ = w.flush();
        }
    }

    /// Close a session's writer — flush + drop the fd (round-59). The files
    /// map had NO eviction path: every session ever seen (including closed
    /// ones) kept an open fd + BufWriter for the process lifetime. Call on
    /// session close/eviction to bound the map by the concurrent session
    /// count (hard cap 16).
    pub fn close_session(&self, sid: &str) {
        use std::io::Write;
        let mut f = self.files.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(mut w) = f.remove(sid) {
            let _ = w.flush();
            // round-98: a closed session's file was never trimmed — a serial
            // console scrolling logs for hours grew an unbounded .jsonl on
            // the install disk.
            // round-99: the naive trim (read_to_string + keep last N lines)
            // had two flaws: (1) it deleted the LAST command/start when the
            // final command produced >2000 output events, silently killing
            // the "interrupted" recovery flag for that command; (2) it read
            // the WHOLE (potentially ~GB) file into RAM at close. Trim by
            // STREAMING the tail: keep the header, the last command/start
            // (recovery needs it) plus everything after it, and if that's
            // still over the cap, the most recent lines.
            let path = self.dir.join(format!("{sid}.jsonl"));
            trim_file(&path);
        }
    }

    /// Record a command AND the agent's stated reasoning for it.
    ///
    /// Best-effort like every write here. The reasoning is optional at every
    /// layer: a client that sends none produces exactly the event this always
    /// produced, so nothing downstream has to special-case its absence.
    pub fn log_command_start_with(
        &self,
        sid: &str,
        command: &str,
        intent: Option<&str>,
        considered: Option<&[String]>,
    ) {
        self.log_command_start_full(sid, command, intent, considered, None);
    }

    /// As [`SessionLogger::log_command_start_with`], plus the plan step.
    pub fn log_command_start_full(
        &self,
        sid: &str,
        command: &str,
        intent: Option<&str>,
        considered: Option<&[String]>,
        plan_step: Option<u32>,
    ) {
        let command = cap_command(command);
        self.log(
            sid,
            SessionEvent::command_start_full(0, &command, intent, considered, plan_step),
        );
    }

    /// As [`SessionLogger::log_command_start_full`], plus the RUN it belongs to.
    ///
    /// The run is the last thing the trail learned and the only piece of it that
    /// says which EXECUTION the command belonged to — see `crate::runs`. Kept as
    /// its own function so the four existing call shapes stay untouched.
    pub fn log_command_start_run(
        &self,
        sid: &str,
        command: &str,
        intent: Option<&str>,
        considered: Option<&[String]>,
        plan_step: Option<u32>,
        run_id: Option<&str>,
    ) {
        let command = cap_command(command);
        self.log(
            sid,
            SessionEvent::command_start_run(0, &command, intent, considered, plan_step, run_id),
        );
    }

    pub fn log_command_start(&self, sid: &str, command: &str) {
        // audit round: the 4 KiB cap existed for OUTPUT only — a single
        // multi-MB command line (`python -c '<payload>'`) rode the trail
        // forever (trim counts LINES) and forced a multi-MB read_line at
        // close. Cap identically (char-boundary-safe).
        let command = cap_command(command);
        self.log(sid, SessionEvent::command_start(0, &command));
    }
    pub fn log_output(&self, sid: &str, text: String) {
        // Cap a single chunk at 4 KiB — a full 1MB burst would dominate the
        // audit trail for one session. The event stream stays dense enough
        // to reconstruct what ran.
        // Char-boundary-safe truncation (round-68): &text[..4096] panicked
        // when byte 4096 split a multi-byte char (binary output expands past
        // 4096 via U+FFFD replacement chars) — the panic killed the drainer
        // and wedged the session. floor_char_boundary keeps the slice valid.
        let text = if text.len() > 4096 {
            let cut = crate::text::boundary_at_or_below(&text, 4096);
            format!("{}…[truncated {} bytes]", &text[..cut], text.len() - cut)
        } else {
            text
        };
        self.log(sid, SessionEvent::output(0, text));
    }
    pub fn log_command_end(
        &self,
        sid: &str,
        exit_code: Option<i32>,
        reason: Option<&str>,
        duration_ms: Option<u64>,
    ) {
        let mut ev = SessionEvent::command_end(0, exit_code, reason);
        ev.duration_ms = duration_ms;
        self.log(sid, ev);
    }
    pub fn log_status(&self, sid: &str, status: &str) {
        self.log(sid, SessionEvent::status(0, status));
    }

    /// Record a control handoff (`holder` is `"human"` or `"ai"`).
    ///
    /// Best-effort like every other write here — a log failure must never block
    /// or break the terminal — which is also why the caller does not check a
    /// result. A missing control event costs a reader some context; failing the
    /// handoff itself would cost the operator the keyboard.
    pub fn log_control(&self, sid: &str, holder: &str) {
        self.log(sid, SessionEvent::control(0, holder));
    }

    /// Record a plan declaration. Best-effort like every write here.
    pub fn log_plan(&self, sid: &str, steps: &[String]) {
        self.log(sid, SessionEvent::plan(0, steps));
    }

    /// As [`SessionLogger::log_plan`], plus the RUN that declared the plan.
    ///
    /// A declared plan belongs to the execution that declared it: without the
    /// id, a run's timeline shows the commands it ran but not what it said it
    /// was going to do — which is half of the comparison the plan exists for.
    pub fn log_plan_run(&self, sid: &str, steps: &[String], run_id: Option<&str>) {
        let mut ev = SessionEvent::plan(0, steps);
        ev.run_id = run_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| crate::text::clip(s, RUN_ID_MAX_BYTES).to_string());
        self.log(sid, ev);
    }

    /// Record a change to the approval posture. Best-effort like every write here.
    ///
    /// Passed an explicit subject rather than reading it back off the manager:
    /// the manager is the live state and may already have moved on (a revoke that
    /// found nothing, a request that was decided by someone else first), while
    /// this records what the CALLER asked for. The two agree in the normal case
    /// and the difference is exactly what a reader wants when they disagree.
    pub fn log_approval(&self, sid: &str, action: &str, subject: &str) {
        self.log(sid, SessionEvent::approval(0, action, subject));
    }

    /// Record the session's stated goal. Best-effort like every write here.
    ///
    /// An EMPTY string is a real value, not a no-op: it is how a goal is CLEARED,
    /// and the trail must show that someone withdrew the objective rather than
    /// leaving a reader to assume the last one still stands.
    pub fn log_goal(&self, sid: &str, text: &str) {
        self.log(sid, SessionEvent::goal(0, text));
    }

    /// Replay a session file, skipping the version header. Returns the parsed
    /// events (for recovery/fold) — or None if the file has no events.
    fn read_events(&self, sid: &str) -> Option<(Vec<serde_json::Value>, u64)> {
        let path = self.dir.join(format!("{sid}.jsonl"));
        let content = std::fs::read_to_string(&path).ok()?;
        let mut events = Vec::new();
        let mut max_seq = 0u64;
        for line in content.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            // Header line — not an event.
            if v.get("type").and_then(|t| t.as_str()) == Some("session") {
                continue;
            }
            if let Some(seq) = v.get("seq").and_then(|s| s.as_u64()) {
                max_seq = max_seq.max(seq);
            }
            events.push(v);
        }
        // ORDER BY `seq`, NOT BY WHEN THE BYTES LANDED.
        //
        // Two logger instances write this file with INDEPENDENT buffers, so
        // their events interleave on disk in flush order. The long-lived
        // terminal-plugin writer keeps a persistent `BufWriter` per session and
        // flushes only at command boundaries (round-58); a web-layer write
        // flushes immediately. A buffered `output` therefore lands AFTER an
        // `asked` that another instance already wrote.
        //
        // Observed on a real run: the file read `1, 2, 4, 5, 6, 3, 7, …` — the
        // buffered event flushed six events late. Returning that order breaks
        // the documented "per-session monotonic seq" contract, and consumers
        // lean on it: the panel keeps `seq` as its "nothing new" watermark, so
        // an event numbered BELOW the watermark is treated as already seen and
        // silently dropped from the rendered trail.
        //
        // Sorting is STABLE, so events that carry no `seq` (there are none
        // today, but the header is skipped by key rather than by position)
        // keep their file order relative to each other.
        events.sort_by_key(|v| v.get("seq").and_then(|s| s.as_u64()).unwrap_or(u64::MAX));
        Some((events, max_seq))
    }

    /// Public read of a session's events (for /api/sessions UI — round-56).
    ///
    /// Returns the events AND whether a record was readable at all. The two are
    /// different answers — "this session left no record" versus "I could not
    /// read the record" — and collapsing them (the old `unwrap_or_default`)
    /// forced every consumer to word its empty state to cover both, which is a
    /// question the API is better placed to answer than the UI.
    ///
    /// `false` covers a missing file and an unparseable one alike: from here
    /// they are the same fact, and inventing a third state the caller cannot
    /// act on differently would only invite it to guess.
    pub fn events_of(&self, sid: &str) -> (Vec<serde_json::Value>, bool) {
        match self.read_events(sid) {
            Some((events, _)) => (events, true),
            None => (Vec::new(), false),
        }
    }

    /// Fold a session's last event into a terminal state (round-56): the
    /// panel's history can show "last activity / final status" instead of
    /// nothing.
    pub fn terminal_state_of(&self, sid: &str) -> Option<serde_json::Value> {
        let (events, _) = self.read_events(sid)?;
        let last = events.last()?;
        Some(serde_json::json!({
            "kind": last.get("kind").and_then(|k| k.as_str()).unwrap_or(""),
            "ts": last.get("ts").and_then(|t| t.as_u64()).unwrap_or(0),
            "reason": last.get("reason").and_then(|r| r.as_str()),
            "exit_code": last.get("exit_code").and_then(|c| c.as_i64()),
            // round-57: a status event (opened/closed) folds to its VALUE —
            // without it a new session's terminal state was just kind:"status"
            // with no way to tell opened from closed.
            "status": last.get("status").and_then(|s| s.as_str()),
        }))
    }

    /// Session ids present on disk (each `<sid>.jsonl` file), in directory
    /// order. Shared by list_sessions and recover_interrupted, which used to
    /// copy-paste the read_dir + jsonl-filter + stem-extraction loop.
    fn session_ids(&self) -> Vec<String> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(sid) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
            {
                out.push(sid);
            }
        }
        out
    }

    /// List all session files (id → terminal state) for /api/sessions.
    pub fn list_sessions(&self) -> Vec<(String, serde_json::Value)> {
        let mut out = Vec::new();
        for sid in self.session_ids() {
            if let Some(state) = self.terminal_state_of(&sid) {
                out.push((sid, state));
            }
        }
        out
    }

    /// Age of a session file in seconds. Prefers the stored `createdAt` from
    /// the version header (immune to clock jumps — mtime can jump forward via
    /// NTP/DST/manual adjust and prune fresh logs as "stale"). Falls back to
    /// mtime only when the header is missing or corrupt.
    fn age_of(&self, path: &std::path::Path, meta: &std::fs::Metadata) -> Duration {
        if let Ok(f) = std::fs::File::open(path) {
            let mut line = String::with_capacity(256);
            let mut r = std::io::BufReader::new(f);
            if r.read_line(&mut line).is_ok() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(ts) = v.get("createdAt").and_then(|c| c.as_u64()) {
                        let now_unix = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or(Duration::ZERO);
                        let created_unix = Duration::from_secs(ts);
                        return now_unix.checked_sub(created_unix).unwrap_or(Duration::ZERO);
                    }
                }
            }
        }
        // Fallback: mtime.
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .unwrap_or(Duration::ZERO);
        let now_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or(Duration::ZERO);
        now_unix.checked_sub(mtime).unwrap_or(Duration::ZERO)
    }

    /// stage-n: retention — delete audit files untouched for longer than
    /// `max_age_days`. Run at STARTUP only (after `recover_interrupted`):
    /// the kill-on-close job (round-134) guarantees the previous agent
    /// generation's shells are all dead, so no live writer can race a
    /// prune. Returns the number of files removed.
    pub fn prune_stale(&self, max_age_days: u64) -> usize {
        use std::time::{Duration, SystemTime};
        if SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .is_err()
        {
            return 0;
        }
        let max_age = Duration::from_secs(max_age_days.saturating_mul(86_400));
        let mut removed = 0;
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return 0;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // audit round: crashed trim rotations left `<sid>.jsonl.tmp`
            // litter invisible to the `.jsonl`-extension filter.
            let fname = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if !(fname.ends_with(".jsonl") || fname.ends_with(".jsonl.tmp")) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            // stage-n: use the stored createdAt from the version header instead
            // of mtime — a forward clock jump (NTP/DST/manual adjust) of >30 days
            // would otherwise prune FRESH session logs as "stale".
            let age = self.age_of(&path, &meta);
            if age > max_age && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        removed
    }

    /// Crash recovery: replay every session file; a file whose last
    /// `command/start` has no paired `command/end` gets a synthetic
    /// `command/end { reason: interrupted }` appended. Returns the affected
    /// session ids (the panel shows "interrupted — may still be running").
    pub fn recover_interrupted(&self) -> Vec<String> {
        let mut affected = Vec::new();
        for sid in self.session_ids() {
            let Some((events, max_seq)) = self.read_events(&sid) else {
                continue;
            };
            // Seed the SHARED counter from the file's max seq — after a
            // restart it starts at 0, so post-restart events re-used seqs that
            // already existed on disk (violating the "per-session monotonic
            // seq" contract; event-sourced consumers would mis-correlate)
            // (round-55).
            //
            // Same key as `next_seq`, including the dir: a counter seeded under
            // one key and read under another is precisely the drift this map
            // exists to prevent.
            if max_seq > 0 {
                if let Ok(mut seqs) = SEQ.lock() {
                    let slot = seqs
                        .entry(format!("{}\0{sid}", self.dir.display()))
                        .or_insert(0);
                    *slot = (*slot).max(max_seq);
                }
            }
            // Track the positions of the last command/start and command/end.
            let mut last_start = None;
            let mut last_end = None;
            for (i, v) in events.iter().enumerate() {
                match v.get("kind").and_then(|k| k.as_str()) {
                    Some("command/start") => last_start = Some(i),
                    Some("command/end") => last_end = Some(i),
                    // round-99: a backgrounded command (run_in_background)
                    // never gets a command/end — it logs status
                    // "backgrounded" and the shell later logs "closed"/
                    // "exited:N". Neither was recognized, so recovery
                    // misreported every completed background command as
                    // "interrupted". Treat any post-start status line
                    // (backgrounded/closed/exited) as a terminal marker.
                    Some("status") => {
                        // round-100: SessionEvent::status() serializes the
                        // value in the `status` field, not `text` (both are
                        // skip-if-none, so a status line has no "text" key)
                        // — the round-99 branch read the wrong field and
                        // never fired.
                        if let Some(text) = v.get("status").and_then(|t| t.as_str()) {
                            if text == "backgrounded"
                                || text == "closed"
                                || text.starts_with("exited:")
                            {
                                last_end = Some(i);
                            }
                        }
                    }
                    _ => {}
                }
            }
            // A start after the last end = the command never finished (the
            // agent died mid-execute — the command may STILL be running on
            // the device as an orphan).
            if let Some(start) = last_start {
                if last_end.map(|e| e < start).unwrap_or(true) {
                    self.log_command_end(&sid, None, Some("interrupted"), None);
                    affected.push(sid.clone());
                }
            }
            // A QUESTION THAT DIED WITH THE PROCESS.
            //
            // The gate's pending question lives in process MEMORY; the trail
            // records `asked` when it is put to the operator and a terminal
            // outcome only when one lands — `approved`/`refused` (decided) or
            // `expired` (TTL ran out). If the agent dies instead (the 60 s
            // watchdog, an update — which kills it BY DESIGN — or a crash), the
            // question ceases to exist and nothing recorded it.
            //
            // This is the command arm's loss, on the last event family recovery
            // did not cover, and it is the confusion `asked`/`expired` were added
            // to kill: without it, a run that stopped because nobody was watching
            // is indistinguishable from one that was never gated, and the
            // operator's badge simply disappears on restart.
            //
            // Postures are deliberately NOT terminal: `armed`/`disarmed` change
            // the gate and `granted`/`revoked` change what runs unasked — none of
            // them answers the question that was asked.
            let mut last_asked: Option<String> = None;
            let mut answered_after = false;
            for v in events.iter() {
                if v.get("kind").and_then(|k| k.as_str()) != Some("approval") {
                    continue;
                }
                match v.get("status").and_then(|t| t.as_str()) {
                    Some("asked") => {
                        last_asked = Some(
                            v.get("text")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string(),
                        );
                        answered_after = false;
                    }
                    // The ways a question ENDS. `abandoned` is in this list
                    // because recovery WROTE it: without it, each recovery pass
                    // would see its own marker as "still unanswered" and append
                    // another one, growing the file without bound — the idempotence
                    // test caught exactly that.
                    Some("approved") | Some("refused") | Some("expired") | Some("abandoned") => {
                        answered_after = true
                    }
                    _ => {}
                }
            }
            if let Some(subject) = last_asked {
                if !answered_after {
                    self.log_approval(&sid, "abandoned", &subject);
                    if !affected.contains(&sid) {
                        affected.push(sid.clone());
                    }
                }
            }
            // round-116 trimmed every recovered session's file here, to stop a
            // crash-open session's .jsonl growing unbounded until its next
            // graceful close. That trim is REMOVED, because it is the one part
            // of recovery that can destroy evidence rather than record it.
            //
            // `trim_file` rewrites atomically — temp file, then RENAME over the
            // original — so the path gets a NEW inode. Any other writer holding
            // a handle on the old one keeps succeeding: `writeln!` and `flush`
            // both return Ok while every byte lands in a file nothing can reach.
            // Recovery is reachable whenever a plugin registry is CONSTRUCTED,
            // not only at boot, so it could rename a file belonging to a session
            // that is LIVE right then and silently swallow that session's
            // remaining audit events.
            //
            // Measured, not reasoned: a test lost its last two events, and
            // instrumenting the write showed the handle at 528 bytes while the
            // path held 393 — same call, two different files. The suite failed on
            // 3 of 4 full runs before this removal and 4 of 4 after it.
            //
            // Disk growth stays bounded without it: output chunks are capped at
            // write time, `close_session` still trims on graceful close, and
            // `prune_stale` deletes whole files past the retention window.
        }
        affected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vale-sesslog-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn torn_final_fragment_is_repaired_before_next_append() {
        // Crash mid-writeln leaves `{"id"...` with no trailing \n. Without
        // repair the next event FUSES onto it and BOTH become unparseable —
        // the exact failure that silently swallowed recovery markers.
        let dir = std::env::temp_dir().join(format!("vale-slog-torn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("s1.jsonl").as_path(),
            b"{\"id\":\"s1\",\"seq\":1,\"kind\":\"comm",
        )
        .unwrap();
        let logger = SessionLogger::new(dir.clone());
        logger.log_status("s1", "resumed");
        drop(logger);
        let logger2 = SessionLogger::new(dir.clone());
        let (events, _) = logger2.events_of("s1");
        assert!(
            events
                .iter()
                .any(|e| e["status"].as_str() == Some("resumed")),
            "post-repair append must parse cleanly, got {events:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_stale_keeps_fresh_and_removes_old() {
        let dir = temp_dir("prune");
        std::fs::create_dir_all(&dir).unwrap();
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("fresh", "echo hi");
        logger.log_command_end("fresh", Some(0), None, None);
        std::fs::write(dir.join("not-a-session.txt"), b"x").unwrap();

        // Nothing is older than 30 days → nothing pruned, non-jsonl untouched.
        assert_eq!(logger.prune_stale(30), 0);
        assert!(dir.join("fresh.jsonl").exists());
        assert!(dir.join("not-a-session.txt").exists());

        // max_age_days = 0 → cutoff is "now"; any file with a nonzero age
        // is stale. The just-written audit file qualifies.
        assert!(logger.prune_stale(0) >= 1);
        assert!(!dir.join("fresh.jsonl").exists());
        // Only .jsonl files are ever considered.
        assert!(dir.join("not-a-session.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_writes_jsonl_lines_with_monotonic_seq() {
        let dir = temp_dir("seq");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("s1", "echo hi");
        logger.log_output("s1", "hi\n".to_string());
        logger.log_command_end("s1", Some(0), Some("marker"), None);

        let content = std::fs::read_to_string(dir.join("s1.jsonl")).unwrap();
        let lines: Vec<serde_json::Value> = content
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        // 1 version header + 3 events (round-56).
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["type"], "session");
        assert_eq!(lines[0]["version"], 1);
        assert_eq!(lines[1]["seq"], 1);
        assert_eq!(lines[2]["seq"], 2);
        assert_eq!(lines[3]["seq"], 3);
        assert_eq!(lines[3]["exit_code"], 0);
        assert_eq!(lines[3]["reason"], "marker");
        // Optional fields are omitted, not null.
        assert!(lines[1].get("exit_code").is_none());
    }

    #[test]
    fn per_session_seq_is_independent() {
        let dir = temp_dir("persid");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("a", "x");
        logger.log_command_start("b", "y");
        logger.log_command_start("a", "z");
        let content = std::fs::read_to_string(dir.join("a.jsonl")).unwrap();
        assert_eq!(content.lines().count(), 3); // header + 2 events
        let content_b = std::fs::read_to_string(dir.join("b.jsonl")).unwrap();
        assert_eq!(content_b.lines().count(), 2); // header + 1 event
    }

    #[test]
    fn recovery_appends_interrupted_for_unfinished_command() {
        let dir = temp_dir("recover");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("s1", "sleep 600");
        logger.log_output("s1", "running\n".to_string());
        // s1 has an open command; s2 completed normally.
        logger.log_command_start("s2", "done");
        logger.log_command_end("s2", Some(0), Some("marker"), None);

        // BufWriter (round-58): recovery replays DISK state — flush buffered
        // output first so seq-seeding sees the full stream.
        logger.flush_all();
        let affected = logger.recover_interrupted();
        assert_eq!(affected, vec!["s1"]);

        let content = std::fs::read_to_string(dir.join("s1.jsonl")).unwrap();
        let last: serde_json::Value = content
            .lines()
            .last()
            .map(|l| serde_json::from_str(l).unwrap())
            .unwrap();
        assert_eq!(last["kind"], "command/end");
        assert_eq!(last["reason"], "interrupted");
        assert_eq!(last["seq"], 3);

        // Idempotent: a second recovery finds the closed command.
        assert!(logger.recover_interrupted().is_empty());
    }

    /// A QUESTION nobody answered before the process died leaves a fact.
    ///
    /// The gate's pending question lives in process memory. The trail records
    /// `asked` when it is put to the operator, and a terminal outcome only when
    /// one lands: `approved` / `refused` (the operator decided) or `expired`
    /// (its TTL ran out). When the agent dies instead — the 60 s watchdog, an
    /// update, which kills it BY DESIGN, or a crash — the question simply ceases
    /// to exist and NOTHING recorded it.
    ///
    /// That is the same loss `recover_interrupted` already repairs for commands,
    /// on the last event family it did not cover, and it matters for the reason
    /// `asked`/`expired` were added in the first place: a run that stopped
    /// because nobody was watching must not look identical to a run that was
    /// never gated. Without this arm the operator's panel badge simply vanishes
    /// on restart and the trail ends on a question with no answer.
    #[test]
    fn recovery_marks_a_question_that_died_with_the_process() {
        let dir = temp_dir("recover-approval");
        let logger = SessionLogger::new(dir.clone());
        logger.log_approval("s1", "asked", "rm -rf /tmp/x");
        // s2's question was ANSWERED — the arm must not touch it.
        logger.log_approval("s2", "asked", "echo hi");
        logger.log_approval("s2", "approved", "echo hi");
        // s3 has no approval traffic at all: no invented events.
        logger.log_command_start("s3", "ls");
        // s4: a POSTURE change happened while a question was open, and the
        // process died. `granted` says a word now runs unasked — it does NOT
        // answer the question that was put to the operator, so this must still
        // be abandoned. (Found by mutation: without this case, widening the
        // terminal set to include postures left the suite GREEN.)
        logger.log_approval("s4", "asked", "systemctl restart nginx");
        logger.log_approval("s4", "granted", "echo");

        logger.flush_all();
        let affected = logger.recover_interrupted();
        affected
            .contains(&"s1".to_string())
            .then_some(())
            .expect("the session whose question died must be reported as affected");

        let last_of = |sid: &str| -> serde_json::Value {
            std::fs::read_to_string(dir.join(format!("{sid}.jsonl")))
                .unwrap()
                .lines()
                .last()
                .map(|l| serde_json::from_str(l).unwrap())
                .unwrap()
        };

        let abandoned = last_of("s1");
        assert_eq!(abandoned["kind"], "approval");
        assert_eq!(abandoned["status"], "abandoned");
        assert_eq!(
            abandoned["text"], "rm -rf /tmp/x",
            "the abandoned event must name the command that was being asked about, \
             or the trail says a question was lost without saying which"
        );

        assert_eq!(
            last_of("s2")["status"],
            "approved",
            "an ANSWERED question must not be marked abandoned"
        );
        assert_ne!(
            last_of("s3")["kind"],
            "approval",
            "a session with no approval traffic must get no approval event"
        );
        assert_eq!(
            last_of("s4")["status"],
            "abandoned",
            "a POSTURE change (`granted`) is not an answer to the question that \
             was asked — the question still died with the process"
        );

        // Idempotent: the second recovery sees the question already closed.
        assert!(
            !logger.recover_interrupted().contains(&"s1".to_string()),
            "recovery must not append a second abandoned event"
        );
    }

    #[test]
    fn recovery_ignores_completed_command_then_new_one() {
        // start1 end1 start2(open) — only start2 triggers interrupted.
        let dir = temp_dir("multi");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("s1", "a");
        logger.log_command_end("s1", Some(0), Some("marker"), None);
        logger.log_command_start("s1", "b");
        assert_eq!(logger.recover_interrupted(), vec!["s1"]);
    }

    #[test]
    fn open_writer_cap_evicts_stale_entries() {
        // Swept/evicted terminal sessions never call close_session — the
        // open-writer map must bound itself. 80 distinct sids, cap 64.
        let dir = temp_dir("cap-writers");
        let logger = SessionLogger::new(dir.clone());
        for i in 0..80 {
            logger.log_output(&format!("s{i}"), "x".to_string());
        }
        let n = logger.files.lock().unwrap_or_else(|p| p.into_inner()).len();
        assert!(n <= 64, "open writers unbounded: {n}");
        // No data loss: every sid's file exists on disk after flush.
        logger.flush_all();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 80);
    }

    #[test]
    fn output_chunk_capped_at_4k() {
        let dir = temp_dir("cap");
        let logger = SessionLogger::new(dir.clone());
        logger.log_output("s1", "x".repeat(10_000));
        // Output events batch in the BufWriter (round-58) — flush before read.
        logger.flush_all();
        let content = std::fs::read_to_string(dir.join("s1.jsonl")).unwrap();
        // Last line is the event (first is the version header).
        let ev: serde_json::Value = content
            .lines()
            .last()
            .map(|l| serde_json::from_str(l).unwrap())
            .unwrap();
        let text = ev["text"].as_str().unwrap();
        assert!(text.len() < 5000, "capped text too long: {}", text.len());
        assert!(text.contains("truncated"));
    }

    #[test]
    fn close_trims_to_last_start_plus_tail_within_cap() {
        // Round-362: trim_file (rounds 98-100, 116) had ZERO tests despite
        // being the most intricate logic here (streaming tail, last-start
        // preservation, atomic temp+rename). First command: start + 2100
        // outputs + end. Second command: start + 2100 outputs (no end —
        // still running at close). After close: the first command's events
        // must be gone, the last start kept, total within header + 2000.
        let dir = temp_dir("trim");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("s1", "first-cmd");
        for i in 0..2100 {
            logger.log_output("s1", format!("old-{i:04}"));
        }
        logger.log_command_end("s1", Some(0), None, None);
        logger.log_command_start("s1", "second-cmd");
        for i in 0..2100 {
            logger.log_output("s1", format!("new-{i:04}"));
        }
        logger.close_session("s1");
        let content = std::fs::read_to_string(dir.join("s1.jsonl")).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        // Header + at most 2000 audit lines + the preserved last start
        // (the cap loop keeps MAX+1 so line 0 — the start — is never the
        // victim; drops come from index 1).
        assert!(
            lines.len() <= 2002,
            "trimmed file must fit the cap, got {} lines",
            lines.len()
        );
        assert!(!content.contains("first-cmd"), "pre-start history drained");
        assert!(!content.contains("old-0000"), "old outputs drained");
        assert!(
            content.contains("second-cmd"),
            "last command/start MUST survive (recovery needs it)"
        );
        assert!(
            !content.contains("new-0000"),
            "over-cap head outputs dropped from index 1"
        );
        assert!(
            content.contains("new-2099"),
            "most recent tail outputs kept"
        );
        // Recovery still sees the running command as interrupted.
        drop(logger);
        let logger2 = SessionLogger::new(dir.clone());
        let recovered = logger2.recover_interrupted();
        assert!(
            recovered.contains(&"s1".to_string()),
            "trim must not eat the interrupted marker: {recovered:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_sessions_reports_last_event_state_per_file() {
        // /api/sessions surface: one row per .jsonl file, non-jsonl
        // ignored, last event folded to kind/ts. Previously untested.
        let dir = temp_dir("list");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("a", "echo a");
        logger.log_command_end("a", Some(3), None, None);
        logger.log_status("b", "opened");
        std::fs::write(dir.join("notes.txt"), b"not a session").unwrap();
        logger.flush_all();
        let mut rows = logger.list_sessions();
        rows.sort_by(|x, y| x.0.cmp(&y.0));
        assert_eq!(rows.len(), 2, "only .jsonl files listed: {rows:?}");
        assert_eq!(rows[0].0, "a");
        assert_eq!(rows[0].1["kind"].as_str(), Some("command/end"));
        assert_eq!(rows[0].1["exit_code"].as_i64(), Some(3));
        assert_eq!(rows[1].0, "b");
        assert_eq!(rows[1].1["kind"].as_str(), Some("status"));
        assert_eq!(rows[1].1["status"].as_str(), Some("opened"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn control_handoff_is_recorded_with_its_holder() {
        // The durable half of the session hold. The live hold is in-memory only
        // (a restart releases it), so this event is the ONLY way a later reader
        // can tell an AI-driven window from a human-driven one — which is why it
        // is pinned rather than assumed.
        let dir = temp_dir("control");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start("s", "display version");
        logger.log_command_end("s", Some(0), None, Some(900));
        logger.log_control("s", "human");
        logger.log_command_start("s", "vlan 100");
        logger.log_control("s", "ai");
        logger.flush_all();

        let (events, _) = logger.events_of("s");
        let controls: Vec<&serde_json::Value> =
            events.iter().filter(|e| e["kind"] == "control").collect();
        assert_eq!(controls.len(), 2, "both handoffs recorded: {events:?}");
        assert_eq!(controls[0]["status"], "human");
        assert_eq!(controls[1]["status"], "ai");

        // ORDER is the payload: the whole value of these events is telling a
        // reader which commands fell inside the human window.
        let human_at = events
            .iter()
            .position(|e| e["kind"] == "control" && e["status"] == "human")
            .unwrap();
        let vlan_at = events
            .iter()
            .position(|e| e["kind"] == "command/start" && e["command"] == "vlan 100")
            .unwrap();
        assert!(
            human_at < vlan_at,
            "the human marker must precede the command it governs"
        );

        // `control` is its OWN kind, not a `status` value: the status vocabulary
        // is the session's lifecycle, and a holder folded into it would make
        // terminalStatus() treat a holder as a terminal state.
        assert!(
            events
                .iter()
                .all(|e| e["kind"] != "status" || e["status"] != "human"),
            "a holder must never appear as a session status"
        );

        // It must survive the fold that decides a session's last state.
        let st = logger.terminal_state_of("s").unwrap();
        assert_eq!(st["kind"], "control", "last event folds to the handoff");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE READ MUST BE ORDERED BY `seq`, NOT BY WHEN BYTES LANDED.
    ///
    /// Two logger instances write the SAME file with INDEPENDENT buffers, so
    /// their events interleave on disk in flush order, not in seq order. The
    /// long-lived terminal-plugin writer keeps a persistent `BufWriter` per
    /// session and only flushes at command boundaries (round-58), while a
    /// web-layer write flushes immediately — so a buffered `output` can land
    /// AFTER a later `asked` that a different instance already wrote.
    ///
    /// OBSERVED ON A REAL DEVICE RUN: the file read
    /// `1, 2, 4, 5, 6, 3, 7, 8, ...` — seq 3 was an output event flushed only
    /// when the next command boundary arrived, six events late. `read_events`
    /// returned that order verbatim.
    ///
    /// The contract the type documents is "per-session monotonic seq", and
    /// consumers order by it: the panel keeps `seq` as its "nothing new"
    /// watermark and uses it as a React key. Returning a sequence that goes
    /// 4, 5, 6, 3 breaks the watermark (3 looks older than what it has seen) and
    /// can drop an event from the rendered trail.
    ///
    /// Sorting at READ is the right fix: the write order across independent
    /// buffers is not something the writer can control without serialising
    /// every append through one lock, and the reader is where the ordering
    /// promise is actually consumed.
    #[test]
    fn reading_a_session_orders_by_seq_not_by_flush_time() {
        let dir = temp_dir("seqorder");
        let plugin = SessionLogger::new(dir.clone());
        let web = SessionLogger::new(dir.clone());

        plugin.log_status("s", "opened"); // seq 1
        plugin.flush_all();
        web.log_control("s", "armed"); // seq 2, flushed immediately
        plugin.log_output("s", "buffered bytes\n".to_string()); // seq 3 — BUFFERED
        web.log_control("s", "asked"); // seq 4, flushed immediately
        plugin.flush_all(); // seq 3 lands LAST

        let events = web.events_of("s").0;
        let seqs: Vec<u64> = events
            .iter()
            .map(|e| e["seq"].as_u64().unwrap_or(0))
            .collect();
        assert_eq!(seqs.len(), 4, "all four events present: {seqs:?}");
        assert!(
            seqs.windows(2).all(|w| w[0] < w[1]),
            "reading must return events in seq order even though the BUFFERED \
             one landed last (got {seqs:?}) — a consumer using seq as a \
             watermark would drop the event that arrived out of order"
        );
    }

    /// `seq` MUST BE UNIQUE EVEN WHEN THE FIRST WRITER HAS NOT FLUSHED.
    ///
    /// The existing `seq_stays_monotonic_across_logger_instances` passes only
    /// because it ends every command first, and `log_command_end` FLUSHES — so
    /// each new logger seeds from a disk that is already current. The counter
    /// itself is per-INSTANCE (`SessionLogger::new` builds a fresh map), so a
    /// fresh logger seeds from disk, and a disk that has not caught up hands it
    /// a seq the first writer is about to use too.
    ///
    /// That is not a narrow race, it is the ordinary case: the terminal plugin
    /// holds a long-lived logger whose `command/start` is BUFFERED (round-58
    /// batches output and flushes on command boundaries), and every web-layer
    /// write builds a NEW logger (`sessions_logger()`). So a gate question
    /// arriving right after a command starts is the sequence that collides:
    ///
    ///   plugin:  start  -> seq 1 (buffered, disk still empty)
    ///   web:     asked  -> seeds disk (0) -> seq 1   <-- DUPLICATE
    ///
    /// Consumers rely on uniqueness: the panel uses `seq` as a React key and as
    /// its "nothing new" watermark, so a repeat is a dropped event and a
    /// duplicated row at once.
    #[test]
    fn seq_is_unique_when_a_second_instance_writes_between_two_writes() {
        let dir = temp_dir("seqstale");
        // The long-lived plugin logger takes the FIRST event, so its in-memory
        // counter is now at 1 — and it will not consult the disk again.
        let plugin = SessionLogger::new(dir.clone());
        plugin.log_command_start("s", "echo hi");
        plugin.flush_all();

        // A web-layer write builds a FRESH logger. It seeds from disk (max 1)
        // and writes 2. Nothing tells the plugin's counter about this.
        let web = SessionLogger::new(dir.clone());
        web.log_control("s", "asked");
        web.flush_all();

        // The plugin's NEXT event: its counter was 1, so it hands out 2 —
        // the value the web logger just used. STALE COUNTER, DUPLICATE SEQ.
        plugin.log_status("s", "approved");
        plugin.flush_all();

        let seqs: Vec<u64> = web
            .events_of("s")
            .0
            .iter()
            .map(|e| e["seq"].as_u64().unwrap_or(0))
            .collect();
        assert_eq!(seqs.len(), 3, "all three events reached disk: {seqs:?}");
        let mut uniq = seqs.clone();
        uniq.sort_unstable();
        uniq.dedup();
        assert_eq!(
            uniq.len(),
            seqs.len(),
            "seq repeated (got {seqs:?}) — the long-lived logger's counter went \
             stale when the fresh instance wrote, so its next event reused the \
             seq the other had just taken"
        );
    }

    #[test]
    fn seq_stays_monotonic_across_logger_instances() {
        // The counter is per-instance and the writer appends, so a second logger
        // used to restart at 1 — two `seq: 1` events in one file, while the type
        // documents `seq` as per-session monotonic and readers order by it.
        //
        // The long-lived terminal-plugin logger owns normal writes, so this held
        // by accident until a web-layer writer built a fresh logger per request.
        // Pinned with TWO instances on purpose: one instance cannot show it.
        let dir = temp_dir("seqinst");
        let first = SessionLogger::new(dir.clone());
        first.log_command_start("s", "one");
        first.log_command_end("s", Some(0), None, None);

        let second = SessionLogger::new(dir.clone());
        second.log_control("s", "human");

        let third = SessionLogger::new(dir.clone());
        third.log_control("s", "ai");
        third.flush_all();

        let seqs: Vec<u64> = third
            .events_of("s")
            .0
            .iter()
            .map(|e| e["seq"].as_u64().unwrap_or(0))
            .collect();
        assert_eq!(seqs.len(), 4, "every event reached disk: {seqs:?}");
        let mut sorted = seqs.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            seqs.len(),
            "seq must not repeat across logger instances (got {seqs:?}) — a reader \
             ordering by it would see a broken trail"
        );
        assert!(
            seqs.windows(2).all(|w| w[0] < w[1]),
            "seq must increase in file order (got {seqs:?})"
        );
        // CONTIGUOUS, not merely increasing. This is an audit trail: with gaps
        // by design, a reader cannot tell a skipped number from a DELETED LINE,
        // which is exactly the question an audit trail exists to answer. The
        // +1 mutation on the seed (max+1 instead of max) is invisible to a
        // monotonicity check and caught only here.
        assert_eq!(
            seqs,
            (1..=seqs.len() as u64).collect::<Vec<_>>(),
            "seq must be contiguous from 1 (got {seqs:?})"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE INTENT LAYER'S FIRST REAL SURFACE: what the agent was thinking, and
    /// what it passed over, recorded beside the command it explains.
    ///
    /// The alternatives are the half that matters. An audit trail already answers
    /// "what ran"; `considered` is the only place the branches NOT taken exist at
    /// all, and without them a finished session reads as a single inevitable line
    /// of steps rather than as a sequence of choices.
    #[test]
    fn intent_and_alternatives_are_recorded_beside_the_command() {
        let dir = temp_dir("intent");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start_with(
            "s1",
            "display ont info 0 1",
            Some("  check whether the ONU is actually online  "),
            Some(&[
                "reset the ONU".to_string(),
                "check the OLT uplink".to_string(),
            ]),
        );
        drop(logger);

        let logger2 = SessionLogger::new(dir.clone());
        let (events, _) = logger2.events_of("s1");
        let start = events
            .iter()
            .find(|e| e["kind"] == "command/start")
            .expect("the command was recorded");
        assert_eq!(
            start["intent"].as_str(),
            Some("check whether the ONU is actually online"),
            "intent is trimmed and stored verbatim otherwise"
        );
        assert_eq!(
            start["considered"].as_array().map(|a| a.len()),
            Some(2),
            "the alternatives are recorded — they exist nowhere else"
        );
    }

    /// A blank or absent intent is ABSENT, not an empty string.
    ///
    /// The view has to tell "the agent explained itself and said nothing useful"
    /// from "the agent sent no explanation", and collapsing them here means no
    /// reader downstream has to distinguish two kinds of nothing.
    #[test]
    fn a_blank_intent_reads_as_absent() {
        let dir = temp_dir("intent-blank");
        let logger = SessionLogger::new(dir.clone());
        logger.log_command_start_with("s1", "ls", Some("   "), Some(&[]));
        drop(logger);

        let (events, _) = SessionLogger::new(dir.clone()).events_of("s1");
        let start = events
            .iter()
            .find(|e| e["kind"] == "command/start")
            .unwrap();
        assert!(
            start.get("intent").is_none(),
            "a blank intent must not appear"
        );
        assert!(
            start.get("considered").is_none(),
            "an empty alternatives list must not appear"
        );
        // The plain entry point produces the same shape, so nothing downstream
        // has to special-case a command logged without reasoning.
        let logger2 = SessionLogger::new(dir.clone());
        logger2.log_command_start("s1", "ls");
        drop(logger2);
        let (events, _) = SessionLogger::new(dir.clone()).events_of("s1");
        assert!(events.iter().all(|e| e.get("intent").is_none()));
    }

    /// The caps are REMOTE-INPUT bounds, so they are asserted at the boundary.
    ///
    /// These strings arrive from a client, ride every audit read, and are written
    /// to disk — an uncapped one is a remote memory and storage amplifier. The
    /// char-boundary part matters for the same reason it does everywhere else in
    /// this file: a naive byte cut panics, and this crate has paid for that three
    /// times.
    #[test]
    fn intent_and_alternatives_are_capped_and_boundary_safe() {
        let dir = temp_dir("intent-caps");
        let logger = SessionLogger::new(dir.clone());

        // Every char is 3 bytes, so a byte cut at 512 lands mid-character.
        let long_intent = "汉".repeat(400);
        let many = (0..20).map(|i| format!("option {i}")).collect::<Vec<_>>();
        logger.log_command_start_with("s1", "x", Some(&long_intent), Some(&many));
        drop(logger);

        let (events, _) = SessionLogger::new(dir.clone()).events_of("s1");
        let start = events
            .iter()
            .find(|e| e["kind"] == "command/start")
            .unwrap();
        let intent = start["intent"].as_str().unwrap();
        assert!(intent.len() <= INTENT_MAX_BYTES, "intent is capped");
        assert_eq!(
            intent.chars().count(),
            intent.len() / 3,
            "the cap must land on a char boundary, not inside 汉"
        );
        let considered = start["considered"].as_array().unwrap();
        assert_eq!(
            considered.len(),
            CONSIDERED_MAX,
            "the branch list is capped"
        );
        assert!(considered
            .iter()
            .all(|c| c.as_str().unwrap().len() <= CONSIDERED_ITEM_MAX_BYTES));
    }

    /// BOTH entry points apply the command cap.
    ///
    /// The cap existed only on the plain path, so a multi-MB one-liner could ride
    /// the trail forever simply by being logged through the intent-carrying
    /// method instead — a second entry point is exactly how a cap drifts.
    #[test]
    fn the_command_cap_applies_to_both_entry_points() {
        let dir = temp_dir("intent-cmdcap");
        let logger = SessionLogger::new(dir.clone());
        let huge = "A".repeat(50_000);
        logger.log_command_start("s1", &huge);
        logger.log_command_start_with("s1", &huge, Some("why"), None);
        drop(logger);

        let (events, _) = SessionLogger::new(dir.clone()).events_of("s1");
        let starts: Vec<_> = events
            .iter()
            .filter(|e| e["kind"] == "command/start")
            .collect();
        assert_eq!(starts.len(), 2);
        for s in starts {
            let cmd = s["command"].as_str().unwrap();
            assert!(
                cmd.len() < 5000,
                "a 50 KB command must be capped on BOTH paths (got {} bytes)",
                cmd.len()
            );
            assert!(cmd.contains("truncated"), "and say that it was cut");
        }
    }

    /// RECOVERY MUST NOT ORPHAN A LIVE WRITER — the evidence-loss bug.
    ///
    /// `recover_interrupted` used to trim each recovered session's file, and the
    /// trim rewrites atomically: temp file, then RENAME over the original. The
    /// path gets a new inode, so every OTHER writer's open handle is orphaned —
    /// its writes still succeed (`writeln!` and `flush` both return `Ok`) while
    /// every byte lands in a file nothing can reach.
    ///
    /// This is what made the web audit pins fail on 3 of 4 full-suite runs, and
    /// the measurement that identified it was the handle and the path reporting
    /// DIFFERENT lengths for the same write (528 vs 393 bytes).
    ///
    /// The test drives the exact shape: one writer with an open handle, a second
    /// logger running recovery, then another write through the FIRST writer. If
    /// recovery renames the file, that last event is lost.
    #[test]
    fn recovery_does_not_orphan_a_live_writer() {
        let dir = temp_dir("recover-orphan");
        let writer = SessionLogger::new(dir.clone());
        writer.log_command_start("s1", "long-running-thing");
        // A start with no end is what recovery looks for — leave it unpaired.
        drop(writer);

        // Reopen with an open handle (this is the "live writer").
        let live = SessionLogger::new(dir.clone());
        live.log_status("s1", "still going");

        // A SECOND instance runs recovery, as a plugin registry construction
        // does. It must not rewrite the file under `live`.
        let other = SessionLogger::new(dir.clone());
        let affected = other.recover_interrupted();
        assert!(
            affected.contains(&"s1".to_string()),
            "recovery should still MARK the unpaired start: {affected:?}"
        );

        // The live writer's next event must be readable.
        live.log_status("s1", "after-recovery");
        let read = SessionLogger::new(dir.clone());
        let statuses: Vec<String> = read
            .events_of("s1")
            .0
            .iter()
            .filter_map(|e| e["status"].as_str().map(|s| s.to_string()))
            .collect();
        assert!(
            statuses.contains(&"after-recovery".to_string()),
            "an event written through a live handle AFTER recovery must survive — \
             recovery renaming the file orphans that handle and swallows it. \
             Statuses seen: {statuses:?}"
        );
    }

    /// `ts` IS SECONDS AND `ts_ms` IS MILLISECONDS — the merge contract.
    ///
    /// The browser's action feed stamps MILLISECONDS in a field named `ts`; this
    /// trail stamps SECONDS in a field with the same name. Whoever merges the two
    /// into one operation timeline must sort on `ts_ms`, because sorting on `ts`
    /// puts every browser action ~50 years in the future while looking perfectly
    /// ordered — a silent failure, which is why it gets a pin.
    #[test]
    fn ts_and_ts_ms_come_from_one_clock_read() {
        // Driven through the PURE function, not through a live clock read.
        //
        // The first version of this test wrote an event and compared the two
        // fields, and it PASSED a mutant that read the clock twice: two reads
        // nanoseconds apart land in the same second essentially always, so the
        // assertion could not see the difference it existed to catch.
        //
        // A duration that STRADDLES a second boundary is the case no pair of
        // separate reads can produce: `…999ms` and `…(1s)000ms` are the same
        // instant, so both stamps must agree on it.
        let d = std::time::Duration::from_millis(1_700_000_000_999);
        let (ts, ts_ms) = stamps_from(d);
        assert_eq!(ts, 1_700_000_000, "ts is the whole second");
        assert_eq!(ts_ms, 1_700_000_000_999, "ts_ms keeps the milliseconds");
        assert_eq!(
            ts_ms / 1000,
            ts,
            "the two stamps must describe the SAME instant — a pair from separate \
             reads can disagree here whenever it straddles a boundary"
        );

        // And the write path really does use it (not a re-implementation).
        let dir = temp_dir("tsms");
        let logger = SessionLogger::new(dir.clone());
        logger.log_status("s1", "opened");
        drop(logger);
        let e = SessionLogger::new(dir.clone()).events_of("s1").0.remove(0);
        let (wts, wts_ms) = (
            e["ts"].as_u64().expect("ts"),
            e["ts_ms"].as_u64().expect("ts_ms"),
        );
        assert!(
            wts > 1_700_000_000,
            "ts must be a real epoch second, got {wts}"
        );
        assert!(
            wts_ms > 1_700_000_000_000,
            "ts_ms must be a real epoch MILLIsecond — a seconds value here means \
             the two were swapped at a call site, got {wts_ms}"
        );
        assert_eq!(wts_ms / 1000, wts, "live stamps must also agree");
    }

    /// THE HAZARD ITSELF, made explicit: the two feeds' `ts` are different units.
    ///
    /// This is the assertion a merge author needs to see fail if they ever sort
    /// the two feeds on `ts`. It documents the divergence as a FACT rather than
    /// leaving it to be discovered.
    #[test]
    fn the_two_feeds_ts_fields_are_different_units() {
        let dir = temp_dir("units");
        let logger = SessionLogger::new(dir.clone());
        logger.log_status("s1", "opened");
        drop(logger);
        let e = SessionLogger::new(dir.clone()).events_of("s1").0.remove(0);
        let audit_ts = e["ts"].as_u64().unwrap();

        // A browser action line, written through the shared writer, with a
        // millisecond stamp as its producers supply.
        let adir = dir.join("evidence");
        std::fs::create_dir_all(&adir).unwrap();
        let ms = crate::now_millis();
        crate::evidence::append_action_line(&adir, ms, &serde_json::json!({"script": "x"}));
        let actions = crate::evidence::recent_actions(&adir, 10);
        let a = actions.first().expect("one action");

        assert_eq!(
            a["ts"].as_u64().unwrap(),
            ms,
            "the action feed's `ts` is MILLISECONDS"
        );
        assert_eq!(
            a["ts_ms"].as_u64().unwrap(),
            ms,
            "and it also carries the explicit name the merge reads"
        );
        assert!(
            a["ts_ms"].as_u64().unwrap() > audit_ts * 100,
            "the two feeds' `ts` differ by ~1000x — sorting on `ts` would \
             interleave them wrongly while looking ordered"
        );
    }

    #[test]
    fn a_fresh_logger_on_an_empty_session_still_starts_at_one() {
        // The other half: seeding must not push the first event to seq 2. A
        // missing file is not an error and must not be treated as "one event
        // already there".
        let dir = temp_dir("seqfresh");
        let logger = SessionLogger::new(dir.clone());
        logger.log_control("new", "human");
        logger.flush_all();
        let (events, _) = logger.events_of("new");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["seq"].as_u64(), Some(1));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
