// react-jsx: no React import needed
import type { Session } from "../hooks/useSessions";
import type { AgentVitals } from "../hooks/useAgentVitals";
import { VitalsDial } from "./VitalsDial";
import { WaitingChip } from "./WaitingChip";

/** A reading, or an em dash while the agent has not reported one. Never 0 for
 *  "unknown": cpu_pct is absent on the FIRST sample by design (it is a server-side
 *  delta), and printing 0% there would be a lie the operator cannot see through. */
const reading = (v: number | null): string => (v === null ? "—" : `${Math.round(v)}%`);

export function StatusBar({ sessions, status, sseState, vitals }: {
  sessions: Session[];
  status: string;
  sseState: "connected" | "down" | "connecting";
  /** Optional, so the strip still renders for callers with no vitals yet: the
   *  instrument is an addition to this line, not a precondition for it. */
  vitals?: AgentVitals;
}) {
  const live = sessions.filter((s) => !s.closed).length;
  return (
    <div id="statusbar">
      {vitals && (
        <span className="instrument">
          <VitalsDial cpu={vitals.cpu} mem={vitals.mem} />
          <span className="instrument-reading">
            <span className="instrument-label">CPU</span>
            <span className="instrument-value">{reading(vitals.cpu)}</span>
          </span>
          <span className="instrument-reading">
            <span className="instrument-label">Mem</span>
            <span className="instrument-value">{reading(vitals.mem)}</span>
          </span>
          {vitals.uptime && (
            <>
              <span className="instrument-divider" aria-hidden="true" />
              <span className="instrument-reading">
                <span className="instrument-label">Up</span>
                <span className="instrument-value">{vitals.uptime}</span>
              </span>
            </>
          )}
          <span className="instrument-divider" aria-hidden="true" />
        </span>
      )}
      <span id="status" className={status.startsWith("error") || status.startsWith("open failed") ? "error" : ""}>{status}</span>
      <span id="session-count" className={live ? "" : "hidden"}>{live} session{live === 1 ? "" : "s"}</span>
      {/* The device-level answer to "is anything waiting for me?" — see
          WaitingChip. Renders nothing at zero. */}
      <WaitingChip sessions={sessions} />
      {sseState === "down" && <span id="sse-status">reconnecting…</span>}
    </div>
  );
}
