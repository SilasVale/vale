// TerminalWorkspace — the ONE implementation of the terminal page for both
// densities. Owns per-session view (terminal|trajectory), the Logs command
// drawer, and the active session's command stream. The old App-level
// detailsOpen/selectedCmdId state lives HERE now (design doc §5).
import { useEffect, useRef, useState } from "react";
import type { Session } from "../hooks/useSessions";
import { TabBar, type SessionView } from "./TabBar";
import { Icon } from "../ui/Icon";
import { TerminalPane } from "./TerminalPane";
import { TrajectoryView } from "./TrajectoryView";
import { PathView } from "./PathView";
import { SessionControl } from "./SessionControl";
import { ApprovalGate } from "./ApprovalGate";
import { GoalBar } from "./GoalBar";
import { DetailsPanel } from "./DetailsPanel";
import { CommandStream } from "./CommandCard";
import type { CommandEvent } from "../hooks/useCommandEvents";

/** The command-events slice TerminalWorkspace consumes from App. */
export interface CommandEvents {
  cards: { id: string; command: string; output: string; startedAt: number; ended: boolean; exitCode: number | null; reason: string | null; durationMs: number | null; seq: number }[];
  events: CommandEvent[];
  /** Where the device's copy of this trail BEGINS (the route's `first_seq`).
   *  This slice existed at runtime since round 23 and the TYPE did not declare
   *  it, which is how the live view came to state an obligation it could not
   *  meet: the value was in scope one line above the mount and the type said it
   *  was not there. */
  firstSeq: number;
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
  /** Hand the session's keyboard to a person / back to the AI. */
  onSetControl: (sid: string, human: boolean) => Promise<unknown>;
  /** Arm/disarm the approval gate for a session. */
  onSetApproval: (sid: string, required: boolean) => Promise<unknown>;
  /** Answer a pending approval request. */
  onDecideApproval: (sid: string, id: string, approve: boolean, grant?: boolean) => Promise<unknown>;
  /** Revoke one approval grant, or every one when omitted. */
  onRevokeGrants: (sid: string, grant?: string) => Promise<unknown>;
  /** State the session's goal, or clear it with an empty string. */
  onSetGoal: (sid: string, goal: string) => Promise<unknown>;
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
  sessions, activeSid, onActivate, onClose, onExport, onViewChange, onSetControl,
  onSetApproval, onDecideApproval, onRevokeGrants, onSetGoal,
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
  const pathOpen = !!activeSid && sessionView === "path";
  // The active session record — used to stamp a saved recipe with what the
  // commands were actually run against (shell kind + label).
  const activeSession = sessions.find((s) => s.sid === activeSid);

  // Control handoff — rendered in BOTH densities from this one place, because
  // both render this workspace and a per-density copy is how the two drifted
  // before (R131). Hidden until a session is active: there is nothing to hold.
  const control = activeSession && !activeSession.closed ? (
    <>
      <SessionControl
        held={!!activeSession.heldByHuman}
        onSet={(human) => onSetControl(activeSession.sid, human)}
      />
      <GoalBar
        goal={activeSession.goal}
        onSet={(g) => onSetGoal(activeSession.sid, g)}
      />
      <ApprovalGate
        armed={!!activeSession.approvalRequired}
        pending={activeSession.pendingApproval}
        grants={activeSession.approvalGrants}
        onArm={(required) => onSetApproval(activeSession.sid, required)}
        onDecide={(id, approve, grant) =>
          onDecideApproval(activeSession.sid, id, approve, grant)
        }
        onRevoke={(grant) => onRevokeGrants(activeSession.sid, grant)}
      />
    </>
  ) : null;
  const selectedCard = selectedCmdId ? cmdEvents.cards.find((c) => c.id === selectedCmdId) ?? null : null;

  // stage-n: refit terminals after the drawer finishes its enter/exit
  // transition — opening the Logs drawer changes the container size but the
  // old code didn't trigger refit, so the grid stayed wrong until next resize.
  useEffect(() => {
    if (!detailsOpen) return;
    const t = setTimeout(() => {
      // Dispatch a window resize event — TerminalPane listens for it and refits.
      window.dispatchEvent(new Event("resize"));
    }, 250); // match drawer transition duration
    return () => clearTimeout(t);
  }, [detailsOpen]);

  // stage-n: refit on drawer CLOSE too — the container grows back and the
  // terminal grid must expand to match.
  const prevDetailsOpen = useRef(detailsOpen);
  useEffect(() => {
    if (prevDetailsOpen.current && !detailsOpen) {
      window.dispatchEvent(new Event("resize"));
    }
    prevDetailsOpen.current = detailsOpen;
  }, [detailsOpen]);

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
          <div className="desktop-term-bar">{control}</div>
          <div id="desktop-term-container" className={trajOpen || pathOpen ? "hidden" : undefined}>
            {pathOpen && activeSid ? (
              <PathView
                key={activeSid}
                events={cmdEvents.events}
                sessionKind={activeSession?.kind}
                sessionLabel={activeSession?.label}
                goal={activeSession?.goal}
                plan={activeSession?.plan}
              />
            ) : trajOpen && activeSid ? (
              <TrajectoryView key={activeSid} events={cmdEvents.events} firstSeq={cmdEvents.firstSeq} />
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
            {control}
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
          {pathOpen && activeSid ? (
            <PathView
              key={activeSid}
              events={cmdEvents.events}
              sessionKind={activeSession?.kind}
              sessionLabel={activeSession?.label}
              goal={activeSession?.goal}
                plan={activeSession?.plan}
            />
          ) : trajOpen && activeSid ? (
            <TrajectoryView key={activeSid} events={cmdEvents.events} firstSeq={cmdEvents.firstSeq} />
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
