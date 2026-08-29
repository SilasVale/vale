// ContextRail — panel-density context rail: for the Terminal page it shows
// the session list (+ new-session menu), for the Plugins page the plugin
// inventory. Other pages hide it entirely (the Shell only renders it when the
// page has a context).
// round-161: unicode glyphs → Icon set; session rename is INLINE (was
// window.prompt, which Tauri blocks and feels alien).
import { useEffect, useRef, useState } from "react";
import type { Session } from "../hooks/useSessions";
import type { usePlugins } from "../hooks/usePlugins";
import type { Page } from "./Shell";
import { Icon } from "../ui/Icon";

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

export function ContextRail({ page, sessions, activeSid, onActivate, onNewSession, plugins }: {
  page: Page;
  sessions: Session[];
  activeSid: string | null;
  onActivate: (sid: string) => void;
  onNewSession: (kind: "pty" | "ssh" | "serial") => void;
  plugins: ReturnType<typeof usePlugins>;
}) {
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [archived, setArchived] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const commitRename = (sid: string) => {
    const name = renameDraft.trim();
    if (name) {
      setLabels((prev) => {
        const next = new Map(prev);
        next.set(sid, name);
        return next;
      });
    }
    setRenaming(null);
  };

  const rows = [...sessions]
    .filter((s) => !archived.has(s.sid))
    .sort((a, b) => (a.closed === b.closed ? b.openedAt - a.openedAt : a.closed ? 1 : -1));

  if (page === "plugins") {
    return (
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
    );
  }

  if (page !== "terminal") return null;

  return (
    <>
      <div className="side-header">
        <h1 className="side-title">Sessions</h1>
        <span className="side-count">{sessions.length}</span>
        <div className="side-add-wrap" ref={menuRef}>
          <button
            className="side-add"
            title="New session"
            aria-label="New session"
            onClick={() => setMenuOpen((m) => !m)}
          >
            <Icon name="plus" size={14} />
          </button>
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
            onClick={() => { if (!s.closed) onActivate(s.sid); }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !s.closed) {
                e.preventDefault();
                onActivate(s.sid);
              }
            }}
          >
            <span className="side-dot" data-kind={s.kind} />
            {renaming === s.sid ? (
              <input
                className="side-rename"
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => commitRename(s.sid)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(s.sid);
                  if (e.key === "Escape") setRenaming(null);
                }}
                onClick={(e) => e.stopPropagation()}
                aria-label="Rename session"
              />
            ) : (
              <span className="side-label">{labels.get(s.sid) || s.label}</span>
            )}
            <span className="side-time">{relTime(s.openedAt)}</span>
            <span className="side-actions">
              <button
                className="side-action"
                title="Rename (local)"
                aria-label="Rename session"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenameDraft(labels.get(s.sid) || s.label);
                  setRenaming(s.sid);
                }}
              >
                <Icon name="edit" size={12} />
              </button>
              <button
                className="side-action archive"
                title="Hide from list"
                aria-label="Archive session"
                onClick={(e) => {
                  e.stopPropagation();
                  setArchived((prev) => { const next = new Set(prev); next.add(s.sid); return next; });
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
