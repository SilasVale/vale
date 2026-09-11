// Shell — ONE shell for both densities (per the core design doc §4).
//   density="panel"   → icon rail | context rail | canvas + status bar
//   density="desktop" → icon rail | canvas (context rail + status bar hidden)
// The density difference is PURELY visibility; navigation and pages are shared.
import type { ReactNode } from "react";

export type Density = "panel" | "desktop";
/** The pages, in rail order. `archive` sits directly under `terminal` because it
 *  is the terminal page's own history: the device's RECORDED sessions, openable
 *  after the session — or the agent — is gone. `activity` follows, because it is
 *  the device-level answer to the question the terminal page answers
 *  per-session, and because it is the one page that works with no session at
 *  all, which is where an operator landing on an idle device starts. */
export type Page = "terminal" | "archive" | "activity" | "browser" | "memory" | "plugins" | "settings";

export const PAGES: Page[] = ["terminal", "archive", "activity", "browser", "memory", "plugins", "settings"];
export const PAGE_LABELS: Record<Page, string> = {
  terminal: "Terminal",
  archive: "Archive",
  activity: "Activity",
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
  // round-161: the status bar is a BOTTOM BAR — it used to be the last flex
  // child of the row-direction #app-shell and rendered as a stray column on
  // the right edge.
  return (
    <div id="app-shell">
      <div id="shell-main">
        <div id="icon-rail">{iconRail}</div>
        {contextRail && <div id="context-rail">{contextRail}</div>}
        <div id="canvas-host">{canvas}</div>
      </div>
      {statusBar}
    </div>
  );
}
