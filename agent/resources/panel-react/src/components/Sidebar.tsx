import { useEffect, useRef, useState } from "react";
import type { Session } from "../hooks/useSessions";
import type { usePlugins } from "../hooks/usePlugins";

// dsh Rows-style session list (round-admin-ui Task 3): each row is a kind
// StateDot + label + relative time; hovering swaps the time for
// rename/archive actions.
//
// round-133: "Sessions" 标题旁新增 "+" 下拉菜单(PTY/SSH/Serial)——新建入口
// 从主区工具栏移到侧栏标题旁(dsh 风格)。Browser 会话行由 App 注入。
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

export function Sidebar({ sessions, activeSid, onActivate, onViewChange, onNewSession, plugins }: {
  sessions: Session[];
  activeSid: string | null;
  onActivate: (sid: string) => void;
  onViewChange: (v: "sessions" | "plugins") => void;
  onNewSession: (kind: "pty" | "ssh" | "serial") => void;
  plugins: ReturnType<typeof usePlugins>;
}) {
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [archived, setArchived] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Re-render so relative times stay fresh (dsh shows "3m"-style labels).
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  // 点击面板其它区域关闭新建菜单
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

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
        {/* round-133: 新建会话入口移到标题旁(dsh 风格 "+")。 */}
        <div className="side-add-wrap" ref={menuRef}>
          <button
            className="side-add"
            title="New session"
            aria-label="New session"
            onClick={() => setMenuOpen((m) => !m)}
          >+</button>
          {menuOpen && (
            <div className="side-menu" role="menu">
              <button role="menuitem" onClick={() => { onNewSession("pty"); setMenuOpen(false); }}>Local shell</button>
              <button role="menuitem" onClick={() => { onNewSession("ssh"); setMenuOpen(false); }}>SSH…</button>
              <button role="menuitem" onClick={() => { onNewSession("serial"); setMenuOpen(false); }}>Serial…</button>
            </div>
          )}
        </div>
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
