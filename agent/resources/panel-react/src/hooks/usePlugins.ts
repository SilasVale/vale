import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { callApi } from "../lib/api";

// Plugin inventory + playwright-mcp control (round-admin-ui Task 6).
//
// Data sources, per the design spec
// (docs/superpowers/specs/2026-08-15-agent-admin-ui-design.md):
//   GET /api/plugins/status              — playwright running state, polled
//                                          while the plugins view is active
//   GET /api/spec                        — the plugin registry (names and
//                                          descriptions come from the agent,
//                                          not a hardcoded list)
//   POST /api/plugins/playwright/start   — spawn playwright-mcp
//   POST /api/plugins/playwright/stop    — stop it
//
// Every start/stop attempt lands in `log` — the verbatim agent error body on
// failures — so the playwright card doubles as a startup log. All rendering
// downstream is TEXT-ONLY (React text nodes, never innerHTML).

export interface PlaywrightStatus {
  running: boolean;
  port?: number;
  started_at?: number;
  healthy?: boolean;
}

/** dsh StateDot states — success | warn | error | ongoing (design spec). */
export type PluginState = "success" | "warn" | "error" | "ongoing";

export interface PluginRow {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
  state: PluginState;
  stateLabel: string;
  /** Live playwright detail; only set on the playwright row. */
  playwright?: PlaywrightStatus;
}

export interface LogLine {
  ts: string;
  text: string;
  error: boolean;
}

interface SpecPlugin {
  name: string;
  displayName: string;
  description: string;
}

const POLL_MS = 5000;
const MAX_LOG = 50;

export function usePlugins(active: boolean) {
  const [spec, setSpec] = useState<SpecPlugin[]>([]);
  const [specLoaded, setSpecLoaded] = useState(false);
  const [playwright, setPlaywright] = useState<PlaywrightStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [actionError, setActionError] = useState("");
  const [log, setLog] = useState<LogLine[]>([]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // One status+spec refresh: the registry is static per agent process, so
  // the spec fetch runs once (specLoaded gates it; a transient failure just
  // retries on the next tick). A FAILED status poll keeps the last good
  // state instead of blanking it (same stance as useSessions).
  const refresh = useCallback(async () => {
    if (!activeRef.current) return;
    if (!specLoaded) {
      try {
        const specRes = await callApi("/api/spec");
        if (Array.isArray(specRes?.plugins)) {
          setSpec((specRes.plugins as SpecPlugin[]).filter((p) => p && typeof p.name === "string"));
          setSpecLoaded(true);
        }
      } catch { /* transient — retry next tick */ }
    }
    try {
      const res = await callApi("/api/plugins/status");
      if (!activeRef.current) return;
      if (res && typeof res === "object" && res.ok === false) throw new Error(res.error || "status failed");
      setPlaywright(res?.playwright && typeof res.playwright === "object" ? res.playwright : null);
      setLoadError("");
    } catch (e: any) {
      if (!activeRef.current) return;
      setLoadError(e?.message ? `status: ${e.message}` : "status poll failed");
    }
  }, [specLoaded]);

  useEffect(() => {
    if (!active) return;
    refresh();
    const t = window.setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [active, refresh]);

  const pushLog = useCallback((text: string, error: boolean) => {
    const ts = new Date().toLocaleTimeString();
    setLog((prev) => [...prev.slice(-(MAX_LOG - 1)), { ts, text, error }]);
  }, []);

  const runAction = useCallback(async (which: "start" | "stop") => {
    if (busyRef.current) return;
    setBusy(which);
    try {
      const res = await callApi(`/api/plugins/playwright/${which}`, { method: "POST" });
      setActionError("");
      const status = res && typeof res === "object" && typeof res.status === "string" ? res.status : "ok";
      pushLog(`${which} → ${status}`, false);
    } catch (e: any) {
      setActionError(e?.message || `${which} failed`);
      pushLog(`${which} FAILED: ${e?.message || "unknown error"}`, true);
    } finally {
      setBusy(null);
      refresh(); // re-sync immediately — don't wait for the poll
    }
  }, [pushLog, refresh]);

  const start = useCallback(() => runAction("start"), [runAction]);
  const stop = useCallback(() => runAction("stop"), [runAction]);

  // Inventory rows: registry plugins with live playwright state. Non-
  // playwright plugins run in-process → success. Playwright maps the four
  // StateDot states: running → ongoing, last action failed → error,
  // stopped → warn.
  const rows = useMemo<PluginRow[]>(() => spec.map((p) => {
    if (p.name === "playwright") {
      if (playwright?.running) return { ...p, enabled: true, state: "ongoing", stateLabel: "Running", playwright };
      if (actionError) return { ...p, enabled: true, state: "error", stateLabel: "Error", playwright };
      return { ...p, enabled: true, state: "warn", stateLabel: "Stopped", playwright };
    }
    return { ...p, enabled: true, state: "success", stateLabel: "Loaded" };
  }), [spec, playwright, actionError]);

  // The playwright card is driven by the live status DIRECTLY — independent
  // of /api/spec, so the control card still works if the registry fetch
  // failed. null = first status poll still pending.
  const playwrightRow: PluginRow | null = useMemo(() => {
    const base = {
      name: "playwright",
      displayName: "Playwright",
      description: "playwright-mcp browser automation",
      enabled: true,
    };
    if (playwright?.running) return { ...base, state: "ongoing" as const, stateLabel: "Running", playwright };
    if (actionError) return { ...base, state: "error" as const, stateLabel: "Error", playwright: playwright ?? { running: false } };
    if (playwright !== null) return { ...base, state: "warn" as const, stateLabel: "Stopped", playwright };
    return null;
  }, [playwright, actionError]);

  return { rows, specLoaded, playwright, playwrightRow, loadError, busy, log, start, stop };
}
