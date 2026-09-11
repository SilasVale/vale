// Run identity — the grouping rules, pinned against the ways they could lie.
//
// THE WHOLE VALUE OF THIS FEATURE IS THAT IT FABRICATES NOTHING. Every test
// below is written against a specific fabrication:
//
//   1. FOLDING BY ADJACENCY. An event with no `run_id` must NOT be counted into
//      the run that happens to precede it in the stream. That is the failure
//      that looks most complete on screen — the counts would simply be wrong —
//      so it is the first thing pinned.
//   2. INVENTING AN END. An open run's span is [begin, its newest event]. A
//      `[begin, now]` span grows on every render and asserts "still running",
//      which nobody recorded.
//   3. INVENTING A VALUE. Absent label/goal/outcome are ABSENT; `""` and
//      whitespace are the same absence; neither becomes a placeholder.
//   4. HIDING A RUN. An id with no `run/begin` is still shown, under its raw id.
//   5. DISCARDING THE RECORD. Grouping once kept counts and extents and dropped
//      the records themselves, so "3 terminal" was all anyone could ever learn.
//      `operationRows` carries the records — what ran, how it ended, why — and
//      the last block below pins them, including the rule that an EXIT CODE OF
//      ZERO is a value and not a missing one.
import { describe, it, expect } from "vitest";
import {
  groupOperation,
  groupCount,
  operationRows,
  type ActivityRow,
  type OperationEvent,
  type RunBoundary,
} from "../runs";

const ev = (o: Partial<OperationEvent>): OperationEvent => ({
  source: "terminal",
  ts_ms: 1000,
  kind: "command/start",
  ...o,
});

const begin = (run_id: string, ts_ms: number, extra: Partial<RunBoundary> = {}): RunBoundary => ({
  kind: "run/begin",
  run_id,
  ts_ms,
  ...extra,
});

const end = (run_id: string, ts_ms: number, extra: Partial<RunBoundary> = {}): RunBoundary => ({
  kind: "run/end",
  run_id,
  ts_ms,
  ...extra,
});

/** A fixed instant, far enough in the past that any test comparing against the
 *  wall clock fails loudly rather than by a millisecond. */
const T0 = 1_700_000_000_000;

describe("groupOperation — grouping", () => {
  it("makes ONE row per run and counts the events carrying its id", () => {
    const g = groupOperation(
      [
        ev({ ts_ms: T0 + 10, run_id: "r-a" }),
        ev({ ts_ms: T0 + 20, run_id: "r-a", kind: "command/end", exit_code: 0 }),
        ev({ ts_ms: T0 + 30, run_id: "r-b" }),
        ev({ ts_ms: T0 + 40, run_id: "r-b", source: "browser", kind: "action", script: "click" }),
      ],
      [begin("r-a", T0), end("r-a", T0 + 25), begin("r-b", T0 + 28), end("r-b", T0 + 50)],
    );
    expect(g.runs.map((r) => r.runId)).toEqual(["r-a", "r-b"]);
    expect(g.runs[0]).toMatchObject({ terminal: 2, browser: 0 });
    expect(g.runs[1]).toMatchObject({ terminal: 1, browser: 1 });
  });

  it("sorts runs by START time, whatever order the device listed them in", () => {
    const g = groupOperation([], [
      begin("r-late", T0 + 500),
      begin("r-early", T0 + 100),
      begin("r-mid", T0 + 300),
    ]);
    expect(g.runs.map((r) => r.runId)).toEqual(["r-early", "r-mid", "r-late"]);
    expect(g.runs.map((r) => r.startMs)).toEqual([T0 + 100, T0 + 300, T0 + 500]);
  });

  it("registers a run whose begin arrives AFTER its events", () => {
    // The hook accumulates across polls, so arrival order is not time order.
    const g = groupOperation(
      [ev({ ts_ms: T0 + 10, run_id: "r-a" })],
      [begin("r-a", T0 + 5), end("r-a", T0 + 20)],
    );
    expect(g.runs).toHaveLength(1);
    expect(g.runs[0]).toMatchObject({ state: "closed", startMs: T0 + 5, terminal: 1 });
  });

  it("ignores records with no usable stamp or id rather than placing them by guess", () => {
    const g = groupOperation(
      [
        ev({ ts_ms: undefined, run_id: "r-a" }),
        ev({ ts_ms: Number.NaN, run_id: "r-a" }),
        ev({ ts_ms: T0, run_id: "r-a" }),
      ],
      [begin("r-a", T0), { kind: "run/begin", run_id: undefined, ts_ms: T0 }, { kind: "run/end", run_id: "r-a", ts_ms: undefined }],
    );
    expect(g.runs).toHaveLength(1);
    expect(g.runs[0]).toMatchObject({ state: "open", terminal: 1 });
  });
});

describe("groupOperation — the three states", () => {
  it("CLOSED: a run/end exists, and the outcome rides with it when given", () => {
    const g = groupOperation(
      [ev({ ts_ms: T0 + 10, run_id: "r-a" })],
      [begin("r-a", T0, { label: "provision the ONU", goal: "get it online" }), end("r-a", T0 + 60_000, { outcome: "done" })],
    );
    expect(g.runs[0]).toMatchObject({
      state: "closed",
      label: "provision the ONU",
      goal: "get it online",
      outcome: "done",
      startMs: T0,
      endMs: T0 + 60_000,
    });
  });

  it("CLOSED without an outcome carries NOTHING — not '', not a placeholder", () => {
    const g = groupOperation([], [begin("r-a", T0), end("r-a", T0 + 5)]);
    expect(g.runs[0].state).toBe("closed");
    expect(g.runs[0].outcome).toBeNull();
    // The device's own blank-collapse, from the other side: a client that
    // "said nothing" must not render as a client that said something empty.
    const blank = groupOperation([], [begin("r-a", T0), end("r-a", T0 + 5, { outcome: "   " })]);
    expect(blank.runs[0].outcome).toBeNull();
  });

  it("CLOSED takes priority when an end has no begin (the device's log is capped)", () => {
    // The runs log keeps the newest N boundaries, so an old run's `run/begin`
    // can be trimmed out from under its recent `run/end`. A recorded end is
    // still a recorded end.
    const g = groupOperation([ev({ ts_ms: T0 + 30, run_id: "r-old" })], [end("r-old", T0 + 40, { outcome: "done" })]);
    expect(g.runs[0]).toMatchObject({ state: "closed", outcome: "done", startMs: T0 + 30, endMs: T0 + 40 });
  });

  it("OPEN: a begin with no end — the COMMON case, not an error", () => {
    const g = groupOperation(
      [ev({ ts_ms: T0 + 10, run_id: "r-a" }), ev({ ts_ms: T0 + 4_000, run_id: "r-a", kind: "command/end" })],
      [begin("r-a", T0)],
    );
    expect(g.runs[0].state).toBe("open");
    expect(g.runs[0].outcome).toBeNull();
  });

  it("OPEN derives its extent from its NEWEST EVENT, never from the clock", () => {
    // A `[begin, now]` span ticks up on every render and claims "still running"
    // — knowledge nobody has: the client may have stopped, or the agent may
    // have restarted. The end must be the newest activity carrying the id.
    const newest = T0 + 12_345;
    const g = groupOperation(
      [ev({ ts_ms: T0 + 10, run_id: "r-a" }), ev({ ts_ms: newest, run_id: "r-a" })],
      [begin("r-a", T0)],
    );
    expect(g.runs[0].endMs).toBe(newest);
    expect(g.runs[0].endMs).toBeLessThan(Date.now() - 24 * 60 * 60 * 1000);
  });

  it("OPEN with NO events yet spans only its begin — a zero extent, not a live one", () => {
    const g = groupOperation([], [begin("r-a", T0)]);
    expect(g.runs[0]).toMatchObject({ state: "open", startMs: T0, endMs: T0 });
  });

  it("UNREGISTERED: events carrying an id whose begin was never recorded", () => {
    const g = groupOperation(
      [ev({ ts_ms: T0, run_id: "run-1700000000000-a1b2c3" }), ev({ ts_ms: T0 + 900, run_id: "run-1700000000000-a1b2c3" })],
      [],
    );
    expect(g.runs).toHaveLength(1);
    expect(g.runs[0]).toMatchObject({
      // The raw id is the ONLY name it has — nothing else may be printed there.
      runId: "run-1700000000000-a1b2c3",
      state: "unregistered",
      label: null,
      goal: null,
      outcome: null,
      startMs: T0,
      endMs: T0 + 900,
      terminal: 2,
    });
  });

  it("a run that is both registered and unregistered in the data is NOT split", () => {
    // Same id in both arrays: one row. Rendering two rows for one id would
    // double every count on screen.
    const g = groupOperation([ev({ ts_ms: T0 + 1, run_id: "r-a" })], [begin("r-a", T0)]);
    expect(g.runs).toHaveLength(1);
    expect(g.runs[0].state).toBe("open");
  });
});

describe("groupOperation — the unattributed bucket", () => {
  it("keeps events with no run_id in their OWN group, never folded into the run before them", () => {
    // THE central guarantee. The unattributed event sits directly after r-a's
    // events in the stream; folding by adjacency would report r-a as having run
    // three commands when it ran two.
    const g = groupOperation(
      [
        ev({ ts_ms: T0 + 10, run_id: "r-a" }),
        ev({ ts_ms: T0 + 20, run_id: "r-a" }),
        ev({ ts_ms: T0 + 30, run_id: null }),
        ev({ ts_ms: T0 + 40, run_id: null, source: "browser", kind: "action" }),
      ],
      [begin("r-a", T0), end("r-a", T0 + 25)],
    );
    expect(g.runs).toHaveLength(1);
    expect(g.runs[0]).toMatchObject({ runId: "r-a", terminal: 2, browser: 0 });
    expect(g.unattributed).toMatchObject({
      runId: null,
      state: "unattributed",
      terminal: 1,
      browser: 1,
      startMs: T0 + 30,
      endMs: T0 + 40,
    });
  });

  it("treats a MISSING run_id and a blank one identically — both are unattributed", () => {
    const g = groupOperation(
      [ev({ ts_ms: T0 }), ev({ ts_ms: T0 + 1, run_id: "" }), ev({ ts_ms: T0 + 2, run_id: "   " })],
      [],
    );
    expect(g.runs).toEqual([]);
    expect(g.unattributed?.terminal).toBe(3);
  });

  it("does not invent an id for the bucket", () => {
    // "unknown" would render as an id the operator could ask the device about,
    // and there is none.
    const g = groupOperation([ev({ ts_ms: T0 })], []);
    expect(g.unattributed!.runId).toBeNull();
    expect(g.unattributed!.label).toBeNull();
  });

  it("is null — and therefore not rendered — when every event carries a run", () => {
    const g = groupOperation([ev({ ts_ms: T0, run_id: "r-a" })], [begin("r-a", T0)]);
    expect(g.unattributed).toBeNull();
  });

  it("survives a timeline with no runs at all", () => {
    const g = groupOperation([ev({ ts_ms: T0 })], []);
    expect(g.runs).toEqual([]);
    expect(groupCount(g)).toBe(1);
  });
});

describe("groupOperation — absent values", () => {
  it("reads absent label/goal/outcome as null, and blank as absent too", () => {
    // The device collapses blank to ABSENT (`label` is a missing key, not "").
    // A reader that rendered the key's absence as "" would put an empty label
    // where a name belongs, and one that rendered "   " would put a blank there.
    const g = groupOperation([], [
      begin("r-none", T0),
      { kind: "run/begin", run_id: "r-blank", ts_ms: T0 + 1, label: "", goal: "  " },
    ]);
    for (const r of g.runs) {
      expect(r.label, `${r.runId} label`).toBeNull();
      expect(r.goal, `${r.runId} goal`).toBeNull();
    }
  });

  it("keeps the label when the client DID supply one, and nothing else", () => {
    const g = groupOperation([], [begin("r-a", T0, { label: "provision the ONU" })]);
    expect(g.runs[0].label).toBe("provision the ONU");
    expect(g.runs[0].goal).toBeNull();
    expect(g.runs[0].outcome).toBeNull();
  });
});

describe("groupCount", () => {
  it("counts the unattributed bucket as a row, so the strip never renders a 0-row list", () => {
    expect(groupCount(groupOperation([ev({ ts_ms: T0 })], []))).toBe(1);
    expect(groupCount(groupOperation([], []))).toBe(0);
    expect(groupCount(groupOperation([ev({ ts_ms: T0, run_id: "r-a" })], [begin("r-a", T0)]))).toBe(1);
  });
});

/** The flattened rows, for the tests that only care about them. */
function rowsOf(events: OperationEvent[], boundaries: RunBoundary[] = []): ActivityRow[] {
  return operationRows(events, boundaries).flatMap((g) => g.rows);
}

describe("operationRows — the records are carried, not just counted", () => {
  it("extracts WHAT ran with the fields the panel used to discard", () => {
    // THE POINT OF THIS MODULE'S NEW HALF. Every field below was fetched by the
    // hook and then dropped on the floor: the operator could see "2 terminal"
    // and never the command.
    const rows = rowsOf(
      [
        ev({
          ts_ms: T0 + 10,
          run_id: "r-a",
          command: "display version",
          intent: "check the firmware before the upgrade",
          considered: ["reboot the ONU", "read the log first"],
          plan_step: 2,
        }),
        ev({ ts_ms: T0 + 20, run_id: "r-a", kind: "command/end", exit_code: 0, duration_ms: 1_250 }),
        {
          source: "browser",
          ts_ms: T0 + 30,
          kind: "action",
          run_id: "r-a",
          script: "await page.click('#login')",
          exit_code: 1,
          duration_ms: 40,
          screenshots: ["/pwout/run-1-before.png"],
          timed_out: true,
        },
      ],
      [begin("r-a", T0)],
    );
    expect(rows.map((r) => r.source)).toEqual(["terminal", "terminal", "browser"]);
    expect(rows[0]).toMatchObject({
      tsMs: T0 + 10,
      kind: "command/start",
      command: "display version",
      intent: "check the firmware before the upgrade",
      considered: ["reboot the ONU", "read the log first"],
      planStep: 2,
      exitCode: null,
      runId: "r-a",
    });
    expect(rows[1]).toMatchObject({ kind: "command/end", command: null, exitCode: 0, durationMs: 1_250 });
    expect(rows[2]).toMatchObject({
      source: "browser",
      kind: "action",
      script: "await page.click('#login')",
      exitCode: 1,
      durationMs: 40,
      screenshots: ["/pwout/run-1-before.png"],
      timedOut: true,
      // The browser feed has no session ownership — an action is never
      // attributed to a terminal that did not run it.
      session: null,
    });
  });

  it("keeps the exit code ZERO apart from an exit code nobody recorded", () => {
    // `0` is the single most common REAL outcome. A reader that treats it as
    // falsy (or a type that says `number | null` and is checked with `if (x)`)
    // makes "it succeeded" and "nobody wrote down how it ended" identical —
    // which is the one distinction this whole panel refuses to blur.
    const [ok, absent] = rowsOf([
      ev({ ts_ms: T0, kind: "command/end", exit_code: 0 }),
      ev({ ts_ms: T0 + 1, kind: "command/end" }),
    ]);
    expect(ok.exitCode).toBe(0);
    expect(absent.exitCode).toBeNull();
    expect(ok.exitCode).not.toBe(absent.exitCode);
    // Same rule for a duration: a measured 0 ms is not a missing measurement.
    expect(rowsOf([ev({ ts_ms: T0, duration_ms: 0 })])[0].durationMs).toBe(0);
  });

  it("reads absent values as ABSENCE — never '' and never a stand-in word", () => {
    const [row] = rowsOf([
      ev({ ts_ms: T0, command: "ls", intent: "   ", considered: [], screenshots: [] }),
    ]);
    expect(row.command).toBe("ls");
    // Blank is the same absence wearing a costume: the device collapses it, and
    // a reader that rendered "   " would put a blank where a reason goes.
    expect(row.intent).toBeNull();
    expect(row.considered).toEqual([]);
    expect(row.screenshots).toEqual([]);
    expect(row.status).toBeNull();
    expect(row.text).toBeNull();
    expect(row.script).toBeNull();
  });

  it("orders rows by ts_ms ALONE, whatever order they arrived in", () => {
    // Both feeds are merged onto one axis and the hook accumulates them across
    // polls, so arrival order is not time order. The device's two feeds stamp
    // `ts` in different UNITS (seconds vs milliseconds); nothing here reads it,
    // and this pins the axis that is actually used.
    const rows = rowsOf([
      ev({ ts_ms: T0 + 5_000, command: "third" }),
      ev({ ts_ms: T0 + 1_000, command: "first" }),
      ev({ ts_ms: T0 + 3_000, command: "second" }),
    ]);
    expect(rows.map((r) => r.command)).toEqual(["first", "second", "third"]);
    expect(rows.map((r) => r.tsMs)).toEqual([T0 + 1_000, T0 + 3_000, T0 + 5_000]);
  });

  it("puts unattributed records in the bucket, never in a neighbouring run's rows", () => {
    // The same central guarantee as the counts, one level down: a row is only
    // ever in the group whose id it carries.
    const grouped = operationRows(
      [
        ev({ ts_ms: T0 + 10, run_id: "r-a", command: "in the run" }),
        ev({ ts_ms: T0 + 20, command: "nobody's" }),
        ev({ ts_ms: T0 + 30, source: "browser", kind: "action", script: "click" }),
      ],
      [begin("r-a", T0), end("r-a", T0 + 40)],
    );
    const run = grouped.find((g) => g.group.runId === "r-a")!;
    expect(run.rows.map((r) => r.command)).toEqual(["in the run"]);
    const bucket = grouped.find((g) => g.group.state === "unattributed")!;
    expect(bucket.rows.map((r) => r.command ?? r.script)).toEqual(["nobody's", "click"]);
    // ...and the rows never appear twice.
    expect(grouped.flatMap((g) => g.rows)).toHaveLength(3);
  });

  it("returns the groups in render order: oldest run first, the bucket LAST", () => {
    const grouped = operationRows(
      [ev({ ts_ms: T0 + 10, run_id: "r-late" }), ev({ ts_ms: T0 + 1, command: "loose" })],
      [begin("r-late", T0 + 5), begin("r-early", T0)],
    );
    expect(grouped.map((g) => g.group.runId)).toEqual(["r-early", "r-late", null]);
    // A run with a begin but no records is still a group — with no rows.
    expect(grouped[0].rows).toEqual([]);
  });

  it("gives every row a unique id, so a list keyed on it cannot silently drop one", () => {
    // Two records can be genuinely identical (the browser feed has no sequence
    // and a client may run the same script twice inside one millisecond), and a
    // duplicate React key throws one of them away without a word.
    const grouped = operationRows(
      [
        ev({ ts_ms: T0, source: "browser", kind: "action", script: "click" }),
        ev({ ts_ms: T0, source: "browser", kind: "action", script: "click" }),
      ],
      [],
    );
    const ids = grouped.flatMap((g) => g.rows.map((r) => r.id));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps a row's identity stable across identical recomputation", () => {
    // The hook re-derives on every poll; an id that changed each time would
    // re-mount every row (and lose the reader's scroll position) for no new
    // fact. Same input ⇒ same ids.
    const events = [ev({ ts_ms: T0 + 10, run_id: "r-a", seq: 7, command: "ls" })];
    const first = rowsOf(events, [begin("r-a", T0)]).map((r) => r.id);
    const second = rowsOf(events, [begin("r-a", T0)]).map((r) => r.id);
    expect(second).toEqual(first);
  });

  it("drops a record with no usable stamp rather than placing it by guess", () => {
    // Unchanged from the grouping rule, and stated here because the rows obey
    // it too: the device itself drops an unstamped record, and a guessed
    // position on the axis would be worse than a missing row.
    const rows = rowsOf([
      ev({ ts_ms: undefined, command: "unstamped" }),
      ev({ ts_ms: Number.NaN, command: "nan" }),
      ev({ ts_ms: T0, command: "placed" }),
    ]);
    expect(rows.map((r) => r.command)).toEqual(["placed"]);
  });
});

describe("groupOperation — rows ride with their group", () => {
  it("gives each group its own rows and leaves the others alone", () => {
    const g = groupOperation(
      [
        ev({ ts_ms: T0 + 10, run_id: "r-a", command: "a1" }),
        ev({ ts_ms: T0 + 20, run_id: "r-b", command: "b1" }),
        ev({ ts_ms: T0 + 30, command: "loose" }),
      ],
      [begin("r-a", T0), begin("r-b", T0 + 15)],
    );
    expect(g.runs[0].rows.map((r) => r.command)).toEqual(["a1"]);
    expect(g.runs[1].rows.map((r) => r.command)).toEqual(["b1"]);
    expect(g.unattributed!.rows.map((r) => r.command)).toEqual(["loose"]);
    // The rows a group carries are the ones its counts counted.
    for (const group of [...g.runs, g.unattributed!]) {
      expect(group.rows.length).toBe(group.terminal + group.browser);
    }
  });
});
