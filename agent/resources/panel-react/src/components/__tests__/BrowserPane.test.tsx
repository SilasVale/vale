// BrowserPane tests — the stage-n Chrome-style toolbar + Evidence drawer.
// Covers: stream placeholder until the first frame, nav-button disabled
// states driven by the bridge "tabs" push (canBack/canFwd), address-bar
// sync to the selected tab, the Evidence drawer toggle with shot/action
// counts, and click-to-expand AI action scripts.
//
// Protocol seams mocked (jsdom has NO WebSocket):
//   * a FakeWS captured per construction so tests can push synthetic frames
//     ({ data: string } JSON frames — exactly what useBrowser parses);
//   * fetch stubbed for POST /api/browser/ws-ticket → { ticket } and the
//     3s evidence poll (pwshots / pwshot / actions).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import BrowserPane from "../BrowserPane";

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  binaryType = "";
  readyState = 0; // CONNECTING — never auto-opens; send() no-ops like the real hook guards
  sent: string[] = [];
  constructor(_url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string) { this.sent.push(String(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
}

interface EvidenceData {
  shots?: { name: string; mtime_ms: number }[];
  actions?: Record<string, unknown>[];
}

function makeFetch(ev: EvidenceData = {}) {
  const shots = ev.shots ?? [];
  const actions = ev.actions ?? [];
  return vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("/api/browser/ws-ticket")) {
      return new Response(JSON.stringify({ ticket: "tk1" }), { status: 200 });
    }
    if (u.includes("/api/browser/pwshots")) {
      return new Response(JSON.stringify({ shots }), { status: 200 });
    }
    if (u.includes("/api/browser/pwshot?")) {
      return new Response(new Blob(["png"]), { status: 200 });
    }
    if (u.includes("/api/browser/actions")) {
      return new Response(JSON.stringify({ actions }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
}

const session = { sid: "s1", url: "https://example.com", active: true };

function renderPane(ev: EvidenceData = {}) {
  vi.stubGlobal("fetch", makeFetch(ev) as unknown as typeof fetch);
  return render(<BrowserPane session={session} apiBase="" token="t" />);
}

/** Wait for the ws-ticket fetch → new WebSocket() chain to settle. */
async function waitWs(): Promise<FakeWS> {
  await waitFor(() => expect(FakeWS.instances.length).toBeGreaterThan(0));
  return FakeWS.instances[FakeWS.instances.length - 1];
}

/** Push a bridge "tabs" push frame through the socket, like the relay does. */
function pushTabs(ws: FakeWS, msg: Record<string, unknown>) {
  act(() => { ws.onmessage?.({ data: JSON.stringify({ ev: "tabs", ...msg }) }); });
}

beforeEach(() => {
  localStorage.clear();
  FakeWS.instances = [];
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BrowserPane", () => {
  it("renders the Chrome-style toolbar (tabstrip row + urlbar row) and the status bar", async () => {
    const { container } = renderPane();
    const toolbar = container.querySelector(".browser-toolbar")!;
    // Two rows, tabs above the address bar — like a real browser.
    expect(toolbar.querySelector(".browser-tabstrip")).toBeTruthy();
    expect(toolbar.querySelector(".browser-urlbar")).toBeTruthy();
    expect(
      toolbar.compareDocumentPosition(toolbar.querySelector(".browser-urlbar")!)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Urlbar controls: nav buttons, address input, Go, zoom select, fullscreen.
    expect(container.querySelectorAll(".browser-nav").length).toBe(3);
    expect(container.querySelector(".browser-url")).toBeTruthy();
    expect(container.querySelector(".browser-go")).toBeTruthy();
    expect(container.querySelector("select.browser-zoom")).toBeTruthy();
    expect(container.querySelector(".browser-fullscreen")).toBeTruthy();
    // Bottom status bar with the Evidence toggle.
    expect(container.querySelector(".browser-statusbar .browser-ev-toggle")).toBeTruthy();
  });

  it("shows the stream placeholder until the first screencast frame arrives", async () => {
    const { container } = renderPane();
    const ph = container.querySelector(".browser-placeholder");
    expect(ph).toBeTruthy();
    expect(ph?.textContent).toContain("No browser stream yet");
    expect(container.querySelector(".browser-fps")?.textContent).toContain("waiting");

    const ws = await waitWs();
    // Binary frame → applyFrame → hasFrame: placeholder gone, status live.
    act(() => { ws.onmessage?.({ data: new Blob(["frame"], { type: "image/jpeg" }) }); });
    expect(container.querySelector(".browser-placeholder")).toBeNull();
    expect(container.querySelector(".browser-fps")?.textContent).toContain("live");
  });

  it("back/forward/reload are disabled until the bridge tabs push reports otherwise", async () => {
    const { container } = renderPane();
    const navs = container.querySelectorAll<HTMLButtonElement>(".browser-nav");
    expect(navs.length).toBe(3);
    const [back, fwd, reload] = Array.from(navs);
    // No history, no tabs yet → everything greyed out like a fresh browser.
    expect(back.disabled).toBe(true);
    expect(fwd.disabled).toBe(true);
    expect(reload.disabled).toBe(true);

    const ws = await waitWs();
    pushTabs(ws, {
      tabs: [{ i: 0, url: "https://a.example", title: "A" }],
      sel: 0, canBack: true, canFwd: false,
    });
    // canBack/canFwd from the push drive the disabled state; reload enables
    // once there is at least one tab.
    expect(back.disabled).toBe(false);
    expect(fwd.disabled).toBe(true);
    expect(reload.disabled).toBe(false);

    pushTabs(ws, {
      tabs: [{ i: 0, url: "https://a.example", title: "A" }],
      sel: 0, canBack: true, canFwd: true,
    });
    expect(fwd.disabled).toBe(false);
  });

  it("syncs the address bar to the selected tab URL on a tabs push", async () => {
    const { container } = renderPane();
    const input = container.querySelector<HTMLInputElement>(".browser-url")!;
    expect(input.value).toBe("https://www.wikipedia.org"); // default until the bridge speaks

    const ws = await waitWs();
    pushTabs(ws, {
      tabs: [
        { i: 0, url: "https://a.example", title: "Alpha" },
        { i: 1, url: "https://b.example/page", title: "Bee" },
      ],
      sel: 1, canBack: true, canFwd: false,
    });
    // Address bar follows the ACTUAL selected tab (sel=1), not tab 0.
    expect(input.value).toBe("https://b.example/page");
    // Tab strip renders both tabs and marks the selected one.
    expect(container.querySelectorAll(".browser-tab").length).toBe(2);
    expect(container.querySelector(".browser-tab.sel .browser-tab-label")?.textContent).toBe("Bee");
  });

  it("Evidence toggle opens the drawer showing screenshot and action counts", async () => {
    const { container } = renderPane({
      shots: [
        { name: "s1.png", mtime_ms: Date.now() - 600_000 },
        { name: "s2.png", mtime_ms: Date.now() - 500_000 },
      ],
      actions: [{ ts: 1700000000000, exit_code: 0, duration_ms: 42, script: "console.log(1)" }],
    });
    // Drawer closed by default — the live viewport stays dominant.
    expect(container.querySelector(".browser-ev-drawer")).toBeNull();

    const toggle = container.querySelector<HTMLButtonElement>(".browser-ev-toggle")!;
    // Evidence poll (first tick fires on mount) feeds the counts into the toggle.
    await waitFor(() => expect(toggle.textContent).toContain("Evidence (2)"));
    expect(toggle.className).not.toContain("active");

    fireEvent.click(toggle);
    expect(toggle.className).toContain("active");
    const drawer = container.querySelector(".browser-ev-drawer");
    expect(drawer).toBeTruthy();
    expect(drawer!.textContent).toContain("AI screenshots (2)");
    expect(drawer!.textContent).toContain("AI actions (1)");
    expect(drawer!.querySelectorAll(".browser-ev-thumb").length).toBe(2);

    // Close button collapses the drawer again.
    fireEvent.click(drawer!.querySelector(".browser-ev-close")!);
    expect(container.querySelector(".browser-ev-drawer")).toBeNull();
    expect(toggle.className).not.toContain("active");
  });

  it("clicking an AI action script row expands and collapses it", async () => {
    const script = `const page = ctx.page;\n${"x".repeat(200)}`;
    const { container } = renderPane({
      shots: [{ name: "s1.png", mtime_ms: Date.now() - 600_000 }],
      actions: [{ ts: 123, exit_code: 1, duration_ms: 7, script, stderr_tail: "boom" }],
    });
    const toggle = container.querySelector<HTMLButtonElement>(".browser-ev-toggle")!;
    await waitFor(() => expect(toggle.textContent).toContain("Evidence (1)"));
    fireEvent.click(toggle);

    const row = container.querySelector<HTMLElement>(".browser-action-script")!;
    expect(row.textContent).toBe(script);
    expect(row.className).not.toContain("expanded");
    fireEvent.click(row);
    expect(row.className).toContain("expanded");
    fireEvent.click(row);
    expect(row.className).not.toContain("expanded");
  });
});
