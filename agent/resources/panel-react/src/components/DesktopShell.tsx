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
import { pendingApprovalCount, type Session } from "../hooks/useSessions";
import { useActiveTabVisible } from "../hooks/useActiveTabVisible";
import { useAgentVitals } from "../hooks/useAgentVitals";
import { VitalsDial } from "./VitalsDial";
import { IconRail, PAGE_ICONS } from "./IconRail";
import { Shell, type Page } from "./Shell";
import { TerminalWorkspace, type CommandEvents } from "./TerminalWorkspace";
import { ArchivePage } from "./ArchivePage";
import { ActivityPage } from "./ActivityPage";
import { BrowserPage } from "./BrowserPage";
import { MemoryPage } from "./MemoryPage";
import { PluginsPage } from "./PluginsPage";
import { SettingsPage } from "./SettingsPage";
import { ConnModal } from "./ConnModal";
import { Icon } from "../ui/Icon";
import type { SessionView } from "./TabBar";
import { ViewSwitch } from "./ViewSwitch";
import { WaitingChip } from "./WaitingChip";
import type { usePlugins } from "../hooks/usePlugins";

interface Props {
  sessions: Session[];
  activeSid: string | null;
  onActivate: (sid: string) => void;
  onClose: (sid: string) => void;
  onExport: (sid: string) => void;
  onViewChange: (sid: string, v: SessionView) => void;
  /**
   * The per-session view, OWNED BY App.
   *
   * This shell used to keep its own `useState` copy, which made App's copy
   * write-only: `Ctrl+Shift+Y` (and PathView's "jump to step") wrote App's state and
   * NOTHING rendered from it, so the shortcut was a no-op with every test green.
   * There is one owner now — App, because the shortcut hook lives there — and this is
   * a READ of it.
   */
  sessionViews: Record<string, SessionView>;
  /** Hand the session's keyboard to a person / back to the AI. */
  onSetControl: (sid: string, human: boolean) => Promise<unknown>;
  /** Arm/disarm the approval gate for a session. */
  onSetApproval: (sid: string, required: boolean) => Promise<unknown>;
  /** Answer a pending approval request (`grant` also remembers it). */
  onDecideApproval: (
    sid: string,
    id: string,
    approve: boolean,
    grant?: boolean,
  ) => Promise<unknown>;
  /** Revoke one approval grant, or every one when omitted. */
  onRevokeGrants: (sid: string, grant?: string) => Promise<unknown>;
  /** State the session's goal, or clear it with an empty string. */
  onSetGoal: (sid: string, goal: string) => Promise<unknown>;
  registerWrite: (
    sid: string,
    fn: (bytes: Uint8Array) => void,
    getRendered: () => number,
  ) => (() => void) & { unregister?: (sid: string) => void };
  onNewSession: (
    kind: "pty" | "ssh" | "serial" | "browser",
    target?: string,
    extra?: Record<string, unknown>,
  ) => void;
  onConnConnect: (
    kind: "ssh" | "serial",
    target: string,
    extra: Record<string, unknown>,
  ) => Promise<unknown>;
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
  archive: "Archive",
  activity: "Activity",
  browser: "Browser",
  memory: "Memory",
  plugins: "Plugins",
  settings: "Settings",
};

export function DesktopShell({
  sessions,
  activeSid,
  onActivate,
  onClose,
  onExport,
  onViewChange,
  sessionViews,
  onSetControl,
  onSetApproval,
  onDecideApproval,
  onRevokeGrants,
  onSetGoal,
  registerWrite,
  onNewSession,
  onConnConnect,
  connModal,
  onConnClose,
  status,
  sseState,
  token,
  plugins,
  cmdEvents,
}: Props) {
  const [page, setPage] = useState<Page>("terminal");
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement | null>(null);
  // P1-5: closing a session kills a possibly-running command — inline
  // two-step confirm, copied from the memory_delete pattern (MemoryPage):
  // first click arms ("close?"), second executes. Cancel disarms.
  const [confirmCloseSid, setConfirmCloseSid] = useState<string | null>(null);
  // Same rule as the panel's TabBar (one owner, see the hook's header): the
  // active tab must stay on screen when the activation is programmatic. That
  // counts double here — the desktop strip is narrower than the panel's, so
  // overflow arrives sooner.
  const openTabs = sessions.filter((s) => !s.closed);
  const tabsRef = useActiveTabVisible(activeSid, openTabs.length);
  // Agent version + vitals for the status strip. THE POLL LIVES IN THE HOOK NOW:
  // the panel's instrument line reads the same values, and two copies of this fetch
  // would be two places for the `release` rule to drift — the single defect
  // lib/agentVersion.ts exists to prevent.
  const vitals = useAgentVitals();
  // stage-n: native menu page navigation — the electron menu sends
  // vale-menu commands for pages too (open-memory / open-settings /
  // open-plugins); route them to the page state.
  useEffect(() => {
    const bridge = (window as any).valeDesktop;
    if (!bridge?.onCommand) return;
    const unsub = bridge.onCommand((cmd: string) => {
      if (cmd === "open-browser") setPage("browser");
      else if (cmd === "open-memory") setPage("memory");
      else if (cmd === "open-settings") setPage("settings");
      else if (cmd === "open-plugins") setPage("plugins");
    });
    return unsub;
  }, []);
  // The view comes from App (see the Props comment). The header's own switch still
  // writes through `onViewChange`, so it keeps working — App's setState re-renders this
  // shell in the same batch.
  const changeView = (sid: string, v: SessionView) => {
    onViewChange(sid, v);
  };
  const activeView: SessionView =
    (activeSid && sessionViews[activeSid]) || "terminal";
  // Close the New menu on outside click.
  useEffect(() => {
    if (!newMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node))
        setNewMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [newMenuOpen]);
  const connected = sseState === "connected";
  const liveCount = sessions.filter((s) => !s.closed).length;
  const statusError =
    status.startsWith("error") ||
    status.startsWith("open failed") ||
    status.startsWith("close failed");
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
          pendingCount={pendingApprovalCount(sessions)}
          desktop
        />
      }
      canvas={
        <div className="desktop-canvas">
          {/* ── Header card: page title + session tabs + New menu ── */}
          <header className="desktop-header">
            <div className="desktop-header-title">
              <span className="desktop-header-icon">
                <Icon name={PAGE_ICONS[page]} size={15} />
              </span>
              <span>{PAGE_TITLES[page]}</span>
            </div>

            {page === "terminal" && (
              <>
                {/* Session tabs (compact pill strip inside the header) */}
                <div
                  className="desktop-tabs"
                  role="tablist"
                  aria-label="Terminal sessions"
                  ref={tabsRef}
                >
                  {openTabs.map((s) => {
                    // Same rule as the panel's TabBar (one meaning, two
                    // densities): a question waiting for a person is marked on
                    // the tab itself, keyed on `pendingApproval` — NEVER on the
                    // armed posture, which is permanent and would mark every
                    // session forever.
                    const waiting = !!s.pendingApproval;
                    return (
                      <div
                        key={s.sid}
                        role="tab"
                        aria-selected={s.sid === activeSid}
                        className={`dtab ${s.sid === activeSid ? "active" : ""}`}
                        data-active={s.sid === activeSid ? "1" : undefined}
                        title={
                          waiting
                            ? `${s.sid} — waiting for your approval`
                            : s.sid
                        }
                        aria-label={
                          waiting
                            ? `${s.label} — waiting for your approval`
                            : undefined
                        }
                        onClick={() => onActivate(s.sid)}
                      >
                        <span className="dtab-dot" data-kind={s.kind} />
                        <span className="dtab-name">{s.label}</span>
                        {waiting && (
                          <span className="tab-wait" aria-hidden="true" />
                        )}
                        {confirmCloseSid === s.sid ? (
                          <span
                            className="dtab-confirm"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="tab-confirm-hint">close?</span>
                            <button
                              type="button"
                              className="btn btn-danger btn-mini"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmCloseSid(null);
                                onClose(s.sid);
                              }}
                            >
                              Close
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-mini"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmCloseSid(null);
                              }}
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="dtab-close"
                            title="Close session"
                            aria-label={`Close session ${s.label}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmCloseSid(s.sid);
                            }}
                          >
                            <Icon name="close" size={10} />
                          </button>
                        )}
                      </div>
                    );
                  })}
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
                      <button
                        role="menuitem"
                        onClick={() => {
                          setNewMenuOpen(false);
                          onNewSession("pty");
                        }}
                      >
                        <span className="nm-ico" data-kind="pty">
                          <Icon name="terminal" size={13} />
                        </span>{" "}
                        Terminal
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setNewMenuOpen(false);
                          onNewSession("ssh");
                        }}
                      >
                        <span className="nm-ico" data-kind="ssh">
                          <Icon name="ssh" size={13} />
                        </span>{" "}
                        SSH…
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setNewMenuOpen(false);
                          onNewSession("serial");
                        }}
                      >
                        <span className="nm-ico" data-kind="serial">
                          <Icon name="serial" size={13} />
                        </span>{" "}
                        Serial…
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setNewMenuOpen(false);
                          onNewSession("browser");
                        }}
                      >
                        <span className="nm-ico" data-kind="browser">
                          <Icon name="browser" size={13} />
                        </span>{" "}
                        Browser…
                      </button>
                    </div>
                  )}
                </div>

                {/* View switch for the ACTIVE session — shared with the panel
                    density so the two cannot disagree on which views exist. */}
                {activeSid && (
                  <ViewSwitch
                    view={activeView}
                    onChange={(v) => changeView(activeSid, v)}
                    className="desktop-view-switch"
                  />
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
                onSetControl={onSetControl}
                onSetApproval={onSetApproval}
                onDecideApproval={onDecideApproval}
                onRevokeGrants={onRevokeGrants}
                onSetGoal={onSetGoal}
                registerWrite={registerWrite}
                cmdEvents={cmdEvents}
                token={token}
                density="desktop"
                sseState={sseState}
                controlledView={activeView}
                onControlledViewChange={(sid, v) => changeView(sid, v)}
              />
            )}
            {page === "archive" && <ArchivePage sessions={sessions} />}
            {page === "activity" && <ActivityPage />}
            {page === "browser" && <BrowserPage token={token} />}
            {page === "memory" && <MemoryPage />}
            {page === "plugins" && <PluginsPage plugins={plugins} />}
            {page === "settings" && (
              <SettingsPage onOpenMemory={() => setPage("memory")} />
            )}
          </main>

          {/* ── Status strip: folded into the content card footer ── */}
          {showStatus && (
            <div className={`desktop-status${statusError ? " error" : ""}`}>
              <span className="desktop-status-msg">
                {status ||
                  (sseState === "down"
                    ? "Connection lost — reconnecting…"
                    : "")}
              </span>
              {/* This density has no StatusBar, so the device-level waiting
                  count lives here instead (same shared chip). */}
              <WaitingChip sessions={sessions} />
            </div>
          )}
          {!showStatus && (
            <div className="desktop-status idle">
              {/* The dial reads the same vitals the sentence spells out. Two
                  densities, ONE instrument — the desktop strip is a footer rather
                  than an instrument line, so the arcs sit beside the text instead of
                  replacing it. The sentence keeps every value, so nothing here is
                  colour-only. */}
              <VitalsDial cpu={vitals.cpu} mem={vitals.mem} size={18} />
              <span className="desktop-status-msg">
                {connected
                  ? `${liveCount} session${liveCount === 1 ? "" : "s"}${vitals.release ? ` · v${vitals.release}` : ""}${vitals.uptime ? ` · up ${vitals.uptime}` : ""}${vitals.cpu !== null ? ` · CPU ${Math.round(vitals.cpu)}%` : ""}${vitals.mem !== null ? ` · MEM ${Math.round(vitals.mem)}%` : ""}`
                  : "connecting…"}
              </span>
              <WaitingChip sessions={sessions} />
            </div>
          )}

          {/* SSH/Serial connection modal — desktop density mounts it here
              (App's setModalKind is shared with PanelApp; the modal itself
              must render in THIS shell or SSH/Serial buttons are dead). */}
          {connModal && (
            <ConnModal
              kind={connModal}
              onClose={onConnClose}
              onConnect={(target, extra) =>
                onConnConnect(connModal!, target, extra)
              }
            />
          )}
        </div>
      }
    />
  );
}
