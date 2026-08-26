import type { ReactNode } from "react";

// DSH-style app shell (round-147 full redesign): ONE fixed-height grid —
//   icon rail | session rail | canvas (100% of remaining space)
// The old three-column frame stacked toolbar/tabs/terminal/commands/status
// vertically, so the terminal and browser panes never filled the window;
// the command stream now lives in a right-side drawer overlay instead of
// reserving canvas height. All panes (TerminalPane/BrowserPane) fill their
// canvas 100% — no vertical leaks, no letterboxing surprises.
export function AppFrame({ iconRail, sessionRail, canvas, drawer }: {
  iconRail: ReactNode;
  sessionRail: ReactNode;
  canvas: ReactNode;
  drawer: ReactNode;
}) {
  return (
    <div id="app-shell">
      <div id="icon-rail">{iconRail}</div>
      <div id="session-rail">{sessionRail}</div>
      <div id="canvas-host">
        {drawer && <div id="drawer">{drawer}</div>}
        {canvas}
      </div>
    </div>
  );
}