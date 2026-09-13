// Vitals for the instrument surfaces: `/api/status`, polled.
//
// ONE OWNER FOR THE POLL. The desktop status strip and the panel's instrument line
// both need cpu / mem / uptime / release, and a second copy of this fetch would be a
// second place for the `release` rule to drift — which is the defect
// `lib/agentVersion.ts` exists to prevent (there is exactly one rule for which
// version field wins, and every caller goes through it).
//
// CPU% IS A SERVER-SIDE DELTA (`agent/src/metrics.rs`): the FIRST sample has no
// previous reading to subtract from, so it is legitimately absent and appears from
// the second poll onward. Nothing here invents a zero for it — an instrument that
// reports 0% when it means "unknown" is worse than one that reports nothing.
import { useEffect, useState } from "react";
import { callApi } from "../lib/api";
import { releaseVersion } from "../lib/agentVersion";

export interface AgentVitals {
  /** Release the device reports (NOT the Cargo version — see lib/agentVersion.ts). */
  release: string;
  /** Human uptime, already formatted. Empty until the first sample. */
  uptime: string;
  /** Percentages 0–100, or null while unknown. */
  cpu: number | null;
  mem: number | null;
}

export const EMPTY_VITALS: AgentVitals = { release: "", uptime: "", cpu: null, mem: null };

/** Seconds → the shortest honest form: `45s`, `12m 30s`, `3h 05m`, `2d 4h`. */
export function fmtUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

export function useAgentVitals(intervalMs = 15000): AgentVitals {
  const [vitals, setVitals] = useState<AgentVitals>(EMPTY_VITALS);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const j = await callApi("/api/status");
        if (!alive || !j) return;
        // A partial sample UPDATES ONLY WHAT IT CARRIES. cpu_pct is missing on the
        // first poll by design, and blanking the memory reading because of it would
        // make the instrument flicker between "known" and "unknown" every start.
        setVitals((prev) => {
          const next: AgentVitals = { ...prev };
          const v = releaseVersion(j);
          if (v) next.release = v;
          if (typeof j.uptime_secs === "number") next.uptime = fmtUptime(j.uptime_secs);
          if (typeof j.cpu_pct === "number") next.cpu = j.cpu_pct;
          if (typeof j.mem_pct === "number") next.mem = j.mem_pct;
          return next;
        });
      } catch {
        /* keep the last values — vitals are a nicety, never a hard dependency */
      }
    };
    void tick();
    const t = window.setInterval(tick, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [intervalMs]);
  return vitals;
}
