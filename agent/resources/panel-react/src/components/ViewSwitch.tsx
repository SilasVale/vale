// ViewSwitch — the per-session view selector, ONE copy for both densities.
//
// Extracted when the PATH view became the third option. Both densities had
// grown their own two-button copy (TabBar's `.view-switch` and DesktopShell's
// `.desktop-view-switch`), and R131's commit records exactly how that ends:
// "fixing one and missing the others is how they drifted apart in the first
// place". Adding a third button to two hand-maintained copies is the same
// mistake with a shorter fuse, so the label list now lives here once.
//
// The two densities keep their own CONTAINER styling (different chrome, pill vs
// rounded-rect) via `className`; only the button set and the accessibility
// wiring are shared.
import type { SessionView } from "./TabBar";

/** Label + tooltip per view, in display order. The tooltips carry the meaning,
 *  because "Trajectory" and "Path" are not self-explanatory next to each other:
 *  one is the raw audit timeline, the other is the same work summarised. */
export const VIEW_LABELS: Array<{ id: SessionView; label: string; title: string }> = [
  {
    id: "terminal",
    label: "Terminal",
    title: "The live terminal session",
  },
  {
    id: "trajectory",
    label: "Trajectory",
    title: "Raw audit timeline — every event, exactly as logged",
  },
  {
    id: "path",
    label: "Path",
    title: "This session's work as steps, with a summary of how it went",
  },
];

export function ViewSwitch({ view, onChange, className }: {
  view: SessionView;
  onChange: (v: SessionView) => void;
  /** Container class: `view-switch` (panel) or `desktop-view-switch`. */
  className: string;
}) {
  return (
    <div className={className} role="tablist" aria-label="Session view">
      {VIEW_LABELS.map((v) => (
        <button
          key={v.id}
          type="button"
          role="tab"
          aria-selected={view === v.id}
          className={`view-switch-btn${view === v.id ? " active" : ""}`}
          title={v.title}
          onClick={() => onChange(v.id)}
        >{v.label}</button>
      ))}
    </div>
  );
}
