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
  /** WHEN THE INSTANCE STARTED — and the device OMITS THIS on its healthy
   *  EXTERNAL branch, which its own comment calls the production path
   *  (`agent/src/plugins/playwright/manager.rs`: the ValePlaywright task hosts
   *  the instance, so it outlives the agent that reported it). A consumer must
   *  therefore treat an absent value as "not reported" rather than substituting
   *  a clock: `started_at ?? Date.now()` rendered "up 0s" for an instance that
   *  had been running for days. */
  started_at?: number;
  healthy?: boolean;
  /** The instance is hosted OUTSIDE this agent (the scheduled task). On the wire
   *  since the external branch was written and NOT DECLARED here until now — the
   *  same shape as `run_id` in round 30: a field the device records and the
   *  panel's type silently drops. */
  external?: boolean;
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
  /** stage-n: number of MCP tools the plugin registers (from /api/spec). */
  toolCount?: number;
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
  /** Full tool definitions from /api/spec — only the COUNT is surfaced
   *  (PluginRow.toolCount); the schemas themselves are dropped in the row
   *  map so state stays light. */
  tools?: { name: string }[];
}

const MAX_LOG = 50;

export function usePlugins(active: boolean) {
  const [spec, setSpec] = useState<SpecPlugin[]>([]);
  const [specLoaded, setSpecLoaded] = useState(false);
  const [playwright, setPlaywright] = useState<PlaywrightStatus | null>(null);
  // TWO READS, TWO ERRORS. These were one `loadError`, and the status fetch's
  // success cleared whatever the SPEC fetch had just set — so the failure this
  // hook most needed to report was wiped microseconds later by an unrelated
  // success, and the page went on saying "Loading inventory…". My own first fix
  // introduced that shape and the test caught it; a single cell cannot carry two
  // independent facts.
  const [specError, setSpecError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [actionError, setActionError] = useState("");
  const [log, setLog] = useState<LogLine[]>([]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // One status+spec refresh: the registry is static per agent process, so the
  // spec fetch runs once and `specLoaded` gates it.
  //
  // A FAILED SPEC FETCH IS NOT "TRANSIENT — RETRY NEXT TICK", which is what this
  // said and what the catch below did. THERE IS NO TICK: the 5 s poll was removed
  // in round 163 (see the effect below) and `specLoaded` is the only thing that
  // re-arms the fetch, so a failure left it FALSE FOREVER — the inventory
  // rendered "Loading inventory…" permanently, with no error, and the only
  // recoveries were a tab refocus or a `playwright-changed` event. The status
  // fetch in the SAME hook does the right thing (its catch sets `loadError`);
  // this is the twin rule applied to one branch and not the other, inside one
  // function. It now reports the failure so the page can say what happened.
  const refresh = useCallback(async () => {
    if (!activeRef.current) return;
    if (!specLoaded) {
      try {
        const specRes = await callApi("/api/spec");
        // AN UNUSABLE BODY IS A FAILURE, NOT A SILENT NO-OP. This used to be
        // `if (Array.isArray(...)) { ... }` with NO else: a 200 whose body the
        // panel cannot use (a proxy's error page, an empty reply) fell straight
        // through, set nothing, and left `specLoaded` false — the same permanent
        // "Loading inventory…" the catch below was fixed for, reached without a
        // throw. Routing it through the ONE failure path means both kinds are
        // reported and there is a single place that decides what a failed read
        // says.
        if (!Array.isArray(specRes?.plugins)) {
          throw new Error("the spec route answered without a plugins list");
        }
        setSpec((specRes.plugins as SpecPlugin[]).filter((p) => p && typeof p.name === "string"));
        setSpecLoaded(true);
      } catch (e: any) {
        if (!activeRef.current) return;
        // Said out loud, and NOT as a permanent "Loading…". The id is left
        // unset so the next refocus/event retries, but the surface must not
        // imply progress that stopped.
        setSpecError(e?.message ? `inventory: ${e.message}` : "inventory could not be read");
      }
    }
    try {
      const res = await callApi("/api/plugins/status");
      if (!activeRef.current) return;
      if (res && typeof res === "object" && res.ok === false) throw new Error(res.error || "status failed");
      setPlaywright(res?.playwright && typeof res.playwright === "object" ? res.playwright : null);
      setStatusError("");
    } catch (e: any) {
      if (!activeRef.current) return;
      setStatusError(e?.message ? `status: ${e.message}` : "status poll failed");
    }
  }, [specLoaded]);

  // round-163: the 5s status POLL is gone. The playwright status refreshes
  // on mount, after every start/stop action (already), on the agent-pushed
  // `playwright-changed` SSE event, and on tab refocus.
  useEffect(() => {
    if (!active) return;
    refresh();
    const onChange = () => { refresh(); };
    window.addEventListener("vale-playwright-changed", onChange);
    document.addEventListener("visibilitychange", onChange);
    return () => {
      window.removeEventListener("vale-playwright-changed", onChange);
      document.removeEventListener("visibilitychange", onChange);
    };
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
      // NOT "ok". A start/stop whose reply carried no status is a call whose
      // outcome the panel did NOT learn, and logging it `ok` reports success the
      // device never claimed. Every current device path sends `status`, so this
      // arm is reached only when the reply is empty or unreadable — precisely
      // when a verdict must not be invented.
      const status =
        res && typeof res === "object" && typeof res.status === "string"
          ? res.status
          : "(no status in the reply)";
      pushLog(`${which} → ${status}`, false);
    } catch (e: any) {
      setActionError(e?.message || `${which} failed`);
      pushLog(`${which} FAILED: ${e?.message || "unknown error"}`, true);
    } finally {
      setBusy(null);
      // Re-read NOW: with no poll (round 163) nothing else would re-read after
      // an action, so the row would keep showing the pre-action state until a
      // refocus or a `playwright-changed` event.
      refresh();
    }
  }, [pushLog, refresh]);

  const start = useCallback(() => runAction("start"), [runAction]);
  const stop = useCallback(() => runAction("stop"), [runAction]);

  // Inventory rows: registry plugins with live playwright state. Non-
  // playwright plugins run in-process → success. Playwright maps the four
  // StateDot states: running → ongoing, last action failed → error,
  // stopped → warn.
  const rows = useMemo<PluginRow[]>(() => spec.map((p) => {
    const base = {
      name: p.name,
      displayName: p.displayName,
      description: p.description,
      enabled: true,
      // stage-n: tools count badge (terminal=25, memory=6, …)
      toolCount: Array.isArray(p.tools) ? p.tools.length : undefined,
    };
    if (p.name === "playwright") {
      const pw = playwright ?? undefined; // PluginRow.playwright is `?`, not nullable
      if (playwright?.running) return { ...base, state: "ongoing" as const, stateLabel: "Running", playwright: pw };
      if (actionError) return { ...base, state: "error" as const, stateLabel: "Error", playwright: pw };
      return { ...base, state: "warn" as const, stateLabel: "Stopped", playwright: pw };
    }
    return { ...base, state: "success" as const, stateLabel: "Loaded" };
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

  // One line for the caller, in the order the reads happen: the inventory is
  // the page's body, the status is a row inside it.
  return { rows, specLoaded, playwright, playwrightRow, loadError: specError || statusError, busy, log, start, stop };
}
