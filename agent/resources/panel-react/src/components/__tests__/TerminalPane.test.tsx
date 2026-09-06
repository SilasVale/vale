// TerminalPane pins — xterm mount/wiring plus the React-owned overlays:
// registerWrite registration, font zoom (persist + clamp), search bar
// open/close, inactive hiding, adopt read on mount.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TerminalPane } from "../TerminalPane";
import { callTool } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  callTool: vi.fn(async () => ({})),
}));

const session = (over: Record<string, unknown> = {}) => ({
  sid: "s1",
  label: "s1",
  kind: "pty",
  closed: false,
  savedOnly: false,
  active: true,
  openedAt: 0,
  closedAt: null,
  ...over,
});

const registerWrite = vi.fn(() => () => {});

beforeEach(() => {
  vi.mocked(callTool).mockClear();
  registerWrite.mockClear();
  localStorage.clear();
});

describe("TerminalPane", () => {
  it("mounts xterm, registers the write callback, adopts history", async () => {
    const { container } = render(<TerminalPane session={session()} registerWrite={registerWrite} />);
    expect(container.querySelector(".term-host")).toBeTruthy();
    expect(container.querySelector(".term-session.active")).toBeTruthy();
    expect(registerWrite).toHaveBeenCalledWith("s1", expect.any(Function), expect.any(Function), expect.any(Function));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith(
      "terminal_read",
      expect.objectContaining({ session_id: "s1" }),
    ));
  });

  it("write callback reaches the terminal", async () => {
    const { container } = render(<TerminalPane session={session()} registerWrite={registerWrite} />);
    const cb = (registerWrite.mock.calls[0] as unknown[])[1] as (bytes: Uint8Array) => void;
    cb(new TextEncoder().encode("hello-pane"));
    await waitFor(() => expect(container.querySelector(".term-host")!.textContent).toContain("hello-pane"));
  });

  it("font zoom persists and clamps to min/max", async () => {
    render(<TerminalPane session={session()} registerWrite={registerWrite} />);
    const smaller = screen.getByTitle("Smaller font");
    for (let i = 0; i < 10; i++) fireEvent.click(smaller);
    expect(localStorage.getItem("valeFontSize")).toBe("9");
    const larger = screen.getByTitle("Larger font");
    for (let i = 0; i < 20; i++) fireEvent.click(larger);
    expect(localStorage.getItem("valeFontSize")).toBe("22");
    fireEvent.click(screen.getByTitle("Reset font size"));
    expect(localStorage.getItem("valeFontSize")).toBe("13");
  });

  it("search bar opens via button and closes via Esc", async () => {
    render(<TerminalPane session={session()} registerWrite={registerWrite} />);
    expect(screen.queryByPlaceholderText("Search…")).toBeNull();
    fireEvent.click(screen.getByTitle("Search scrollback (Ctrl+F)"));
    const input = await screen.findByPlaceholderText("Search…");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByPlaceholderText("Search…")).toBeNull();
  });

  it("inactive session hides and drops the overlays", () => {
    const { container } = render(<TerminalPane session={session({ active: false })} registerWrite={registerWrite} />);
    expect(container.querySelector(".term-session")!.getAttribute("style")).toContain("none");
    expect(screen.queryByTitle("Smaller font")).toBeNull();
  });
});
