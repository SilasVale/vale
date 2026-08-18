/**
 * vale-gate — Cloudflare Worker unified AI gateway (multi-user BYOK relay) + device console
 *
 * Routes by model-name prefix to different backends, each user bringing their own
 * backend keys (Bring Your Own Key):
 *
 *   or/<model>   → OpenRouter (proxied via the openrouter-proxy CF Worker)
 *   ds/<model>   → DeepSeek official (api.deepseek.com/anthropic, Bearer passthrough)
 *   og/<model>   → OpenCode Go (opencode.ai/zen/go — deepseek-v4-flash native
 *                  Anthropic via /v1/messages with x-api-key; other models
 *                  Anthropic↔OpenAI translation via chat/completions)
 *   (none)       → default ds/ (DeepSeek official)
 *
 * Auth:
 *   - /v1/* (client requests): x-api-key = the user's "gateway token" → resolve user →
 *                              use that user's own backend keys
 *   - Console (CONSOLE_HOST only): web login (cookie), invite-code registration;
 *                                  /api/me and /api/admin/*
 *   - Static page served by Workers Assets (run_worker_first; hostname-based split)
 *
 * Keys live in Cloudflare KV via store.js (users, tokens, invites, per-user keys).
 * The admin is seeded from the existing CLIENT_KEY, keeping the legacy settings.json working.
 *
 * Module map (2026-08-12 refactor):
 *   index.js              front door + console API + /v1/* routing (handleGateway)
 *   channels.js           channel registry (MODELS/ROUTE_INFO/HEALTH channels + og endpoints)
 *   body-scan.js          10ms-CPU-budget raw-string scans (never parse big bodies)
 *   anthropic-translate.js Anthropic↔OpenAI SSE translation (pure, zero env)
 *   reliability.js        fetchWithTimeout/Retry + BreakerDO + timeouts
 *   http.js               jsonOk/jsonError/readJson/CORS
 *   store.js / auth.js / device-fetch.js / mcp.js / plugin-hub.js  supporting modules
 */

import { seedAdmin, createUser, getUser, findUserByUsername, findUserByToken, listUsers, setUserEnabled, regenerateToken, getUserKeys, setUserKey, deleteUserKey, createInvite, getAdminPassword, hasAdminPassword, verifyAdminPassword, setAdminPassword, maskKey, ADMIN_ID, USER_KEY_NAMES, listDevices, getDevice, upsertDevice, insertDevice, deleteDevice, createRegKey, hasRegKey, hasRegGrant, deleteRegKey, deleteRegGrant, consumeRegKey, getCfToken, setCfToken, getUserRoute, setUserRoute, getGlobalSetting, setGlobalSetting, listPluginLinks, addPluginLink, getPluginByToken, removePluginLink, createPairCode, consumePairCode, createWsTicket, consumeWsTicket } from "./store.ts";
import { verifyPassword, issueSessionToken, verifySessionToken, parseCookie, sessionCookieHeader, clearSessionCookieHeader, SESSION_COOKIE, randomHex } from "./auth.ts";
import { build101Response, deviceFetch } from "./device-fetch.ts";
import { handleMcp } from "./mcp.ts";
import { PluginHubDO } from "./plugin-hub.ts";
import { RouteDO } from "./route-do.ts";
import { toOpenAIRequest, toAnthropicResponse, streamOgToAnthropic, AnthropicStreamEncoder, sse, toSSE } from "./anthropic-translate.ts";
import { fetchWithTimeout, fetchWithRetry, upstreamTimeoutMs, ogTimeoutMs, passthroughTimeoutMs, BreakerDO, isChannelDegraded, recordChannelFailure, recordChannelSuccess } from "./reliability.ts";
import { rawWithModel, scanTopLevelModel, estimateTokens } from "./body-scan.ts";
import { jsonOk, jsonError, readJson, CORS_HEADERS } from "./http.ts";
import { MODELS, ROUTE_INFO, HEALTH_CHANNELS, HEALTH_PRIORITY, OG_ZEN_ANTHROPIC, OG_ZEN_CHAT, OG_NATIVE_ANTHROPIC, VERIFY_PATH, usProxyBase } from "./channels.ts";
export { MODELS, ROUTE_INFO, HEALTH_CHANNELS, HEALTH_PRIORITY, OG_ZEN_ANTHROPIC, OG_ZEN_CHAT, OG_NATIVE_ANTHROPIC, VERIFY_PATH };
export { jsonOk, jsonError, readJson, CORS_HEADERS };
export { toOpenAIRequest, toAnthropicResponse, streamOgToAnthropic, AnthropicStreamEncoder, sse, toSSE };
export { fetchWithTimeout, fetchWithRetry, upstreamTimeoutMs, ogTimeoutMs, passthroughTimeoutMs, BreakerDO, isChannelDegraded, recordChannelFailure, recordChannelSuccess };
export { rawWithModel, scanTopLevelModel, estimateTokens };
export { PluginHubDO };
export { RouteDO };
import { createPluginContext, registerPlugins, dispatch } from "./plugins/registry.ts";
import authPlugin from "./plugins/auth.ts";
import devicesPlugin from "./plugins/devices.ts";
import mcpPlugin from "./plugins/mcp.ts";
import translatePlugin from "./plugins/translate.ts";
import adminPlugin from "./plugins/admin.ts";
// Plugin context (round-73): built once per isolate with the shared helpers;
// routes registered here run first in handleConsole (and /v1 via handleGateway
// once migrated). Lazy so a reload never re-registers duplicate routes.
let __pluginCtx: any = null;
function ensurePluginCtx() {
  if (__pluginCtx) return __pluginCtx;
  __pluginCtx = createPluginContext(null, { jsonOk, jsonError: jsonError as (status: number, message: string, code?: string) => Response, readJson, CORS_HEADERS });
  registerPlugins(__pluginCtx, [authPlugin, devicesPlugin, mcpPlugin, translatePlugin, adminPlugin]);
  return __pluginCtx;
}


const AUTH_BASE = "/api/auth";
const ADMIN_BASE = "/api/admin";
const ME_BASE = "/api/me";
const DEVICE_BASE = "/api/devices";
const PLUGIN_BASE = "/api/plugins";

// Public /api/vale-probe rate limit: each probe costs a real upstream call
// (real money), so cap probes per-caller via a KV counter. Per-IP (the
// gateway-wide bucket let one caller exhaust the budget for everyone AND a
// minute-boundary race double-spent).
const PROBE_RATE_LIMIT = 60; // probes per minute, per IP
const PROBE_RATE_WINDOW_MS = 60000;

// In-memory per-IP probe counters (per isolate) — the KV version cost 1
// read + 1 write per probe call; probes are user-invoked but this keeps the
// "no per-request KV writes" invariant (KV quota). Each bucket's first call
// per IP reads KV once; nothing is written.
const __probeRate = new Map(); // `ip:${bucket}` → count

export async function probeRateLimited(env: any, request: Request) {
  try {
    const ip = (request?.headers?.get?.("cf-connecting-ip")) || "unknown";
    const bucket = Math.floor(Date.now() / PROBE_RATE_WINDOW_MS);
    const key = `probe-rate:${ip}:${bucket}`;
    const hit = __probeRate.get(key);
    if (hit !== undefined) {
      if (hit >= PROBE_RATE_LIMIT) return true;
      __probeRate.set(key, hit + 1);
      return false;
    }
    let cur = 0;
    try { cur = Number(await env.KEYS.get(key)) || 0; } catch {}
    __probeRate.set(key, cur + 1);
    if (__probeRate.size > 4096) __probeRate.delete(__probeRate.keys().next().value);
    return cur >= PROBE_RATE_LIMIT;
  } catch { return false; } // fail-open on KV errors, like the breaker
}

export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);

    // Force HTTPS: the Secure session cookie is only stored over https; on plain http
    // the browser drops it and login appears to "succeed then bounce back".
    // (Cloudflare normalizes url.protocol to https, so inspect x-forwarded-proto.)
    const proto = String(request.headers.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
    if (proto && proto !== "https") {
      return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 308);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // Hostname isolation: the console (static page + /api/*) lives only on the
      // CONSOLE_HOST var(s). localhost / 127.0.0.1 are allowed for local `wrangler dev`.
      const consoleHosts = String(env.CONSOLE_HOST || "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      const isPageHost =
        url.hostname === "localhost" || url.hostname === "127.0.0.1" || consoleHosts.includes(url.hostname);
      const path = url.pathname;

      // ---- Public tooling endpoints (any host) ----
      if (path === "/api/health") {
        return jsonOk(await buildHealth(env));
      }
      if (request.method === "POST" && path === "/api/vale-probe") {
        if (await probeRateLimited(env, request)) {
          return jsonError(429, "probe rate limit exceeded", "rate_limit_error");
        }
        const body = await readJson(request);
        return await valeProbe(env, String(body.model || ""));
      }
      if (path === "/api/vale-cli" || path === "/api/vale-install" || path === "/api/vale-install.ps1") {
        const cli = await serveAssetText(env, "/vale");
        if (cli === null) return jsonError(404, "vale CLI not found", "not_found_error");
        if (path === "/api/vale-cli") {
          return new Response(cli, { headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS } });
        }
        const b64 = encodeBase64Utf8(cli);
        const body = path === "/api/vale-install" ? posixInstaller(b64) : psInstaller(b64);
        return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS } });
      }

      await seedAdmin(env);

      // ---- Console API ----
      if (isPageHost && path.startsWith("/api/")) {
        return await handleConsole(request, env, url);
      }

      // ---- MCP endpoint (Claude Code) — admin token, page host only ----
      if (isPageHost && path === "/mcp") {
        return await handleMcp(request, env);
      }

      // ---- OpenAI-compatible alias: /models → /v1/models, /chat/completions → /v1/chat/completions ----
      if ((path === "/models" || path === "/chat/completions") && request.method !== "OPTIONS") {
        const v1Url = new URL(url);
        v1Url.pathname = "/v1" + path;
        return await handleGateway(request, env, v1Url);
      }

      // ---- Static page (Workers Assets): non-/v1/ paths → ai domain only ----
      if (!path.startsWith("/v1/")) {
        if (!isPageHost) return jsonError(404, "Not Found", "not_found_error");
        if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
          return env.ASSETS.fetch(request);
        }
        return jsonError(404, "Not Found", "not_found_error");
      }

      // ---- /v1/* gateway (both domains) ----
      return await handleGateway(request, env, url);
    } catch (error) {
      return jsonError(500, (error as any).message || "Internal error", "api_error");
    }
  },
};

/* ---------------- Console (web UI API) ---------------- */

async function handleConsole(request: Request, env: any, url: URL) {
  const path = url.pathname;
  const method = request.method;
  const secure = url.protocol === "https:";

  // Plugin dispatch (round-73): the console's routes are being migrated to
  // DSH-style plugins (plugins/auth.js, devices.js, mcp.js). Registered
  // plugin routes run FIRST; unmatched requests fall through to the legacy
  // inline handlers below (which still exist until fully migrated). Zero
  // behavior change: a plugin route that matches is the same handler that
  // used to run inline.
  const pctx = ensurePluginCtx();
  if (pctx.routes.length) {
    const hit = dispatch(pctx, method, path, request, env, url, secure);
    if (hit !== null) return hit;
  }

  // ---- Public: register / login / logout / route info ----
  if (method === "POST" && path === `${AUTH_BASE}/register`) return authRegister(request, env, secure);
  if (method === "POST" && path === `${AUTH_BASE}/login`) return authLogin(request, env, secure);
  if (method === "POST" && path === `${AUTH_BASE}/logout`) {
    // Revoke the session server-side: the HMAC cookie alone was cleared
    // client-side, but a copied cookie stayed valid for the full 24h. Blacklist
    // the token hash in KV until its exp so it dies everywhere.
    const cookie = parseCookie(request.headers.get("Cookie") || "")[SESSION_COOKIE];
    if (cookie && env.KEYS) {
      try {
        const payload = JSON.parse(atob(cookie.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/")) || "{}");
        if (payload.exp) {
          // round-122: exp is stored in MS (issueSessionToken uses Date.now() + SESSION_TTL_MS) — the old *1000 treated it as seconds, overstating the remaining life ~1000x (every logout wrote a 2-day entry).
          // round-124: floor 60 — KV's minimum expirationTtl; the old floor of 1 let a <60s-life session skip the blacklist write entirely.
          const ttl = Math.max(60, Math.min(86400, Math.ceil((payload.exp - Date.now()) / 1000)));
          await env.KEYS.put(`sess-revoked:${cookie}`, "1", { expirationTtl: ttl });
        }
      } catch { /* malformed cookie — ignore */ }
    }
    return jsonOk({ ok: true }, { "Set-Cookie": clearSessionCookieHeader(secure) });
  }
  if (method === "GET" && path === `${ADMIN_BASE}/public`) {
    return jsonOk({ routes: ROUTE_INFO, models: MODELS.map((m) => m.id), apiHost: env.API_HOST || "" });
  }

  // Public device registration (the Windows install calls this with a one-time
  // registration key + the device's {name, hostname, token}). Not session-based:
  // the install runs headless on the device machine.
  if (method === "POST" && path === "/api/register") {
    const body = await readJson(request);
    // Accept either a live key or the short-lived grant issued when the key
    // was spent at /api/install/tunnel-token (same install, both calls).
    const keyOk = (await hasRegKey(env, body.key)) || (await hasRegGrant(env, body.key));
    if (!keyOk) {
      return jsonError(403, "Invalid or used registration key", "authorization_error");
    }
    let device: any;
    try { device = validateDevice(body); } catch (e) { return jsonError(400, (e as any).message, "invalid_request"); }
    // round-68: a one-time-key holder could upsert an EXISTING device name —
    // the register endpoint silently replaced a production device's
    // hostname/token, redirecting console terminal tools + the proxy to the
    // attacker. Refuse when the name is already registered; re-registering
    // an existing device is an admin action.
    // round-122: insertDevice checks existence INSIDE the lock (the old
    // getDevice check-then-act let concurrent same-name registrations both
    // pass and the second upsert took over the name).
    const inserted = await insertDevice(env, device);
    if (!inserted) {
      return jsonError(409, `Device '${device.name}' already registered — use the console (admin) to update it`, "conflict");
    }
    await deleteRegKey(env, body.key); // one-time — consumed only after success
    await deleteRegGrant(env, body.key);
    return jsonOk({ ok: true, device: { name: device.name, hostname: device.hostname } });
  }

  // Public: the Windows install fetches the Cloudflare tunnel API token with a
  // valid registration key (so tunnel setup needs no browser login and no
  // token pasted on the machine). This returns the ACCOUNT-LEVEL CF API
  // token, so the key is SPENT here (first authenticated use) and a short-
  // lived grant is issued in its place for /api/register — a leaked or
  // stolen key can be used exactly once, not harvested repeatedly.
  if (method === "POST" && path === "/api/install/tunnel-token") {
    const body = await readJson(request);
    const k = String(body.key || "").toLowerCase();
    if (!k || !(await hasRegKey(env, k))) {
      return jsonError(403, "Invalid or used registration key", "authorization_error");
    }
    // Single-flight: claim the key with a short TTL lock FIRST, then consume.
    // hasRegKey→consume was check-then-act on eventually-consistent KV — two
    // concurrent requests could both pass the check and both harvest the
    // account-level CF token. The lock key makes the claim atomic-enough (KV
    // put-if-absent is not available; a 30s TTL lock bounds the race).
    const claim = await env.KEYS.get(`regclaim:${k}`);
    if (claim) {
      return jsonError(403, "Registration key already in use", "authorization_error");
    }
    await env.KEYS.put(`regclaim:${k}`, "1", { expirationTtl: 60 });
    if (!(await hasRegKey(env, k))) {
      await env.KEYS.delete(`regclaim:${k}`);
      return jsonError(403, "Invalid or used registration key", "authorization_error");
    }
    await consumeRegKey(env, k);
    return jsonOk({ ok: true, apiToken: await getCfToken(env) });
  }

  // Public: browser-extension pairing — the extension has no admin session, the
  // pairing code is the credential (same pattern as /api/register above).
  if (method === "POST" && path === `${PLUGIN_BASE}/pair/claim`) {
    const { code }: any = (await request.json().catch(() => ({}))) || {};
    const c = String(code || "");
    if (!c) return jsonError(403, "Invalid or used pairing code", "authorization_error");
    // Single-flight: consumePairCode was check-then-act on eventually-
    // consistent KV — two concurrent claims both passed and minted two
    // 30-day device-control tokens from one code. A claim lock bounds it.
    const claim = await env.KEYS.get(`pairclaim:${c}`);
    if (claim) return jsonError(403, "Pairing code already in use", "authorization_error");
    await env.KEYS.put(`pairclaim:${c}`, "1", { expirationTtl: 60 });
    const device = await consumePairCode(env, c);
    if (!device) {
      await env.KEYS.delete(`pairclaim:${c}`);
      return jsonError(403, "Invalid or used pairing code", "authorization_error");
    }
    const token = randomHex(16);
    await addPluginLink(env, token, device);
    return jsonOk({ token, device });
  }

  // Extension unpair: revoke the plugin token server-side (local-only unpair
  // left a 30-day device-control credential valid after the user unpaired).
  if (method === "POST" && path === `${PLUGIN_BASE}/revoke`) {
    const auth = String(request.headers.get("authorization") || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) return jsonError(401, "Missing plugin token", "authentication_error");
    await removePluginLink(env, token);
    return jsonOk({ ok: true });
  }

  // Public: the extension trades its plugin token for a one-time WS ticket
  // here (no admin session — the plugin token is the credential). The ticket
  // keeps the long-lived token out of the /ws URL and is consumed once.
  if (method === "POST" && path === `${PLUGIN_BASE}/ws-ticket`) {
    const auth = String(request.headers.get("authorization") || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const link = token ? await getPluginByToken(env, token) : null;
    if (!link) return jsonError(401, "Invalid plugin token", "authorization_error");
    const ticket = await createWsTicket(env, link.device);
    return jsonOk({ ticket, device: link.device });
  }

  // Public: the browser extension opens its WebSocket here, trading a one-time
  // ticket (fetched via /api/plugins/ws-ticket with the plugin token) for the
  // connection. Ticket consumption keeps the long-lived token out of the URL
  // and gates the hub by knowledge of a valid ticket, not just the device name.
  if (method === "GET" && path === `${PLUGIN_BASE}/ws`) {
    const device = url.searchParams.get("device") || "";
    const ticket = url.searchParams.get("ticket") || "";
    const ok = await consumeWsTicket(env, ticket);
    if (!ok || ok !== device) return jsonError(403, "Invalid or expired WS ticket", "authorization_error");
    const d = await getDevice(env, device);
    if (!d) return jsonError(404, "Device not found", "not_found_error");
    const id = env.PLUGIN_HUB.idFromName(device);
    const hub = env.PLUGIN_HUB.get(id);
    // The DO dispatches on its own /ws path — rewrite the URL path so the
    // upgrade request lands on the DO's handler (the raw request path is
    // /api/plugins/ws, which the DO would 404).
    const wsUrl = new URL(request.url);
    wsUrl.pathname = "/ws";
    // Internal auth for the DO (it has its own external address) — the shared
    // secret header is set by the main worker only.
    const wsReq = new Request(wsUrl.toString(), request);
    if (env.DO_AUTH) wsReq.headers.set("x-do-auth", env.DO_AUTH);
    return hub.fetch(wsReq);
  }

  // ---- Device reverse-proxy: admin session cookie OR paired plugin token ----
  // <any> /api/devices/<name>/proxy/<rest> → reverse-proxy to the device panel.
  // The console admin browses the panel with the session cookie; the browser
  // extension's terminal page is cross-site (no console cookie, SameSite=Lax),
  // so it authenticates with the plugin token it was paired with
  // (Authorization: Bearer <token>, the same credential as /api/plugins/ws).
  // The token grants access ONLY to the device it's paired to — no other
  // device, no admin APIs, no /api/me.
  const proxyMatch = path.match(new RegExp(`^${DEVICE_BASE}/([^/]+)/proxy(.*)$`));
  if (proxyMatch) {
    const deviceName = decodeURIComponent(proxyMatch[1]);
    const d = await getDevice(env, deviceName);
    if (!d) return jsonError(404, "Device not found", "not_found_error");
    const user = await requireSession(request, env);
    if (user && user.role === "admin") {
      return await proxyDevice(request, env, d, proxyMatch[2] || "/");
    }
    const auth = String(request.headers.get("authorization") || "");
    const qToken = url.searchParams.get("token") || "";
    // ?token= is accepted ONLY for a top-level browser navigation (the
    // extension's Terminal button) — a browser navigation cannot carry an
    // Authorization header. Any other request with a query token is rejected:
    // a leaked URL (history/sync/screenshot/log) would otherwise grant full
    // device terminal control via /proxy/* for the 30-day plugin-link TTL.
    // Sec-Fetch-Mode is set by browsers on every fetch/navigation and cannot
    // be spoofed cross-origin (it is a forbidden header for fetch()).
    const isNav = String(request.headers.get("sec-fetch-mode") || "") === "navigate";
    if (qToken && !auth && !isNav) {
      return jsonError(401, "Invalid plugin token", "authentication_error");
    }
    // Bootstrap-navigation reload support: the navigation pins the plugin
    // token in a PER-DEVICE cookie so the panel's relative subresources
    // (panel.css/js/vendor/*) and an F5/history-forward reload authenticate.
    // The cookie is scoped to THIS device's proxy path and carries the device
    // name in its key — one origin-wide cookie would let a later-opened
    // device's page steal an earlier device's terminal (cross-device hijack)
    // and would clobber a multi-device pairing.
    // The cookie was written with encodeURIComponent — decode on read so a
    // future non-hex token charset (base64 +/=, etc.) still matches the
    // plugin-link map (hex tokens are a no-op, but the decode must exist).
    let cookieToken = "";
    try {
      cookieToken = decodeURIComponent(parseCookie(request.headers.get("cookie") || "")[`vale_pt_${deviceName}`] || "");
    } catch { /* malformed — treat as absent */ }
    const token = (auth.startsWith("Bearer ") ? auth.slice(7).trim() : "") || qToken || cookieToken;
    const link = token ? await getPluginByToken(env, token) : null;
    if (link && link.device === deviceName) {
      // Never cache a response that carried a token in the URL.
      const resp = await proxyDevice(request, env, d, proxyMatch[2] || "/");
      resp.headers.set("Cache-Control", "no-store");
      if (qToken && isNav) {
        // Per-device path scope + per-device name: a leaked cookie only ever
        // authenticates THIS device's proxy, and never leaves this subtree.
        resp.headers.append("Set-Cookie", `vale_pt_${deviceName}=${encodeURIComponent(qToken)}; Path=${DEVICE_BASE}/${deviceName}/proxy; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
      }
      return resp;
    }
    // A top-level navigation with a bad/expired token gets a readable page
    // (with a re-pair hint) instead of a raw JSON 401 — the panel's own
    // recovery UI can never load if the bootstrap navigation itself 401s.
    if (!auth && isNav) {
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vale — session expired</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;color:#1d1d1f;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:14px;padding:32px 40px;max-width:400px;text-align:center;box-shadow:0 12px 32px rgba(0,0,0,.12)}h1{font-size:18px;margin:0 0 8px}p{color:#6e6e73;font-size:14px;margin:0 0 4px}.mark{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:10px;background:#1d1d1f;color:#fff;font-weight:700;font-size:24px;margin-bottom:14px}</style></head><body><div class="card"><span class="mark">V</span><h1>Device session expired</h1><p>This device pairing has expired or the browser was restarted.</p><p>Open the Vale extension and re-pair to access the terminal.</p></div></body></html>`,
        { status: 401, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    return jsonError(401, "Not logged in or invalid plugin token", "authentication_error");
  }

  // ---- Everything below requires a session ----
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");

  // /api/me
  if (method === "GET" && path === ME_BASE) {
    const ukeys = await getUserKeys(env, user.id);
    return jsonOk({
      id: user.id,
      username: user.username,
      role: user.role,
      enabled: user.enabled,
      token: user.token,
      keys: userKeysStatus(ukeys),
    });
  }
  // Per-user route selection (Claude Code model=auto)
  if (method === "GET" && path === `${ME_BASE}/route`) {
    return jsonOk({ model: await getUserRoute(env, user.id) });
  }
  if (method === "PUT" && path === `${ME_BASE}/route`) {
    const body = await readJson(request);
    const model = body?.model ?? null;
    if (model !== null && !MODELS.some((m) => m.id === model)) {
      return jsonError(400, `Unknown model: ${model}`, "invalid_request");
    }
    await setUserRoute(env, user.id, model);
    return jsonOk({ ok: true, model });
  }
  if (method === "POST" && path === `${ME_BASE}/token/regenerate`) {
    const token = await regenerateToken(env, user.id);
    return jsonOk({ ok: true, token });
  }
  // 美国出口开关(全局设置):GET 读当前值;PUT 改(仅管理员)。
  // 网关在每次请求路由时读 KV,开关立即生效,无需重启。
  if (method === "GET" && path === `${ME_BASE}/usproxy`) {
    const v = await getGlobalSetting(env, "US_PROXY");
    return jsonOk({ enabled: !!v });
  }
  if (method === "PUT" && path === `${ME_BASE}/usproxy`) {
    if (user.role !== "admin") {
      return jsonError(403, "Admin only", "forbidden");
    }
    const body = await readJson(request);
    // round-95: OFF persisted as "0" (not deleted) so it shadows an
    // env/US_PROXY Worker var; getGlobalSetting normalizes "0" → null for
    // every consumer.
    await setGlobalSetting(env, "US_PROXY", body?.enabled ? "1" : "0");
    const v = await getGlobalSetting(env, "US_PROXY");
    return jsonOk({ ok: true, enabled: !!v });
  }
  if (method === "PUT" && path === `${ME_BASE}/keys`) {
    const body = await readJson(request);
    const { name, value } = body || {};
    if (!USER_KEY_NAMES.includes(name)) return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
    if (typeof value !== "string" || !value.trim()) return jsonError(400, "value must not be empty", "invalid_request");
    const v = value.trim();
    await setUserKey(env, user.id, name, v);
    return jsonOk({ ok: true, name, masked: maskKey(v) });
  }
  if (method === "DELETE" && path === `${ME_BASE}/keys`) {
    const name = url.searchParams.get("name") || "";
    if (!USER_KEY_NAMES.includes(name)) return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
    await deleteUserKey(env, user.id, name);
    return jsonOk({ ok: true, name });
  }
  if (method === "POST" && path === `${ME_BASE}/keys/test`) {
    const body = await readJson(request);
    const name = body?.name;
    if (!USER_KEY_NAMES.includes(name)) return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
    const ukeys = await getUserKeys(env, user.id);
    return testKey(env, name, ukeys[name]);
  }

  // ---- Admin-only ----
  if (user.role !== "admin") return jsonError(403, "Admin permission required", "authorization_error");

  // ---- Device module (Vale Agent registry) ----
  // (the reverse-proxy route lives in its own section above, before the
  //  session gate — it also accepts the paired plugin token)
  // GET    /api/devices                        → list (token masked)
  // POST   /api/devices                        → add/update {name, hostname, token}
  // POST   /api/devices/register-key           → generate a one-time install key
  // DELETE /api/devices/<name>                 → remove
  // GET    /api/devices/<name>/mcp             → MCP config for a device (with token)
  if (method === "POST" && path === `${DEVICE_BASE}/register-key`) {
    const key = await createRegKey(env);
    return jsonOk({ ok: true, key });
  }
  if (method === "GET" && path === DEVICE_BASE) {
    const devices = await listDevices(env);
    return jsonOk({
      devices: devices.map((d) => ({
        name: d.name, hostname: d.hostname,
        token: maskKey(d.token), mcp: mcpConfig(d),
      })),
    });
  }
  if (method === "POST" && path === DEVICE_BASE) {
    const body = await readJson(request);
    let device: any;
    try { device = validateDevice(body); } catch (e) { return jsonError(400, (e as any).message, "invalid_request"); }
    await upsertDevice(env, device);
    return jsonOk({ ok: true, device: { name: device.name, hostname: device.hostname, token: maskKey(device.token) } });
  }
  const mcpMatch = path.match(new RegExp(`^${DEVICE_BASE}/([^/]+)/mcp$`));
  if (mcpMatch && method === "GET") {
    const d = await getDevice(env, decodeURIComponent(mcpMatch[1]));
    if (!d) return jsonError(404, "Device not found", "not_found_error");
    return jsonOk({ name: d.name, hostname: d.hostname, mcp: mcpConfig(d) });
  }
  const delMatch = path.match(new RegExp(`^${DEVICE_BASE}/([^/]+)$`));
  if (delMatch && method === "DELETE") {
    await deleteDevice(env, decodeURIComponent(delMatch[1]));
    return jsonOk({ ok: true });
  }

  // ---- Plugin (extension) pairing & status ----
  // POST /api/plugins/pair          → generate a one-time pairing code for a device
  // POST /api/plugins/unpair        → drop all plugin links for a device
  // GET  /api/plugins/status        → online/offline per device (via PluginHubDO)
  // (POST /api/plugins/pair/claim, POST /api/plugins/ws-ticket and
  //  GET /api/plugins/ws are PUBLIC — defined in the public section above:
  //  the extension has no admin session and authenticates by pairing code /
  //  plugin token instead.)
  if (method === "POST" && path === `${PLUGIN_BASE}/pair`) {
    const { device }: any = (await request.json().catch(() => ({}))) || {};
    const d = device ? await getDevice(env, String(device)) : null;
    if (!d) return jsonError(404, "Device not found", "not_found_error");
    const code = await createPairCode(env, d.name);
    return jsonOk({ code });
  }
  if (method === "POST" && path === `${PLUGIN_BASE}/unpair`) {
    const { device }: any = (await request.json().catch(() => ({}))) || {};
    const links = await listPluginLinks(env);
    for (const [t, l] of Object.entries(links)) if (l.device === device) await removePluginLink(env, t);
    // round-92: removing the KV links was not enough — the extension's LIVE
    // hub socket kept relaying browser_* commands past the unpair (the socket
    // stays in the DO and its 20s pings keep the idle alarm from ever firing,
    // so alarm()'s token re-validation never runs either). revoke() (round-84)
    // already knew this and calls /close-all; unpair is the same revocation
    // contract and must do the same.
    const id = env.PLUGIN_HUB.idFromName(device);
    const hub = env.PLUGIN_HUB.get(id);
    const req = new Request("https://hub/close-all", { method: "POST" });
    if (env.DO_AUTH) req.headers.set("x-do-auth", env.DO_AUTH);
    await hub.fetch(req).catch(() => {});
    return jsonOk({ ok: true });
  }
  if (method === "GET" && path === `${PLUGIN_BASE}/status`) {
    const devices = await listDevices(env);
    const out: Record<string, { online: boolean; agent_up: boolean; tunnel_up: boolean }> = {};
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

  // Cloudflare tunnel API token — account-level credential the install fetches
  // (reg-key gated) so tunnel setup needs no browser login. Admin-only here.
  if (method === "GET" && path === `${ADMIN_BASE}/cloudflare-token`) {
    const token = await getCfToken(env);
    return jsonOk({ configured: !!token, masked: token ? maskKey(token) : "" });
  }
  if (method === "PUT" && path === `${ADMIN_BASE}/cloudflare-token`) {
    const body = await readJson(request);
    const v = String(body?.token || "").trim();
    if (v && !/^[A-Za-z0-9_-]{20,}$/.test(v)) {
      return jsonError(400, "Token looks invalid (expected 20+ chars of letters/digits/_ -)", "invalid_request");
    }
    await setCfToken(env, v);
    return jsonOk({ ok: true });
  }

  if (method === "POST" && path === `${ADMIN_BASE}/invite`) {
    const code = await createInvite(env);
    return jsonOk({ ok: true, code });
  }
  if (method === "GET" && path === `${ADMIN_BASE}/users`) {
    const users = await listUsers(env);
    const out = [];
    for (const u of users) {
      const ukeys = await getUserKeys(env, u.id);
      out.push({
        id: u.id,
        username: u.username,
        role: u.role,
        enabled: u.enabled,
        createdAt: u.createdAt,
        token: u.token,
        keys: userKeysStatus(ukeys),
      });
    }
    return jsonOk({ users: out });
  }
  if (method === "PUT" && path.startsWith(`${ADMIN_BASE}/users/`) && path.endsWith("/enabled")) {
    const id = decodeURIComponent(path.slice(`${ADMIN_BASE}/users/`.length, -"/enabled".length));
    const body = await readJson(request);
    if (id === ADMIN_ID) return jsonError(400, "Cannot disable the admin account", "invalid_request");
    const u = await setUserEnabled(env, id, !!body.enabled);
    return jsonOk({ ok: true, id, enabled: u.enabled });
  }

  // Admin password: presence / change. The raw password is NEVER returned
  // (was plaintext before — a session holder could read it and impersonate
  // the admin indefinitely).
  if (method === "GET" && path === `${ADMIN_BASE}/password`) {
    return jsonOk({ set: await hasAdminPassword(env) });
  }
  if (method === "PUT" && path === `${ADMIN_BASE}/password`) {
    const body = await readJson(request);
    const v = String(body?.password || "");
    if (v.length < 8) return jsonError(400, "Admin password must be at least 8 chars", "invalid_request");
    // Require the CURRENT password: a hijacked session must not be able to
    // rotate the password and permanently lock out the real admin.
    if (!(await verifyAdminPassword(env, String(body?.currentPassword || "")))) {
      return jsonError(403, "Current password is incorrect", "authentication_error");
    }
    await setAdminPassword(env, v);
    return jsonOk({ ok: true, changed: true });
  }

  return jsonError(404, "Not Found", "not_found_error");
}

// Session HMAC key: prefer the dedicated high-entropy SESSION_SECRET (wrangler
// secret) over the admin password. Using the password directly lets any invited
// user offline-brute-force it from their own signed cookie (HMAC-SHA256 is not
// memory-hard); with SESSION_SECRET set, the password is never a signing key.
function sessionSecret(env: any, adminPassword: string) {
  return env.SESSION_SECRET || adminPassword;
}

async function requireSession(request: Request, env: any) {
  const ap = await getAdminPassword(env);
  if (!ap) return null;
  const cookie = parseCookie(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  if (!cookie) return null;
  // Revoked by logout (server-side blacklist — a copied cookie dies too).
  if (env.KEYS && (await env.KEYS.get(`sess-revoked:${cookie}`))) return null;
  const session = await verifySessionToken(sessionSecret(env, ap), cookie);
  if (!session) return null;
  const user = await getUser(env, session.uid);
  if (!user || !user.enabled) return null;
  return user;
}

/* ---- Register / Login ---- */

async function authRegister(request: Request, env: any, secure: boolean) {
  const ap = await getAdminPassword(env);
  if (!ap) return jsonError(500, "Admin password not configured", "config_error");
  const body = await readJson(request);
  try {
    const created = await createUser(env, {
      username: body.username,
      password: body.password,
      inviteCode: body.inviteCode,
      role: "user", // always a normal user; the admin can only come from seeding
    });
    const token = await issueSessionToken(sessionSecret(env, ap), created.id, created.role);
    return jsonOk({ ok: true, username: created.username, role: created.role, token: created.token }, { "Set-Cookie": sessionCookieHeader(token, 86400, secure) });
  } catch (e) {
    return jsonError(400, (e as any).message, "invalid_request");
  }
}

async function authLogin(request: Request, env: any, secure: boolean) {
  if (!(await hasAdminPassword(env))) return jsonError(500, "Admin password not configured", "config_error");
  // The session-signing key in fallback mode is the stored admin password
  // HASH (same value requireSession uses) — getAdminPassword returns the
  // hash, never the plaintext.
  const ap = await getAdminPassword(env);
  const body = await readJson(request);
  // Brute-force throttle: 5 consecutive failures lock the username for 30s
  // (exponential backoff would need the failure count; a flat lock is simple
  // and stops online guessing of the 6-8 char passwords).
  // Trim + lowercase: findUserByUsername trims, so an untrimmed key let
  // "admin " variants bypass the lock while still reaching the real admin
  // password check (brute-force bypass).
  // Bind the lock to the CALLER (IP+username): a per-username-only key let
  // any unauthenticated attacker POST 5 wrong passwords and hold the admin
  // console login at 429 forever (permanent login-layer DoS).
  const callerIp = request.headers?.get?.("cf-connecting-ip") || "unknown";
  // Per-IP in-memory burst gate BEFORE the KV lock path: a brute-force loop
  // otherwise burns 2-3 KV WRITES per failed login — ~400 attempts exhaust
  // the Free-plan daily write quota (1000). >10 failures/min from one IP
  // short-circuits with no KV traffic; the KV lock below still handles the
  // sustained case.
  const gk = `login:${callerIp}:${Math.floor(Date.now() / 60000)}`;
  const gate = (__loginGate.get(gk) || 0) + 1;
  __loginGate.set(gk, gate);
  if (__loginGate.size > 4096) __loginGate.delete(__loginGate.keys().next().value);
  if (gate > 10) {
    return jsonError(429, "Too many attempts — try again in a moment", "rate_limit_error");
  }
  const lockKey = `login-lock:${callerIp}:${String(body.username || "").trim().toLowerCase()}`;
  const locked = await env.KEYS.get(lockKey);
  if (locked) {
    return jsonError(429, "Too many attempts — try again in ~30s", "rate_limit_error");
  }
  const user = await findUserByUsername(env, body.username);
  if (!user || !user.enabled) return jsonError(401, "Incorrect username or password", "authentication_error");
  let ok = false;
  if (user.id === ADMIN_ID) {
    // The admin account logs in with the admin password (stored HASHED —
    // compare via verifyAdminPassword, never read the plaintext).
    ok = await verifyAdminPassword(env, body.password || "");
  } else {
    ok = !!user.salt && !!user.passwordHash && (await verifyPassword(body.password || "", user.salt, user.passwordHash));
  }
  if (!ok) {
    // Track failures: 5th consecutive miss arms the 30s lock.
    const fails = Number(await env.KEYS.get(lockKey + ":n")) || 0;
    const next = fails + 1;
    if (next >= 5) {
      await env.KEYS.put(lockKey, "1", { expirationTtl: 60 });
      await env.KEYS.delete(lockKey + ":n");
    } else {
      await env.KEYS.put(lockKey + ":n", String(next), { expirationTtl: 60 });
    }
    return jsonError(401, "Incorrect username or password", "authentication_error");
  }
  // Success clears the failure counter.
  await env.KEYS.delete(lockKey + ":n");
  const token = await issueSessionToken(sessionSecret(env, ap), user.id, user.role);
  return jsonOk({ ok: true, username: user.username, role: user.role }, { "Set-Cookie": sessionCookieHeader(token, 86400, secure) });
}

/* ---------------- /v1/* gateway ---------------- */

// In-memory per-token rate-limit counters (per isolate). The old KV
// get-then-put counters cost 2 reads + 2 writes per /v1/messages request —
// that alone burned the Free-plan daily KV WRITE quota (1000/day) at ~250
// requests. Never written; each window's first request per token reads KV
// once to inherit other isolates' counts.
const __loginGate = new Map(); // `login:${ip}:${minute}` → failed-login burst count


/**
 * Structured request log for the /v1/* hot path — one line per gateway
 * request (user/model/status/latency). Visible via `wrangler tail`; no
 * persistent storage on the Free plan, but enough to see who used what and
 * which channel misbehaves.
 */
export async function handleGateway(request: Request, env: any, url: URL) {
  const started = Date.now();
  // round-99: plugin dispatch FIRST — plugins/translate.ts registers its
  // /v1/* routes here but they were NEVER reached (the old code went
  // straight to the inline impl below, leaving the plugin's 800-line copy
  // dead and drifting). A matching plugin route now runs; unmatched
  // requests fall through to the inline impl.
  const pctx = ensurePluginCtx();
  if (pctx.routes.length) {
    const hit = dispatch(pctx, request.method, url.pathname, request, env, url, url.protocol === "https:");
    if (hit !== null) return hit;
  }
  // round-120: the inline handleGatewayImpl below was a STALE duplicate of
  // the plugin's copy — the plugin had the round-116/118/119 fixes (US_PROXY
  // web_search swap, breaker reset, ds vision) while the inline copy kept the
  // regressions, and it was still reachable via the plugin-prefix fallthrough
  // (e.g. /v1/x/messages). Route the fallthrough to the plugin's implementation
  // instead and delete the inline copy (single source of truth).
  const api = pctx.api?.translate;
  if (api?.handleGateway) return api.handleGateway(request, env, url);
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "translate plugin unavailable" } }), {
    status: 500, headers: { "content-type": "application/json" },
  });
}

/* ---------------- Device module helpers ---------------- */

// Device /api/status probe with a 30s in-isolate cache — the console polls
// /api/plugins/status every 30s, so a live probe per call would hammer the
// tunnel. The cache bounds it to one tunnel round-trip per 30s per device.
const DEVICE_PROBE_CACHE = new Map(); // name -> { at, ok }
const DEVICE_PROBE_TTL_MS = 30000;

async function cachedDeviceProbe(env: any, device: any) {
  const hit = DEVICE_PROBE_CACHE.get(device.name);
  // round-96: the cache stored the timestamp under `ts` but the hit check
  // read `hit.at` — the cache NEVER hit, so every /api/plugins/status poll
  // live-probed every device through the tunnel (the exact hammering the
  // 30s cache exists to prevent). Check `ts`.
  if (hit && Date.now() - hit.ts < DEVICE_PROBE_TTL_MS) return hit;
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

function validateDevice(body: any) {
  const name = String(body?.name || "").trim();
  const hostname = String(body?.hostname || "").trim();
  const token = String(body?.token || "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error("Device name must be 1-32 chars: letters/digits/_ -");
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(hostname)) throw new Error("hostname must be a domain like d1.agent.saisi.online");
  if (token.length < 8) throw new Error("Token must be at least 8 chars");
  return { name, hostname, token };
}

/** Claude Code MCP config snippet for a device (the only place the raw token is returned). */
function mcpConfig(d: any) {
  const url = `https://${d.hostname}/mcp`;
  const snippet = {
    mcpServers: {
      "vale-agent": { type: "http", url, headers: { Authorization: `Bearer ${d.token}` } },
    },
  };
  return { url, json: JSON.stringify(snippet, null, 2) };
}

/** Reverse-proxy to the device panel, injecting the Bearer token server-side. */
async function proxyDevice(request: Request, env: any, device: any, restPath: string) {
  const url = new URL(request.url);

  // The panel sits behind a tunnel that adds its own x-forwarded-*; don't pass
  // the console's through. deviceFetch injects the Bearer token and strips
  // host/cookie; restPath carries the request query string.
  const headers = new Headers(request.headers);
  headers.delete("x-forwarded-proto");
  headers.delete("x-forwarded-for");
  headers.delete("cf-connecting-ip");
  headers.set("x-forwarded-proto", "https");

  // Never forward the extension's ?token= to the device — the plugin token
  // is a console-side credential; the device authenticates with its own
  // Bearer (injected by deviceFetch). A leaked token must not reach device
  // query logs.
  const q = new URLSearchParams(url.search);
  q.delete("token");
  const qs = q.toString();
  const { resp, error } = await deviceFetch(env, device, restPath + (qs ? `?${qs}` : ""), {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
  });
  if (!resp) return jsonError(502, error || "Device unreachable", "proxy_error");

  const outHeaders = new Headers(resp.headers);
  outHeaders.set("Access-Control-Allow-Origin", "*");
  const ct = String(outHeaders.get("content-type") || "").toLowerCase();

  if (resp.status === 101) {
    return build101Response(resp) ?? resp;
  }
  // Streaming (SSE / octet-stream): pass the body through untouched.
  if (resp.body && (ct.includes("text/event-stream") || ct.includes("application/octet-stream"))) {
    return new Response(resp.body, { status: resp.status, headers: outHeaders });
  }

  // Text assets (HTML/JS/CSS): rewrite absolute panel paths to the proxy mount.
  if (resp.body && ct.includes("text/")) {
    const text = await resp.text();
    const rewritten = rewriteDeviceBody(text, device.name);
    if (outHeaders.has("content-length")) {
      outHeaders.set("content-length", String(new TextEncoder().encode(rewritten).length));
    }
    return new Response(rewritten, { status: resp.status, headers: outHeaders });
  }

  // JSON / binary: pass through unchanged.
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

// Absolute paths a vale-agent panel serves from its own root. When proxied
// through the console they must carry the proxy mount so the SPA's absolute
// paths (/api/*, /app.js, /ui/*, ...) keep resolving through the proxy.
const PANEL_ROOT_PATHS = [
  "/api/", "/mcp", "/app.js", "/styles.css", "/state.js", "/ipc.js",
  "/events.js", "/transport.js", "/view.js", "/tabs.js", "/browser.js",
  "/term.js", "/conn.js", "/icons.js", "/ui/", "/vendor/",
];

function rewriteDeviceBody(text: string, name: string) {
  const prefix = `${DEVICE_BASE}/${name}/proxy`;
  const already = `${DEVICE_BASE}/[^/"']+/proxy/`;
  let out = text;
  for (const p of PANEL_ROOT_PATHS) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A quote/backtick OR template-interpolation close (}) followed by a
    // root path that isn't already the proxy prefix → insert the prefix
    // between them (avoids double-rewriting). The } case matters: panel.js
    // builds `https://${hostname}/api/events/term` where the path follows a
    // `}` — without it the SSE stream URL was never rewritten and the
    // proxied panel froze ("stream error 404", no needSync recovery).
    const re = new RegExp(`(["'\`}])(?!${already})${escaped}`, "g");
    out = out.replace(re, `$1${prefix}${p}`);
  }
  // Strip the agent's injected device token from proxied HTML. Direct
  // same-origin HTML never passes through this function (it only runs in
  // proxyDevice for /proxy/*), and the admin session-cookie flow authenticates
  // BEFORE any token parsing — so stripping costs nothing functionally, and
  // it prevents an extension user from reading the PERMANENT device token off
  // a console-origin page (DOM/devtools/XSS) and keeping direct control of
  // /api/tools/* and /mcp after the plugin-link TTL or unpair — the exact
  // revocation scope the plugin token exists to enforce.
  out = out.replace(/window\.__PANEL_TOKEN__\s*=\s*"[^"]*"/g, "window.__PANEL_TOKEN__=\"\"");
  return out;
}

/* ---- Connectivity tests ---- */

async function testKey(env: any, name: string, key: string) {
  if (!key) return jsonOk({ ok: false, name, detail: "Key not configured" });
  try {
    if (name === "DEEPSEEK_API_KEY") {
      const res = await fetchWithTimeout("https://api.deepseek.com/models", { headers: { Authorization: `Bearer ${key}` } });
      return jsonOk({ ok: res.ok, name, status: res.status, detail: res.ok ? "DeepSeek auth OK" : `Upstream ${res.status}` });
    }
    if (name === "OPENROUTER_API_KEY") {
      const res = await fetchWithTimeout("https://openrouter.ai/api/v1/auth/key", { headers: { Authorization: `Bearer ${key}` } });
      return jsonOk({ ok: res.ok, name, status: res.status, detail: res.ok ? "OpenRouter auth OK" : `Upstream ${res.status}` });
    }
    if (name === "OPENCODE_GO_API_KEY") {
      // Do not send the literal "[1m]" suffix — zen rejects it with 401
      // 尊重 US_PROXY 开关:开启时经美国代理探测(实测 chat/completions
      // 走代理 1-3s vs 直连 12-13s);关闭时直连。
      const usProxy = await getGlobalSetting(env, "US_PROXY");
      const probeUrl = usProxy
        ? `${usProxyBase(env)}/api/zen?target=og&path=${encodeURIComponent("/v1/chat/completions")}`
        : OG_ZEN_CHAT;
      const res = await fetchWithTimeout(probeUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: true,
        }),
      });
      if (!res.ok) {
        return jsonOk({ ok: false, name, status: res.status, detail: `Upstream ${res.status}` });
      }
      // 流式探测:收到首个 SSE data 块即判定连通(auth OK + 连接建立),
      // 不等 thinking 结束(非流式要等完整响应 ~10s)。提前 cancel 释放连接。
      const firstChunk = await (async () => {
        const reader = res.body!.getReader();
        const { value } = await reader.read();
        await reader.cancel().catch(() => {});
        return new TextDecoder().decode(value || new Uint8Array());
      })();
      const ok = firstChunk.includes("data:");
      return jsonOk({ ok, name, status: res.status, detail: ok ? "OpenCode Go auth OK" : "OpenCode Go auth FAILED (no stream data)" });
    }
    if (name === "QWEN_API_KEY") {
      const res = await fetchWithTimeout("https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "qwen3.8-max-preview",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      });
      return jsonOk({ ok: res.ok, name, status: res.status, detail: res.ok ? "Qwen MaaS auth OK" : `Upstream ${res.status}` });
    }
  } catch (e) {
    return jsonOk({ ok: false, name, detail: "Test failed: " + (e as any).message });
  }
  return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
}

function userKeysStatus(ukeys: Record<string, any>) {
  const out: Record<string, { configured: boolean; masked: string }> = {};
  for (const n of USER_KEY_NAMES) {
    const v = ukeys[n];
    out[n] = { configured: !!v, masked: maskKey(v) };
  }
  return out;
}


// Claude Code appends a [context-window] marker (e.g. [1m]) to model names and strips it
// before sending; strip it here too as a safety net so a literal "[1m]" never hits zen/OpenRouter.
function stripBracket(s: string) {
  return s.replace(/\[[^\]]*\]$/, "");
}

function pickRoute(prefix: string, env: any, usProxy?: string | null) {
  // 美国出口开关:US_PROXY=1 时所有模型经 Vercel 代理(v.saisi.online/api/zen)
  // 从美国边缘出口访问上游,规避区域限制/拥堵。target=og|ds|qw|or 选上游,
  // path 参数带上游相对路径(代理 base 已含主机级前缀)。usProxy is a local
  // per-request value — never mutate the shared env object with it.
  const via = (direct: string, path: string) => usProxy
    ? `${usProxyBase(env)}/api/zen?target=${prefix}&path=${encodeURIComponent(path)}`
    : direct;
  switch (prefix) {
    case "or":
      return {
        type: "passthrough",
        kind: "openrouter", // passes through the user's own OPENROUTER_API_KEY
        stripPrefix: true,
        // 代理 base 是 openrouter.ai/api,path 只用 /v1/messages(不含 /api,
        // 否则拼出 openrouter.ai/api/api/v1/messages → 404)
        upstream: via((env.OPENROUTER_PROXY_URL || "https://v.saisi.online/api/proxy") + VERIFY_PATH, "/v1/messages"),
      };
    case "ds":
      return {
        type: "passthrough",
        kind: "deepseek",
        stripPrefix: true,
        upstream: via("https://api.deepseek.com/anthropic" + VERIFY_PATH, "/anthropic/v1/messages"),
      };
    case "qw":
      return {
        type: "passthrough",
        kind: "qwen",
        stripPrefix: true,
        upstream: via("https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic" + VERIFY_PATH, "/apps/anthropic/v1/messages"),
      };
    case "og":
      return {
        type: "translate",
        kind: "opencode",
        stripPrefix: true,
        upstream: via("https://opencode.ai/zen/go/v1/chat/completions", "/v1/chat/completions"),
      };
    default:
      // No prefix / unknown prefix → DeepSeek official
      return {
        type: "passthrough",
        kind: "deepseek",
        stripPrefix: false,
        upstream: via("https://api.deepseek.com/anthropic" + VERIFY_PATH, "/anthropic/v1/messages"),
      };
  }
}

function passthroughHeaders(bearerKey: string, { apiKeyHeader = false }: { apiKeyHeader?: string | false } = {}) {
  const h = new Headers();
  h.set("Content-Type", "application/json");
  // All passthrough targets speak the Anthropic protocol (ds/qw native,
  // openrouter-proxy) — send the standard version header; OpenAI-format
  // backends ignore it.
  h.set("anthropic-version", "2023-06-01");
  // Do not forward the client's auth header — use this user's own key.
  // zen/go/v1/messages (native-Anthropic og) authenticates with x-api-key;
  // every other upstream accepts Bearer.
  if (bearerKey) {
    if (apiKeyHeader) h.set(apiKeyHeader, bearerKey);
    else h.set("Authorization", `Bearer ${bearerKey}`);
  }
  return h;
}




/* ---------------- Public endpoints: health / vale-cli / installers ---------------- */

export async function buildHealth(env: any) {
  const channels: any[] = [];
  for (const c of HEALTH_CHANNELS) {
    let ok = true;
    let reason = "";
    if (c.id === "og") {
      ok = !(await isChannelDegraded(env));
      if (!ok) reason = "circuit open";
    }
    channels.push({ id: c.id, ok, model: c.model, ...(reason ? { reason } : {}) });
  }
  const recommended = HEALTH_PRIORITY.map((id) => channels.find((c) => c.id === id)).find((c) => c.ok);
  return {
    channels,
    recommended: recommended ? { channel: recommended.id, model: recommended.model } : null,
  };
}

/** Model usable for routing? In the whitelist, (og) breaker not open, AND
 *  the REQUESTING user's key for that channel is configured — a channel
 *  without a key 502s every request, so model=auto must not route to it.
 *  round-68: the old code checked ADMIN_ID's keys — a BYOK user with only an
 *  og key was told og was "unusable" (the admin lacks it) and routed to ds,
 *  which the user lacks → 502 on every model=auto request. */
export async function isModelUsable(env: any, model: string, uid: string) {
  if (!MODELS.some((m) => m.id === model)) return false;
  const userKeys: any = await getUserKeys(env, uid).catch(() => ({}));
  const prefix = model.split("/")[0] + "/";
  if (prefix === "og/" && !(userKeys.OPENCODE_GO_API_KEY || env.OPENCODE_GO_API_KEY)) return false;
  if (prefix === "ds/" && !(userKeys.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY)) return false;
  if (prefix === "qw/" && !(userKeys.QWEN_API_KEY || env.QWEN_API_KEY)) return false;
  if (prefix === "or/" && !(userKeys.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY)) return false;
  if (model.startsWith("og/")) return !(await isChannelDegraded(env));
  return true;
}

// Default channel when the user hasn't made a selection: the stable,
// cheapest direct channel (DeepSeek official).
const DEFAULT_ROUTE_MODEL = "ds/deepseek-v4-flash";

/**
 * Resolve Claude Code's fixed `auto` model name to this user's chosen
 * channel (per-user route selection). Falls back to the default channel
 * (ds/deepseek-v4-flash) when unset or unusable.
 */
export async function resolveAutoModel(env: any, uid: string) {
  const chosen = await getUserRoute(env, uid);
  if (chosen && (await isModelUsable(env, chosen, uid))) return chosen;
  // round-99: the default fallback returned DEFAULT_ROUTE_MODEL (ds/...)
  // UNCHECKED — a BYOK user without a DeepSeek key got a guaranteed 502 on
  // every model=auto request (the exact hole round-68 fixed for the
  // chosen-route path). Fall back to the first usable channel instead.
  for (const m of [DEFAULT_ROUTE_MODEL, "qw/qwen3.8-max-preview", "og/deepseek-v4-flash", "or/openai/gpt-5.6-luna:floor[1m]"]) {
    if (await isModelUsable(env, m, uid)) return m;
  }
  return DEFAULT_ROUTE_MODEL;
}

/** UTF-8-safe base64: btoa is Latin1-only and throws on non-ASCII (the vale
 *  CLI is full of Chinese text). Encode to bytes first. */
export function encodeBase64Utf8(text: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/**
 * Channel probe for the vale CLI's `use` command (public POST /api/vale-probe).
 *
 * Fires a real max_tokens=1 request through the requested channel using the
 * WORKER-level provider keys, so the CLI can verify a channel serves BEFORE
 * rewriting settings — from any settings state. Public like /api/health;
 * each probe costs one tiny upstream call (og short-circuits on the open
 * breaker, so a degraded channel costs nothing).
 */
export async function valeProbe(env: any, model: string) {
  const prefix = model.split("/")[0];
  const known = HEALTH_CHANNELS.some((c) => c.id === prefix) && MODELS.some((m) => m.id === model);
  if (!known) {
    return jsonError(400, `Unknown channel model: ${model}`, "invalid_request");
  }
  // og → zen; respect the breaker first so a degraded channel fails fast at no cost.
  // Native-Anthropic models (deepseek-v4-flash / minimax-m3) probe zen/go/v1/messages,
  // other og models probe chat/completions — same probe body works for both formats.
  if (prefix === "og") {
    if (await isChannelDegraded(env)) {
      return jsonOk({ ok: false, channel: prefix, detail: "circuit open" });
    }
    const key = env.OPENCODE_GO_API_KEY || "";
    if (!key) return jsonOk({ ok: false, channel: prefix, detail: "OPENCODE_GO_API_KEY not configured" });
    const upstreamModel = stripBracket(model.slice(prefix.length + 1));
    const native = OG_NATIVE_ANTHROPIC.has(upstreamModel);
    let res;
    try {
      // Native models hit zen /v1/messages with x-api-key; translate models
      // hit chat/completions with Bearer.
      const headers = native
        ? { "x-api-key": key, "Content-Type": "application/json" }
        : { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
      res = await fetchWithTimeout(native ? OG_ZEN_ANTHROPIC : OG_ZEN_CHAT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: upstreamModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
      }, upstreamTimeoutMs(env));
    } catch (e) {
      return jsonOk({ ok: false, channel: prefix, detail: (e as any).message });
    }
    return jsonOk({ ok: res.ok, channel: prefix, status: res.status, detail: res.ok ? "" : `upstream ${res.status}` });
  }
  // Passthrough channels (ds/qw/or): reuse the exact route config of /v1/messages.
  const route = pickRoute(prefix, env);
  const key = prefix === "or" ? (env.OPENROUTER_API_KEY || "")
    : prefix === "qw" ? (env.QWEN_API_KEY || "")
    : (env.DEEPSEEK_API_KEY || "");
  if (!key) return jsonOk({ ok: false, channel: prefix, detail: `${prefix}: key not configured` });
  const upstreamModel = stripBracket(route.stripPrefix ? model.slice(prefix.length + 1) : model);
  let res;
  try {
    res = await fetchWithTimeout(route.upstream, {
      method: "POST",
      headers: passthroughHeaders(key),
      body: JSON.stringify({
        model: upstreamModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    }, upstreamTimeoutMs(env));
  } catch (e) {
    return jsonOk({ ok: false, channel: prefix, detail: (e as any).message });
  }
  return jsonOk({ ok: res.ok, channel: prefix, status: res.status, detail: res.ok ? "" : `upstream ${res.status}` });
}

// POSIX one-liner installer — embeds the vale CLI as base64 (no quoting issues).
export function posixInstaller(b64: string) {
  return `#!/bin/sh
set -e
command -v node >/dev/null 2>&1 || { echo "error: Node.js required"; exit 1; }
DEST="\${VALE_BIN:-\$HOME/.local/bin}"
mkdir -p "\$DEST"
echo "${b64}" | (base64 -d 2>/dev/null || base64 -D) > "\$DEST/vale"
chmod +x "\$DEST/vale"
echo "installed: \$DEST/vale"
echo "usage: vale check | vale use <ds|qw|og|or> | vale use auto | vale restore"
`;
}

// PowerShell one-liner installer (irm | iex) — installs vale + vale.cmd wrapper.
export function psInstaller(b64: string) {
  return `$ErrorActionPreference = "Stop"
try { node --version | Out-Null } catch { Write-Error "Node.js required"; exit 1 }
$dest = Join-Path $HOME ".local\\bin"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${b64}"))
Set-Content -Path (Join-Path $dest "vale") -Value $script -Encoding UTF8 -NoNewline
Set-Content -Path (Join-Path $dest "vale.cmd") -Value '@echo off\r\nnode "%~dp0vale" %*' -Encoding ASCII
Write-Host "installed: $dest\\vale  (command: vale)"
`;
}

async function serveAssetText(env: any, assetPath: string) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return null;
  }
  const res = await env.ASSETS.fetch(new Request(`https://assets.local${assetPath}`));
  return res.ok ? await res.text() : null;
}
