// useDesktopCommands — the menu/shortcut → action mapping must be exact:
// each command fires the right action, cycle wraps, and the keydown fallback
// only attaches without the Electron bridge.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDesktopCommands } from "../useDesktopCommands";

function makeActions() {
  return {
    onNewSession: vi.fn(),
    onClose: vi.fn(),
    onActivate: vi.fn(),
    onExport: vi.fn(),
    onSetView: vi.fn(),
  };
}

const sessions = [
  { sid: "a", closed: false },
  { sid: "b", closed: false },
  { sid: "c", closed: true }, // tombstone — must be skipped by cycling
  { sid: "d", closed: false },
];

describe("useDesktopCommands — menu bridge", () => {
  let actions: ReturnType<typeof makeActions>;
  let handlers: ((cmd: string) => void)[] = [];

  beforeEach(() => {
    actions = makeActions();
    handlers = [];
    (window as any).valeDesktop = {
      onCommand: (fn: (cmd: string) => void) => {
        handlers.push(fn);
        return () => {};
      },
    };
  });
  afterEach(() => {
    delete (window as any).valeDesktop;
    handlers = [];
  });

  it("new-* maps to onNewSession with the kind", () => {
    renderHook(() => useDesktopCommands(true, sessions, "b", {}, actions));
    handlers[0]("new-pty");
    handlers[0]("new-ssh");
    handlers[0]("new-serial");
    handlers[0]("new-browser");
    expect(actions.onNewSession.mock.calls).toEqual([
      ["pty"], ["ssh"], ["serial"], ["browser"],
    ]);
  });

  it("close/export act on the active session", () => {
    renderHook(() => useDesktopCommands(true, sessions, "b", {}, actions));
    handlers[0]("close-session");
    handlers[0]("export-session");
    expect(actions.onClose).toHaveBeenCalledWith("b");
    expect(actions.onExport).toHaveBeenCalledWith("b");
  });

  it("next/prev cycle live sessions and skip tombstones", () => {
    const { rerender } = renderHook(
      ({ sid }) => useDesktopCommands(true, sessions, sid, {}, actions),
      { initialProps: { sid: "b" } },
    );
    handlers[0]("next-session"); // b → d (c is closed)
    expect(actions.onActivate).toHaveBeenCalledWith("d");
    rerender({ sid: "d" });
    handlers[0]("next-session"); // d → wraps to a
    expect(actions.onActivate).toHaveBeenLastCalledWith("a");
    rerender({ sid: "a" });
    handlers[0]("prev-session"); // a → wraps back to d
    expect(actions.onActivate).toHaveBeenLastCalledWith("d");
  });

  it("toggle-trajectory flips the active session's view", () => {
    const views = { b: "terminal" as const };
    renderHook(() => useDesktopCommands(true, sessions, "b", views, actions));
    handlers[0]("toggle-trajectory");
    expect(actions.onSetView).toHaveBeenCalledWith("b", "trajectory");
    handlers[0]("toggle-trajectory");
    // views prop is a snapshot — the hook re-reads it each render; simulate
    // App having applied the change by re-rendering with the flipped view.
    const views2 = { b: "trajectory" as const };
    renderHook(() => useDesktopCommands(true, sessions, "b", views2, actions));
    handlers[1]("toggle-trajectory");
    expect(actions.onSetView).toHaveBeenLastCalledWith("b", "terminal");
  });
});

describe("useDesktopCommands — browser keydown fallback", () => {
  beforeEach(() => {
    delete (window as any).valeDesktop;
  });

  it("attaches keydown when there is no Electron bridge", () => {
    const actions = makeActions();
    const addSpy = vi.spyOn(document, "addEventListener");
    renderHook(() => useDesktopCommands(true, sessions, "a", {}, actions));
    const keydownCount = addSpy.mock.calls.filter(([t]) => t === "keydown").length;
    expect(keydownCount).toBe(1); // no bridge → fallback keydown attached
    addSpy.mockRestore();
  });

  it("handles Ctrl+Shift+T → new-pty when no bridge", () => {
    const actions = makeActions();
    renderHook(() => useDesktopCommands(true, sessions, "a", {}, actions));
    const e = new KeyboardEvent("keydown", { key: "t", ctrlKey: true, shiftKey: true, cancelable: true });
    document.dispatchEvent(e);
    expect(actions.onNewSession).toHaveBeenCalledWith("pty");
  });

  it("handles Ctrl+Tab → next-session when no bridge", () => {
    const actions = makeActions();
    renderHook(() => useDesktopCommands(true, sessions, "a", {}, actions));
    const e = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, cancelable: true });
    document.dispatchEvent(e);
    expect(actions.onActivate).toHaveBeenCalledWith("b");
  });
});
