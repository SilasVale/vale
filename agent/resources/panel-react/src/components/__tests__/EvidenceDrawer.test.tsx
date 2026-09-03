import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { EvidenceDrawer } from "../EvidenceDrawer";

// round-255: the embedded pane's evidence drawer fetches shots + actions on
// demand when opened (no polling) and renders them with the shared classes.
describe("EvidenceDrawer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("fetches shots + actions when opened and renders the timeline", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/browser/pwshots")) {
        return new Response(JSON.stringify({ shots: [{ name: "page-1.png", mtime_ms: 1000 }] }), { status: 200 });
      }
      if (url.includes("/api/browser/actions")) {
        return new Response(JSON.stringify({ actions: [{ ts: 1000, exit_code: 0, script: "browser_run_script", duration_ms: 5 }] }), { status: 200 });
      }
      if (url.includes("/api/events")) {
        // hold the SSE connection open (no events needed for this test)
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { rerender, container } = render(<EvidenceDrawer apiBase="" token="t" open={false} onClose={() => {}} />);
    // Closed: no fetch, no drawer content.
    expect(container.querySelector(".browser-ev-drawer.open")).toBeNull();
    rerender(<EvidenceDrawer apiBase="" token="t" open={true} onClose={() => {}} />);
    // Opened: fetches happen; timeline + action log render.
    await waitFor(() => expect(screen.getByText(/AI screenshots \(1\)/)).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText(/AI actions \(1\)/)).toBeTruthy();
    expect(container.querySelector(".browser-ev-thumb")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/browser/pwshots"), expect.anything());
  });
});
