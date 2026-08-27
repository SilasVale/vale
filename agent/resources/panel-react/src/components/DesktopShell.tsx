// DesktopShell — the vale-desktop (Tauri/WebView2) full-screen shell:
// a tab strip for the top-level pages (Terminal | Memory | Settings) with the
// terminal page owning the multi-session tab bar + xterm panes. Everything
// reuses the existing panel components; the shell only composes them and
// removes the icon-rail/sidebar chrome for maximum canvas space.
import { useState } from "react";
import type { Session } from "../hooks/useSessions";
import { TerminalPane } from "./TerminalPane";
import BrowserPane from "./BrowserPane";
import { TabBar, type SessionView } from "./TabBar";
import { MemoryPane } from "./MemoryPane";

export type DesktopPage = "terminal" | "memory" | "settings";

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

export function DesktopShell({
  sessions, activeSid, onActivate, onClose, onExport, view, onViewChange,
  registerWrite, browserActive, onNewSession, sseState, token,
}: Props) {
  const [page, setPage] = useState<DesktopPage>("terminal");

  return (
    <div className="desktop-shell">
      <div className="desktop-topbar">
        <div className="desktop-brand">Vale</div>
        <div className="desktop-nav">
          <button className={`desktop-nav-btn${page === "terminal" ? " active" : ""}`} onClick={() => setPage("terminal")}>Terminal</button>
          <button className={`desktop-nav-btn${page === "memory" ? " active" : ""}`} onClick={() => { setPage("memory"); }}>Memory</button>
          <button className={`desktop-nav-btn${page === "settings" ? " active" : ""}`} onClick={() => setPage("settings")}>Settings</button>
        </div>
        <div className={`desktop-status ${sseState === "connected" ? "ok" : ""}`}>
          {sseState === "connected" ? "connected" : sseState}
        </div>
      </div>

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
    </div>
  );
}
