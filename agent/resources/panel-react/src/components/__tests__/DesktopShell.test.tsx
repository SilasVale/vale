// Shell + DesktopShell tests — the two densities share the same page set;
// DesktopShell must switch between all 5 pages and the rail must reflect
// the active page. (Uses mock props; no backend calls.)
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DesktopShell } from "../DesktopShell";
import { Shell } from "../Shell";
import type { Session } from "../../hooks/useSessions";
import { callApi } from "../../lib/api";

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
    // Default page: Terminal (the header title marks the current page).
    expect(document.querySelector(".desktop-header-title")?.textContent).toContain("Terminal");
    for (const label of ["Browser", "Memory", "Plugins", "Settings"]) {
      fireEvent.click(screen.getByTitle(label));
      expect(document.querySelector(".desktop-header-title")?.textContent).toContain(label);
    }
  });

  it("shows a single New menu instead of four scattered buttons (stage-l)", () => {
    render(<DesktopShell {...baseProps} />);
    expect(document.querySelectorAll(".desktop-new .btn-new").length).toBe(1);
    // The old four-button row is gone.
    expect(document.querySelectorAll(".desktop-new .btn-ghost").length).toBe(0);
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

  it("status strip shows vitals from /api/status polling (stage-n vitals)", async () => {
    (callApi as any).mockResolvedValueOnce({
      version: "1.0.145", uptime_secs: 95, live_sessions: 1, cpu_pct: 12.4, mem_pct: 48.9,
    });
    render(<DesktopShell {...baseProps} />);
    const el = await waitFor(() => {
      const node = document.querySelector(".desktop-status-msg");
      expect(node?.textContent).toContain("CPU");
      return node!;
    });
    expect(el.textContent).toContain("1 session");
    expect(el.textContent).toContain("v1.0.145");
    expect(el.textContent).toContain("up 1m 35s");
    expect(el.textContent).toContain("CPU 12%");
    expect(el.textContent).toContain("MEM 49%");
  });

  it("status strip omits vitals when the fields are absent (graceful degradation)", async () => {
    (callApi as any).mockResolvedValueOnce({ version: "1.0.145" });
    render(<DesktopShell {...baseProps} />);
    await waitFor(() => expect(document.querySelector(".desktop-status-msg")?.textContent).toContain("v1.0.145"));
    expect(document.querySelector(".desktop-status-msg")?.textContent).not.toContain("CPU");
    expect(document.querySelector(".desktop-status-msg")?.textContent).not.toContain("MEM");
  });
});
