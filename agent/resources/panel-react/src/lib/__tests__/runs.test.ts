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
import { describe, it, expect } from "vitest";
import { groupOperation, groupCount, type OperationEvent, type RunBoundary } from "../runs";

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
