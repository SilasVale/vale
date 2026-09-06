// IconRail pins — shared rail for both densities: 5 page buttons (active
// marked), theme toggle wired to lib/theme, connection dot state.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("connection dot reflects state", () => {
    const { rerender } = render(<IconRail {...props({ connected: true })} />);
    expect(screen.getByTitle("connected")).toBeTruthy();
    rerender(<IconRail {...props({ connected: false })} />);
    expect(screen.getByTitle("disconnected")).toBeTruthy();
  });

  it("desktop density uses desktop classes", () => {
    const { container } = render(<IconRail {...props({ desktop: true, page: "browser" })} />);
    expect(container.querySelector(".desktop-rail-brand")).toBeTruthy();
    expect(screen.getByTitle("Browser").className).toContain("desktop-rail-btn");
    expect(screen.getByTitle("agent connected")).toBeTruthy();
  });
});
