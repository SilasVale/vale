import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
    // No embedded real-browser slot in plain-browser mode.
    expect(container.querySelector(".browser-embedded-slot")).toBeNull();
  });

  it("renders the embedded REAL-browser controller when window.valeEmbedded exists (Electron shell)", async () => {
    (window as any).valeEmbedded = {
      announceGuest: vi.fn().mockResolvedValue({ ok: true }),
      state: vi.fn().mockResolvedValue({ ok: true, url: "https://example.com", hasGuest: true, canBack: true, canFwd: false }),
    };
    const { container } = render(<BrowserPage plugins={pluginsStub} token="t" />);
    // The embedded controller mounts its real-browser slot (no screenshot
    // <img>; the <webview> element is Electron-only and inert in jsdom).
    expect(container.querySelector(".browser-embedded-slot")).toBeTruthy();
    expect(container.querySelector("img.browser-frame")).toBeNull();
    // Address input drives the embedded view.
    expect(screen.getByPlaceholderText(/rendered live by the real embedded browser/i)).toBeTruthy();
    // Nav buttons render (their enabled state is driven by the live webview
    // element's events, which jsdom cannot fire — asserted in device tests).
    expect(container.querySelectorAll("button.browser-nav").length).toBe(3);
  });
});
