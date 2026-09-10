// TabBar pins — session tabs: closed tabs never activate (round-161 honest
// label, round-113 no-op), export doesn't activate (stopPropagation),
// two-step close confirm (P1-5, memory_delete pattern), view switch only
// while a session is active.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabBar } from "../TabBar";
import type { Session } from "../../hooks/useSessions";

const session = (over: Partial<Session> = {}): Session => ({
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

const props = (over: Partial<React.ComponentProps<typeof TabBar>> = {}) => ({
  sessions: [session()],
  activeSid: "s1" as string | null,
  onActivate: vi.fn(),
  onClose: vi.fn(),
  onExport: vi.fn(),
  view: "terminal" as const,
  onViewChange: vi.fn(),
  ...over,
});

describe("TabBar", () => {
  it("clicking a live tab activates it; closed tabs are a silent no-op", () => {
    const p = props({ sessions: [session(), session({ sid: "s2", label: "dead", closed: true })] });
    render(<TabBar {...p} />);
    fireEvent.click(screen.getByText("shell"));
    expect(p.onActivate).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByText("dead"));
    expect(p.onActivate).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle("dead — closed (history stays in Trajectory/Logs)")).toBeTruthy();
  });

  it("export does not activate the tab", () => {
    const p = props();
    render(<TabBar {...p} />);
    fireEvent.click(screen.getByTitle("Export this session log"));
    expect(p.onExport).toHaveBeenCalledWith("s1");
    expect(p.onActivate).not.toHaveBeenCalled();
  });

  it("two-step close: arm → Close executes, Cancel disarms", () => {
    const p = props();
    render(<TabBar {...p} />);
    fireEvent.click(screen.getByTitle("Close session"));
    expect(p.onClose).not.toHaveBeenCalled();
    expect(screen.getByText("close?")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("close?")).toBeNull();
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("Close session"));
    fireEvent.click(screen.getByText("Close"));
    expect(p.onClose).toHaveBeenCalledWith("s1");
  });

  it("savedOnly and closed sessions show no close affordance", () => {
    const p = props({
      sessions: [
        session({ sid: "s9", label: "saved", savedOnly: true }),
        session({ sid: "s8", label: "gone", closed: true }),
      ],
      activeSid: null,
    });
    render(<TabBar {...p} />);
    expect(screen.queryByTitle("Close session")).toBeNull();
  });

  it("view switch renders only with an active session and flips views", () => {
    const p = props();
    const { rerender } = render(<TabBar {...p} />);
    fireEvent.click(screen.getByText("Trajectory"));
    expect(p.onViewChange).toHaveBeenCalledWith("trajectory");
    rerender(<TabBar {...props({ activeSid: null })} />);
    expect(screen.queryByText("Trajectory")).toBeNull();
    expect(screen.queryByText("Terminal")).toBeNull();
  });
});
