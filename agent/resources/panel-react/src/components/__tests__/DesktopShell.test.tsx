// Shell + DesktopShell tests — the two densities share the same page set;
// DesktopShell must switch between all 5 pages and the rail must reflect
// the active page. (Uses mock props; no backend calls.)
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DesktopShell } from "../DesktopShell";
import { Shell } from "../Shell";
import type { Session } from "../../hooks/useSessions";

vi.mock("../../lib/api", () => ({
  callApi: vi.fn(() => Promise.resolve({})),
  callTool: vi.fn(() => Promise.resolve({})),
}));

function sessions(): Session[] {
  return [{
    sid: "s1", label: "shell", kind: "pty", closed: false, savedOnly: false,
    active: true, openedAt: Date.now(), closedAt: null,
  }];
}

const baseProps = {
  sessions: sessions(),
  activeSid: "s1",
  onActivate: vi.fn(),
  onClose: vi.fn(),
  onExport: vi.fn(),
  onViewChange: vi.fn(),
  registerWrite: vi.fn(() => vi.fn()),
  plugins: { rows: [], specLoaded: false, loadError: "", busy: null, log: [], start: vi.fn(), stop: vi.fn() } as any,
  onNewSession: vi.fn(),
  onConnConnect: vi.fn(() => Promise.resolve("s1")),
  connModal: null,
  onConnClose: vi.fn(),
  status: "",
  sseState: "connected" as "connected" | "down" | "connecting",
  token: "t",
  cmdEvents: { cards: [], events: [] } as any,
};

describe("Shell", () => {
  it("renders three columns for panel density", () => {
    const { container } = render(
      <Shell density="panel" iconRail={<div>rail</div>} contextRail={<div>ctx</div>} canvas={<div>canvas</div>} statusBar={<div>status</div>} />,
    );
    expect(container.querySelector("#app-shell")).toBeTruthy();
    expect(container.querySelector("#icon-rail")).toBeTruthy();
    expect(container.querySelector("#context-rail")).toBeTruthy();
    expect(container.querySelector("#canvas-host")).toBeTruthy();
  });

  it("renders desktop-shell layout for desktop density without context rail", () => {
    const { container } = render(
      <Shell density="desktop" iconRail={<div>rail</div>} canvas={<div>canvas</div>} />,
    );
    expect(container.querySelector(".desktop-shell")).toBeTruthy();
    expect(container.querySelector("#context-rail")).toBeNull();
    expect(container.querySelector("#app-shell")).toBeNull();
  });
});

describe("DesktopShell", () => {
  it("switches between all five pages via the rail", () => {
    render(<DesktopShell {...baseProps} />);
    // Default page: Terminal (the nav label marks the current page).
    expect(document.querySelector(".desktop-nav-label")?.textContent).toBe("Terminal");
    for (const label of ["Browser", "Memory", "Plugins", "Settings"]) {
      fireEvent.click(screen.getByTitle(label));
      expect(document.querySelector(".desktop-nav-label")?.textContent).toBe(label);
    }
  });

  it("shows connection dot state from sseState", () => {
    const { container } = render(<DesktopShell {...baseProps} />);
    expect(container.querySelector(".desktop-rail-status.ok")).toBeTruthy();
    const { container: c2 } = render(<DesktopShell {...baseProps} sseState="down" />);
    expect(c2.querySelector(".desktop-rail-status.ok")).toBeNull();
  });

  it("renders the SSH connection modal when connModal is set (regression: desktop shell had no ConnModal mount — SSH/Serial buttons were dead)", () => {
    const { container } = render(<DesktopShell {...baseProps} connModal="ssh" />);
    expect(container.querySelector("#conn-modal")).toBeTruthy();
    expect(container.querySelector(".modal-card h2")?.textContent).toBe("New SSH");
    const { container: c2 } = render(<DesktopShell {...baseProps} connModal="serial" />);
    expect(c2.querySelector(".modal-card h2")?.textContent).toBe("New Serial");
  });
});
