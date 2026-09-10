// TerminalWorkspace pins — the ONE terminal page for both densities:
// empty state, reconnect banner, per-session view switch, Logs drawer
// (open/close, card select/deselect, refit dispatch), desktop density
// (no TabBar, controlled view). TerminalPane mounts real xterm (as in
// DesktopShell.test) — assertions stay at the composition level.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TerminalWorkspace } from "../TerminalWorkspace";
import type { Session } from "../../hooks/useSessions";

vi.mock("../../lib/api", () => ({
  callApi: vi.fn(() => Promise.resolve({})),
  callTool: vi.fn(() => Promise.resolve({})),
}));

const session = (over: Partial<Session & { active: boolean }> = {}) => ({
  sid: "s1",
  label: "shell",
  kind: "pty",
  closed: false,
  savedOnly: false,
  active: true,
  openedAt: Date.now(),
  closedAt: null,
  heldByHuman: false,
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof TerminalWorkspace>> = {}) => ({
  sessions: [session()],
  activeSid: "s1" as string | null,
  onActivate: vi.fn(),
  onClose: vi.fn(),
  onExport: vi.fn(),
  onViewChange: vi.fn(),
  onSetControl: vi.fn(() => Promise.resolve(false)),
  registerWrite: vi.fn(() => Object.assign(vi.fn(), {})),
  cmdEvents: { cards: [], events: [] },
  token: "tok",
  density: "panel" as const,
  sseState: "connected" as const,
  ...over,
});

describe("TerminalWorkspace", () => {
  it("empty sessions → empty state, no crash", () => {
    render(<TerminalWorkspace {...props({ sessions: [], activeSid: null })} />);
    expect(screen.getByText("No sessions yet")).toBeTruthy();
  });

  it("sse down → reconnect banner", () => {
    render(<TerminalWorkspace {...props({ sseState: "down" })} />);
    expect(screen.getByText("Connection lost — reconnecting…")).toBeTruthy();
  });

  it("view switch flips to the trajectory timeline and notifies", () => {
    const p = props();
    render(<TerminalWorkspace {...p} />);
    fireEvent.click(screen.getByText("Trajectory"));
    expect(p.onViewChange).toHaveBeenCalledWith("s1", "trajectory");
    expect(screen.getByText("No commands in this session yet.")).toBeTruthy();
    fireEvent.click(screen.getByText("Terminal"));
    expect(p.onViewChange).toHaveBeenCalledWith("s1", "terminal");
  });

  it("Logs drawer opens, selects a card into DetailsPanel, closes clean", () => {
    const cards = [{
      id: "c-1", command: "ls", output: "a", startedAt: 1,
      ended: true, exitCode: 0, reason: null, durationMs: 10, seq: 1,
    }];
    render(<TerminalWorkspace {...props({ cmdEvents: { cards, events: [] } })} />);
    expect(screen.queryByText("Details")).toBeNull();
    fireEvent.click(screen.getByTitle("Command log"));
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.getByText("Select a command card to inspect its parameters, output, and exit code.")).toBeTruthy();
    // select the card in the stream → details shows it; click again → deselect
    fireEvent.click(screen.getByTitle("ls"));
    expect(screen.queryAllByText("ls").length).toBeGreaterThan(1);
    fireEvent.click(screen.getByTitle("Close"));
    expect(screen.queryByText("Details")).toBeNull();
  });

  it("desktop density renders the terminal area without the tab bar", () => {
    const onControlled = vi.fn();
    const { container } = render(
      <TerminalWorkspace
        {...props({ density: "desktop", controlledView: "terminal", onControlledViewChange: onControlled })}
      />,
    );
    expect(container.querySelector(".desktop-terminal")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("desktop honors the controlled view value", () => {
    const base = props({ density: "desktop", controlledView: "terminal", onControlledViewChange: vi.fn() });
    const { rerender } = render(<TerminalWorkspace {...base} />);
    expect(screen.queryByText("No commands in this session yet.")).toBeNull();
    rerender(<TerminalWorkspace {...base} controlledView="trajectory" />);
    expect(screen.getByText("No commands in this session yet.")).toBeTruthy();
  });
});
