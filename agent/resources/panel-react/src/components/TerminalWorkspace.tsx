// TerminalWorkspace — the ONE implementation of the terminal page for both
// densities. Owns per-session view (terminal|trajectory), the Logs command
// drawer, and the active session's command stream. The old App-level
// detailsOpen/selectedCmdId state lives HERE now (design doc §5).
import { useState } from "react";
import type { Session } from "../hooks/useSessions";
import { TabBar, type SessionView } from "./TabBar";
import { Icon } from "../ui/Icon";
import { TerminalPane } from "./TerminalPane";
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
  token: string;
  density: "panel" | "desktop";
  sseState: "connected" | "down" | "connecting";
  /** Desktop density: the header (DesktopShell) owns the view switch —
   *  pass the controlled value + setter so both render the same view. */
  controlledView?: SessionView;
  onControlledViewChange?: (sid: string, v: SessionView) => void;
}

export function TerminalWorkspace({
  sessions, activeSid, onActivate, onClose, onExport, onViewChange,
  registerWrite, cmdEvents, token, density, sseState,
  controlledView, onControlledViewChange,
}: Props) {
  const [selectedCmdId, setSelectedCmdId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sessionViews, setSessionViews] = useState<Record<string, SessionView>>({});
  const sessionView: SessionView = density === "desktop"
    ? (controlledView ?? "terminal")
    : ((activeSid && sessionViews[activeSid]) || "terminal");
  const trajOpen = !!activeSid && sessionView === "trajectory";
  const selectedCard = selectedCmdId ? cmdEvents.cards.find((c) => c.id === selectedCmdId) ?? null : null;

  const changeView = (v: SessionView) => {
    if (!activeSid) return;
    if (density === "desktop") {
      onControlledViewChange?.(activeSid, v);
      return;
    }
    setSessionViews((m) => ({ ...m, [activeSid]: v }));
    onViewChange(activeSid, v);
  };

  // Browserless-style connection banner: the SSE stream dropped — say so in
  // place instead of leaving the user typing into a frozen terminal.
  const reconnectBanner = sseState === "down" ? (
    <div className="term-reconnect">Connection lost — reconnecting…</div>
  ) : null;

  return (
    <>
      {/* Terminal page banner (both densities) */}
      {reconnectBanner}
      {density === "desktop" ? (
        <div className="desktop-terminal">
          {/* Desktop density: session tabs + New menu live in the header card
              (DesktopShell) — this workspace renders ONLY the terminal area.
              The trajectory/terminal view switch is a header button. */}
          <div id="desktop-term-container" className={trajOpen ? "hidden" : undefined}>
            {trajOpen && activeSid ? (
              <TrajectoryView key={activeSid} events={cmdEvents.events} />
            ) : (
              <>
                {sessions.filter((s) => !s.closed).map((s) => (
                  <TerminalPane key={s.sid} session={s} registerWrite={registerWrite} />
                ))}
                {sessions.length === 0 && (
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
              {sessions.length === 0 ? (
                <div id="empty-state">
                  <div className="empty-card"><span className="empty-mark">V</span><p>No sessions yet</p></div>
                </div>
              ) : (
                sessions.filter((s) => !s.closed).map((s) => (
                  <TerminalPane key={s.sid} session={s} registerWrite={registerWrite} />
                ))
              )}
            </div>
          )}
          {detailsOpen && (
            <div id="drawer">
              <div id="drawer-inner">
                <div id="drawer-head">
                  <span>Commands</span>
                  <button title="Close" onClick={() => { setDetailsOpen(false); setSelectedCmdId(null); }}><Icon name="close" size={13} /></button>
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
