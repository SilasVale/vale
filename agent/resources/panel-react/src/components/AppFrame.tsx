import { useCallback, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// dsh-style resizable three-column frame (round-admin-ui Task 3):
//   sidebar | main | details
// Column widths live in CSS vars (--ds-sidebar-w / --ds-details-w) so the
// grid-template-columns transition animates the details open/close; the
// data-dragging attribute kills the transition while a resize is in flight
// (otherwise the columns lag the cursor).
const SIDEBAR_MIN = 180, SIDEBAR_MAX = 420, SIDEBAR_DEFAULT = 240;
const DETAILS_MIN = 260, DETAILS_MAX = 720, DETAILS_DEFAULT = 360;

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

export function AppFrame({ sidebar, main, details, detailsOpen }: {
  sidebar: ReactNode;
  main: ReactNode;
  details: ReactNode;
  detailsOpen: boolean;
}) {
  const [sidebarW, setSidebarW] = useState(SIDEBAR_DEFAULT);
  const [detailsW, setDetailsW] = useState(DETAILS_DEFAULT);
  const [dragging, setDragging] = useState<"side" | "details" | null>(null);
  // Drag params live in a ref — the window mousemove handler reads the
  // snapshot taken at mousedown, not the (re-created) closure.
  const dragRef = useRef<{ which: "side" | "details"; startX: number; startW: number } | null>(null);

  const beginDrag = useCallback((which: "side" | "details") => (e: React.MouseEvent) => {
    e.preventDefault(); // keep the drag from starting text selection
    dragRef.current = { which, startX: e.clientX, startW: which === "side" ? sidebarW : detailsW };
    setDragging(which);
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      // The side handle drags its column's right edge; the details handle
      // drags the boundary from the RIGHT edge, so dx flips sign.
      if (d.which === "side") setSidebarW(clamp(d.startW + dx, SIDEBAR_MIN, SIDEBAR_MAX));
      else setDetailsW(clamp(d.startW - dx, DETAILS_MIN, DETAILS_MAX));
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [sidebarW, detailsW]);

  // Keyboard resize (role="separator" handles): arrows nudge the width;
  // dragging stays set until blur so the 0.3s column transition doesn't
  // animate every keypress.
  const keyResize = useCallback((which: "side" | "details") => (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = which === "side" ? 1 : -1; // arrow meaning flips at the right edge
    const delta = (e.key === "ArrowRight" ? dir : -dir) * 16;
    setDragging(which);
    if (which === "side") setSidebarW((w) => clamp(w + delta, SIDEBAR_MIN, SIDEBAR_MAX));
    else setDetailsW((w) => clamp(w + delta, DETAILS_MIN, DETAILS_MAX));
  }, []);

  const resetWidth = useCallback((which: "side" | "details") => () => {
    if (which === "side") setSidebarW(SIDEBAR_DEFAULT);
    else setDetailsW(DETAILS_DEFAULT);
  }, []);

  const frameStyle = {
    "--ds-sidebar-w": `${sidebarW}px`,
    "--ds-details-w": detailsOpen ? `${detailsW}px` : "0px",
  } as CSSProperties;

  return (
    <div
      className="frame"
      style={frameStyle}
      data-details-open={detailsOpen}
      data-dragging={dragging || undefined}
    >
      <aside className="frame-side">{sidebar}</aside>
      <div
        className="frame-handle frame-handle-side"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={0}
        onMouseDown={beginDrag("side")}
        onKeyDown={keyResize("side")}
        onBlur={() => setDragging(null)}
        onDoubleClick={resetWidth("side")}
      />
      <main className="frame-main">{main}</main>
      {detailsOpen && (
        <>
          <div
            className="frame-handle frame-handle-details"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize details panel"
            tabIndex={0}
            onMouseDown={beginDrag("details")}
            onKeyDown={keyResize("details")}
            onBlur={() => setDragging(null)}
            onDoubleClick={resetWidth("details")}
          />
          <section className="frame-details">{details}</section>
        </>
      )}
    </div>
  );
}
