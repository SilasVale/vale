// DesktopShell — the desktop-density page router. It is NOT a second
// implementation of the app: it renders the same pages as the panel density,
// inside the Shell (desktop density). Terminal page = TerminalWorkspace;
// browser/memory/plugins/settings = the same page components as panel.
import { useState } from "react";
import type { Session } from "../hooks/useSessions";
import { IconRail } from "./IconRail";
import { Shell, type Page } from "./Shell";
import { TerminalWorkspace, type CommandEvents } from "./TerminalWorkspace";
import { BrowserPage } from "./BrowserPage";
import { MemoryPage } from "./MemoryPage";
import { PluginsPage } from "./PluginsPage";
import { SettingsPage } from "./SettingsPage";
import { ConnModal } from "./ConnModal";
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
  const connected = sseState === "connected";
  // round-164: the desktop density hid session status (open/close failures)
  // — panel density shows StatusBar, desktop had nothing, so a failed SSH/
  // serial connect was invisible. A slim status strip at the foot mirrors it.
  const statusError = status.startsWith("error") || status.startsWith("open failed") || status.startsWith("close failed");

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
        <>
          {/* In-app nav strip: page title + new-session buttons on Terminal */}
          <div className="desktop-nav">
            {page === "terminal" && (
              <div className="desktop-new">
                <button className="btn btn-ghost btn-mini" onClick={() => onNewSession("pty")}>+ PTY</button>
                <button className="btn btn-ghost btn-mini" onClick={() => onNewSession("ssh")}>SSH</button>
                <button className="btn btn-ghost btn-mini" onClick={() => onNewSession("serial")}>Serial</button>
                <button className="btn btn-ghost btn-mini" onClick={() => onNewSession("browser")}>Browser…</button>
              </div>
            )}
            <span className="desktop-nav-label">{PAGE_TITLES[page]}</span>
          </div>

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
            />
          )}
          {page === "browser" && <BrowserPage plugins={plugins} token={token} />}
          {page === "memory" && <MemoryPage />}
          {page === "plugins" && <PluginsPage plugins={plugins} />}
          {page === "settings" && <SettingsPage onOpenMemory={() => setPage("memory")} />}

          {/* Desktop status strip — panel's StatusBar equivalent. Session
              open/close failures MUST be visible in the desktop density
              (round-164: they were swallowed silently before). */}
          <div className={`desktop-status${statusError ? " error" : ""}`}>
            {status && <span className="desktop-status-msg">{status}</span>}
            {!status && sseState === "down" && <span className="desktop-status-msg">Connection lost — reconnecting…</span>}
            {!status && sseState !== "down" && (
              <span className="desktop-status-msg">
                {sessions.filter((s) => !s.closed).length} session{sessions.filter((s) => !s.closed).length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </>
      }
    />
  );
}
