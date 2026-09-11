// RunStrip — the device's RUNS, at the top of the Path view.
//
// WHAT IT IS FOR. An AI client can now declare the boundaries of one run
// (`run_begin` / `run_end`) and the device stamps the minted `run_id` onto the
// records it writes. This strip is the operator's view of that: one row per run,
// so "what did it do while I was away" can be read a run at a time instead of as
// one undifferentiated stream.
//
// It is DEVICE-level and deliberately lives inside the per-session Path view
// rather than in a view of its own: `SessionView` is per-session, and a run
// crosses sessions (one execution can open three terminals and drive the browser
// between them). The Path view is where the operator already reads work
// post-hoc, so the runs are bracketed there — collapsed to a header by default
// is not an option: the feature exists to make them VISIBLE, so the rows are
// open and the header collapses them on request.
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
import { groupOperation, groupCount, type RunGroup, type RunState } from "../lib/runs";
import { useOperationRuns } from "../hooks/useOperationRuns";
import { fmtDuration } from "./CommandCard";

/** The word each state is rendered as. Deliberately the state's own name rather
 *  than a verdict: "closed" says the boundary was recorded, not that it went
 *  well — that judgement is not this panel's to make from a boundary record. */
const STATE_LABEL: Record<RunState, string> = {
  closed: "closed",
  open: "open",
  unregistered: "unregistered",
  unattributed: "unattributed",
};

/** The one short line of honesty each state needs, or `null` for a state whose
 *  own name already says everything (a closed run needs no note). */
function stateNote(g: RunGroup): string | null {
  switch (g.state) {
    // "Still running" is exactly what this view CANNOT say: the client may have
    // stopped, or the agent may have restarted. The absence is the fact.
    case "open": return "no end recorded";
    case "unregistered": return "no begin recorded";
    default: return null;
  }
}

/** Wall clock for the axis. The date is omitted on purpose — a run strip is
 *  read against the work around it, and the endpoint serves the recent
 *  timeline. */
function clock(ms: number): string {
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
              <div className="run-row-head">
                <span className="run-row-state" data-state={g.state}>
                  {STATE_LABEL[g.state]}
                </span>
                {primary(g)}
                <span className="run-row-counts">
                  <span className="run-row-count">{g.terminal} terminal</span>
                  <span className="run-row-count">{g.browser} browser</span>
                </span>
                <span
                  className="run-row-span"
                  data-start-ms={g.startMs}
                  data-end-ms={g.endMs}
                >
                  {spanText(g)}
                </span>
              </div>
              {(g.goal || stateNote(g)) && (
                <div className="run-row-meta">
                  {g.goal && (
                    <span className="run-row-goal">
                      <span className="run-row-goal-label">goal</span>
                      {g.goal}
                    </span>
                  )}
                  {stateNote(g) && <span className="run-row-note">{stateNote(g)}</span>}
                </div>
              )}
              {/* The outcome is the client's words, not a verdict this panel can
                  derive: "failed: ONU did not register" is as legitimate a value
                  as "done", so it is rendered in the reading ink and NEVER
                  coloured as success or failure. Absent ⇒ nothing at all. */}
              {g.outcome && (
                <p className="run-row-outcome">
                  <span className="run-row-outcome-label">outcome</span>
                  {g.outcome}
                </p>
              )}
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
              <div className="run-row-head">
                <span className="run-row-state" data-state="unattributed">
                  {STATE_LABEL.unattributed}
                </span>
                {primary(groups.unattributed)}
                <span className="run-row-counts">
                  <span className="run-row-count">
                    {groups.unattributed.terminal} terminal
                  </span>
                  <span className="run-row-count">
                    {groups.unattributed.browser} browser
                  </span>
                </span>
                <span
                  className="run-row-span"
                  data-start-ms={groups.unattributed.startMs}
                  data-end-ms={groups.unattributed.endMs}
                >
                  {spanText(groups.unattributed)}
                </span>
              </div>
              <div className="run-row-meta">
                <span className="run-row-note">
                  these events declared no run — shown apart rather than assumed
                  into one
                </span>
              </div>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
