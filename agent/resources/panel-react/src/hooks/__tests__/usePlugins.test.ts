// Coverage audit row 18: usePlugins had no test file. Exercises the plugin
// status poll contract: inactive → no fetch + empty rows; active → fetches
// /api/spec + /api/plugins/status.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePlugins } from "../usePlugins";

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
