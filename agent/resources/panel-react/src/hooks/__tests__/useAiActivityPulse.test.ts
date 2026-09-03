import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useAiActivityPulse } from "../useAiActivityPulse";

// round-253: the embedded pane's AI-activity pulse must light on an SSE
// browser-actions-changed push (event-driven, no polling), then fade.
describe("useAiActivityPulse", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lights up on a browser-actions-changed SSE push and fades after ~8s", async () => {
    const enc = new TextEncoder();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/events")) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode('data: {"ev":"browser-actions-changed"}\n\n'));
          },
        });
        return new Response(stream, { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { result } = renderHook(() => useAiActivityPulse("", "t"));
    // The pushed event should set active=true (real timers pump the stream).
    await waitFor(() => expect(result.current).toBe(true), { timeout: 3000 });
    // After the 8s fade window it clears (UI timer, not a poll).
    await new Promise((r) => setTimeout(r, 9000));
    expect(result.current).toBe(false);
  }, 20000);
});
