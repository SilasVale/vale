// theme.ts pins — light default, localStorage persistence, body[data-theme]
// application, live-flip events (TerminalPane re-themes xterm on these),
// and fail-safe behavior when storage throws (private mode).
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("theme", () => {
  let theme: typeof import("./theme");

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    document.body.removeAttribute("data-theme");
    theme = await import("./theme");
  });

  it("defaults to light when nothing stored, honors stored dark", async () => {
    expect(theme.getTheme()).toBe("light");
    localStorage.setItem("vale-theme", "dark");
    expect(theme.getTheme()).toBe("dark");
  });

  it("garbage stored value falls back to light", () => {
    localStorage.setItem("vale-theme", "midnight");
    expect(theme.getTheme()).toBe("light");
  });

  it("setTheme persists, applies to body, and notifies subscribers", () => {
    const seen: string[] = [];
    const off = theme.onThemeChange(() => seen.push(document.body.dataset.theme!));
    theme.setTheme("dark");
    expect(localStorage.getItem("vale-theme")).toBe("dark");
    expect(document.body.dataset.theme).toBe("dark");
    expect(seen).toEqual(["dark"]);
    off();
    theme.setTheme("light");
    expect(seen).toEqual(["dark"]); // unsubscribed listener must not fire
  });

  it("toggleTheme flips both ways and returns the new theme", () => {
    expect(theme.toggleTheme()).toBe("dark");
    expect(document.body.dataset.theme).toBe("dark");
    expect(theme.toggleTheme()).toBe("light");
    expect(theme.getTheme()).toBe("light");
  });

  it("storage failure degrades to light, never throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(theme.getTheme()).toBe("light");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => theme.setTheme("dark")).not.toThrow();
    expect(document.body.dataset.theme).toBe("dark"); // apply lands even when persist fails
  });
});
