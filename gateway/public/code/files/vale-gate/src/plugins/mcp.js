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
 * handler + cachedDeviceProbe helper); handleMcp is imported from mcp.js.
 */

import { handleMcp } from "../mcp.js";
import { listDevices } from "../store.js";
import { deviceFetch } from "../device-fetch.js";
import { jsonOk } from "../http.js";

const PLUGIN_BASE = "/api/plugins";

/* ---------------- Device module helpers (copied verbatim from index.js) ---------------- */

// Device /api/status probe with a 30s in-isolate cache — the console polls
// /api/plugins/status every 30s, so a live probe per call would hammer the
// tunnel. The cache bounds it to one tunnel round-trip per 30s per device.
const DEVICE_PROBE_CACHE = new Map(); // name -> { at, ok }
const DEVICE_PROBE_TTL_MS = 30000;

async function cachedDeviceProbe(env, device) {
  const hit = DEVICE_PROBE_CACHE.get(device.name);
  if (hit && Date.now() - hit.at < DEVICE_PROBE_TTL_MS) return hit;
  // Probe through the tunnel; classify the failure: a tunnel-level error
  // (1033/530 — origin unreachable) vs an agent-level error (HTTP response).
  let state = { tunnel: false, agent: false, ts: Date.now() };
  try {
    const res = await deviceFetch(env, device, "/api/status");
    state.tunnel = true;
    state.agent = res.ok;
  } catch { /* tunnel-level failure (1033/530/network) */ }
  if (DEVICE_PROBE_CACHE.size >= 64) DEVICE_PROBE_CACHE.clear();
  DEVICE_PROBE_CACHE.set(device.name, state);
  return state;
}

/* ---------------- Routes ---------------- */

// GET /api/plugins/status — online/offline per device (via PluginHubDO)
// (handler body copied verbatim from index.js handleConsole)
async function pluginStatus(request, env) {
  const devices = await listDevices(env);
  const out = {};
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
    } catch { /* hub unreachable */ }
    // Agent + tunnel health: probe the device's own /api/status through its
    // tunnel (cached 30s — the console polls every 30s already).
    const probe = await cachedDeviceProbe(env, d);
    out[d.name] = { online: extOnline, agent_up: probe.agent, tunnel_up: probe.tunnel };
  }
  return jsonOk({ devices: out });
}

export default {
  name: "mcp",
  deps: [],
  setup(ctx) {
    // ---- MCP endpoint (Claude Code) — admin token, page host only ----
    // index.js had no method filter here (GET = SSE stream, POST = JSON-RPC).
    ctx.routes.push({
      match: (m, p) => p === "/mcp",
      handler: (request, env) => handleMcp(request, env),
    });
    // ---- GET /api/plugins/status (was inside handleConsole, admin-gated) ----
    ctx.routes.push({
      match: (m, p) => m === "GET" && p === `${PLUGIN_BASE}/status`,
      handler: pluginStatus,
    });
  },
};
