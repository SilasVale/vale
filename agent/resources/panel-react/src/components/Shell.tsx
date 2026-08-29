// Shell — ONE shell for both densities (per the core design doc §4).
//   density="panel"   → icon rail | context rail | canvas + status bar
//   density="desktop" → icon rail | canvas (context rail + status bar hidden)
// The density difference is PURELY visibility; navigation and pages are shared.
import type { ReactNode } from "react";

export type Density = "panel" | "desktop";
export type Page = "terminal" | "browser" | "memory" | "plugins" | "settings";

export const PAGES: Page[] = ["terminal", "browser", "memory", "plugins", "settings"];
export const PAGE_LABELS: Record<Page, string> = {
  terminal: "Terminal",
  browser: "Browser",
  memory: "Memory",
  plugins: "Plugins",
  settings: "Settings",
};

export function Shell({ density, iconRail, contextRail, canvas, statusBar }: {
  density: Density;
  iconRail: ReactNode;
  contextRail?: ReactNode;   // panel density only
  canvas: ReactNode;
  statusBar?: ReactNode;     // panel density only
}) {
  if (density === "desktop") {
    return (
      <div className="desktop-shell">
        <aside className="desktop-rail">{iconRail}</aside>
        <main className="desktop-main">{canvas}</main>
      </div>
    );
  }
  return (
    <div id="app-shell">
      <div id="icon-rail">{iconRail}</div>
      {contextRail && <div id="context-rail">{contextRail}</div>}
      <div id="canvas-host">{canvas}</div>
      {statusBar}
    </div>
  );
}
