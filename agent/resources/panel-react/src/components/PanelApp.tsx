// PanelApp — the panel-density app: Shell (panel density) with the context
// rail (sessions/plugins) + status bar. Renders the SAME pages as the desktop
// density (design doc §4). The old AppFrame three-column wiring + Sidebar
// dual-view are replaced by Shell + ContextRail.
import { useState } from "react";
import type { Session } from "../hooks/useSessions";
import { IconRail } from "./IconRail";
import { Shell, type Page } from "./Shell";
import { ContextRail } from "./ContextRail";
import { StatusBar } from "./StatusBar";
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
  onNewSession: (kind: "pty" | "ssh" | "serial" | "browser") => void;
  status: string;
  sseState: string;
  token: string;
  plugins: ReturnType<typeof usePlugins>;
  cmdEvents: CommandEvents;
  connModal: "ssh" | "serial" | null;
  onConnClose: () => void;
  onConnConnect: (kind: "ssh" | "serial", target: string, extra: Record<string, unknown>) => Promise<unknown>;
}

export function PanelApp(props: Props) {
  const [page, setPage] = useState<Page>("terminal");
  const connected = props.sseState === "connected";

  return (
    <>
      <Shell
        density="panel"
        iconRail={
          <IconRail
            page={page}
            onPageChange={setPage}
            connected={connected}
          />
        }
        contextRail={page === "terminal" || page === "plugins" ? (
          <ContextRail
            page={page}
            sessions={props.sessions}
            activeSid={props.activeSid}
            onActivate={props.onActivate}
            onNewSession={props.onNewSession}
            plugins={props.plugins}
          />
        ) : undefined}
        statusBar={
          <StatusBar
            sessions={props.sessions}
            status={props.status}
            sseState={props.sseState as "connected" | "down" | "connecting"}
          />
        }
        canvas={
          <div id="panel-main">
            {props.connModal && (
              <ConnModal
                kind={props.connModal}
                onClose={props.onConnClose}
                onConnect={(target, extra) => props.onConnConnect(props.connModal!, target, extra)}
              />
            )}
            {page === "terminal" && (
              <TerminalWorkspace
                sessions={props.sessions as any}
                activeSid={props.activeSid}
                onActivate={props.onActivate}
                onClose={props.onClose}
                onExport={props.onExport}
                onViewChange={props.onViewChange}
                registerWrite={props.registerWrite}
                cmdEvents={props.cmdEvents}
                token={props.token}
                density="panel"
                sseState={props.sseState as "connected" | "down" | "connecting"}
              />
            )}
            {page === "browser" && <BrowserPage token={props.token} />}
            {page === "memory" && <MemoryPage />}
            {page === "plugins" && <PluginsPage plugins={props.plugins} />}
            {page === "settings" && <SettingsPage onOpenMemory={() => setPage("memory")} />}
          </div>
        }
      />
    </>
  );
}
