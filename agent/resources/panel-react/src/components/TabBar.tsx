// react-jsx: no React import needed
import { useState } from "react";
import type { Session } from "../hooks/useSessions";
import { useActiveTabVisible } from "../hooks/useActiveTabVisible";
import { Icon } from "../ui/Icon";
import { ViewSwitch } from "./ViewSwitch";

/** Per-session main-area view (round-admin-ui Task 5): the terminal pane +
 *  command card stream, the raw trajectory timeline, or the PATH — this
 *  session's work as a scannable list of steps plus a summary (design §2.1/§7). */
export type SessionView = "terminal" | "trajectory" | "path";

export function TabBar({ sessions, activeSid, onActivate, onClose, onExport, view, onViewChange }: {
  sessions: Session[];
  activeSid: string | null;
  onActivate: (sid: string) => void;
  onClose: (sid: string) => void;
  onExport: (sid: string) => void;
  view: SessionView;
  onViewChange: (v: SessionView) => void;
}) {
  // P1-5: closing a session kills a possibly-running command — inline
  // two-step confirm, copied from the memory_delete pattern (MemoryPage):
  // first click arms ("close?"), second executes. Cancel disarms.
  const [confirmSid, setConfirmSid] = useState<string | null>(null);
  // Keep the ACTIVE tab on screen: every activation here is programmatic
  // (close selects a neighbour, the AI opens sessions, a deep link selects),
  // and none of those scroll the strip — see the hook's header.
  const tabsRef = useActiveTabVisible(activeSid, sessions.length);
  return (
    <div className="tabrow">
      <div id="tabs" role="tablist" aria-label="Terminal sessions" ref={tabsRef}>
        {sessions.map((s) => {
          // A question is waiting for a PERSON in this session. Keyed on
          // `pendingApproval`, never on `approvalRequired`: an armed tab asks
          // before every command, so keying off the gate would mark every armed
          // session forever and the mark would stop meaning anything. There is
          // no count here on purpose — a session holds at most one question, so
          // a number would be either 0 or 1 and carry no information.
          const waiting = !s.closed && !!s.pendingApproval;
          return (
          <div
            key={s.sid}
            // role=tab: the div already carried aria-selected, which is only
            // valid on this role — and a name given by aria-label is dropped on
            // a generic element, so the waiting label below needs it too.
            role="tab"
            className={`tab ${s.closed ? "closed" : ""} ${s.sid === activeSid ? "active" : ""}`}
            // The hook finds the active tab by this attribute rather than by
            // id: a session id in a selector needs escaping (`:` / `@` are
            // common) and `CSS.escape` is absent in jsdom.
            data-active={s.sid === activeSid ? "1" : undefined}
            // round-161: closed tabs are visually dead AND honestly labelled —
            // activation rejects closed sessions (round-113 unmounted their
            // panes), so a click was a silent no-op before.
            // The label used to promise the history "stays in Trajectory/Logs":
            // there is no Logs view, and Trajectory shows the ACTIVE session. The
            // durable trail IS reachable now — in the Archive page, the surface
            // that reads this device's recorded sessions — so the tab names where
            // it actually is instead of a place that does not exist.
            title={
              s.closed
                ? `${s.label} — closed (its recorded trail is in Archive)`
                : waiting
                  ? `${s.label} — waiting for your approval`
                  : s.sid
            }
            aria-label={waiting ? `${s.label} — waiting for your approval` : undefined}
            aria-selected={s.sid === activeSid}
            onClick={() => { if (!s.closed) onActivate(s.sid); }}
          >
            <span className={`tab-dot ${s.kind === "ssh" ? "ssh" : s.kind === "serial" ? "serial" : ""}`} data-kind={s.kind} />
            <span className="tab-name">{s.label}</span>
            {/* A SHAPE, not the existing .tab-dot (a circle): the two marks sit
                in the same row, so a second circle would read as a second lane
                dot. aria-hidden because the tab's own label already carries the
                word for assistive tech. */}
            {waiting && <span className="tab-wait" aria-hidden="true" />}
            <span
              className="tab-export"
              title="Export this session log"
              onClick={(e) => { e.stopPropagation(); onExport(s.sid); }}
            >
              <Icon name="export" size={12} />
            </span>
            {!s.savedOnly && !s.closed && (
              confirmSid === s.sid ? (
                <span className="tab-confirm" onClick={(e) => e.stopPropagation()}>
                  <span className="tab-confirm-hint">close?</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-mini"
                    onClick={(e) => { e.stopPropagation(); setConfirmSid(null); onClose(s.sid); }}
                  >Close</button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-mini"
                    onClick={(e) => { e.stopPropagation(); setConfirmSid(null); }}
                  >Cancel</button>
                </span>
              ) : (
                <span
                  className="tab-close"
                  title="Close session"
                  onClick={(e) => { e.stopPropagation(); setConfirmSid(s.sid); }}
                >
                  <Icon name="close" size={12} />
                </span>
              )
            )}
          </div>
          );
        })}
      </div>
      {/* round-admin-ui Task 5: per-session view switch (dsh segmented pill) —
          shown only while a session is active. Session-tab behavior above is
          untouched. */}
      {activeSid && (
        <ViewSwitch view={view} onChange={onViewChange} className="view-switch" />
      )}
    </div>
  );
}
