// ActivityPage — WHAT THIS DEVICE HAS BEEN DOING, with no session open.
//
// THE HOLE THIS FILLS. `GET /api/operation` merges the terminal audit trail and
// the browser action feed onto one ordered axis and returns the run boundaries
// beside it, and until now the panel fetched those records, counted them
// ("3 terminal / 1 browser") and threw the records themselves away. Worse, the
// only thing that read them at all was the RunStrip inside the per-session Path
// view, which is unreachable until a session exists and is active. So work that
// was browser-only had NO view anywhere, and an operator returning to a device
// with zero sessions saw "No sessions yet". This page is that view.
//
// WHAT IT IS, AND WHAT IT IS NOT:
//   * DEVICE-scoped, like the runs it groups: every session's commands, the
//     browser's actions, and work that had no session at all.
//   * A RECORD, read post-hoc, like the Path view — not a console. There is no
//     refresh button because it polls, and no "is it still running" indicator
//     because NOBODY HERE KNOWS: a client may have stopped, or the agent may have
//     restarted, and an open run means "no end was recorded", nothing more.
//     There is no live-ticking timer for the same reason (see lib/runs.ts).
//   * NOT a second runs view: the runs are the GROUPING here, and the rows are
//     the point. Neither this page nor the strip can answer the other's
//     question — see the header of RunStrip.tsx for the full argument.
//
// HONEST EMPTIES (this panel's discipline):
//   * an absent field draws NOTHING — no "—", no "failed", no "unknown";
//   * `exit 0` and "no exit code was recorded" are different renderings of
//     different facts, never collapsed;
//   * a record whose payload the device did not write renders without a body
//     line rather than with a placeholder sentence;
//   * a run with no records says so in one quiet line instead of drawing an
//     empty list that reads as a broken feature.
import { useMemo } from "react";
import { operationRows, type ActivityRow } from "../lib/runs";
import { useOperationRuns } from "../hooks/useOperationRuns";
import { fmtDuration } from "./CommandCard";
import { RunGroupHead, clock } from "./RunStrip";

/** The record's own payload, in the form its kind gives it. `null` when the
 *  device wrote nothing to show — the row then renders WITHOUT a body line,
 *  because a placeholder there ("(no command)") would be this page asserting a
 *  fact about a record it cannot see. */
function payload(row: ActivityRow): string | null {
  // A browser row's own text is its script (the feed has no command field). A
  // script the device did not record is absent, NOT empty: no line is drawn.
  if (row.source === "browser") return row.script ?? row.text ?? null;
  return row.command ?? row.text ?? null;
}

/** The facts some kinds carry in `status` rather than in a payload. Returns
 *  `null` (draw nothing) for every kind whose payload already says it. */
function kindNote(row: ActivityRow): string | null {
  if (row.kind === "control") {
    // The handoff record: who held the keyboard. The VALUE, not a verdict.
    return row.status ? `keyboard: ${row.status}` : null;
  }
  if (row.kind === "approval") {
    return row.status ? `approval ${row.status}` : null;
  }
  return null;
}

/** A screenshot is named by its FILE, never re-rendered here: the evidence
 *  drawer owns showing it, and a thumbnail in a timeline row would be a second
 *  answer to "what does this shot look like". */
function shotName(s: string): string {
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

function RowBody({ row }: { row: ActivityRow }) {
  const what = payload(row);
  const note = kindNote(row);
  return (
    <>
      <div className="activity-row-head">
        {/* Which feed it came from, as a WORD. The browser rows carry no
            session, so this is also the honest answer to "which terminal was
            this" for an action that never had one. */}
        <span className="activity-row-source" data-source={row.source}>
          {row.source}
        </span>
        {row.kind && <span className="activity-row-kind">{row.kind}</span>}
        {row.session && (
          <span className="activity-row-session" title="The terminal session this record belongs to">
            {row.session}
          </span>
        )}
        <span className="activity-row-facts">
          {/* A REAL VALUE, drawn for every exit code INCLUDING zero, and drawn
              differently from "no exit code was recorded" — which is the absence
              of this element, not a word in its place. The shape channel (see
              the stylesheet) carries the zero/not-zero difference as well as the
              ink, because this panel has already shipped a state pair that
              differed by one channel only. */}
          {row.exitCode != null && (
            <span
              className="activity-row-exit"
              data-exit={row.exitCode === 0 ? "zero" : "nonzero"}
            >
              exit {row.exitCode}
            </span>
          )}
          {row.durationMs != null && (
            <span className="activity-row-dur">{fmtDuration(row.durationMs)}</span>
          )}
          {/* Only when the device WROTE it: a missing flag is not a timeout. */}
          {row.timedOut && <span className="activity-row-timeout">timed out</span>}
          {row.planStep != null && (
            <span className="activity-row-step">plan step {row.planStep}</span>
          )}
          <span className="activity-row-ts">{clock(row.tsMs)}</span>
        </span>
      </div>

      {what && <p className="activity-row-what">{what}</p>}
      {note && <p className="activity-row-kindnote">{note}</p>}

      {/* The client's stated reason, where it stated one. Most rows have none
          and NOTHING is drawn for them: a "no intent recorded" line on every
          row would bury the rows that have one. */}
      {row.intent && (
        <p className="activity-row-intent">
          <span className="activity-row-intent-label">intent</span>
          {row.intent}
        </p>
      )}

      {/* The alternatives it says it passed over. Same rule: none named ⇒ no
          line at all, never a note about the silence. */}
      {row.considered.length > 0 && (
        <p className="activity-row-alt" title="Alternatives the client says it passed over">
          <span className="activity-row-alt-label">instead of</span>
          {row.considered.map((c) => (
            <span key={c} className="activity-row-alt-item">{c}</span>
          ))}
        </p>
      )}

      {row.screenshots.length > 0 && (
        <p className="activity-row-shots">
          <span className="activity-row-shots-label">screenshots</span>
          {row.screenshots.map((s) => (
            <span key={s} className="activity-row-shot" title={s}>{shotName(s)}</span>
          ))}
        </p>
      )}
    </>
  );
}

/** Oldest and newest stamp actually on the axis, or `null` when there is
 *  nothing placed (an empty timeline — the caller does not render a span for
 *  it). Derived from `ts_ms` ONLY, which is the single axis every record here
 *  carries (see lib/runs.ts: the two feeds stamp `ts` in different units). */
function extent(groups: { rows: ActivityRow[] }[]): { first: number; last: number } | null {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const g of groups) {
    for (const r of g.rows) {
      if (r.tsMs < first) first = r.tsMs;
      if (r.tsMs > last) last = r.tsMs;
    }
  }
  return first <= last ? { first, last } : null;
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

export function ActivityPage({ pollMs }: { pollMs?: number }) {
  const snapshot = useOperationRuns(pollMs);
  const groups = useMemo(
    () => operationRows(snapshot.events, snapshot.boundaries),
    [snapshot],
  );
  const span = useMemo(() => extent(groups), [groups]);

  const runCount = groups.filter((g) => g.group.state !== "unattributed").length;
  const records = groups.reduce((n, g) => n + g.rows.length, 0);
  const unattributed = groups.find((g) => g.group.state === "unattributed") ?? null;

  return (
    <section className="activity-page" aria-label="Activity">
      <header className="activity-head">
        <div className="activity-head-line">
          <h2 className="activity-title">Activity</h2>
          <span className="activity-scope">this device · every session · the browser</span>
        </div>
        <p className="activity-lede">
          The device's merged timeline: terminal commands and browser actions on one
          axis, grouped by the run that declared them. Nothing here needs a session
          open, so browser-only work shows up too.
        </p>
        {groups.length > 0 && (
          <div className="activity-stats">
            <span className="activity-stat">{plural(runCount, "run", "runs")}</span>
            {/* "records", not "commands": one command is a start record and an
                end record, and calling that two commands would inflate the count
                the operator is reading. */}
            <span className="activity-stat">{plural(records, "record", "records")}</span>
            {unattributed && (
              <span className="activity-stat activity-stat-unattributed">
                {plural(unattributed.rows.length, "record with no run", "records with no run")}
              </span>
            )}
            {span && (
              <span className="activity-span">
                {span.first === span.last
                  ? clock(span.first)
                  : `${clock(span.first)} – ${clock(span.last)}`}
              </span>
            )}
          </div>
        )}
      </header>

      {groups.length === 0 ? (
        // A QUIET LINE, not an empty container: an empty list with a title reads
        // as a feature that failed to load. The wording is about what has been
        // READ rather than about what the device did — the poll keeps its last
        // good snapshot and does not report a failure, so "the device recorded
        // nothing" is not something this page can honestly claim.
        <p className="activity-empty">
          Nothing has been read from this device yet. Commands run in any terminal
          session and actions the AI takes in the browser appear here as they are
          recorded — this page does not need a session open.
        </p>
      ) : (
        <ol className="activity-groups">
          {groups.map(({ group, rows }) => (
            <li
              key={group.runId ?? "unattributed"}
              className={`activity-group${group.state === "unattributed" ? " activity-group-unattributed" : ""}`}
              data-state={group.state}
              data-run-id={group.runId ?? ""}
            >
              {/* The SAME header component the run strip draws, so the two
                  surfaces cannot disagree about a state's name, a run's label or
                  which boundary is missing. */}
              <div className="activity-group-head">
                <RunGroupHead group={group} />
              </div>
              {rows.length === 0 ? (
                // The bucket is never empty (it exists only when something is in
                // it); a run with no records is the case here — its begin and
                // end were recorded and no record carries the id. Saying so is
                // the honest half of the header above it.
                <p className="activity-group-empty">No records carry this run id.</p>
              ) : (
                <ul className="activity-rows">
                  {rows.map((row) => (
                    <li
                      className="activity-row"
                      key={row.id}
                      data-source={row.source}
                      data-kind={row.kind ?? ""}
                      data-run-id={row.runId ?? ""}
                    >
                      <RowBody row={row} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
