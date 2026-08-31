// DesktopShell — the desktop-density page router (stage-l visual refactor:
// card-based layout, clean hierarchy, no redundant chrome).
//
// Layout:
//   [icon rail]  [ header card: page title + session tabs + New menu ]
//                [ content card: terminal / browser / memory / ...   ]
//                [ status strip (folded into the content card footer) ]
//
// The header card and content card sit on a softly-tinted canvas with
// rounded corners + shadow — the desktop app reads as surfaces, not bars.
import { useEffect, useRef, useState } from "react";
import type { Session } from "../hooks/useSessions";
import { IconRail } from "./IconRail";
import { Shell, type Page } from "./Shell";
import { TerminalWorkspace, type CommandEvents } from "./TerminalWorkspace";
import { BrowserPage } from "./BrowserPage";
import { MemoryPage } from "./MemoryPage";
import { PluginsPage } from "./PluginsPage";
import { SettingsPage } from "./SettingsPage";
import { ConnModal } from "./ConnModal";
import { Icon } from "../ui/Icon";
import type { SessionView } from "./TabBar";
import type { usePlugins } from "../hooks/usePlugins";

interface Props {
  sessions: Session[];
  activeSid: string | null;
  onActivate: (sid: string) => void;
  onClose: (sid: string) => void;
  onExport: (sid: string) => void;
  onViewChange: (sid: string, v: SessionView) => void;
  registerWrite: (sid: string, fn: (bytes: Uint8Array) => void, getRendered: () => number) => (() => void) & { unregister?: (sid: string) => void };
  onNewSession: (kind: "pty" | "ssh" | "serial" | "browser", target?: string, extra?: Record<string, unknown>) => void;
  onConnConnect: (kind: "ssh" | "serial", target: string, extra: Record<string, unknown>) => Promise<unknown>;
  connModal: "ssh" | "serial" | null;
  onConnClose: () => void;
  status: string; // session status line (open/close failures etc.)
  sseState: "connected" | "down" | "connecting";
  token: string;
  plugins: ReturnType<typeof usePlugins>;
  cmdEvents: CommandEvents;
}

const PAGE_TITLES: Record<Page, string> = {
  terminal: "Terminal",
  browser: "Browser",
  memory: "Memory",
  plugins: "Plugins",
  settings: "Settings",
};

export function DesktopShell({
  sessions, activeSid, onActivate, onClose, onExport, onViewChange,
  registerWrite, onNewSession, onConnConnect, connModal, onConnClose,
  status, sseState, token, plugins, cmdEvents,
}: Props) {
  const [page, setPage] = useState<Page>("terminal");
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement | null>(null);
  // Per-session terminal|trajectory view — mirrored from TerminalWorkspace
  // (which owns the panel-density copy) so the header toggle stays in sync.
  const [sessionViews, setSessionViews] = useState<Record<string, SessionView>>({});
  const changeView = (sid: string, v: SessionView) => {
    setSessionViews((m) => ({ ...m, [sid]: v }));
    onViewChange(sid, v);
  };
  const activeView: SessionView = (activeSid && sessionViews[activeSid]) || "terminal";
  // Close the New menu on outside click.
  useEffect(() => {
    if (!newMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) setNewMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [newMenuOpen]);
  const connected = sseState === "connected";
  const liveCount = sessions.filter((s) => !s.closed).length;
  const statusError = status.startsWith("error") || status.startsWith("open failed") || status.startsWith("close failed");
  // round-164: desktop density had no status bar — session open/close
  // failures were invisible. The status line folds into the content card
  // footer (visible only when there is something to say).
  const showStatus = !!status || sseState === "down";

  return (
    <Shell
      density="desktop"
      iconRail={
        <IconRail
          page={page}
          onPageChange={setPage}
          connected={connected}
          desktop
        />
      }
      canvas={
        <div className="desktop-canvas">
          {/* ── Header card: page title + session tabs + New menu ── */}
          <header className="desktop-header">
            <div className="desktop-header-title">
              <span className="desktop-header-icon"><Icon name={page === "terminal" ? "terminal" : page === "browser" ? "browser" : page === "memory" ? "memory" : page === "plugins" ? "plugins" : "settings"} size={15} /></span>
              <span>{PAGE_TITLES[page]}</span>
            </div>

            {page === "terminal" && (
              <>
                {/* Session tabs (compact pill strip inside the header) */}
                <div className="desktop-tabs" role="tablist" aria-label="Terminal sessions">
                  {sessions.filter((s) => !s.closed).map((s) => (
                    <div
                      key={s.sid}
                      role="tab"
                      aria-selected={s.sid === activeSid}
                      className={`dtab ${s.sid === activeSid ? "active" : ""}`}
                      title={s.sid}
                      onClick={() => onActivate(s.sid)}
                    >
                      <span className="dtab-dot" data-kind={s.kind} />
                      <span className="dtab-name">{s.label}</span>
                      <span
                        className="dtab-close"
                        title="Close session"
                        onClick={(e) => { e.stopPropagation(); onClose(s.sid); }}
                      >
                        <Icon name="close" size={10} />
                      </span>
                    </div>
                  ))}
                </div>

                {/* New-session menu — ONE entry point instead of four buttons */}
                <div className="desktop-new" ref={newMenuRef}>
                  <button
                    className="btn-new"
                    onClick={() => setNewMenuOpen((o) => !o)}
                    aria-expanded={newMenuOpen}
                  >
                    <Icon name="plus" size={13} /> New
                  </button>
                  {newMenuOpen && (
                    <div className="new-menu" role="menu">
                      <button role="menuitem" onClick={() => { setNewMenuOpen(false); onNewSession("pty"); }}>
                        <span className="nm-ico" data-kind="pty"><Icon name="terminal" size={13} /></span> Terminal
                      </button>
                      <button role="menuitem" onClick={() => { setNewMenuOpen(false); onNewSession("ssh"); }}>
                        <span className="nm-ico" data-kind="ssh"><Icon name="ssh" size={13} /></span> SSH…
                      </button>
                      <button role="menuitem" onClick={() => { setNewMenuOpen(false); onNewSession("serial"); }}>
                        <span className="nm-ico" data-kind="serial"><Icon name="serial" size={13} /></span> Serial…
                      </button>
                      <button role="menuitem" onClick={() => { setNewMenuOpen(false); onNewSession("browser"); }}>
                        <span className="nm-ico" data-kind="browser"><Icon name="browser" size={13} /></span> Browser…
                      </button>
                    </div>
                  )}
                </div>

                {/* Trajectory/terminal view toggle for the ACTIVE session */}
                {activeSid && (
                  <div className="desktop-view-switch" role="tablist" aria-label="Session view">
                    <button
                      type="button"
                      className={`view-switch-btn${activeView === "terminal" ? " active" : ""}`}
                      onClick={() => changeView(activeSid, "terminal")}
                    >Terminal</button>
                    <button
                      type="button"
                      className={`view-switch-btn${activeView === "trajectory" ? " active" : ""}`}
                      onClick={() => changeView(activeSid, "trajectory")}
                    >Trajectory</button>
                  </div>
                )}
              </>
            )}
          </header>

          {/* ── Content card ── */}
          <main className="desktop-content">
            {page === "terminal" && (
              <TerminalWorkspace
                sessions={sessions as any}
                activeSid={activeSid}
                onActivate={onActivate}
                onClose={onClose}
                onExport={onExport}
                onViewChange={onViewChange}
                registerWrite={registerWrite}
                cmdEvents={cmdEvents}
                token={token}
                density="desktop"
                sseState={sseState}
                controlledView={activeView}
                onControlledViewChange={(sid, v) => changeView(sid, v)}
              />
            )}
            {page === "browser" && <BrowserPage plugins={plugins} token={token} />}
            {page === "memory" && <MemoryPage />}
            {page === "plugins" && <PluginsPage plugins={plugins} />}
            {page === "settings" && <SettingsPage onOpenMemory={() => setPage("memory")} />}
          </main>

          {/* ── Status strip: folded into the content card footer ── */}
          {showStatus && (
            <div className={`desktop-status${statusError ? " error" : ""}`}>
              <span className="desktop-status-msg">
                {status || (sseState === "down" ? "Connection lost — reconnecting…" : "")}
              </span>
            </div>
          )}
          {!showStatus && (
            <div className="desktop-status idle">
              <span className="desktop-status-msg">
                {connected ? `${liveCount} session${liveCount === 1 ? "" : "s"}` : "connecting…"}
              </span>
            </div>
          )}

          {/* SSH/Serial connection modal — desktop density mounts it here
              (App's setModalKind is shared with PanelApp; the modal itself
              must render in THIS shell or SSH/Serial buttons are dead). */}
          {connModal && (
            <ConnModal
              kind={connModal}
              onClose={onConnClose}
              onConnect={(target, extra) => onConnConnect(connModal!, target, extra)}
            />
          )}
        </div>
      }
    />
  );
}
