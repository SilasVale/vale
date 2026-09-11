// useOperationRuns — the poll, and the three properties the strip depends on:
// it asks only for what it has not seen, it never double-counts the record that
// sits ON the cursor, and a failed poll never blanks what the operator is
// reading.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useOperationRuns } from "../useOperationRuns";
import { callApi } from "../../lib/api";
import type { OperationEvent } from "../../lib/runs";

vi.mock("../../lib/api", () => ({
  callApi: vi.fn(),
}));

const mockCallApi = callApi as unknown as ReturnType<typeof vi.fn>;

const T0 = 1_700_000_000_000;
const ev = (ts_ms: number, command: string): OperationEvent => ({
  source: "terminal", ts_ms, kind: "command/start", command,
});

/** The `since_ms` a given call asked for. */
function sinceOf(call: unknown[]): number {
  const path = String(call[0]);
  const m = path.match(/since_ms=(\d+)/);
  return m ? Number(m[1]) : Number.NaN;
}

beforeEach(() => {
  mockCallApi.mockReset();
});

describe("useOperationRuns", () => {
  it("polls /api/operation with a since cursor and a bounded limit", async () => {
    mockCallApi.mockResolvedValue({ events: [ev(T0, "ls")], runs: [], cursor_ms: T0 });
    const { result } = renderHook(() => useOperationRuns(60_000));
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(String(mockCallApi.mock.calls[0][0])).toMatch(
      /^\/api\/operation\?since_ms=0&limit=\d+$/,
    );
  });

  it("asks only for what it has not seen, and does NOT double-count the record on the cursor", async () => {
    // `since_ms` filters `ts_ms < since_ms`, so the record stamped exactly AT
    // the cursor is sent again by the device. Counting it twice would inflate
    // every number on the strip by one per poll.
    const boundary = ev(T0 + 1_000, "second");
    mockCallApi
      .mockResolvedValueOnce({ events: [ev(T0, "first"), boundary], runs: [], cursor_ms: T0 + 1_000 })
      .mockResolvedValue({ events: [boundary, ev(T0 + 2_000, "third")], runs: [], cursor_ms: T0 + 2_000 });
    const { result } = renderHook(() => useOperationRuns(25));
    await waitFor(() => expect(result.current.events).toHaveLength(3), { timeout: 3000 });
    expect(result.current.events.map((e) => e.command)).toEqual(["first", "second", "third"]);
    // The second request picked up where the first reply ended.
    await waitFor(() => expect(mockCallApi.mock.calls.length).toBeGreaterThan(1));
    expect(sinceOf(mockCallApi.mock.calls[1])).toBe(T0 + 1_000);
  });

  it("accumulates run boundaries across polls instead of replacing them", async () => {
    // A begin and its end usually arrive in DIFFERENT replies. Replacing the
    // boundary list each poll would leave every run looking open forever.
    mockCallApi
      .mockResolvedValueOnce({
        events: [], runs: [{ kind: "run/begin", run_id: "r-a", ts_ms: T0, label: "the run" }], cursor_ms: T0,
      })
      .mockResolvedValue({
        events: [],
        runs: [
          { kind: "run/begin", run_id: "r-a", ts_ms: T0, label: "the run" },
          { kind: "run/end", run_id: "r-a", ts_ms: T0 + 5_000, outcome: "done" },
        ],
        cursor_ms: T0 + 5_000,
      });
    const { result } = renderHook(() => useOperationRuns(25));
    await waitFor(
      () => expect(result.current.boundaries.some((b) => b.kind === "run/end")).toBe(true),
      { timeout: 3000 },
    );
    // The re-sent begin is held once, not twice.
    expect(result.current.boundaries.filter((b) => b.kind === "run/begin")).toHaveLength(1);
  });

  it("never rewinds its cursor, even if a reply reports an older one", async () => {
    mockCallApi
      .mockResolvedValueOnce({ events: [], runs: [], cursor_ms: T0 + 5_000 })
      .mockResolvedValue({ events: [], runs: [], cursor_ms: 0 });
    renderHook(() => useOperationRuns(25));
    await waitFor(() => expect(mockCallApi.mock.calls.length).toBeGreaterThan(1), { timeout: 3000 });
    expect(sinceOf(mockCallApi.mock.calls[1])).toBe(T0 + 5_000);
  });

  it("keeps the last good snapshot when a poll fails (no blanking)", async () => {
    mockCallApi
      .mockResolvedValueOnce({ events: [ev(T0, "survives")], runs: [], cursor_ms: T0 })
      .mockRejectedValue(new Error("HTTP 502"));
    const { result } = renderHook(() => useOperationRuns(25));
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 120));
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].command).toBe("survives");
  });

  it("does not churn the snapshot when a poll brings nothing new", async () => {
    // The same reply arrives every few seconds against a mostly-static log. A
    // fresh array each time would re-derive every group and re-render the strip
    // (and the Path view around it) for no new fact, so the identity is kept.
    const payload = {
      events: [ev(T0, "one")],
      runs: [{ kind: "run/begin", run_id: "r-a", ts_ms: T0 }],
      cursor_ms: T0,
    };
    mockCallApi.mockResolvedValue(payload);
    const { result } = renderHook(() => useOperationRuns(20));
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    const first = result.current;
    await waitFor(() => expect(mockCallApi.mock.calls.length).toBeGreaterThan(2), { timeout: 3000 });
    expect(result.current).toBe(first);
  });

  it("stops polling once it is unmounted", async () => {
    // An in-flight reply must not reach setState on a dead component, and the
    // interval must not keep asking a device nobody is watching.
    mockCallApi.mockResolvedValue({ events: [], runs: [], cursor_ms: T0 });
    const { unmount } = renderHook(() => useOperationRuns(20));
    await waitFor(() => expect(mockCallApi).toHaveBeenCalled());
    unmount();
    const calls = mockCallApi.mock.calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(mockCallApi.mock.calls.length).toBe(calls);
  });
});
