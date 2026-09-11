// RunStrip — what the operator actually sees, pinned against the lies the
// grouping rules exist to prevent (see lib/__tests__/runs.test.ts for the same
// rules at the data layer; these are the RENDER-level halves, which is where a
// correct model can still be printed wrongly).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { RunStrip } from "../RunStrip";
import { PathView } from "../PathView";
import { callApi } from "../../lib/api";
import type { OperationEvent, RunBoundary } from "../../lib/runs";
import type { CommandEvent } from "../../hooks/useCommandEvents";

vi.mock("../../lib/api", () => ({
  callApi: vi.fn(),
  callTool: vi.fn(() => Promise.resolve({})),
}));

const mockCallApi = callApi as unknown as ReturnType<typeof vi.fn>;

const T0 = 1_700_000_000_000;

const ev = (o: Partial<OperationEvent>): OperationEvent => ({
  source: "terminal",
  ts_ms: T0,
  kind: "command/start",
  ...o,
});
const begin = (run_id: string, ts_ms: number, extra: Partial<RunBoundary> = {}): RunBoundary => ({
  kind: "run/begin", run_id, ts_ms, ...extra,
});
const end = (run_id: string, ts_ms: number, extra: Partial<RunBoundary> = {}): RunBoundary => ({
  kind: "run/end", run_id, ts_ms, ...extra,
});

/** Answer every /api/operation poll with the same payload. */
function device(events: OperationEvent[], runs: RunBoundary[]) {
  mockCallApi.mockResolvedValue({
    events,
    runs,
    since_ms: 0,
    cursor_ms: events.reduce((m, e) => Math.max(m, e.ts_ms ?? 0), 0),
  });
}

async function mount(ui: React.ReactElement) {
  const r = render(ui);
  return r;
}

beforeEach(() => {
  mockCallApi.mockReset();
});

describe("RunStrip — one row per run", () => {
  it("renders the label, the goal, the state and the per-feed counts", async () => {
    device(
      [
        ev({ ts_ms: T0 + 10, run_id: "r-a" }),
        ev({ ts_ms: T0 + 20, run_id: "r-a" }),
        ev({ ts_ms: T0 + 30, run_id: "r-a", source: "browser", kind: "action" }),
      ],
      [
        begin("r-a", T0, { label: "provision the ONU", goal: "get it online" }),
        end("r-a", T0 + 60_000, { outcome: "done" }),
      ],
    );
    const { container } = await mount(<RunStrip pollMs={60_000} />);
    await waitFor(() => expect(container.querySelectorAll(".run-row")).toHaveLength(1));
    const row = container.querySelector(".run-row")!;
    expect(row.getAttribute("data-state")).toBe("closed");
    expect(row.querySelector(".run-row-label")!.textContent).toBe("provision the ONU");
    expect(row.querySelector(".run-row-goal")!.textContent).toContain("get it online");
    expect(row.querySelector(".run-row-state")!.textContent).toBe("closed");
    expect([...row.querySelectorAll(".run-row-count")].map((c) => c.textContent)).toEqual([
      "2 terminal",
      "1 browser",
    ]);
    // The span is the run's OWN extent, not a live one.
    expect(row.querySelector(".run-row-span")!.getAttribute("data-start-ms")).toBe(String(T0));
    expect(row.querySelector(".run-row-span")!.getAttribute("data-end-ms")).toBe(String(T0 + 60_000));
  });

  it("shows the outcome a closed run recorded", async () => {
    device([], [begin("r-a", T0), end("r-a", T0 + 5_000, { outcome: "done" })]);
    const { container } = await mount(<RunStrip pollMs={60_000} />);
    await waitFor(() => expect(container.querySelector(".run-row-outcome")).not.toBeNull());
    expect(container.querySelector(".run-row-outcome")!.textContent).toContain("done");
    // ...and no honesty note is added to a run that HAS an ending.
    expect(container.querySelector(".run-row-note")).toBeNull();
  });

  it("draws NOTHING where an absent outcome would go", async () => {
    // A "—" in that slot reads as a value, and "failed" would be the panel
    // asserting an ending the client never stated. The only honest render of an
    // absent outcome is no element at all.
    device([ev({ ts_ms: T0 + 1, run_id: "r-a" })], [begin("r-a", T0), end("r-a", T0 + 9_000)]);
    const { container } = await mount(<RunStrip pollMs={60_000} />);
    await waitFor(() => expect(container.querySelectorAll(".run-row")).toHaveLength(1));
    const row = container.querySelector(".run-row")!;
    expect(row.querySelector(".run-row-outcome")).toBeNull();
    expect(row.textContent).not.toContain("—");
    expect(row.textContent).not.toMatch(/failed|success|ok\b/i);
    // The state chip is the state's NAME, not a verdict about how it went.
    expect(row.querySelector(".run-row-state")!.textContent).toBe("closed");
  });

  it("renders an OPEN run as open, with the honesty line and a non-ticking span", async () => {
    const newest = T0 + 12_345;
    device(
      [ev({ ts_ms: T0 + 10, run_id: "r-a" }), ev({ ts_ms: newest, run_id: "r-a" })],
      [begin("r-a", T0, { label: "still going" })],
    );
    const { container } = await mount(<RunStrip pollMs={60_000} />);
    await waitFor(() => expect(container.querySelectorAll(".run-row")).toHaveLength(1));
    const row = container.querySelector(".run-row")!;
    expect(row.getAttribute("data-state")).toBe("open");
    expect(row.querySelector(".run-row-state")!.textContent).toBe("open");
    expect(row.querySelector(".run-row-note")!.textContent).toBe("no end recorded");
    // The extent is the newest event — NOT the wall clock. A [begin, now] span
    // would grow on every render and imply "still running".
    const endMs = Number(row.querySelector(".run-row-span")!.getAttribute("data-end-ms"));
    expect(endMs).toBe(newest);
    expect(endMs).toBeLessThan(Date.now() - 24 * 60 * 60 * 1000);
  });

  it("renders an UNREGISTERED run under its raw id", async () => {
    const raw = "run-1700000000000-a1b2c3";
    device([ev({ ts_ms: T0, run_id: raw })], []);
    const { container } = await mount(<RunStrip pollMs={60_000} />);
    await waitFor(() => expect(container.querySelectorAll(".run-row")).toHaveLength(1));
    const row = container.querySelector(".run-row")!;
    expect(row.getAttribute("data-state")).toBe("unregistered");
    expect(row.querySelector(".run-row-state")!.textContent).toBe("unregistered");
    // The id IS the name here — not the "unlabeled" marker, which would hide
    // the one fact that is known about it.
    expect(row.querySelector(".run-row-id")!.textContent).toBe(raw);
    expect(row.querySelector(".run-row-unlabeled")).toBeNull();
    expect(row.querySelector(".run-row-note")!.textContent).toBe("no begin recorded");
  });

  it("marks an unlabeled run EXPLICITLY instead of leaving its name blank", async () => {
    device([], [begin("r-a", T0), end("r-a", T0 + 1_000)]);
    const { container } = await mount(<RunStrip pollMs={60_000} />);
    await waitFor(() => expect(container.querySelectorAll(".run-row")).toHaveLength(1));
    const row = container.querySelector(".run-row")!;
    expect(row.querySelector(".run-row-unlabeled")!.textContent).toBe("unlabeled");
    expect(row.querySelector(".run-row-label")).toBeNull();
  });
});

describe("RunStrip — the unattributed bucket", () => {
  it("is a row of its OWN, after the runs, never folded into the one above it", async () => {
    device(
      [
        ev({ ts_ms: T0 + 10, run_id: "r-a" }),
        ev({ ts_ms: T0 + 20, run_id: "r-a" }),
        ev({ ts_ms: T0 + 30, run_id: null }),
        ev({ ts_ms: T0 + 40, run_id: null, source: "browser", kind: "action" }),
      ],
      [begin("r-a", T0), end("r-a", T0 + 25)],
    );
    const { container } = await mount(<RunStrip pollMs={60_000} />);
    await waitFor(() => expect(container.querySelectorAll(".run-row")).toHaveLength(2));
    const rows = [...container.querySelectorAll(".run-row")];
    // The run's OWN counts are untouched by the events that follow it.
    expect([...rows[0].querySelectorAll(".run-row-count")].map((c) => c.textContent)).toEqual([
      "2 terminal",
      "0 browser",
    ]);
    expect(rows[1].getAttribute("data-state")).toBe("unattributed");
    expect(rows[1].querySelector(".run-row-state")!.textContent).toBe("unattributed");
    expect(rows[1].querySelector(".run-row-unlabeled")!.textContent).toBe("no run id");
    expect([...rows[1].querySelectorAll(".run-row-count")].map((c) => c.textContent)).toEqual([
      "1 terminal",
      "1 browser",
    ]);
    // Explicitly its own group, not merely the last run in the list.
    expect(rows[1].className).toContain("run-row-unattributed");
  });

  it("renders alone when the device recorded no runs at all", async () => {
    device([ev({ ts_ms: T0, run_id: null })], []);
    const { container } = await mount(<RunStrip pollMs={60_000} />);
    await waitFor(() => expect(container.querySelectorAll(".run-row")).toHaveLength(1));
    expect(container.querySelector(".run-row")!.getAttribute("data-state")).toBe("unattributed");
  });
});

describe("RunStrip — section behaviour", () => {
  it("collapses and re-expands, keeping the header visible", async () => {
    device([ev({ ts_ms: T0, run_id: "r-a" })], [begin("r-a", T0)]);
    const { container } = await mount(<RunStrip pollMs={60_000} />);
    await waitFor(() => expect(container.querySelectorAll(".run-row")).toHaveLength(1));
    const head = container.querySelector(".run-strip-head")!;
    expect(head.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(head);
    expect(container.querySelectorAll(".run-row")).toHaveLength(0);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    // The header still names what is hidden — a collapsed strip must not become
    // a mystery.
    expect(head.textContent).toContain("Runs");
    fireEvent.click(head);
    expect(container.querySelectorAll(".run-row")).toHaveLength(1);
  });

  it("summarises open runs without expanding anything", async () => {
    device(
      [ev({ ts_ms: T0, run_id: "r-a" }), ev({ ts_ms: T0, run_id: "r-b" })],
      [begin("r-a", T0), begin("r-b", T0 + 1)],
    );
    const { container } = await mount(<RunStrip pollMs={60_000} />);
    await waitFor(() => expect(container.querySelector(".run-strip-open")).not.toBeNull());
    expect(container.querySelector(".run-strip-open")!.textContent).toBe("2 open");
    expect(container.querySelector(".run-strip-count")!.textContent).toBe("2");
  });

  it("renders NOTHING when the device has no run activity", async () => {
    // An empty "Runs (0)" container reads as a feature that failed to load.
    device([], []);
    const { container } = await mount(<RunStrip pollMs={60_000} />);
    await waitFor(() => expect(mockCallApi).toHaveBeenCalled());
    expect(container.querySelector(".run-strip")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders nothing after a FAILED fetch — no broken container", async () => {
    mockCallApi.mockRejectedValue(new Error("HTTP 502"));
    const { container } = await mount(<RunStrip pollMs={60_000} />);
    await waitFor(() => expect(mockCallApi).toHaveBeenCalled());
    expect(container.querySelector(".run-strip")).toBeNull();
  });
});

describe("PathView integration", () => {
  const cmdEvents: CommandEvent[] = [
    { seq: 1, ts: 100, kind: "command/start", command: "display version" },
    { seq: 2, ts: 101, kind: "command/end", exit_code: 0, duration_ms: 10 },
  ];

  it("puts the run strip at the very top of the path view", async () => {
    device([ev({ ts_ms: T0, run_id: "r-a" })], [begin("r-a", T0, { label: "the run" })]);
    const { container } = await mount(<PathView events={cmdEvents} />);
    await waitFor(() => expect(container.querySelector(".run-strip")).not.toBeNull());
    const view = container.querySelector(".path-view")!;
    // FIRST child, so "what ran" is read before "what this session did with it".
    expect(view.firstElementChild!.className).toContain("run-strip");
    expect(screen.getByText("the run")).toBeTruthy();
  });

  it("still shows the device's runs when this session has no path yet", async () => {
    // Runs are device-level: "this session ran nothing" and "this device ran
    // something" are both true, and the second is what the operator came back
    // for.
    device([], [begin("r-a", T0, { label: "another session's run" }), end("r-a", T0 + 10)]);
    const { container } = await mount(<PathView events={[]} />);
    await waitFor(() => expect(container.querySelector(".run-strip")).not.toBeNull());
    expect(screen.getByText("another session's run")).toBeTruthy();
    expect(screen.getByText("No path yet")).toBeTruthy();
  });
});
