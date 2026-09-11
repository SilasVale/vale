// Run identity — folding the device's operation timeline into RUNS.
//
// An AI client can declare the boundaries of "one run" (one execution of its
// work) with the device's `run_begin` / `run_end` tool pair. The device mints a
// `run_id` and stamps it onto the records it writes; `GET /api/operation`
// returns those records (`events`) and the boundaries (`runs`) as two SEPARATE
// arrays on one millisecond axis. This module is the only place that joins them.
//
// THE ONE RULE THAT MATTERS: never fabricate an attribution.
//
//   * An event whose `run_id` is absent is UNATTRIBUTED. It gets its own group
//     and is never folded into whatever run happened to precede it in the
//     stream. Folding would assert "this command belonged to that run" from
//     nothing but adjacency, which is precisely the claim the run id exists to
//     make verifiable. It is also the failure that is hardest to notice: the
//     numbers would look complete.
//
//   * An id with no `run/begin` is UNREGISTERED, and is shown under the raw id
//     rather than hidden or merged into a neighbour. The device's run log is
//     best-effort and capped, so this happens honestly.
//
//   * An OPEN run (a begin with no matching end) is the COMMON case — the client
//     may still be working, may have stopped, or the agent may have restarted.
//     Its extent is `[begin, the newest event carrying that id]`, NEVER
//     `[begin, now]`: a live-ticking span grows forever on screen and implies a
//     knowledge of "still running" that no one here has.
//
// Pure by construction (no clock, no fetch, no React) so the rules above are
// testable directly rather than through a rendered component.

/** One row of `GET /api/operation`'s `events` array. Every field is optional in
 *  the type because the panel must survive a device that sends fewer of them
 *  than this build expects — a missing key must read as absent, not crash. */
export interface OperationEvent {
  /** Which feed the row came from. Anything that is not `browser` is the
   *  terminal audit trail (the only other producer on the device). */
  source?: string | null;
  /** ALWAYS milliseconds — the only axis this module sorts or spans on. */
  ts_ms?: number | null;
  /** Terminal events only; browser actions have no session. */
  session?: string | null;
  kind?: string | null;
  /** Terminal only: the audit file's per-session monotonic sequence. */
  seq?: number | null;
  command?: string | null;
  text?: string | null;
  status?: string | null;
  exit_code?: number | null;
  duration_ms?: number | null;
  intent?: string | null;
  considered?: string[] | null;
  plan_step?: number | null;
  /** Browser rows. */
  script?: string | null;
  screenshots?: string[] | null;
  timed_out?: boolean | null;
  /** The run this activity was attributed to. `null`/absent = never attributed. */
  run_id?: string | null;
}

/** One record of `GET /api/operation`'s `runs` array: a `run/begin` or a
 *  `run/end`. `label`, `goal` and `outcome` are ABSENT (a missing key, not
 *  `null` and not `""`) when the client supplied nothing — the device collapses
 *  blank to absent deliberately, so presence is read, never truthiness. */
export interface RunBoundary {
  kind?: string | null;
  run_id?: string | null;
  ts_ms?: number | null;
  label?: string | null;
  goal?: string | null;
  outcome?: string | null;
}

export type RunState = "closed" | "open" | "unregistered" | "unattributed";

export interface RunGroup {
  /** `null` for the unattributed bucket. Inventing an id ("unknown") there would
   *  render as an id the device could be asked about, and there is none. */
  runId: string | null;
  state: RunState;
  /** Absent ⇒ `null`. Never `""`, never a placeholder word. */
  label: string | null;
  goal: string | null;
  outcome: string | null;
  /** Wall-clock span on the `ts_ms` axis. For an open run `endMs` is the newest
   *  event carrying the id — never the current time. */
  startMs: number;
  endMs: number;
  /** How many of the device's terminal events carry this `run_id`. */
  terminal: number;
  /** How many browser actions carry it. */
  browser: number;
}

export interface OperationGroups {
  /** Sorted by start time. */
  runs: RunGroup[];
  /** The events with no `run_id`, as their OWN group. `null` when there are
   *  none — an empty group is not rendered at all. */
  unattributed: RunGroup | null;
}

/** A string field as a VALUE, or `null` when it holds nothing.
 *
 *  The device trims and collapses blank to absent, so an empty or
 *  whitespace-only string is the same absence wearing a costume — and a
 *  reader that renders it would put a blank where a label goes. */
function value(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/** A usable millisecond stamp, or `null`. The device DROPS a record with no
 *  explicit stamp rather than guessing its unit; a reader must not place one by
 *  guess either. */
function stamp(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface Acc {
  id: string | null;
  beginTs: number | null;
  endTs: number | null;
  label: string | null;
  goal: string | null;
  outcome: string | null;
  /** Extent of the EVENTS carrying this id, which is what an open run's span is
   *  derived from. */
  firstMs: number | null;
  lastMs: number | null;
  terminal: number;
  browser: number;
}

function emptyAcc(id: string | null): Acc {
  return {
    id, beginTs: null, endTs: null, label: null, goal: null, outcome: null,
    firstMs: null, lastMs: null, terminal: 0, browser: 0,
  };
}

function accFor(map: Map<string, Acc>, id: string): Acc {
  let a = map.get(id);
  if (!a) {
    a = emptyAcc(id);
    map.set(id, a);
  }
  return a;
}

/**
 * Fold the timeline's events and its run boundaries into one group per run,
 * plus the unattributed bucket.
 *
 * Order-independent: both inputs may arrive in any order (the hook accumulates
 * them across polls), so extents are computed with min/max rather than by
 * position, and a `run/begin` that arrives after its own events still registers
 * the run.
 */
export function groupOperation(
  events: OperationEvent[],
  boundaries: RunBoundary[],
): OperationGroups {
  const byId = new Map<string, Acc>();
  const unattributed = emptyAcc(null);

  for (const e of events) {
    const ts = stamp(e?.ts_ms);
    // No usable stamp ⇒ the row cannot be placed on the axis, counted into a
    // span, or ordered. Dropped, exactly as the device drops its unstamped
    // half — a guessed position is worse than a missing row.
    if (ts == null) continue;
    const id = value(e?.run_id);
    const a = id ? accFor(byId, id) : unattributed;
    // Anything that is not the browser feed came from the terminal audit trail;
    // those are the only two producers on the device.
    if (e?.source === "browser") a.browser += 1;
    else a.terminal += 1;
    a.firstMs = a.firstMs == null ? ts : Math.min(a.firstMs, ts);
    a.lastMs = a.lastMs == null ? ts : Math.max(a.lastMs, ts);
  }

  for (const b of boundaries) {
    const ts = stamp(b?.ts_ms);
    const id = value(b?.run_id);
    if (ts == null || id == null) continue;
    const a = accFor(byId, id);
    if (b?.kind === "run/begin") {
      // The EARLIEST begin is the run's identity: a duplicate begin for one id
      // is a client error, and honouring the later one would move the run's
      // start forward while its events stayed put.
      if (a.beginTs == null || ts < a.beginTs) {
        a.beginTs = ts;
        a.label = value(b.label);
        a.goal = value(b.goal);
      }
    } else if (b?.kind === "run/end") {
      // The LATEST end closes it: a repeated `run_end` must not reopen a span
      // that has already been reported as finished.
      if (a.endTs == null || ts > a.endTs) {
        a.endTs = ts;
        a.outcome = value(b.outcome);
      }
    }
  }

  const runs: RunGroup[] = [];
  for (const a of byId.values()) {
    // `closed` first: a `run/end` is the one record that says the run is over,
    // even when its `run/begin` is missing (the device's runs log is capped, so
    // an old begin can be trimmed out from under a recent end).
    const state: RunState =
      a.endTs != null ? "closed" : a.beginTs != null ? "open" : "unregistered";
    const startMs = a.beginTs ?? a.firstMs ?? a.endTs ?? 0;
    // A CLOSED run's span ends where the client said it ended; an OPEN run's
    // ends at its newest event. Neither ever reads the wall clock.
    const endMs =
      a.endTs != null ? a.endTs : a.lastMs != null ? Math.max(a.lastMs, startMs) : startMs;
    runs.push({
      runId: a.id,
      state,
      label: a.label,
      goal: a.goal,
      outcome: a.outcome,
      startMs,
      endMs,
      terminal: a.terminal,
      browser: a.browser,
    });
  }
  runs.sort(
    (x, y) =>
      x.startMs - y.startMs ||
      (x.runId ?? "").localeCompare(y.runId ?? ""),
  );

  const residue = unattributed.terminal + unattributed.browser;
  return {
    runs,
    unattributed:
      residue > 0
        ? {
            runId: null,
            state: "unattributed",
            label: null,
            goal: null,
            outcome: null,
            startMs: unattributed.firstMs ?? 0,
            endMs: unattributed.lastMs ?? unattributed.firstMs ?? 0,
            terminal: unattributed.terminal,
            browser: unattributed.browser,
          }
        : null,
  };
}

/** Total rows a fully expanded strip would draw. */
export function groupCount(g: OperationGroups): number {
  return g.runs.length + (g.unattributed ? 1 : 0);
}
