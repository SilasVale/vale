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
// WHAT ELSE THIS MODULE CARRIES. Grouping alone answers "how many" and "how
// long", which is all a one-line strip needs. The device's records themselves —
// what ran, how it ended, why — are extracted here too (`operationRows`, and the
// `rows` on every group) so that no reader has to re-derive them from the raw
// array. Two readers use this: the run strip beside a session (counts and
// extent) and the device-level Activity page (the records). Both read the SAME
// grouping, so they cannot disagree about which run a record belongs to, and the
// extraction rules — drop an unplaceable record, never fold an unattributed one
// — live in one place.
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
 *  `run/end`.
 *
 *  `label`, `goal` and `outcome` ARRIVE AS `null` WHEN THE CLIENT SUPPLIED
 *  NOTHING — the key is PRESENT. This said the opposite ("ABSENT — a missing key,
 *  not `null` and not `""` … so presence is read, never truthiness"), and the
 *  device's own comment is explicit about which is true: "`json!` renders `None`
 *  as `null`, so the JSONL — and `recent`, which passes it straight through —
 *  carries `"label": null` rather than omitting the key … Every consumer must
 *  therefore treat null, missing AND blank alike."
 *
 *  So there are THREE kinds of nothing on this wire, and the discipline is to
 *  collapse all three rather than to test for one of them. `value()` below is
 *  that collapse and is what the code has always used; the sentence above was
 *  the wrong half, and a future reader would have taken it as licence to write a
 *  key-existence check that silently misses every real case. */
export interface RunBoundary {
  kind?: string | null;
  run_id?: string | null;
  ts_ms?: number | null;
  label?: string | null;
  goal?: string | null;
  outcome?: string | null;
}

export type RunState = "closed" | "open" | "unregistered" | "unattributed";

/** Which of the device's two feeds a row came from. Anything that is not the
 *  browser feed is the terminal audit trail — the only two producers there are. */
export type ActivitySource = "terminal" | "browser";

/** ONE record of the timeline, as a row a reader can render.
 *
 *  A row is a READING of a record, never a summary of two of them: every field
 *  is either the value the device sent or `null`, and nothing here is inferred
 *  from a neighbouring record. That is why a `command/end` whose
 *  `command/start` fell outside the window stands as its own row instead of
 *  being attached to the command before it — joining the two is a per-session
 *  derivation that already has exactly one owner (`lib/path.ts`, for the Path
 *  view), and a second copy of it here would be a second answer to "which
 *  command did this end belong to". */
export interface ActivityRow {
  /** Stable identity for list rendering, built from the record's own fields.
   *  Never rendered. */
  id: string;
  source: ActivitySource;
  /** ALWAYS milliseconds — the only axis rows are ordered or displayed on. */
  tsMs: number;
  /** The record's own kind: `command/start`, `command/end`, `goal`, `plan`,
   *  `approval`, `control`, or `action` for the browser feed. */
  kind: string | null;
  /** Terminal rows only; the browser feed has no session ownership. */
  session: string | null;
  seq: number | null;
  /** Terminal: what ran, when the record carries it. */
  command: string | null;
  /** Browser: the script that ran, when the record carries it. */
  script: string | null;
  /** The record's own text payload (a goal, a plan, an approval subject). */
  text: string | null;
  /** The record's own status word (`human` / `ai` on a handoff, the action on
   *  an approval record). */
  status: string | null;
  /** A VALUE, not a flag: `0` is an outcome the device recorded and `null` is
   *  the absence of one. The two are never collapsed — an exit code of zero is
   *  the single most common real outcome there is. */
  exitCode: number | null;
  durationMs: number | null;
  intent: string | null;
  /** Alternatives the client says it passed over. `[]` when it named none —
   *  the reader renders nothing rather than a note about the silence. */
  considered: string[];
  planStep: number | null;
  /** Screenshot names a browser action produced. `[]` when none. */
  screenshots: string[];
  /** The RECORDED timeout flag: true only when the device wrote true. */
  timedOut: boolean;
  /** The run the record declared. `null` means it declared none, and the row
   *  then belongs to the unattributed bucket — never folded into a neighbour. */
  runId: string | null;
}

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
  /** The records themselves, oldest first. `rows.length` is exactly
   *  `terminal + browser`: a record whose `ts_ms` could not be used is counted
   *  NOWHERE and shown nowhere, because it cannot be placed in any group — the
   *  same drop the device performs at the source (see `groupOperation`). */
  rows: ActivityRow[];
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

/** A finite number as a VALUE, or `null` when the field holds nothing.
 *
 *  Deliberately NOT truthiness: `0` is a real exit code and a real duration, and
 *  the single most common successful outcome there is. Collapsing it to absence
 *  would make "it succeeded" indistinguishable from "nobody wrote down how it
 *  ended" — the exact pair this panel must keep apart. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A list of non-blank strings, in the order given. Anything that is not an
 *  array of strings contributes nothing: an empty list means "none named",
 *  which is rendered as nothing at all rather than as a note about the gap. */
function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = value(item);
    if (s != null) out.push(s);
  }
  return out;
}

/** One event as a row. Every field is the device's own value or `null`; nothing
 *  here is inferred from a neighbouring record (see ActivityRow). */
function rowFromEvent(e: OperationEvent, tsMs: number): ActivityRow {
  const source: ActivitySource = e?.source === "browser" ? "browser" : "terminal";
  const kind = value(e?.kind);
  const runId = value(e?.run_id);
  const session = source === "browser" ? null : value(e?.session);
  const seq = source === "browser" ? null : num(e?.seq);
  return {
    id: rowId(source, session, seq, tsMs, kind, e),
    source,
    tsMs,
    kind,
    session,
    seq,
    command: value(e?.command),
    script: value(e?.script),
    text: value(e?.text),
    status: value(e?.status),
    exitCode: num(e?.exit_code),
    durationMs: num(e?.duration_ms),
    intent: value(e?.intent),
    considered: strings(e?.considered),
    planStep: num(e?.plan_step),
    screenshots: strings(e?.screenshots),
    // Exactly what the device wrote: `true` only for a written `true`, so a
    // missing flag never renders as a timeout.
    timedOut: e?.timed_out === true,
    runId,
  };
}

/** A stable identity for one row, so the list does not re-key (and re-mount)
 *  on every poll. Built from the record's own fields; never rendered. */
function rowId(
  source: ActivitySource,
  session: string | null,
  seq: number | null,
  tsMs: number,
  kind: string | null,
  e: OperationEvent,
): string {
  const where = source === "browser" ? "b" : `t:${session ?? ""}:${seq ?? ""}`;
  const what = (value(e?.command) ?? value(e?.script) ?? value(e?.text) ?? "").slice(0, 64);
  return `${where}:${tsMs}:${kind ?? ""}:${what}`;
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
  /** The records themselves, oldest first — this is what a reader needs to see
   *  WHAT ran, and until now it was counted and then discarded. */
  rows: ActivityRow[];
}

function emptyAcc(id: string | null): Acc {
  return {
    id, beginTs: null, endTs: null, label: null, goal: null, outcome: null,
    firstMs: null, lastMs: null, terminal: 0, browser: 0, rows: [],
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

/** Append a row, keeping the group's rows ordered by `ts_ms` alone (never by
 *  `ts`, which the two feeds stamp in different units — see the module header).
 *  A stable sort on a list that arrives nearly sorted, and the tie-break is
 *  arrival order, so two records in the same millisecond do not swap between
 *  polls. */
function pushRow(a: Acc, row: ActivityRow): void {
  a.rows.push(row);
  if (a.rows.length > 1) a.rows.sort((x, y) => x.tsMs - y.tsMs);
}

/** `#2`, `#3`, … for a row whose identity is already taken by another row in the
 *  same group. Two genuinely identical records exist (a client may run the same
 *  script twice inside one millisecond, and the browser feed has no sequence),
 *  and React throws away a list with duplicate keys — so a repeat gets a
 *  positional suffix instead of a collision. */
function disambiguate(seen: Map<string, number>, id: string): string {
  const n = (seen.get(id) ?? 0) + 1;
  seen.set(id, n);
  return n === 1 ? id : `${id}#${n}`;
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
  // Row ids are de-duplicated per group, so the same counter is reset for each.
  const seenIds = new Map<string, Map<string, number>>();
  const seenFor = (a: Acc): Map<string, number> => {
    const key = a.id ?? "\u0000unattributed";
    let m = seenIds.get(key);
    if (!m) {
      m = new Map();
      seenIds.set(key, m);
    }
    return m;
  };

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
    const row = rowFromEvent(e, ts);
    row.id = disambiguate(seenFor(a), row.id);
    pushRow(a, row);
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
      rows: a.rows,
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
            rows: unattributed.rows,
          }
        : null,
  };
}

/**
 * Every row of the timeline, in the same groups `groupOperation` builds.
 *
 * This is `groupOperation(...).runs` plus the unattributed bucket, in the order
 * the groups are rendered — i.e. "grouped by run, oldest group first, the
 * unattributed bucket last and separate". It exists as its own name because that
 * is the shape a reader asks for; the grouping itself has exactly one
 * implementation above, so the rows a reader sees cannot disagree with the
 * counts a strip shows.
 *
 * A record with no usable `ts_ms` appears in NEITHER — not counted, not shown.
 * The device drops such a record before it ever reaches the panel
 * (`operation.rs` orders on the explicit millisecond stamp and refuses to guess
 * the unit), so this is the defensive half of one rule rather than a second
 * one: an unplaceable record has no group to belong to, and inventing one from
 * adjacency is the fabrication this module exists to prevent.
 */
export function operationRows(
  events: OperationEvent[],
  boundaries: RunBoundary[],
): { group: RunGroup; rows: ActivityRow[] }[] {
  const groups = groupOperation(events, boundaries);
  const out = groups.runs.map((group) => ({ group, rows: group.rows }));
  if (groups.unattributed) out.push({ group: groups.unattributed, rows: groups.unattributed.rows });
  return out;
}

/** Total rows a fully expanded strip would draw. */
export function groupCount(g: OperationGroups): number {
  return g.runs.length + (g.unattributed ? 1 : 0);
}

/** The word each state is rendered as, in BOTH views that read a group (the run
 *  strip in the Path view and the device-level Activity page). Deliberately the
 *  state's own name rather than a verdict: "closed" says the boundary was
 *  recorded, not that it went well — that judgement is not this panel's to make
 *  from a boundary record. */
export const RUN_STATE_LABEL: Record<RunState, string> = {
  closed: "closed",
  open: "open",
  unregistered: "unregistered",
  unattributed: "unattributed",
};

/** The one short line of honesty each state needs, or `null` for a state whose
 *  own name already says everything (a closed run needs no note).
 *
 *  `null` means NOTHING IS DRAWN — not a placeholder, and not a statement that
 *  there is nothing to say. */
export function runStateNote(g: RunGroup): string | null {
  switch (g.state) {
    // "Still running" is exactly what these views CANNOT say: the client may
    // have stopped, or the agent may have restarted. The absence is the fact.
    case "open": return "no end recorded";
    case "unregistered": return "no begin recorded";
    // The bucket is the ONE group whose reason is not a missing boundary: it is
    // apart because its records declared no run at all, and the whole point of
    // the rule is that no reader should assume the attribution the data does
    // not carry. Both views render this, so neither can show the bucket without
    // saying why it is one.
    case "unattributed":
      return "these events declared no run — shown apart rather than assumed into one";
    default: return null;
  }
}
