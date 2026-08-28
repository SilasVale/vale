// DesktopShell — the vale-desktop (Tauri/WebView2) full-screen shell in the
// DSH style: a slim LEFT icon rail (brand mark on top, page icons below,
// connection status pinned at the bottom) + one full-canvas main area.
// No top nav — the rail is the only chrome. Pages:
//   Terminal — multi-session tab bar + xterm panes
//   Browser  — live interactive remote browser (WebSocket JPEG stream)
//   Memory   — device memory browser (memory_* tools)
//   Settings — local agent info
import { useState } from "react";
import type { Session } from "../hooks/useSessions";
import { TerminalPane } from "./TerminalPane";
import BrowserPane from "./BrowserPane";
import { TabBar, type SessionView } from "./TabBar";
import { MemoryPane } from "./MemoryPane";

export type DesktopPage = "terminal" | "browser" | "memory" | "settings";

interface Props {
  sessions: Session[];
  activeSid: string | null;
  onActivate: (sid: string) => void;
  onClose: (sid: string) => void;
  onExport: (sid: string) => void;
  view: SessionView;
  onViewChange: (v: SessionView) => void;
  registerWrite: (sid: string, fn: (bytes: Uint8Array) => void, getRendered: () => number) => (() => void) & { unregister?: (sid: string) => void };
  browserActive: boolean;
  onNewSession: (kind: "pty" | "ssh" | "serial", target?: string, extra?: Record<string, unknown>) => void;
  sseState: string;
  token: string;
}

/** 16px stroke icon set (same family as the gateway console sidebar). */
const icons: Record<DesktopPage, React.ReactNode> = {
  terminal: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  browser: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  memory: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

const NAV_ORDER: DesktopPage[] = ["terminal", "browser", "memory", "settings"];
const NAV_LABELS: Record<DesktopPage, string> = {
  terminal: "Terminal",
  browser: "Browser",
  memory: "Memory",
  settings: "Settings",
};

export function DesktopShell({
  sessions, activeSid, onActivate, onClose, onExport, view, onViewChange,
  registerWrite, browserActive, onNewSession, sseState, token,
}: Props) {
  const [page, setPage] = useState<DesktopPage>("terminal");
  const connected = sseState === "connected";

  return (
    <div className="desktop-shell">
      {/* Left icon rail (DSH style) */}
      <aside className="desktop-rail">
        <div className="desktop-rail-brand" title="Vale">
          <svg width="26" height="26" viewBox="0 0 48 48" aria-hidden="true">
            <defs>
              <linearGradient id="dsh-brand-sky" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#f59f00" />
                <stop offset="1" stopColor="#e8590c" />
              </linearGradient>
              <radialGradient id="dsh-brand-glow" cx=".5" cy=".5" r=".5">
                <stop offset="0" stopColor="#fff8e1" stopOpacity=".55" />
                <stop offset="1" stopColor="#ffe8a3" stopOpacity="0" />
              </radialGradient>
            </defs>
            <rect width="48" height="48" rx="11" fill="url(#dsh-brand-sky)" />
            <circle cx="21" cy="14" r="7.5" fill="url(#dsh-brand-glow)" />
            <circle cx="21" cy="14" r="4" fill="#fff8e1" />
            <path fill="#ffffff" opacity=".78" d="M14 41Q26 16 44 41Z" />
            <path fill="#ffffff" d="M2 41Q12 20 24 41Z" />
          </svg>
        </div>
        <nav className="desktop-rail-nav" aria-label="Desktop pages">
          {NAV_ORDER.map((p) => (
            <button
              key={p}
              type="button"
              className={`desktop-rail-btn${page === p ? " active" : ""}`}
              title={NAV_LABELS[p]}
              aria-label={NAV_LABELS[p]}
              onClick={() => setPage(p)}
            >
              {icons[p]}
            </button>
          ))}
        </nav>
        <div
          className={`desktop-rail-status ${connected ? "ok" : ""}`}
          title={connected ? "agent connected" : sseState || "connecting"}
        >
          <span className="dot" />
        </div>
      </aside>

      {/* Main content */}
      <main className="desktop-main">
        {page === "terminal" && (
          <div className="desktop-terminal">
            <div className="desktop-tabs-row">
              <TabBar
                sessions={sessions}
                activeSid={activeSid}
                onActivate={onActivate}
                onClose={onClose}
                onExport={onExport}
                view={view}
                onViewChange={onViewChange}
              />
              <div className="desktop-new">
                <button className="btn btn-ghost btn-mini" onClick={() => onNewSession("pty")}>+ PTY</button>
                <button className="btn btn-ghost btn-mini" onClick={() => onNewSession("ssh")}>SSH</button>
                <button className="btn btn-ghost btn-mini" onClick={() => onNewSession("serial")}>Serial</button>
              </div>
            </div>
            <div id="desktop-term-container" className={view === "trajectory" ? "hidden" : undefined}>
              {sessions.map((s) => (
                <TerminalPane
                  key={s.sid}
                  session={s}
                  registerWrite={registerWrite}
                />
              ))}
              {browserActive && (
                <BrowserPane
                  session={{ sid: "browser", url: "", active: true }}
                  apiBase=""
                  token={token}
                />
              )}
            </div>
          </div>
        )}

        {page === "browser" && (
          <div className="desktop-browser">
            <BrowserPane
              key="desktop-browser"
              session={{ sid: "browser", url: "", active: true }}
              apiBase=""
              token={token}
            />
          </div>
        )}

        {page === "memory" && <MemoryPane />}

        {page === "settings" && (
          <div className="desktop-settings">
            <h2>Settings</h2>
            <p className="muted">Device: local agent on 127.0.0.1:18080</p>
            <div className="settings-section">
              <h3>Memory</h3>
              <p className="muted">
                Memory entries live in <code>&lt;install&gt;/memory/memory.jsonl</code>, shared across
                AI clients (Claude Code / DSH / this desktop). Capacity is configured in
                config.yaml <code>memory:</code> (max_entries / max_bytes / retention_days).
                AI clients save knowledge via <code>memory_save</code> and query via
                <code> memory_search</code>.
              </p>
              <button className="btn btn-ghost btn-mini" onClick={() => setPage("memory")}>Open Memory</button>
            </div>
            <div className="settings-section">
              <h3>Terminal</h3>
              <p className="muted">
                Sessions (PTY/SSH/serial) are held by the agent service — closing this
                window or refreshing never kills a running session. Reconnect via the
                + buttons or <code>terminal_connect_saved</code>.
              </p>
            </div>
            <div className="settings-section">
              <h3>Transport</h3>
              <p className="muted">
                The desktop shell talks to the agent over loopback HTTP/WS with the
                device token. No cloud dependency — saisi.online endpoints are optional.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
