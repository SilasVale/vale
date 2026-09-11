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
  approvalRequired: false,
  pendingApproval: null, approvalGrants: [], goal: null, plan: [], ...over,
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

describe("TabBar — a question waiting for a person", () => {
  const question = { id: "g1", command: "reload", expiresAtMs: Date.now() + 60_000 };

  it("marks the session that is holding a question, with a shape AND a word", () => {
    const p = props({
      sessions: [
        session(),
        session({ sid: "s2", label: "gated", pendingApproval: question }),
      ],
    });
    const { container } = render(<TabBar {...p} />);
    // A SHAPE, not the lane dot: the strip's other marks are circles, so a
    // second circle beside them would read as another lane.
    expect(container.querySelectorAll(".tab-wait")).toHaveLength(1);
    const tab = screen.getByTitle("gated — waiting for your approval");
    expect(tab.querySelector(".tab-wait")).toBeTruthy();
    // ...and the word, for anyone who cannot see the mark.
    expect(tab.getAttribute("aria-label")).toBe("gated — waiting for your approval");
    // The unmarked session keeps its ordinary title.
    expect(screen.getByTitle("s1")).toBeTruthy();
  });

  it("does NOT mark a session that is merely ARMED", () => {
    // Keying the badge off `approvalRequired` would make every armed session
    // shout forever, which is how a badge becomes wallpaper.
    const { container } = render(
      <TabBar {...props({ sessions: [session({ sid: "s3", label: "armed", approvalRequired: true })] })} />,
    );
    expect(container.querySelector(".tab-wait")).toBeNull();
    expect(screen.queryByTitle("armed — waiting for your approval")).toBeNull();
    expect(screen.getByTitle("s3")).toBeTruthy();
    expect(screen.queryByLabelText("armed — waiting for your approval")).toBeNull();
  });

  it("never marks a CLOSED tombstone, even if it still carries a question", () => {
    const { container } = render(
      <TabBar
        {...props({
          sessions: [session({ sid: "s9", label: "gone", closed: true, pendingApproval: question })],
          activeSid: null,
        })}
      />,
    );
    expect(container.querySelector(".tab-wait")).toBeNull();
    expect(screen.getByTitle("gone — closed (history stays in Trajectory/Logs)")).toBeTruthy();
  });

  it("shows no COUNT — one session holds at most one question", () => {
    const { container } = render(
      <TabBar {...props({ sessions: [session({ sid: "s2", label: "gated", pendingApproval: question })] })} />,
    );
    expect(container.querySelector(".tab-wait")!.textContent).toBe("");
  });
});
