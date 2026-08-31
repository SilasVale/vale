// useBrowser tests — the round-160 browser UX additions: local URL history
// (dedup + persistence), viewport zoom state, and the AI-activity signal
// derived from fresh pwout screenshots (Browserless "watching sessions").
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useBrowser } from "../useBrowser";

// No real WS in jsdom: a FakeWS that never opens keeps send() a no-op while
// the reconnect loop stays bounded (unmount clears the timer).
class FakeWS {
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  binaryType = "";
  readyState = 0;
  constructor() {
    (globalThis as any).__lastWS = this;
  }
  close() { this.readyState = 3; this.onclose?.(); }
  send() { /* not open — caller no-ops */ }
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useBrowser", () => {
  it("navigate() records URL history locally (dedup, newest first)", async () => {
    localStorage.setItem("valeUrlHistory", JSON.stringify(["https://old.example.com"]));
    const { result } = renderHook(() => useBrowser({ apiBase: "", token: "t" }));
    act(() => result.current.setUrl("example.com"));
    await act(async () => { result.current.navigate(); });
    expect(result.current.url).toBe("https://example.com");
    expect(result.current.urlHistory[0]).toBe("https://example.com");
    expect(result.current.urlHistory).toContain("https://old.example.com");
    expect(JSON.parse(localStorage.getItem("valeUrlHistory")!)).toContain("https://example.com");

    // Navigating to the same URL must not duplicate the entry.
    await act(async () => { result.current.navigate(); });
    expect(result.current.urlHistory.filter((u) => u === "https://example.com").length).toBe(1);
  });

  it("zoom is a plain controlled value the view applies to the frame width", () => {
    const { result } = renderHook(() => useBrowser({ apiBase: "", token: "t" }));
    expect(result.current.zoom).toBe(100);
    act(() => result.current.setZoom(125));
    expect(result.current.zoom).toBe(125);
  });

  it("aiActive is true only while a screenshot is fresh (<90s)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/browser/pwshots")) {
        return new Response(JSON.stringify({ shots: [{ name: "a.png", mtime_ms: Date.now() - 5000 }] }), { status: 200 });
      }
      if (url.includes("/api/browser/pwshot")) {
        return new Response(new Blob(["png"]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { result } = renderHook(() => useBrowser({ apiBase: "", token: "t" }));
    await waitFor(() => expect(result.current.aiActive).toBe(true));
  });

  it("aiActive stays false with no screenshots", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/browser/pwshots")) {
        return new Response(JSON.stringify({ shots: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { result } = renderHook(() => useBrowser({ apiBase: "", token: "t" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.aiActive).toBe(false);
  });

  it("focuses the frame on the FIRST frame only — later frames must not steal focus from the URL bar", async () => {
    // Regression: the old <img onLoad={() => img.focus()}> re-fired on every
    // frame and stole focus from the URL input mid-typing (a >1s pause in
    // the address bar dropped all further keystrokes into the remote page).
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/browser/ws-ticket")) {
        return new Response(JSON.stringify({ ticket: "t1" }), { status: 200 });
      }
      if (url.includes("/api/browser/pwshots")) {
        return new Response(JSON.stringify({ shots: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const focusMock = vi.fn();
    const img = {
      focus: focusMock,
      src: "",
      addEventListener: vi.fn(),
    } as unknown as HTMLImageElement;
    const { result } = renderHook(() => useBrowser({ apiBase: "", token: "t" }));
    // jsdom renders nothing — attach the hook's imgRef to our fake img.
    (result.current.imgRef as { current: HTMLImageElement | null }).current = img;

    // Wait for the WS ticket fetch → FakeWS construction.
    await waitFor(() => expect((globalThis as any).__lastWS).toBeTruthy());
    const ws = (globalThis as any).__lastWS;
    act(() => { ws.onopen?.(); });

    // Frame 1: must focus exactly once.
    act(() => {
      ws.onmessage({ data: new Blob(["frame1"], { type: "image/jpeg" }) });
    });
    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(result.current.hasFrame).toBe(true);

    // Frame 2, 3: must NOT focus again.
    act(() => { ws.onmessage({ data: new Blob(["frame2"], { type: "image/jpeg" }) }); });
    act(() => { ws.onmessage({ data: new Blob(["frame3"], { type: "image/jpeg" }) }); });
    expect(focusMock).toHaveBeenCalledTimes(1);
  });
});
