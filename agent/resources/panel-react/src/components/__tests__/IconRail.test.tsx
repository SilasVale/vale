// IconRail pins — shared rail for both densities: 5 page buttons (active
// marked), theme toggle wired to lib/theme, connection dot state.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { IconRail } from "../IconRail";

const props = (over: Partial<React.ComponentProps<typeof IconRail>> = {}) => ({
  page: "terminal" as const,
  onPageChange: vi.fn(),
  connected: true,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
});

describe("IconRail", () => {
  it("renders all 5 pages; active page marked", () => {
    render(<IconRail {...props()} />);
    for (const t of ["Terminal", "Browser", "Memory", "Plugins", "Settings"]) {
      expect(screen.getByTitle(t)).toBeTruthy();
    }
    const term = screen.getByTitle("Terminal");
    expect(term.className).toContain("active");
    expect(term.getAttribute("aria-current")).toBe("page");
    expect(screen.getByTitle("Browser").className).not.toContain("active");
  });

  it("clicking a page notifies", () => {
    const p = props();
    render(<IconRail {...p} />);
    fireEvent.click(screen.getByTitle("Memory"));
    expect(p.onPageChange).toHaveBeenCalledWith("memory");
  });

  it("theme toggle flips title and persists", () => {
    const { unmount } = render(<IconRail {...props()} />);
    expect(screen.getByTitle("Switch to dark")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("theme"));
    expect(screen.getByTitle("Switch to light")).toBeTruthy();
    expect(localStorage.getItem("vale-theme")).toBe("dark");
    unmount();
    // remount reads the persisted theme
    render(<IconRail {...props()} />);
    expect(screen.getByTitle("Switch to light")).toBeTruthy();
  });

  it("device dot reflects state, not just connectivity", () => {
    const { rerender } = render(<IconRail {...props({ connected: true })} />);
    // Connected with no activity = IDLE. The rail used to say only
    // "connected", which meant all the work the AI did in a terminal was
    // invisible at the device level.
    expect(screen.getByTitle("device is idle")).toBeTruthy();
    rerender(<IconRail {...props({ connected: false })} />);
    expect(screen.getByTitle("disconnected")).toBeTruthy();
  });

  it("the device dot turns to WORKING on terminal activity", async () => {
    // The merge this hook exists for: terminal output now moves the device
    // state. Before it, only browser events did — and only inside the browser
    // pane, so `terminal_execute` work showed nowhere at the device level.
    const { container } = render(<IconRail {...props()} />);
    const dot = () =>
      container.querySelector(".rail-dot")!.getAttribute("data-state");
    expect(dot()).toBe("idle");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("vale-term-output", { detail: { sid: "s1" } }),
      );
    });
    expect(dot()).toBe("working");
  });

  it("desktop density uses desktop classes", () => {
    const { container } = render(
      <IconRail {...props({ desktop: true, page: "browser" })} />,
    );
    expect(container.querySelector(".desktop-rail-brand")).toBeTruthy();
    expect(screen.getByTitle("Browser").className).toContain(
      "desktop-rail-btn",
    );
    expect(screen.getByTitle("device is idle")).toBeTruthy();
  });
});

describe("IconRail — a decision waiting outranks device activity", () => {
  it("shows waiting, and it wins over working", () => {
    // A question EXPIRES if it goes unnoticed, so of the two true things the
    // dot could say, it says the one that decays.
    const { container, rerender } = render(
      <IconRail {...props({ pendingCount: 1 })} />,
    );
    const dot = () =>
      container.querySelector(".rail-dot")!.getAttribute("data-state");
    expect(dot()).toBe("waiting");
    expect(screen.getByTitle("1 command waiting for your answer")).toBeTruthy();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("vale-term-output", { detail: { sid: "s1" } }),
      );
    });
    // Both are true at once — the question still wins.
    expect(dot()).toBe("waiting");

    // ...and with nothing waiting, the same activity reads as working.
    rerender(<IconRail {...props({ pendingCount: 0 })} />);
    expect(dot()).toBe("working");

    // No transport: nothing can be answered, so the dot stays honest about off.
    rerender(<IconRail {...props({ pendingCount: 3, connected: false })} />);
    expect(dot()).toBe("off");
    expect(screen.getByTitle("disconnected")).toBeTruthy();
  });

  it("counts in the label, singular and plural — and says nothing at zero", () => {
    const { rerender } = render(<IconRail {...props({ pendingCount: 2 })} />);
    expect(
      screen.getByTitle("2 commands waiting for your answer"),
    ).toBeTruthy();
    rerender(<IconRail {...props({ pendingCount: 0 })} />);
    expect(screen.queryByTitle(/waiting for your answer/)).toBeNull();
    expect(screen.getByTitle("device is idle")).toBeTruthy();
  });

  it("carries the same waiting state in the desktop density", () => {
    const { container } = render(
      <IconRail {...props({ desktop: true, pendingCount: 1 })} />,
    );
    expect(
      container
        .querySelector(".desktop-rail-status")!
        .getAttribute("data-state"),
    ).toBe("waiting");
    expect(screen.getByTitle("1 command waiting for your answer")).toBeTruthy();
  });
});
