// RunStrip — the device's RUNS, at the top of the Path view.
//
// WHAT IT IS FOR. An AI client can now declare the boundaries of one run
// (`run_begin` / `run_end`) and the device stamps the minted `run_id` onto the
// records it writes. This strip is the operator's view of that: one row per run,
// so "what did it do while I was away" can be read a run at a time instead of as
// one undifferentiated stream.
//
// WHY IT STILL LIVES IN THE PATH VIEW, AND WHY THE ACTIVITY PAGE EXISTS TOO.
// The original argument for putting the runs HERE rather than in a view of their
// own was that a run crosses sessions (one execution can open three terminals
// and drive the browser between them) while `SessionView` is per-session — so
// the device-level thing had to be bracketed where the operator already reads
// work post-hoc. That argument was HALF right, and the half it missed is why
// there is now a second surface. The two answer DIFFERENT questions:
//
//   * THIS strip, inside the Path view, answers "what did the device do while I
//     was reading THIS session" — it is the context for the session's own steps,
//     which is why it is a strip above them and not a page: the operator reads a
//     run to make sense of the commands underneath it.
//
//   * The ACTIVITY page (`ActivityPage`) answers "what has this device been
//     doing at all" — a question that exists with ZERO sessions open, and for
//     work that never had a session in the first place (the AI driving the
//     embedded browser on its own). Neither surface can answer the other's
//     question: this strip is unreachable without an active session, and a page
//     of records is the wrong shape for "the run above these five commands".
//
// So the old comment's claim is not deleted — it is the reason THIS component is
// still here — but it is no longer the whole story, and neither surface should
// be "fixed" away by folding it into the other. Both read ONE grouping
// (`lib/runs.ts`) and ONE header (`RunGroupHead`, below), so they cannot
// disagree about which run a record belongs to or what a state is called.
//
// Still open by default, and collapsed only on request: this feature exists to
// make the runs VISIBLE, so it does not start folded away.
//
// THE THREE HONEST STATES (see lib/runs.ts for the derivation):
//   closed       — a run/end exists. The outcome is shown when the client gave
//                  one, and NOTHING is drawn where it would go when it did not:
//                  a guessed "failed" or a "—" reading as a value would be the
//                  panel asserting an ending nobody recorded.
//   open         — a begin with no end. The COMMON case, not an error. Its span
//                  is [begin, newest event] and it SAYS "no end recorded".
//   unregistered — events carrying an id whose begin was never seen. Shown under
//                  the raw id, because that is the only true name it has.
// plus the UNATTRIBUTED group: events with no run id at all, kept separate so
// adjacency is never mistaken for attribution.
import { useMemo, useState } from "react";
import { groupOperation, groupCount, RUN_STATE_LABEL, runStateNote, type RunGroup } from "../lib/runs";
import { useOperationRuns } from "../hooks/useOperationRuns";
import { fmtDuration } from "./CommandCard";

/** Wall clock for the axis. The date is omitted on purpose — a run strip is
 *  read against the work around it, and the endpoint serves the recent
 *  timeline. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/** The row's name: the label, the raw id when that is all there is, or an
 *  explicit marker. Never blank — a blank reads as a label that failed to
 *  load. */
function primary(g: RunGroup) {
  if (g.state === "unregistered") {
    return <span className="run-row-id" title={g.runId ?? ""}>{g.runId}</span>;
  }
  if (g.state === "unattributed") {
    return <span className="run-row-unlabeled">no run id</span>;
  }
  if (g.label) return <span className="run-row-label">{g.label}</span>;
  return <span className="run-row-unlabeled">unlabeled</span>;
}

/** `[start]` or `[start – end (duration)]`. A zero-length extent shows ONE
 *  stamp: "10:00:00 – 10:00:00" invents a duration nobody measured. */
function spanText(g: RunGroup): string {
  if (g.endMs <= g.startMs) return clock(g.startMs);
  return `${clock(g.startMs)} – ${clock(g.endMs)} (${fmtDuration(g.endMs - g.startMs)})`;
}

/** ONE run's header, shared by both views that list runs (this strip and the
 *  Activity page) so the state vocabulary, the naming rules and the honesty
 *  lines have exactly one implementation. */
export function RunGroupHead({ group }: { group: RunGroup }) {
  const derived = runStateNote(group);
  return (
    <>
      <div className="run-row-head">
        <span className="run-row-state" data-state={group.state}>
          {RUN_STATE_LABEL[group.state]}
        </span>
        {primary(group)}
        <span className="run-row-counts">
          <span className="run-row-count">{group.terminal} terminal</span>
          <span className="run-row-count">{group.browser} browser</span>
        </span>
        <span
          className="run-row-span"
          data-start-ms={group.startMs}
          data-end-ms={group.endMs}
        >
          {spanText(group)}
        </span>
      </div>
      {(group.goal || derived) && (
        <div className="run-row-meta">
          {group.goal && (
            <span className="run-row-goal">
              <span className="run-row-goal-label">goal</span>
              {group.goal}
            </span>
          )}
          {derived && <span className="run-row-note">{derived}</span>}
        </div>
      )}
      {/* The outcome is the client's words, not a verdict this panel can
          derive: "failed: ONU did not register" is as legitimate a value
          as "done", so it is rendered in the reading ink and NEVER
          coloured as success or failure. Absent ⇒ nothing at all. */}
      {group.outcome && (
        <p className="run-row-outcome">
          <span className="run-row-outcome-label">outcome</span>
          {group.outcome}
        </p>
      )}
    </>
  );
}

export function RunStrip({ pollMs }: { pollMs?: number }) {
  const { events, boundaries } = useOperationRuns(pollMs);
  const groups = useMemo(() => groupOperation(events, boundaries), [events, boundaries]);
  const [open, setOpen] = useState(true);

  const total = groupCount(groups);
  // NOTHING TO GROUP ⇒ NOTHING RENDERED. An empty container with a "Runs"
  // header would read as a feature that failed to load, which is worse than the
  // feature being absent — the same stance the plan block takes when the agent
  // declared no plan.
  if (total === 0) return null;

  const openRuns = groups.runs.filter((r) => r.state === "open").length;

  return (
    <section className="run-strip" aria-label="Runs">
      <button
        type="button"
        className="run-strip-head"
        aria-expanded={open}
        title={open ? "Hide runs" : "Show runs"}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="run-strip-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="run-strip-title">Runs</span>
        <span className="run-strip-count">{groups.runs.length}</span>
        {openRuns > 0 && <span className="run-strip-open">{openRuns} open</span>}
        {groups.unattributed && (
          <span className="run-strip-residue">unattributed activity</span>
        )}
      </button>

      {open && (
        <ul className="run-list">
          {groups.runs.map((g) => (
            <li
              className="run-row"
              key={g.runId ?? `${g.startMs}`}
              data-state={g.state}
              data-run-id={g.runId ?? ""}
            >
              <RunGroupHead group={g} />
            </li>
          ))}

          {/* THE SEPARATE BUCKET. It is a row of its own, after the runs and
              never merged into the one it follows in the stream: folding these
              events into a neighbouring run would manufacture exactly the
              attribution the run id exists to make checkable. */}
          {groups.unattributed && (
            <li
              className="run-row run-row-unattributed"
              data-state="unattributed"
              data-run-id=""
            >
              <RunGroupHead group={groups.unattributed} />
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
