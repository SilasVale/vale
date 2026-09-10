// StatusBar + BrowserPage pins — the last two untested components:
// live-session count/plural/hidden, error styling, SSE reconnect chip;
// browser page routes to the embedded controller with a bridge and to
// the desktop-app hint without one.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBar } from "../StatusBar";
import { BrowserPage } from "../BrowserPage";

const sess = (over: Record<string, unknown> = {}) => ({
  sid: "s1",
  label: "s1",
  kind: "pty",
  closed: false,
  savedOnly: false,
  active: true,
  openedAt: 0,
  closedAt: null,
  heldByHuman: false,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StatusBar", () => {
  it("counts live sessions with singular/plural, hides at zero", () => {
    const { rerender } = render(
      <StatusBar sessions={[sess(), sess({ sid: "s2" }), sess({ sid: "s3", closed: true })]} status="ok" sseState="connected" />,
    );
    expect(screen.getByText("2 sessions")).toBeTruthy();
    rerender(<StatusBar sessions={[sess()]} status="ok" sseState="connected" />);
    expect(screen.getByText("1 session")).toBeTruthy();
    rerender(<StatusBar sessions={[sess({ closed: true })]} status="ok" sseState="connected" />);
    expect(screen.getByText("0 sessions").className).toContain("hidden");
  });

  it("marks error statuses; shows the reconnect chip only when down", () => {
    const { rerender } = render(<StatusBar sessions={[]} status="error: boom" sseState="down" />);
    expect(screen.getByText("error: boom").className).toContain("error");
    expect(screen.getByText("reconnecting…")).toBeTruthy();
    rerender(<StatusBar sessions={[]} status="open failed: x" sseState="connected" />);
    expect(screen.getByText("open failed: x").className).toContain("error");
    rerender(<StatusBar sessions={[]} status="ok" sseState="connecting" />);
    expect(screen.queryByText("reconnecting…")).toBeNull();
  });
});

describe("BrowserPage", () => {
  it("renders the embedded controller when the bridge exists", () => {
    vi.stubGlobal("valeEmbedded", {
      navigate: () => Promise.resolve(),
      back: () => Promise.resolve(),
      fwd: () => Promise.resolve(),
      reload: () => Promise.resolve(),
      zoom: () => Promise.resolve(),
      place: () => Promise.resolve(),
      state: () => Promise.resolve({ ok: false }),
      recover: () => Promise.resolve(),
      onNav: () => () => {},
      onGone: () => () => {},
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    render(<BrowserPage token="t" />);
    expect(screen.getByPlaceholderText(/Enter a URL/)).toBeTruthy();
  });

  it("explains the desktop-app requirement without a bridge", () => {
    render(<BrowserPage token="t" />);
    expect(screen.getByText("The browser needs the Vale desktop app")).toBeTruthy();
  });
});
