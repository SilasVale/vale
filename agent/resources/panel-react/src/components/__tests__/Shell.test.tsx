// Shell pins — ONE shell, two densities (core design §4): panel density
// lays out icon rail + context rail + canvas with the status bar as a
// BOTTOM bar (round-161 stray-column fix); desktop hides context rail +
// status bar. PAGES/PAGE_LABELS are the shared page contract.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Shell, PAGES, PAGE_LABELS, type Page } from "../Shell";

describe("Shell page contract", () => {
  it("PAGES lists all 5 pages with labels", () => {
    expect(PAGES).toEqual(["terminal", "browser", "memory", "plugins", "settings"]);
    const labels = (Object.keys(PAGE_LABELS) as Page[]).map((p) => PAGE_LABELS[p]);
    expect(labels).toEqual(["Terminal", "Browser", "Memory", "Plugins", "Settings"]);
  });
});

describe("Shell panel density", () => {
  it("lays out rails + canvas with the status bar as a bottom bar", () => {
    const { container } = render(
      <Shell
        density="panel"
        iconRail={<span>rail</span>}
        contextRail={<span>ctx</span>}
        canvas={<span>canvas</span>}
        statusBar={<span>status</span>}
      />,
    );
    expect(screen.getByText("rail")).toBeTruthy();
    expect(screen.getByText("ctx")).toBeTruthy();
    expect(screen.getByText("canvas")).toBeTruthy();
    const shell = container.querySelector("#app-shell")!;
    const status = screen.getByText("status");
    expect(status.parentElement).toBe(shell);
    expect(status.previousElementSibling?.id).toBe("shell-main");
  });

  it("optional rails omit their hosts", () => {
    const { container } = render(
      <Shell density="panel" iconRail={<span>rail</span>} canvas={<span>canvas</span>} />,
    );
    expect(container.querySelector("#context-rail")).toBeNull();
  });
});

describe("Shell desktop density", () => {
  it("hides context rail and status bar", () => {
    const { container } = render(
      <Shell
        density="desktop"
        iconRail={<span>rail</span>}
        contextRail={<span>ctx</span>}
        canvas={<span>canvas</span>}
        statusBar={<span>status</span>}
      />,
    );
    expect(container.querySelector(".desktop-shell")).toBeTruthy();
    expect(screen.queryByText("ctx")).toBeNull();
    expect(screen.queryByText("status")).toBeNull();
    expect(screen.getByText("canvas")).toBeTruthy();
  });
});
