import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAiActivityPulse, PULSE_MS } from "../useAiActivityPulse";

// round-253: the embedded pane's AI-activity pulse must light on an agent
// activity push, then fade. P1-3: the hook no longer opens its own SSE
// stream — it subscribes to the `vale-*` window events re-dispatched by
// useSSE's single stream.
describe("useAiActivityPulse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lights up on a vale-browser-actions-changed window event and fades after the pulse window", () => {
    const { result } = renderHook(() => useAiActivityPulse());
    expect(result.current).toBe(false);
    act(() => {
      window.dispatchEvent(new CustomEvent("vale-browser-actions-changed", { detail: {} }));
    });
    expect(result.current).toBe(true);
    act(() => {
      window.dispatchEvent(new CustomEvent("vale-playwright-changed", { detail: {} }));
    });
    expect(result.current).toBe(true);
    // After the fade window it clears (UI timer, not a poll).
    act(() => {
      vi.advanceTimersByTime(PULSE_MS + 1000);
    });
    expect(result.current).toBe(false);
  });

  it("opens no fetch of its own (P1-3: single-stream rule)", () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    renderHook(() => useAiActivityPulse());
    act(() => {
      window.dispatchEvent(new CustomEvent("vale-browser-actions-changed", { detail: {} }));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
