// react-jsx: no React import needed
import type { Session } from "../hooks/useSessions";

export function TabBar({ sessions, activeSid, onActivate, onClose, onExport }: {
  sessions: Session[];
  activeSid: string | null;
  onActivate: (sid: string) => void;
  onClose: (sid: string) => void;
  onExport: (sid: string) => void;
}) {
  return (
    <div id="tabs" role="tablist" aria-label="Terminal sessions">
      {sessions.map((s) => (
        <div
          key={s.sid}
          className={`tab ${s.closed ? "closed" : ""} ${s.sid === activeSid ? "active" : ""}`}
          title={s.sid}
          // round-86: closed tabs stay clickable — the vanilla panel allowed
          // reviewing a closed session's retained history (the old guard
          // made them dead, so a closed session's log was unreachable).
          onClick={() => onActivate(s.sid)}
        >
          <span className={`tab-dot ${s.kind === "ssh" ? "ssh" : s.kind === "serial" ? "serial" : ""}`} data-kind={s.kind} />
          <span className="tab-name">{s.label}</span>
          {/* round-86: per-tab export restored (vanilla .tab-export) — the
              bulk Export-all couldn't get a single session's log. */}
          <span
            className="tab-export"
            title="Export this session log"
            onClick={(e) => { e.stopPropagation(); onExport(s.sid); }}
          >⇩</span>
          {!s.savedOnly && (
            <span
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); onClose(s.sid); }}
            >✕</span>
          )}
        </div>
      ))}
    </div>
  );
}
