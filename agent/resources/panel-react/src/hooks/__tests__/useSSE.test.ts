// Coverage audit row 18: useSSE had no test file. The connected path opens
// an SSE stream + reconnect loop (complex to mock deterministically); the
// not-connected guard is the cheap, high-value contract — the panel must
// NOT open a stream (or start a reconnect loop) while disconnected.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSSE } from "../useSSE";
import { initTransport } from "../../lib/api";

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

  it("builds the stream URL + Bearer from the transport singleton (P2-1b)", async () => {
    vi.useRealTimers();
    initTransport("dev1.example.com", "tok-1", () => {});
    const fetchMock = vi.fn(async () => new Response("x", { status: 401 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const writeCallbacks = { current: new Map() };
    const getLiveSidsRef = { current: () => [] };
    const { unmount } = renderHook(() => useSSE(true, writeCallbacks, getLiveSidsRef));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 3000 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers?: Record<string, string> }];
    expect(String(url)).toContain("dev1.example.com/api/events/term");
    expect(init?.headers?.authorization).toBe("Bearer tok-1");
    unmount();
  });
});
