// Coverage audit row 18: usePlugins had no test file. Exercises the plugin
// status poll contract: inactive → no fetch + empty rows; active → fetches
// /api/spec + /api/plugins/status.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePlugins } from "../usePlugins";
import { initTransport } from "../../lib/api";

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("usePlugins", () => {
  it("pauses polling when not active and returns empty rows", () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const { result } = renderHook(() => usePlugins(false));
    expect(result.current.rows).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// A FAILED SPEC READ USED TO LEAVE THE INVENTORY SAYING "Loading inventory…"
// FOR EVER. The catch was `catch { /* transient — retry next tick */ }` and set
// nothing, while the SAME hook's status fetch sets `loadError` — the twin rule
// applied to one branch and not the other, inside one function. There is no tick
// to retry on: the 5 s poll was removed in round 163 (the file says so itself,
// four lines below the comment that promised the retry), and `specLoaded` is the
// only thing that re-arms the fetch. So `specLoaded` stayed false, no error was
// reported, and the page's `!specLoaded` branch rendered a claim of progress
// that had stopped.
describe("usePlugins — a failed inventory read", () => {
  it("reports the failure instead of loading for ever", async () => {
    // This one awaits a rejection landing in state, so it needs REAL timers —
    // the file's fake ones never advance `waitFor`'s polling clock.
    vi.useRealTimers();
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/spec")) {
        // A 200 the panel cannot use — the shape that reached the silent catch.
        return new Response("not json", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(JSON.stringify({ ok: true, playwright: { running: true, port: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // The transport is module state; without it `callApi` never dials and the
    // hook's failure path is unreachable — a test that "proves" nothing.
    initTransport("device.test", "tok", () => {});

    const { result } = renderHook(() => usePlugins(true));
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.length, "the hook must actually dial").toBeGreaterThan(0);
    });
    await vi.waitFor(() => {
      expect(result.current.loadError, "the failure must be REPORTED").not.toBe("");
    });
    expect(result.current.specLoaded, "and the inventory must not claim it loaded").toBe(false);
    expect(result.current.loadError).toMatch(/inventory/i);
  });
});
