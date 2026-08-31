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
  registerWrite, onNewSession, sseState, token, plugins, cmdEvents,
}: Props) {
  const [page, setPage] = useState<Page>("terminal");
  const connected = sseState === "connected";

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
              </div>
            )}
            <span className="desktop-nav-label">{PAGE_TITLES[page]}</span>
          </div>

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
        </>
      }
    />
  );
}
