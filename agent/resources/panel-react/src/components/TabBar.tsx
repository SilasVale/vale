// react-jsx: no React import needed
import type { Session } from "../hooks/useSessions";

export function TabBar({ sessions, activeSid, onActivate, onClose }: {
  sessions: Session[];
  activeSid: string | null;
  onActivate: (sid: string) => void;
  onClose: (sid: string) => void;
}) {
  return (
    <div id="tabs" role="tablist" aria-label="Terminal sessions">
      {sessions.map((s) => (
        <div
          key={s.sid}
          className={`tab ${s.closed ? "closed" : ""} ${s.sid === activeSid ? "active" : ""}`}
          title={s.sid}
          onClick={() => !s.closed && onActivate(s.sid)}
        >
          <span className={`tab-dot ${s.kind === "ssh" ? "ssh" : s.kind === "serial" ? "serial" : ""}`} data-kind={s.kind} />
          <span className="tab-name">{s.label}</span>
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
