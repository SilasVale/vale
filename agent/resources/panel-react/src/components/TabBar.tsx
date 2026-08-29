// react-jsx: no React import needed
import type { Session } from "../hooks/useSessions";
import { Icon } from "../ui/Icon";

/** Per-session main-area view (round-admin-ui Task 5): the terminal pane +
 *  command card stream, or the raw trajectory timeline. */
export type SessionView = "terminal" | "trajectory";

export function TabBar({ sessions, activeSid, onActivate, onClose, onExport, view, onViewChange }: {
  sessions: Session[];
  activeSid: string | null;
  onActivate: (sid: string) => void;
  onClose: (sid: string) => void;
  onExport: (sid: string) => void;
  view: SessionView;
  onViewChange: (v: SessionView) => void;
}) {
  return (
    <div className="tabrow">
      <div id="tabs" role="tablist" aria-label="Terminal sessions">
        {sessions.map((s) => (
          <div
            key={s.sid}
            className={`tab ${s.closed ? "closed" : ""} ${s.sid === activeSid ? "active" : ""}`}
            // round-161: closed tabs are visually dead AND honestly labelled —
            // activation rejects closed sessions (round-113 unmounted their
            // panes), so a click was a silent no-op before.
            title={s.closed ? `${s.label} — closed (history stays in Trajectory/Logs)` : s.sid}
            aria-selected={s.sid === activeSid}
            onClick={() => { if (!s.closed) onActivate(s.sid); }}
          >
            <span className={`tab-dot ${s.kind === "ssh" ? "ssh" : s.kind === "serial" ? "serial" : ""}`} data-kind={s.kind} />
            <span className="tab-name">{s.label}</span>
            <span
              className="tab-export"
              title="Export this session log"
              onClick={(e) => { e.stopPropagation(); onExport(s.sid); }}
            >
              <Icon name="export" size={12} />
            </span>
            {!s.savedOnly && !s.closed && (
              <span
                className="tab-close"
                title="Close session"
                onClick={(e) => { e.stopPropagation(); onClose(s.sid); }}
              >
                <Icon name="close" size={12} />
              </span>
            )}
          </div>
        ))}
      </div>
      {/* round-admin-ui Task 5: per-session view switch (dsh segmented pill) —
          shown only while a session is active. Session-tab behavior above is
          untouched. */}
      {activeSid && (
        <div className="view-switch" role="tablist" aria-label="Session view">
          <button
            type="button"
            className={`view-switch-btn${view === "terminal" ? " active" : ""}`}
            onClick={() => onViewChange("terminal")}
          >Terminal</button>
          <button
            type="button"
            className={`view-switch-btn${view === "trajectory" ? " active" : ""}`}
            onClick={() => onViewChange("trajectory")}
          >Trajectory</button>
        </div>
      )}
    </div>
  );
}
