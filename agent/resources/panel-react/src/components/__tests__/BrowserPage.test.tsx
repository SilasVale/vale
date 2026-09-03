import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BrowserPage } from "../BrowserPage";

// round-246: the Electron shell (window.valeEmbedded) must render the REAL
// embedded-browser controller; plain browsers keep the screenshot pane.
const pluginsStub = {
  playwright: { running: true, healthy: true, port: 9229 },
  playwrightRow: { state: "ongoing", stateLabel: "Running" },
  busy: null,
  start: vi.fn(),
  stop: vi.fn(),
} as any;

describe("BrowserPage", () => {
  beforeEach(() => {
    delete (window as any).valeEmbedded;
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  });
  afterEach(() => {
    delete (window as any).valeEmbedded;
    vi.unstubAllGlobals();
  });

  it("renders the screenshot BrowserPane when no embedded bridge exists (plain browser)", () => {
    const { container } = render(<BrowserPage plugins={pluginsStub} token="t" />);
    expect(container.querySelector(".browser-pane")).toBeTruthy();
    expect(container.querySelector("#vale-embedded-browser-slot")).toBeNull();
  });

  it("renders the embedded REAL-browser controller when window.valeEmbedded exists (Electron shell)", async () => {
    (window as any).valeEmbedded = {
      navigate: vi.fn().mockResolvedValue({ ok: true }),
      back: vi.fn().mockResolvedValue({ ok: true }),
      fwd: vi.fn().mockResolvedValue({ ok: true }),
      reload: vi.fn().mockResolvedValue({ ok: true }),
      place: vi.fn().mockResolvedValue({ ok: true }),
      state: vi.fn().mockResolvedValue({ ok: true, url: "https://example.com", canBack: true, canFwd: false, visible: true }),
      onNav: vi.fn().mockReturnValue(() => {}),
    };
    const { container } = render(<BrowserPage plugins={pluginsStub} token="t" />);
    // The embedded controller mounts its slot (no screenshot <img>).
    expect(container.querySelector("#vale-embedded-browser-slot")).toBeTruthy();
    expect(container.querySelector("img.browser-frame")).toBeNull();
    // Address input drives the embedded view.
    expect(screen.getByPlaceholderText(/rendered live by the real embedded browser/i)).toBeTruthy();
    // Nav buttons reflect the REAL page history state from the bridge.
    const navBtns = container.querySelectorAll("button.browser-nav");
    expect(navBtns.length).toBe(3); // back / fwd / reload
    await waitFor(() => {
      expect((navBtns[0] as HTMLButtonElement).disabled).toBe(false); // canBack: true
      expect((navBtns[1] as HTMLButtonElement).disabled).toBe(true);  // canFwd: false
    });
  });
});
