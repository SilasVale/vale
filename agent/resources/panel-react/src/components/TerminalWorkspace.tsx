// TerminalWorkspace — the ONE implementation of the terminal page for both
// densities. Owns per-session view (terminal|trajectory), the Logs command
// drawer, and the active session's command stream. The old App-level
// browserActive/detailsOpen/selectedCmdId state lives HERE now (design doc §5).
import { useState } from "react";
import type { Session } from "../hooks/useSessions";
import { TabBar, type SessionView } from "./TabBar";
import { TerminalPane } from "./TerminalPane";
import BrowserPane from "./BrowserPane";
import { TrajectoryView } from "./TrajectoryView";
import { DetailsPanel } from "./DetailsPanel";
import { CommandStream } from "./CommandCard";
import type { CommandEvent } from "../hooks/useCommandEvents";

/** The command-events slice TerminalWorkspace consumes from App. */
export interface CommandEvents {
  cards: { id: string; command: string; output: string; startedAt: number; ended: boolean; exitCode: number | null; reason: string | null; durationMs: number | null; seq: number }[];
  events: CommandEvent[];
}

export interface WorkspaceSession extends Session {
  active: boolean;
}

interface Props {
  sessions: WorkspaceSession[];
  activeSid: string | null;
  onActivate: (sid: string) => void;
  onClose: (sid: string) => void;
  onExport: (sid: string) => void;
  onViewChange: (sid: string, v: SessionView) => void;
  registerWrite: (sid: string, fn: (bytes: Uint8Array) => void, getRendered: () => number) => (() => void) & { unregister?: (sid: string) => void };
  cmdEvents: CommandEvents;
  browserActive: boolean;
  token: string;
  density: "panel" | "desktop";
}

export function TerminalWorkspace({
  sessions, activeSid, onActivate, onClose, onExport, onViewChange,
  registerWrite, cmdEvents, browserActive, token, density,
}: Props) {
  const [selectedCmdId, setSelectedCmdId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sessionViews, setSessionViews] = useState<Record<string, SessionView>>({});
  const sessionView: SessionView = (activeSid && sessionViews[activeSid]) || "terminal";
  const trajOpen = !!activeSid && sessionView === "trajectory";
  const selectedCard = selectedCmdId ? cmdEvents.cards.find((c) => c.id === selectedCmdId) ?? null : null;

  const changeView = (v: SessionView) => {
    if (activeSid) {
      setSessionViews((m) => ({ ...m, [activeSid]: v }));
      onViewChange(activeSid, v);
    }
  };

  return (
    <>
      {density === "desktop" ? (
        <div className="desktop-terminal">
          <div className="desktop-tabs-row">
            <TabBar
              sessions={sessions}
              activeSid={activeSid}
              onActivate={onActivate}
              onClose={onClose}
              onExport={onExport}
              view={sessionView}
              onViewChange={changeView}
            />
            <div className="desktop-new">
              {/* New-session entry points are provided by the parent (menu on
                  panel density, buttons here on desktop density). */}
            </div>
          </div>
          <div id="desktop-term-container" className={trajOpen ? "hidden" : undefined}>
            {trajOpen && activeSid ? (
              <TrajectoryView key={activeSid} events={cmdEvents.events} />
            ) : (
              <>
                {browserActive && (
                  <BrowserPane
                    key="browser"
                    session={{ sid: "browser", url: "", active: true }}
                    apiBase=""
                    token={token}
                  />
                )}
                {!browserActive && sessions.filter((s) => !s.closed).map((s) => (
                  <TerminalPane key={s.sid} session={s} registerWrite={registerWrite} />
                ))}
                {!browserActive && sessions.length === 0 && (
                  <div id="empty-state"><div className="empty-card"><span className="empty-mark">V</span><p>No sessions yet</p></div></div>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          <div id="canvas-top">
            <TabBar
              sessions={sessions}
              activeSid={activeSid}
              onActivate={onActivate}
              onClose={onClose}
              onExport={onExport}
              view={sessionView}
              onViewChange={changeView}
            />
            <button
              id="cmd-toggle"
              className={detailsOpen ? "active" : ""}
              title="Command log"
              onClick={() => {
                if (detailsOpen) { setDetailsOpen(false); setSelectedCmdId(null); }
                else setDetailsOpen(true);
              }}
            >Logs</button>
          </div>
          {trajOpen && activeSid ? (
            <TrajectoryView key={activeSid} events={cmdEvents.events} />
          ) : (
            <div id="term-container">
              <div className="browser-wrap" style={{ display: browserActive ? undefined : "none" }}>
                <BrowserPane key="browser" session={{ sid: "browser", url: "", active: true }} apiBase="" token={token} />
              </div>
              {!browserActive && (sessions.length === 0 ? (
                <div id="empty-state">
                  <div className="empty-card"><span className="empty-mark">V</span><p>No sessions yet</p></div>
                </div>
              ) : (
                sessions.filter((s) => !s.closed).map((s) => (
                  <TerminalPane key={s.sid} session={s} registerWrite={registerWrite} />
                ))
              ))}
            </div>
          )}
          {detailsOpen && (
            <div id="drawer">
              <div id="drawer-inner">
                <div id="drawer-head">
                  <span>Commands</span>
                  <button title="Close" onClick={() => { setDetailsOpen(false); setSelectedCmdId(null); }}>✕</button>
                </div>
                <DetailsPanel card={selectedCard} onClose={() => setSelectedCmdId(null)} />
                <CommandStream
                  cards={cmdEvents.cards}
                  selectedId={selectedCmdId}
                  onSelect={(id) => {
                    if (id === selectedCmdId) { setSelectedCmdId(null); }
                    else { setSelectedCmdId(id); }
                  }}
                />
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
