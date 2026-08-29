/**
 * mcp plugin (round-73 extraction) — MCP endpoint + plugin-link status.
 *
 * Routes:
 *   /mcp                      (any method, page host) → handleMcp(request, env)
 *                             GET = SSE stream, POST = JSON-RPC (Claude Code)
 *   GET /api/plugins/status   → online/offline per device (via PluginHubDO)
 *
 * NOTE: the original index.js guarded /mcp with isPageHost and
 * /api/plugins/status with the admin session (inside handleConsole). Those
 * are fetch/dispatch-layer guards — this plugin registers method+path only;
 * the wiring phase decides where the guards live.
 *
 * Logic copied VERBATIM from index.js (mcp route handler + /api/plugins/status
 * handler + cachedDeviceProbe helper); handleMcp is imported from mcp.ts.
 */

import { handleMcp } from "../mcp.ts";
import { listDevices, touchDeviceSeen, type Device } from "../store.ts";
import { deviceFetch } from "../device-fetch.ts";
import { jsonOk, jsonError } from "../http.ts";
import { requireSession } from "../session.ts";
import type { Plugin, PluginContext } from "./registry.ts";

const PLUGIN_BASE = "/api/plugins";

/* ---------------- Device module helpers (copied verbatim from index.js) ---------------- */

interface DeviceProbeState {
  tunnel: boolean;
  agent: boolean;
  ts: number;
  /// Agent version from the device's /api/status (CARGO_PKG_VERSION) — the
  /// probe already fetched it and used to throw it away.
  version?: string;
  checkedAt: number;
}

// Device /api/status probe with a 30s in-isolate cache — the console polls
// /api/plugins/status every 30s, so a live probe per call would hammer the
// tunnel. The cache bounds it to one tunnel round-trip per 30s per device.
// `fresh` (the console's "check now" button) bypasses the cache read but
// still rewrites it, so a burst of fresh clicks costs at most one probe per
// click and every other poller keeps seeing the refreshed state.
const DEVICE_PROBE_CACHE = new Map<string, any>(); // name -> { at, ok }
const DEVICE_PROBE_TTL_MS = 30000;

async function cachedDeviceProbe(env: any, device: Device, fresh = false): Promise<DeviceProbeState> {
  const hit = DEVICE_PROBE_CACHE.get(device.name);
  // round-98: the TTL check read hit.at but the cache stores ts — the 30s
  // cache NEVER hit, so every /api/plugins/status poll live-probed every
  // device through the tunnel (the hammering the cache exists to prevent).
  if (!fresh && hit && Date.now() - hit.ts < DEVICE_PROBE_TTL_MS) return hit;
  // Probe through the tunnel; classify the failure: a tunnel-level error
  // (1033/530 — origin unreachable) vs an agent-level error (HTTP response).
  // round-101: deviceFetch NEVER throws — it returns {status:502,
  // ok:false, error:'Device unreachable: …'} on any network failure, so the
  // old try/catch left tunnel=true always (the catch was unreachable) and a
  // down device showed tunnel_up:true. Classify from the returned shape:
  // the 502-with-unreachable error string is the tunnel-level case.
  const state: DeviceProbeState = { tunnel: false, agent: false, ts: Date.now(), checkedAt: Date.now() };
  const res = await deviceFetch(env, device, "/api/status");
  if (res && res.status !== undefined) {
    const tunnelLevel =
      !res.ok && typeof res.error === "string" && res.error.includes("Device unreachable");
    state.tunnel = !tunnelLevel;
    state.agent = res.ok;
    if (res.ok && res.resp) {
      const j: any = await res.resp.json().catch(() => null);
      if (j && typeof j.version === "string") state.version = j.version;
    }
  }
  if (DEVICE_PROBE_CACHE.size >= 64) DEVICE_PROBE_CACHE.clear();
  DEVICE_PROBE_CACHE.set(device.name, state);
  return state;
}

/* ---------------- Routes ---------------- */

// GET /api/plugins/status — online/offline per device (via PluginHubDO)
// (handler body copied verbatim from index.js handleConsole). round-159:
// adds the agent version + probe timestamp from the /api/status probe and a
// `?fresh=1` cache bypass for the console's "check now" button; successful
// probes feed touchDeviceSeen (write-bounded lastSeen/lastVersion refresh).
async function pluginStatus(request: Request, env: any): Promise<Response> {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const devices = await listDevices(env);
  const out: Record<
    string,
    { online: boolean; agent_up: boolean; tunnel_up: boolean; version?: string; checked_at: number }
  > = {};
  for (const d of devices) {
    // Extension WS (chrome.debugger hub) — reflects the browser extension.
    let extOnline = false;
    try {
      const id = env.PLUGIN_HUB.idFromName(d.name);
      const hub = env.PLUGIN_HUB.get(id);
      const statusReq = new Request("https://hub/status");
      if (env.DO_AUTH) statusReq.headers.set("x-do-auth", env.DO_AUTH);
      const res = await hub.fetch(statusReq);
      extOnline = !!(await res.json()).online;
    } catch {
      /* hub unreachable */
    }
    // Agent + tunnel health: probe the device's own /api/status through its
    // tunnel (cached 30s — the console polls every 30s already).
    const probe = await cachedDeviceProbe(env, d, fresh);
    if (probe.agent) {
      // Bounded write: only touches KV when the version changed or the last
      // write is >1h old — see touchDeviceSeen.
      await touchDeviceSeen(env, d.name, probe.version).catch(() => {});
    }
    out[d.name] = {
      online: extOnline,
      agent_up: probe.agent,
      tunnel_up: probe.tunnel,
      ...(probe.version ? { version: probe.version } : {}),
      checked_at: probe.checkedAt,
    };
  }
  return jsonOk({ devices: out });
}

export default {
  name: "mcp",
  deps: [],
  setup(ctx: PluginContext) {
    // ---- MCP endpoint (Claude Code) — admin token, page host only ----
    // index.js had no method filter here (GET = SSE stream, POST = JSON-RPC).
    ctx.routes.push({
      match: (_m, p) => p === "/mcp",
      handler: (request, env) => handleMcp(request, env),
    });
    // ---- GET /api/plugins/status (was inside handleConsole, admin-gated) ----
    // round-83: the migration dropped the admin gate — the plugin route runs
    // BEFORE the legacy session checks, so it returned the device inventory
    // to unauthenticated callers (verified live). Restore the guard through
    // the shared session module (round-88's full contract: sess-revoked
    // blacklist + enabled check — the hand-rolled copy had drifted).
    ctx.routes.push({
      match: (m, p) => m === "GET" && p === `${PLUGIN_BASE}/status`,
      handler: async (request: Request, env: any) => {
        const user = await requireSession(request, env);
        if (!user || user.role !== "admin") {
          return jsonError(401, "Not logged in", "authentication_error");
        }
        return pluginStatus(request, env);
      },
    });
  },
} satisfies Plugin;
