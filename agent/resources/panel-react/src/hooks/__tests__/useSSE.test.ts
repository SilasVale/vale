// Coverage audit row 18: useSSE had no test file. The connected path opens
// an SSE stream + reconnect loop (complex to mock deterministically); the
// not-connected guard is the cheap, high-value contract — the panel must
// NOT open a stream (or start a reconnect loop) while disconnected.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSSE } from "../useSSE";

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("useSSE", () => {
  it("returns connecting and opens nothing when the panel is not connected", () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const writeCallbacks = { current: new Map() };
    const getLiveSidsRef = { current: () => [] };
    const { result } = renderHook(() => useSSE(false, writeCallbacks, getLiveSidsRef));
    expect(result.current).toBe("connecting");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
