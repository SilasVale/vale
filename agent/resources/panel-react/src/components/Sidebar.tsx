import { useEffect, useState } from "react";
import type { Session } from "../hooks/useSessions";
import type { usePlugins } from "../hooks/usePlugins";

// dsh Rows-style session list (round-admin-ui Task 3): each row is a kind
// StateDot + label + relative time; hovering swaps the time for
// rename/archive actions.
//
// Rename/archive are CLIENT-SIDE for now — Phase 1 core has no server-side
// rename/archive API (the agent's /api/sessions list is read-only, and the
// design spec scopes row actions to the sidebar). A rename overrides the
// label locally, archive hides the row; both survive the 3s useSessions
// poll (it mutates the same array in place, it never recreates rows).
// Server-side persistence lands when an API exists.
function relTime(ts: number): string {
  const sec = Math.max(0, (Date.now() - ts) / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return day < 7 ? `${day}d` : new Date(ts).toLocaleDateString();
}

export function Sidebar({ sessions, activeSid, onActivate, view, onViewChange, plugins }: {
  sessions: Session[];
  activeSid: string | null;
  onActivate: (sid: string) => void;
  view: "sessions" | "plugins";
  onViewChange: (v: "sessions" | "plugins") => void;
  plugins: ReturnType<typeof usePlugins>;
}) {
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [archived, setArchived] = useState<Set<string>>(new Set());
  // Re-render so relative times stay fresh (dsh shows "3m"-style labels).
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const rename = (sid: string, current: string) => {
    const name = window.prompt("Rename session", current);
    if (name && name.trim()) {
      setLabels((prev) => {
        const next = new Map(prev);
        next.set(sid, name.trim());
        return next;
      });
    }
  };

  // Live sessions first, newest-opened first; closed (tombstone) after.
  const rows = [...sessions]
    .filter((s) => !archived.has(s.sid))
    .sort((a, b) => (a.closed === b.closed ? b.openedAt - a.openedAt : a.closed ? 1 : -1));

  return (
    <>
      {/* round-admin-ui Task 6: section nav — Sessions | Plugins. The plugin
          rows below share the live status hook, so the dots stay current. */}
      <div className="side-nav" role="tablist" aria-label="Panel sections">
        <button
          className={`side-nav-btn${view === "sessions" ? " active" : ""}`}
          role="tab"
          aria-selected={view === "sessions"}
          onClick={() => onViewChange("sessions")}
        >Sessions</button>
        <button
          className={`side-nav-btn${view === "plugins" ? " active" : ""}`}
          role="tab"
          aria-selected={view === "plugins"}
          onClick={() => onViewChange("plugins")}
        >Plugins</button>
      </div>
      {view === "plugins" ? (
        <>
          <div className="side-header">
            <h1 className="side-title">Plugins</h1>
            <span className="side-count">{plugins.rows.length}</span>
          </div>
          <div className="side-list">
            {!plugins.specLoaded && <p className="side-empty">Inventory loading…</p>}
            {plugins.specLoaded && plugins.rows.length === 0 && <p className="side-empty">No plugins</p>}
            {plugins.rows.map((r) => (
              <div key={r.name} className="side-plug-row" title={r.description}>
                <span className="plug-dot" data-state={r.state} />
                <span className="side-label">{r.displayName}</span>
                <span className="side-time">{r.stateLabel}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
      <>
      <div className="side-header">
        <h1 className="side-title">Sessions</h1>
        <span className="side-count">{sessions.length}</span>
      </div>
      <div className="side-list">
        {rows.length === 0 && <p className="side-empty">No sessions yet</p>}
        {rows.map((s) => (
          <div
            key={s.sid}
            role="button"
            tabIndex={0}
            title={s.sid}
            className={`side-row ${s.closed ? "closed" : ""} ${s.sid === activeSid ? "active" : ""}`}
            // round-117: a closed (tombstone) row must NOT become active —
            // round-113 unmounted closed panes, so activating one blanks the
            // terminal area. useSessions.activate guards too; the sidebar
            // doesn't even ask.
            onClick={() => { if (!s.closed) onActivate(s.sid); }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !s.closed) {
                e.preventDefault();
                onActivate(s.sid);
              }
            }}
          >
            <span className="side-dot" data-kind={s.kind} />
            <span className="side-label">{labels.get(s.sid) || s.label}</span>
            <span className="side-time">{relTime(s.openedAt)}</span>
            <span className="side-actions">
              <button
                className="side-action"
                title="Rename (local)"
                onClick={(e) => { e.stopPropagation(); rename(s.sid, labels.get(s.sid) || s.label); }}
              >Rename</button>
              <button
                className="side-action archive"
                title="Hide from list"
                onClick={(e) => {
                  e.stopPropagation();
                  setArchived((prev) => { const next = new Set(prev); next.add(s.sid); return next; });
                }}
              >Archive</button>
            </span>
          </div>
        ))}
      </div>
      </>
      )}
    </>
  );
}
