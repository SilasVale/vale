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
 */

import { seedAdmin, createUser, getUser, findUserByUsername, findUserByToken, listUsers, setUserEnabled, regenerateToken, getUserKeys, setUserKey, deleteUserKey, createInvite, getAdminPassword, setAdminPassword, maskKey, ADMIN_ID, USER_KEY_NAMES, listDevices, getDevice, upsertDevice, deleteDevice, createRegKey, hasRegKey, deleteRegKey, getCfToken, setCfToken, getUserRoute, setUserRoute, listPluginLinks, addPluginLink, getPluginByToken, removePluginLink, createPairCode, consumePairCode, createWsTicket, consumeWsTicket } from "./store.js";
import { verifyPassword, issueSessionToken, verifySessionToken, parseCookie, sessionCookieHeader, clearSessionCookieHeader, SESSION_COOKIE, randomHex } from "./auth.js";
import { build101Response, deviceFetch } from "./device-fetch.js";
import { handleMcp } from "./mcp.js";
import { PluginHubDO } from "./plugin-hub.js";
export { PluginHubDO };

const VERIFY_PATH = "/v1/messages";
const COUNT_PATH = "/v1/messages/count_tokens";

// Request body cap: Claude Code 1M-context bodies run ~4-10MB; anything larger
// would blow the Workers Free plan's 10ms CPU budget just to scan/parse it.
const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB

// OpenCode Zen/Go endpoints. deepseek-v4-flash is Anthropic-native on
// zen/go/v1/messages (announced 2026-08-06) and authenticates with x-api-key
// (verified 2026-08-10 per handoff 2.5.6: ~54s full response, thinking +
// answer). Native passthrough forwards the Anthropic stream untouched — no
// per-chunk OpenAI translation, so no 1102 CPU risk on huge streams. Other og
// models (minimax-m3, mimo-v2.5) only speak chat/completions and keep the
// translate path (verified 2026-08-07 with this user's key).
const OG_ZEN_ANTHROPIC = "https://opencode.ai/zen/go" + VERIFY_PATH;
const OG_ZEN_CHAT = "https://opencode.ai/zen/go/v1/chat/completions";
const OG_NATIVE_ANTHROPIC = new Set(["deepseek-v4-flash"]);
const AUTH_BASE = "/api/auth";
const ADMIN_BASE = "/api/admin";
const ME_BASE = "/api/me";
const DEVICE_BASE = "/api/devices";
const PLUGIN_BASE = "/api/plugins";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS,DELETE,PUT",
  "Access-Control-Allow-Headers": "*",
};

const MODELS = [
  { id: "ds/deepseek-v4-flash", owned_by: "deepseek" },
  { id: "og/deepseek-v4-flash", owned_by: "opencode" },
  { id: "og/minimax-m3", owned_by: "opencode" },
  { id: "or/openai/gpt-5.6-luna:floor[1m]", owned_by: "openrouter" },
  { id: "qw/qwen3.8-max-preview", owned_by: "qwen" },
];

// Route info shown in the console ("model routing" section). Public, no keys.
const ROUTE_INFO = [
  {
    prefix: "og/",
    backend: "OpenCode Go",
    desc: "opencode.ai/zen/go — chat/completions translation (all models)",
    models: ["deepseek-v4-flash", "minimax-m3"],
  },
  {
    prefix: "ds/",
    backend: "DeepSeek Official",
    desc: "api.deepseek.com/anthropic — Bearer passthrough",
    models: ["deepseek-v4-flash"],
  },
  {
    prefix: "or/",
    backend: "OpenRouter",
    desc: "openrouter.ai — user's own key, proxied via openrouter-proxy",
    models: ["openai/gpt-5.6-luna:floor[1m]"],
  },
  {
    prefix: "qw/",
    backend: "Qwen MaaS (Aliyun)",
    desc: "token-plan.ap-southeast-1.maas.aliyuncs.com — Anthropic passthrough",
    models: ["qwen3.8-max-preview"],
  },
  {
    prefix: "none",
    backend: "DeepSeek Official (default)",
    desc: "fallback route",
    models: ["deepseek-v4-flash"],
  },
];

// ---- Channel health (public /api/health) ----
const HEALTH_CHANNELS = [
  { id: "ds", model: "ds/deepseek-v4-flash" },
  { id: "qw", model: "qw/qwen3.8-max-preview" },
  { id: "og", model: "og/deepseek-v4-flash" },
  { id: "or", model: "or/openai/gpt-5.6-luna:floor[1m]" },
];
const HEALTH_PRIORITY = ["qw", "ds", "og", "or"];

// Public /api/vale-probe rate limit: each probe costs a real upstream call
// (real money), so cap probes at 60/min gateway-wide via a KV counter.
// KV is eventually consistent (~1s) — fine for a rate limiter.
const PROBE_RATE_LIMIT = 60; // probes per minute, whole gateway
const PROBE_RATE_WINDOW_MS = 60000;

export async function probeRateLimited(env) {
  try {
    const bucket = Math.floor(Date.now() / PROBE_RATE_WINDOW_MS);
    const key = `probe-rate:${bucket}`;
    const cur = Number(await env.KEYS.get(key)) || 0;
    if (cur >= PROBE_RATE_LIMIT) return true;
    await env.KEYS.put(key, String(cur + 1), { expirationTtl: 120 });
    return false;
  } catch { return false; } // fail-open on KV errors, like the breaker
}

export default {
  async fetch(request, env) {
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
        if (await probeRateLimited(env)) {
          return jsonError(429, "probe rate limit exceeded", "rate_limited");
        }
        let body = {};
        try { body = await request.json(); } catch {}
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
      return jsonError(500, error.message || "Internal error", "api_error");
    }
  },
};

/* ---------------- Console (web UI API) ---------------- */

async function handleConsole(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const secure = url.protocol === "https:";

  // ---- Public: register / login / logout / route info ----
  if (method === "POST" && path === `${AUTH_BASE}/register`) return authRegister(request, env, secure);
  if (method === "POST" && path === `${AUTH_BASE}/login`) return authLogin(request, env, secure);
  if (method === "POST" && path === `${AUTH_BASE}/logout`) {
    return jsonOk({ ok: true }, { "Set-Cookie": clearSessionCookieHeader(secure) });
  }
  if (method === "GET" && path === `${ADMIN_BASE}/public`) {
    return jsonOk({ routes: ROUTE_INFO, models: MODELS.map((m) => m.id), apiHost: env.API_HOST || "" });
  }

  // Public device registration (the Windows install calls this with a one-time
  // registration key + the device's {name, hostname, token}). Not session-based:
  // the install runs headless on the device machine.
  if (method === "POST" && path === "/api/register") {
    let body = {};
    try { body = await request.json(); } catch {}
    if (!(await hasRegKey(env, body.key))) {
      return jsonError(403, "Invalid or used registration key", "authorization_error");
    }
    let device;
    try { device = validateDevice(body); } catch (e) { return jsonError(400, e.message, "invalid_request"); }
    await upsertDevice(env, device);
    await deleteRegKey(env, body.key); // one-time — consumed only after success
    return jsonOk({ ok: true, device: { name: device.name, hostname: device.hostname } });
  }

  // Public: the Windows install fetches the Cloudflare tunnel API token with a
  // valid registration key (so tunnel setup needs no browser login and no
  // token pasted on the machine). Validates but does NOT consume the key —
  // consumption happens at /api/register when the device is registered.
  if (method === "POST" && path === "/api/install/tunnel-token") {
    let body = {};
    try { body = await request.json(); } catch {}
    if (!(await hasRegKey(env, body.key))) {
      return jsonError(403, "Invalid or used registration key", "authorization_error");
    }
    return jsonOk({ ok: true, apiToken: await getCfToken(env) });
  }

  // Public: browser-extension pairing — the extension has no admin session, the
  // pairing code is the credential (same pattern as /api/register above).
  if (method === "POST" && path === `${PLUGIN_BASE}/pair/claim`) {
    const { code } = (await request.json().catch(() => ({}))) || {};
    const device = await consumePairCode(env, String(code || ""));
    if (!device) return jsonError(403, "Invalid or used pairing code", "authorization_error");
    const token = randomHex(16);
    await addPluginLink(env, token, device);
    return jsonOk({ token, device });
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
    return hub.fetch(new Request(wsUrl.toString(), request));
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
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const link = token ? await getPluginByToken(env, token) : null;
    if (link && link.device === deviceName) {
      return await proxyDevice(request, env, d, proxyMatch[2] || "/");
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
    let body = {};
    try { body = await request.json(); } catch {}
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
  if (method === "PUT" && path === `${ME_BASE}/keys`) {
    let body = {};
    try { body = await request.json(); } catch {}
    const { name, value } = body || {};
    if (!USER_KEY_NAMES.includes(name)) return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
    if (typeof value !== "string" || !value.trim()) return jsonError(400, "value must not be empty", "invalid_request");
    const v = value.trim();
    await setUserKey(env, user.id, name, v);
    return jsonOk({ ok: true, name, masked: maskKey(v) });
  }
  if (method === "DELETE" && path === `${ME_BASE}/keys`) {
    const name = url.searchParams.get("name");
    if (!USER_KEY_NAMES.includes(name)) return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
    await deleteUserKey(env, user.id, name);
    return jsonOk({ ok: true, name });
  }
  if (method === "POST" && path === `${ME_BASE}/keys/test`) {
    let body = {};
    try { body = await request.json(); } catch {}
    const name = body?.name;
    if (!USER_KEY_NAMES.includes(name)) return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
    const ukeys = await getUserKeys(env, user.id);
    return testKey(name, ukeys[name]);
  }

  // ---- Admin-only ----
  if (user.role !== "admin") return jsonError(403, "Admin permission required", "authorization_error");

  // ---- Device module (Vale Command registry) ----
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
    let body = {};
    try { body = await request.json(); } catch {}
    let device;
    try { device = validateDevice(body); } catch (e) { return jsonError(400, e.message, "invalid_request"); }
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
    const { device } = (await request.json().catch(() => ({}))) || {};
    const d = device ? await getDevice(env, String(device)) : null;
    if (!d) return jsonError(404, "Device not found", "not_found_error");
    const code = await createPairCode(env, d.name);
    return jsonOk({ code });
  }
  if (method === "POST" && path === `${PLUGIN_BASE}/unpair`) {
    const { device } = (await request.json().catch(() => ({}))) || {};
    const links = await listPluginLinks(env);
    for (const [t, l] of Object.entries(links)) if (l.device === device) await removePluginLink(env, t);
    return jsonOk({ ok: true });
  }
  if (method === "GET" && path === `${PLUGIN_BASE}/status`) {
    const devices = await listDevices(env);
    const out = {};
    for (const d of devices) {
      try {
        const id = env.PLUGIN_HUB.idFromName(d.name);
        const hub = env.PLUGIN_HUB.get(id);
        const res = await hub.fetch("https://hub/status");
        const j = await res.json();
        out[d.name] = { online: !!j.online };
      } catch { out[d.name] = { online: false }; }
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
    let body = {};
    try { body = await request.json(); } catch {}
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
    let body = {};
    try { body = await request.json(); } catch {}
    if (id === ADMIN_ID) return jsonError(400, "Cannot disable the admin account", "invalid_request");
    const u = await setUserEnabled(env, id, !!body.enabled);
    return jsonOk({ ok: true, id, enabled: u.enabled });
  }

  // Admin password: view / change (stored in KV, viewable from the console)
  if (method === "GET" && path === `${ADMIN_BASE}/password`) {
    return jsonOk({ password: await getAdminPassword(env) });
  }
  if (method === "PUT" && path === `${ADMIN_BASE}/password`) {
    let body = {};
    try { body = await request.json(); } catch {}
    const v = String(body?.password || "");
    if (v.length < 8) return jsonError(400, "Admin password must be at least 8 chars", "invalid_request");
    await setAdminPassword(env, v);
    return jsonOk({ ok: true, changed: true });
  }

  return jsonError(404, "Not Found", "not_found_error");
}

async function requireSession(request, env) {
  const ap = await getAdminPassword(env);
  if (!ap) return null;
  const cookie = parseCookie(request.headers.get("Cookie"))[SESSION_COOKIE];
  const session = await verifySessionToken(ap, cookie);
  if (!session) return null;
  const user = await getUser(env, session.uid);
  if (!user || !user.enabled) return null;
  return user;
}

/* ---- Register / Login ---- */

async function authRegister(request, env, secure) {
  const ap = await getAdminPassword(env);
  if (!ap) return jsonError(500, "Admin password not configured", "config_error");
  let body = {};
  try { body = await request.json(); } catch {}
  try {
    const created = await createUser(env, {
      username: body.username,
      password: body.password,
      inviteCode: body.inviteCode,
      role: "user", // always a normal user; the admin can only come from seeding
    });
    const token = await issueSessionToken(ap, created.id, created.role);
    return jsonOk({ ok: true, username: created.username, role: created.role, token: created.token }, { "Set-Cookie": sessionCookieHeader(token, 86400, secure) });
  } catch (e) {
    return jsonError(400, e.message, "invalid_request");
  }
}

async function authLogin(request, env, secure) {
  const ap = await getAdminPassword(env);
  if (!ap) return jsonError(500, "Admin password not configured", "config_error");
  let body = {};
  try { body = await request.json(); } catch {}
  const user = await findUserByUsername(env, body.username);
  if (!user || !user.enabled) return jsonError(401, "Incorrect username or password", "authentication_error");
  let ok = false;
  if (user.id === ADMIN_ID) {
    // The admin account logs in with the admin password (stored in KV, viewable/changeable from the console)
    ok = (body.password || "") === ap;
  } else {
    ok = !!user.salt && !!user.passwordHash && (await verifyPassword(body.password || "", user.salt, user.passwordHash));
  }
  if (!ok) return jsonError(401, "Incorrect username or password", "authentication_error");
  const token = await issueSessionToken(ap, user.id, user.role);
  return jsonOk({ ok: true, username: user.username, role: user.role }, { "Set-Cookie": sessionCookieHeader(token, 86400, secure) });
}

/* ---------------- /v1/* gateway ---------------- */

export async function handleGateway(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // Auth: x-api-key = the user's gateway token
  const token = request.headers.get("x-api-key") || "";
  const user = await findUserByToken(env, token);
  if (!user || !user.enabled) {
    return jsonError(401, "Missing or invalid x-api-key", "authentication_error");
  }
  const ukeys = await getUserKeys(env, user.id);
  const deepseekKey = ukeys.DEEPSEEK_API_KEY || null;
  const opencodeGoKey = ukeys.OPENCODE_GO_API_KEY || null;
  const openRouterKey = ukeys.OPENROUTER_API_KEY || null;
  const qwenKey = ukeys.QWEN_API_KEY || null;

  // GET /v1/models — list of prefixed models this gateway supports
  if (method === "GET" && path.endsWith("/models")) {
    return jsonOk({
      object: "list",
      data: MODELS.map((m, i) => ({
        id: m.id,
        object: "model",
        created: 1785000000 + i,
        owned_by: m.owned_by,
      })),
    });
  }

  const isCount = method === "POST" && path.endsWith(COUNT_PATH);
  const isMessages = method === "POST" && path.endsWith(VERIFY_PATH);
  if (!(isCount || isMessages)) {
    return jsonError(404, "Not Found", "not_found_error");
  }

  // Read the body as raw text ONCE and extract the top-level "model" field
  // with a lightweight scan — full JSON.parse + re-stringify of a multi-MB
  // body exceeds the Workers Free plan 10ms CPU budget (Error 1102). Only the
  // og translate path (which must walk the message array) parses the object.
  // Size guard first: a body over MAX_BODY_BYTES would take too long to even
  // scan on the Free plan — reject it outright.
  const declaredLen = Number(request.headers.get("content-length") || 0);
  if (declaredLen > MAX_BODY_BYTES) {
    return jsonError(413, `request body too large (max ${MAX_BODY_BYTES} bytes)`, "invalid_request");
  }
  const rawText = await request.text();
  if (rawText.length > MAX_BODY_BYTES) {
    return jsonError(413, `request body too large (max ${MAX_BODY_BYTES} bytes)`, "invalid_request");
  }
  const { model: scannedModel } = scanTopLevelModel(rawText);
  let model = scannedModel || "";
  if (model === "auto") {
    // Claude Code 固定模型名 auto：按用户网页选择路由
    model = await resolveAutoModel(env, user.id);
  }
  const prefix = model.split("/")[0];
  // og/gpt-5.6-luna is region-blocked on zen (upstream 403 for CN) but fully
  // usable via OpenRouter's US exit. Map it to the or/ channel so both og/ and
  // or/ spellings hit the same working route (OpenRouter key + proxy exit).
  const directOg = url.searchParams.get("direct") === "1";
  let effectiveModel = model;
  if (model === "og/gpt-5.6-luna" || model === "og/openai/gpt-5.6-luna:floor[1m]") {
    effectiveModel = "or/openai/gpt-5.6-luna:floor[1m]";
  } else {
    effectiveModel = model;
  }
  const prefix2 = effectiveModel.split("/")[0];
  const baseRoute = pickRoute(prefix2, env);
  const upstreamModel = stripBracket(baseRoute.stripPrefix ? effectiveModel.slice(prefix2.length + 1) : effectiveModel);
  // og/deepseek-v4-flash is Anthropic-native on zen/go/v1/messages (x-api-key
  // auth, verified 2026-08-10) — bypass the OpenAI translation; other og models
  // (minimax-m3, mimo-v2.5, kimi, glm) keep the translate path. upstreamModel is
  // already bracket-stripped, so a [1m] marker cannot mask the check.
  const route =
    baseRoute.kind === "opencode" && OG_NATIVE_ANTHROPIC.has(upstreamModel)
      ? { ...baseRoute, type: "passthrough", upstream: env.US_PROXY
          ? `https://v.saisi.online/api/zen?target=og&path=${encodeURIComponent("/v1/messages")}`
          : OG_ZEN_ANTHROPIC }
      : baseRoute;

  // The full body object is only needed on the og translate path (web_search
  // detection, image pre-processing, toOpenAIRequest). Passthrough routes
  // (ds/qw/or) forward the raw text with the model field swapped — parsing a
  // multi-MB body into an object graph would blow the Free plan CPU budget.
  let body = null;

  // ---- Gateway web search (og/ model answers, DeepSeek executes the search) ----
  // Claude Code's WebSearch is executed server-side via Anthropic's web_search
  // server tool. opencode zen (og/) doesn't implement it — for any og model,
  // native-Anthropic or not — but DeepSeek official's Anthropic endpoint does.
  // So for og/ models, run the search through DeepSeek official and let the
  // requested og/ model answer from the results — the model stays og/, DeepSeek
  // is only the search backend. Requires this user's DEEPSEEK_API_KEY. ds/ and
  // or/ requests pass through untouched (ds/ handles web_search natively).
  if (isMessages && (route.type === "translate" || route.kind === "opencode")) {
    body = JSON.parse(rawText);
    const isWebSearch = (
      (Array.isArray(body.tools) && body.tools.some((t) => t && typeof t.type === "string" && t.type.startsWith("web_search"))) ||
      (body.tool_choice && body.tool_choice.type === "tool" && body.tool_choice.name === "web_search")
    );
    if (isWebSearch) {
      if (!deepseekKey) {
        return jsonError(502, "DEEPSEEK_API_KEY not configured — required for gateway web search", "config_error");
      }
      const res = await runWebSearch(body, env, ukeys, route, upstreamModel, deepseekKey, opencodeGoKey);
      if (body.stream) {
        return new Response(toSSE(res), {
          headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...CORS_HEADERS },
        });
      }
      return jsonOk(res);
    }

    // ---- Gateway-side vision pre-processing ----
    // Text-only models (deepseek, minimax, ...) can't see images. When a request
    // carries image blocks and the target model isn't on the vision-capable
    // allowlist, describe each image with the configured vision model (default
    // og/mimo-v2.5) and swap the image blocks for that text, so any model can
    // answer image questions. count_tokens skips this.
    const prep = await preprocessImages(body.messages, env, ukeys, model, upstreamModel);
    if (prep.changed) body.messages = prep.messages;
  }

  // or/ goes through the openrouter-proxy using "this user's" OpenRouter key (BYOK)
  if (route.kind === "openrouter" && !openRouterKey) {
    return jsonError(502, "OPENROUTER_API_KEY not configured — add your own key in the console", "config_error");
  }
  // ds / no prefix use this user's DeepSeek key; qw/ uses their Qwen key;
  // og/ (translate or native) uses their OpenCode Go key — never the DeepSeek key.
  const bearerKey = route.kind === "openrouter" ? openRouterKey
    : route.kind === "qwen" ? qwenKey
    : route.kind === "opencode" ? opencodeGoKey
    : deepseekKey;

  // count_tokens
  if (isCount) {
    if (route.kind === "opencode" || env.US_PROXY) {
      // og counts locally — translate AND native passthrough (zen's count
      // endpoint adds nothing; local estimate is CPU-cheap). estimateTokens
      // itself approximates for bodies over 1M chars.
      // US_PROXY 开启时同样本地估算:代理 URL 是编码后的 ?path=,replace()
      // 拼不出正确的 count 路径,硬拼会变成真实生成调用(浪费)。
      return jsonOk({ input_tokens: estimateTokens(rawText) });
    }
    if (route.kind === "deepseek" && !deepseekKey) {
      return jsonError(502, "DEEPSEEK_API_KEY not configured — add your own key in the console", "config_error");
    }
    if (route.kind === "qwen" && !qwenKey) {
      return jsonError(502, "QWEN_API_KEY not configured — add your own key in the console", "config_error");
    }
    let upstream;
    try {
      upstream = await fetchWithTimeout(route.upstream.replace(VERIFY_PATH, COUNT_PATH), {
        method: "POST",
        headers: passthroughHeaders(bearerKey),
        body: rawWithModel(rawText, upstreamModel),
      }, upstreamTimeoutMs(env));
    } catch (e) {
      // Upstream unreachable/failed — fall back to a local estimate instead of
      // 502ing: Claude Code calls count_tokens on every request, and a big body
      // shouldn't turn that into an error (or a 10ms-CPU trip on the Free plan).
      return jsonOk({ input_tokens: estimateTokens(rawText) });
    }
    if (!upstream.ok) {
      return jsonOk({ input_tokens: estimateTokens(rawText) });
    }
    const json = await upstream.json();
    return jsonOk({ input_tokens: json.input_tokens || estimateTokens(rawText) });
  }

  // ---- POST /v1/messages ----
  // Passthrough routes (or/ds/qw): the upstream already speaks the Anthropic
  // protocol, forward the body unchanged + stream the response.
  if (route.type === "passthrough") {
    if (route.kind === "deepseek" && !deepseekKey) {
      return jsonError(502, "DEEPSEEK_API_KEY not configured — add your own key in the console", "config_error");
    }
    if (route.kind === "qwen" && !qwenKey) {
      return jsonError(502, "QWEN_API_KEY not configured — add your own key in the console", "config_error");
    }
    // og-native parsed the body above (web-search detection, image
    // pre-processing) — forward THAT (images must arrive described, deepseek
    // is text-only). ds/qw/or never parse: raw text with only the top-level
    // model field swapped — no parse, no spread, no full re-stringify (Free
    // plan 10ms CPU budget). og-native authenticates with x-api-key;
    // every other passthrough channel uses Bearer.
    const forwardBody = body !== null
      ? JSON.stringify({ ...body, model: upstreamModel })
      : rawWithModel(rawText, upstreamModel);
    const { response: upstream, detail } = await fetchWithRetry(route.upstream, {
      method: "POST",
      headers: passthroughHeaders(bearerKey, { apiKeyHeader: route.kind === "opencode" ? "x-api-key" : false }),
      body: forwardBody,
    }, { timeoutMs: passthroughTimeoutMs(env, route.kind) });
    if (!upstream) {
      // Slow failure (timeout / network error) — single attempt, no retry, no
      // breaker trip (passthrough channels have no breaker anyway).
      return jsonError(502, `upstream ${route.kind}: ${detail}`, "api_error");
    }
    if (!upstream.ok) {
      let message = `Upstream ${upstream.status}`;
      try {
        const err = await upstream.json();
        message = err.error?.message || err.message || JSON.stringify(err).slice(0, 200) || message;
      } catch { /* non-JSON error body */ }
      return jsonError(upstream.status, message, "api_error");
    }
    const headers = new Headers(upstream.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // Translation route (og, non-native models only): Anthropic → OpenAI → zen/go,
  // then reshape back to Anthropic SSE. deepseek-v4-flash / minimax-m3 never get
  // here — they were switched to passthrough above.
  if (!opencodeGoKey) {
    return jsonError(502, "OPENCODE_GO_API_KEY not configured — add your own key in the console", "config_error");
  }
  if (await isChannelDegraded(env)) {
    // Circuit open: repeated hard failures — fail fast instead of waiting on zen again.
    return jsonError(502, "og: circuit open (recent upstream failures, try again in ~1 min)", "api_error");
  }
  const openaiReq = toOpenAIRequest(body, upstreamModel);
  const { response: upstream, detail } = await fetchWithRetry(route.upstream, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opencodeGoKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(openaiReq),
  }, { timeoutMs: ogTimeoutMs(env) });
  if (!upstream || !upstream.ok) {
    // Only a hard network failure (channel unreachable) counts toward the
    // breaker — and only N consecutive failures open it (see BreakerDO).
    // Slow responses (timeout) are zen's normal behavior — multi-second latency
    // is observed routinely, so a slow request must NOT take the whole og
    // channel down; Claude Code's own retry handles it. Fast 5xx/429 stays with
    // the retries (no trip). detail distinguishes: "network error: ..." vs
    // "timeout after ...ms".
    if (detail?.startsWith("network error")) await recordChannelFailure(env);
    return jsonError(502, `og: ${detail || `upstream ${upstream?.status || "error"}`}`, "api_error");
  }
  // A real response (even a retried 5xx→2xx) resets the consecutive-failure
  // count — otherwise yesterday's blips would combine with today's to trip.
  await recordChannelSuccess(env);
  // True streaming: when the client asked for a stream, forward zen's OpenAI SSE
  // chunks to Anthropic SSE increments as they arrive (instead of buffering the
  // whole response and flushing it at once — that made thinking look frozen and
  // could time out long generations).
  if (body.stream) {
    // Extract the scalars the encoder needs, then drop the big body object so
    // the GC can reclaim it while the (potentially minutes-long) stream runs —
    // keeping a multi-MB parsed body resident the whole time pushes the Free
    // plan's 128MB isolate limit.
    const clientModel = body.model;
    const streamBody = streamOgToAnthropic(upstream.body, clientModel, upstreamModel);
    body = null;
    return new Response(streamBody, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...CORS_HEADERS },
    });
  }
  const anthropicRes = toAnthropicResponse(await upstream.json(), upstreamModel);
  return jsonOk(anthropicRes);
}

/**
 * Fetch an upstream with retry on transient failures (5xx / 429).
 *
 * Used by the og translate path (zen/go, which intermittently returns 500 —
 * observed ~50% on 2026-08-03) and the ds/qw/or passthrough paths (official
 * APIs' transient 5xx/429s). Retrying the identical request a couple of times
 * makes the gateway transparently absorb those failures instead of surfacing
 * "API error" to the client. Only retries before any response body has started
 * (a streaming response that dies mid-stream cannot be replayed).
 *
 * Slow failures (timeout / network error) are NOT retried — an upstream that
 * takes 45s to fail will simply fail again; retries only help fast 5xx/429s.
 * Returns { response, detail } where detail explains the failure for the 502.
 */
export async function fetchWithRetry(url, init, { attempts = 3, backoffMs = 750, timeoutMs = 30000 } = {}) {
  let last = null;
  let detail = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      last = await fetchWithTimeout(url, { ...init, body: init.body }, timeoutMs);
    } catch (e) {
      detail = e.name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : `network error: ${e.message}`;
      break;
    }
    if (last.ok || !(last.status >= 500 || last.status === 429)) {
      return { response: last, detail: "" };
    }
    detail = `upstream ${last.status} (retried ${attempt}/${attempts})`;
    console.error(`[gateway] upstream ${last.status} on attempt ${attempt}/${attempts} — retrying`);
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }
  return { response: last, detail };
}

/* ---------------- Device module helpers ---------------- */

function validateDevice(body) {
  const name = String(body?.name || "").trim();
  const hostname = String(body?.hostname || "").trim();
  const token = String(body?.token || "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error("Device name must be 1-32 chars: letters/digits/_ -");
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(hostname)) throw new Error("hostname must be a domain like d1.agent.saisi.online");
  if (token.length < 8) throw new Error("Token must be at least 8 chars");
  return { name, hostname, token };
}

/** Claude Code MCP config snippet for a device (the only place the raw token is returned). */
function mcpConfig(d) {
  const url = `https://${d.hostname}/mcp`;
  const snippet = {
    mcpServers: {
      "vale-agent": { type: "http", url, headers: { Authorization: `Bearer ${d.token}` } },
    },
  };
  return { url, json: JSON.stringify(snippet, null, 2) };
}

/** Reverse-proxy to the device panel, injecting the Bearer token server-side. */
async function proxyDevice(request, env, device, restPath) {
  const url = new URL(request.url);

  // The panel sits behind a tunnel that adds its own x-forwarded-*; don't pass
  // the console's through. deviceFetch injects the Bearer token and strips
  // host/cookie; restPath carries the request query string.
  const headers = new Headers(request.headers);
  headers.delete("x-forwarded-proto");
  headers.delete("x-forwarded-for");
  headers.delete("cf-connecting-ip");
  headers.set("x-forwarded-proto", "https");

  const { resp, error } = await deviceFetch(env, device, restPath + url.search, {
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

function rewriteDeviceBody(text, name) {
  const prefix = `${DEVICE_BASE}/${name}/proxy`;
  const already = `${DEVICE_BASE}/[^/"']+/proxy/`;
  let out = text;
  for (const p of PANEL_ROOT_PATHS) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A quote/backtick followed by a root path that isn't already the proxy
    // prefix → insert the prefix between them (avoids double-rewriting).
    const re = new RegExp(`(["'\`])(?!${already})${escaped}`, "g");
    out = out.replace(re, `$1${prefix}${p}`);
  }
  return out;
}

/* ---- Connectivity tests ---- */

async function testKey(name, key) {
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
      // NOTE: intentionally direct (not via US_PROXY) — key validation is a
      // gateway-background operation, not a user-routed request.
      const res = await fetchWithTimeout(OG_ZEN_CHAT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
      });
      return jsonOk({ ok: res.ok, name, status: res.status, detail: res.ok ? "OpenCode Go auth OK" : `Upstream ${res.status}` });
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
    return jsonOk({ ok: false, name, detail: "Test failed: " + e.message });
  }
  return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
}

function userKeysStatus(ukeys) {
  const out = {};
  for (const n of USER_KEY_NAMES) {
    const v = ukeys[n];
    out[n] = { configured: !!v, masked: maskKey(v) };
  }
  return out;
}

export async function fetchWithTimeout(url, init = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error(`timeout after ${ms}ms`);
      err.name = "TimeoutError";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- Reliability: upstream timeout, circuit breaker, estimation ---------------- */

/** Effective upstream timeout: env UPSTREAM_TIMEOUT_MS, default 30s. */
export function upstreamTimeoutMs(env) {
  const v = Number(env?.UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 30000;
}

/**
 * og (zen) timeout — 120s. zen is a third-party gateway whose latency
 * intermittently spikes past 30s (observed "og: timeout after 30000ms" 502s),
 * and real max-thinking requests run 40-54s before first byte (measured
 * 2026-08-09); a 60s budget was tight for those. 120s absorbs the spikes AND
 * the legitimate long thinking without surfacing a 502. Streaming note: this
 * timeout only gates time-to-headers (observed ~7s) — once the SSE stream
 * starts, it runs untimed.
 */
export function ogTimeoutMs(env) {
  const v = Number(env?.OG_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 120000;
}

/**
 * Timeout for passthrough routes. og-native (e.g. deepseek-v4-flash) must use
 * the 120s og budget — zen's latency intermittently spikes past 30s and real
 * max-thinking runs 40-54s to first byte — while every other passthrough
 * channel (ds/qw/or) keeps the generic 30s upstream budget.
 */
export function passthroughTimeoutMs(env, kind) {
  return kind === "opencode" ? ogTimeoutMs(env) : upstreamTimeoutMs(env);
}

// Circuit breaker for the og channel, backed by a Durable Object so every
// worker isolate shares one strongly-consistent state. Alternatives were
// tried and failed on Cloudflare platform semantics:
//   - in-memory counter: isolates restart the count → never trips
//   - KV counter: writes can take up to 60s to propagate → every request reads
//     the pre-write state → never trips
//   - Cache API: put() is not available on the free plan → silently no-ops
//
// Semantics: only HARD network failures (channel unreachable) count toward the
// breaker, and only BREAKER_FAIL_THRESHOLD (3) CONSECUTIVE failures open it for
// BREAKER_DEGRADE_MS (60s) — a single network blip must not take the whole og
// channel down. Slow responses (timeout) are zen's normal behavior (multi-second
// latency observed routinely) and do NOT count; fast 5xx/429 stays handled by
// fetchWithRetry's retries and does NOT trip, so zen's intermittent 500s
// (~50% observed 2026-08-03) never cut the channel. A successful response
// (/reset) zeroes the count. After the TTL the first request probes zen for
// real and re-trips on failure.
const BREAKER_DEGRADE_MS = 60000;
const BREAKER_FAIL_THRESHOLD = 3;

/** Durable Object holding the breaker state (single instance per channel name). */
export class BreakerDO {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    const action = new URL(request.url).pathname;
    try {
      if (action === "/trip") {
        // Record one hard failure; open the circuit only after N consecutive.
        const count = Number((await this.state.storage.get("failCount")) || 0) + 1;
        if (count >= BREAKER_FAIL_THRESHOLD) {
          await this.state.storage.put("degradedUntil", Date.now() + BREAKER_DEGRADE_MS);
          await this.state.storage.delete("failCount");
        } else {
          await this.state.storage.put("failCount", count);
        }
        return new Response("ok");
      }
      if (action === "/reset") {
        // A success between failures — restart the consecutive count. The
        // degradedUntil is NOT cleared: while the circuit is open no real
        // request gets through, and the half-open probe that succeeds resets
        // the count for the next genuine failure.
        await this.state.storage.delete("failCount");
        return new Response("ok");
      }
      if (action === "/clear") {
        await this.state.storage.delete("degradedUntil");
        await this.state.storage.delete("failCount");
        return new Response("ok");
      }
      if (action === "/check") {
        const degradedUntil = (await this.state.storage.get("degradedUntil")) || 0;
        return new Response(degradedUntil > Date.now() ? "1" : "0");
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response(`breaker error: ${e.message}`, { status: 500 });
    }
  }
}

function breakerStub(env) {
  return env.BREAKER.get(env.BREAKER.idFromName("og"));
}

export async function isChannelDegraded(env) {
  try {
    const res = await breakerStub(env).fetch("https://breaker/check");
    return (await res.text()) === "1";
  } catch (e) {
    console.error("[breaker] check failed:", e.message);
    return false;
  }
}

export async function recordChannelFailure(env) {
  try {
    await breakerStub(env).fetch("https://breaker/trip");
  } catch (e) {
    console.error("[breaker] trip failed:", e.message);
  }
}

export async function recordChannelSuccess(env) {
  try {
    await breakerStub(env).fetch("https://breaker/reset");
  } catch (e) {
    console.error("[breaker] reset failed:", e.message);
  }
}

/**
 * Replace the top-level "model" value in a raw JSON body without parsing it.
 * Re-scans for the field's value span (cheap O(n), no object graph) and
 * rebuilds only that slice. Falls back to the unchanged body if the field
 * can't be located.
 */
export function rawWithModel(raw, newModel) {
  const { valueStart, valueEnd } = scanTopLevelModel(raw);
  if (valueStart < 0 || valueEnd <= valueStart) return raw;
  return raw.slice(0, valueStart) + JSON.stringify(newModel) + raw.slice(valueEnd);
}

/**
 * Lightweight scan of a JSON request body for the TOP-LEVEL "model" field,
 * WITHOUT building the object graph (avoids the full parse + re-stringify
 * that burns the Workers Free plan's 10ms CPU budget on multi-MB bodies).
 *
 * Walks the JSON once: skips strings (with escapes), objects, arrays, and
 * tracks depth. Returns { model, valueStart, valueEnd } where valueStart/End
 * bound the model string value (including its quotes) for in-place
 * replacement; model is null when absent.
 */
export function scanTopLevelModel(raw) {
  let i = 0;
  const n = raw.length;
  let depth = 0; // {} and [] nesting — model must sit at depth 0
  let inStr = false;
  let keyStart = -1; // first char of the key text (after its opening quote)
  let keyEnd = -1;   // index of the key's closing quote
  let pendingKey = false;
  while (i < n) {
    const c = raw[i];
    if (inStr) {
      if (c === "\\") { i += 2; continue; }
      if (c === '"') {
        inStr = false;
        if (keyStart >= 0) keyEnd = i; // closing quote of a key string
      }
      i += 1;
      continue;
    }
    if (c === '"') {
      if (pendingKey) {
        keyStart = i + 1; // start of the key text
        keyEnd = -1;
        pendingKey = false;
      }
      inStr = true;
      i += 1;
      continue;
    }
    if (c === "{" || c === "[") {
      depth += 1;
      if (depth === 1) pendingKey = true; // entering the top-level object
      i += 1;
      continue;
    }
    if (c === "}" || c === "]") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (c === ",") {
      // Top-level comma → the next token is a new key. Without this, any
      // field before "model" (system/tools, which Claude Code sends first)
      // leaves pendingKey false and "model" is never matched — the request
      // silently routes to the default (ds) channel.
      if (depth === 1) pendingKey = true;
      keyStart = -1;
      keyEnd = -1;
      i += 1;
      continue;
    }
    if (c === ":") {
      // key "model" at top level? keyStart..keyEnd bound the key text.
      if (depth === 1 && keyStart >= 0 && keyEnd > keyStart && raw.slice(keyStart, keyEnd) === "model") {
        // value follows — skip whitespace, expect a string.
        let j = i + 1;
        while (j < n && (raw[j] === " " || raw[j] === "\t" || raw[j] === "\n" || raw[j] === "\r")) j += 1;
        if (j < n && raw[j] === '"') {
          const vs = j;
          let k = j + 1;
          let val = "";
          while (k < n) {
            if (raw[k] === "\\") { val += raw[k] + (raw[k + 1] || ""); k += 2; continue; }
            if (raw[k] === '"') break;
            val += raw[k];
            k += 1;
          }
          return { model: val, valueStart: vs, valueEnd: k + 1 };
        }
        return { model: null, valueStart: -1, valueEnd: -1 };
      }
      keyStart = -1;
      keyEnd = -1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return { model: null, valueStart: -1, valueEnd: -1 };
}

/**
 * Rough token estimate. ASCII runs ~4 chars/token, CJK/other script chars are
 * ~1.8 tokens each — the plain `length / 4` underestimates Chinese-heavy
 * prompts, which skews the client's context accounting.
 *
 * CPU-safe: the char-by-char walk is O(n) and on a multi-MB body could alone
 * exceed the Workers Free plan 10ms CPU budget. Large bodies fall back to a
 * byte-length approximation (never stringify+walk them) — count_tokens only
 * needs a context-budget estimate, ±20% is fine.
 */
const ESTIMATE_WALK_LIMIT = 1_000_000; // chars: beyond this, approximate

export function estimateTokens(jsonStr) {
  const s = String(jsonStr);
  if (s.length > ESTIMATE_WALK_LIMIT) {
    // ~4 chars/token ASCII, CJK denser — the ceiling is enough for budgeting.
    return Math.ceil(s.length / 3);
  }
  let ascii = 0;
  let other = 0;
  for (const ch of s) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other * 1.8);
}

/* ---------------- Routing ---------------- */

// Claude Code appends a [context-window] marker (e.g. [1m]) to model names and strips it
// before sending; strip it here too as a safety net so a literal "[1m]" never hits zen/OpenRouter.
function stripBracket(s) {
  return s.replace(/\[[^\]]*\]$/, "");
}

function pickRoute(prefix, env) {
  // 美国出口开关:US_PROXY=1 时所有模型经 Vercel 代理(v.saisi.online/api/zen)
  // 从美国边缘出口访问上游,规避区域限制/拥堵。target=og|ds|qw|or 选上游,
  // path 参数带上游相对路径(代理 base 已含主机级前缀)。
  const via = (direct, path) => env.US_PROXY
    ? `https://v.saisi.online/api/zen?target=${prefix}&path=${encodeURIComponent(path)}`
    : direct;
  switch (prefix) {
    case "or":
      return {
        type: "passthrough",
        kind: "openrouter", // passes through the user's own OPENROUTER_API_KEY
        stripPrefix: true,
        // 代理 base 是 openrouter.ai/api,path 只用 /v1/messages(不含 /api,
        // 否则拼出 openrouter.ai/api/api/v1/messages → 404)
        upstream: via((env.OPENROUTER_PROXY_URL || "https://openrouter.example.com/api/proxy") + VERIFY_PATH, "/v1/messages"),
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

function passthroughHeaders(bearerKey, { apiKeyHeader = false } = {}) {
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

/* ---------------- Anthropic → OpenAI (for og translation) ---------------- */

function toOpenAIRequest(req, model) {
  const messages = [];
  if (req.system) {
    const text = Array.isArray(req.system)
      ? req.system.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : req.system;
    if (text) messages.push({ role: "system", content: text });
  }
  for (const m of req.messages || []) {
    if (m.role === "user") {
      const content = typeof m.content === "string" ? m.content : m.content || [];
      if (typeof content === "string") {
        if (content) messages.push({ role: "user", content });
      } else {
        // Keep text and image parts together as an OpenAI content array, so the
        // og/ translation forwards images (vision models) instead of dropping them.
        const parts = [];
        let textBuf = [];
        const flush = () => { if (textBuf.length) { parts.push({ type: "text", text: textBuf.join("\n") }); textBuf = []; } };
        for (const b of content) {
          if (b.type === "tool_result") {
            flush();
            const toolText =
              typeof b.content === "string" ? b.content : (b.content || []).map((c) => c.text || c.thinking || "").join("\n");
            messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolText });
          } else if (b.type === "text") {
            textBuf.push(b.text);
          } else if (b.type === "image") {
            flush();
            const mediaType = b.source?.media_type || "image/png";
            const data = b.source?.data || "";
            if (data) parts.push({ type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } });
          }
        }
        flush();
        if (parts.length) messages.push({ role: "user", content: parts });
      }
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: null };
      const content = typeof m.content === "string" ? m.content : m.content || [];
      const textParts = [], thinkParts = [], toolCalls = [];
      if (typeof content === "string") textParts.push(content);
      else {
        for (const b of content) {
          if (b.type === "thinking") thinkParts.push(b.thinking);
          else if (b.type === "text") textParts.push(b.text);
          else if (b.type === "tool_use") {
            toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
          }
        }
      }
      if (textParts.length) msg.content = textParts.join("\n");
      if (thinkParts.length) msg.reasoning_content = thinkParts.join("\n");
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      messages.push({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
    }
  }

  const out = { model, messages, stream: !!req.stream };
  if (req.max_tokens) out.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => {
      // OpenAI function tools require parameters to be a JSON Schema object.
      // Claude Code may send an empty/absent input_schema for server-side tools
      // like web_search, which some backends (opencode zen) reject. Normalize it.
      const raw = t.input_schema && typeof t.input_schema === "object" ? t.input_schema : {};
      const parameters = raw.type ? raw : { type: "object", properties: raw.properties || {} };
      return { type: "function", function: { name: t.name, description: t.description || "", parameters } };
    });
    if (req.tool_choice) {
      const tc = req.tool_choice;
      if (tc.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
      else if (tc.type === "any") out.tool_choice = "required";
      else out.tool_choice = "auto";
    }
  }
  return out;
}

/* ---------------- Gateway-side vision pre-processing ---------------- */
// The gateway's own models (deepseek, minimax, ...) are text-only. If an incoming
// request carries Anthropic image blocks and the target model isn't on the
// vision-capable allowlist, describe each image with a vision model (default
// og/mimo-v2.5, configurable via env VISION_MODEL) and replace the image blocks
// with the returned text so every model can "see" the picture.

function isVisionCapable(model, upstreamModel, env) {
  const list = String(env.VISION_CAPABLE_MODELS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(model) || list.includes(upstreamModel);
}

async function preprocessImages(messages, env, ukeys, model, upstreamModel) {
  if (!Array.isArray(messages)) return { messages, changed: false };
  if (isVisionCapable(model, upstreamModel, env)) return { messages, changed: false };
  const visionModel = env.VISION_MODEL || "og/mimo-v2.5";
  let changed = false;
  const out = [];
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content !== "object" || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    if (!m.content.some((b) => b.type === "image")) {
      out.push(m);
      continue;
    }
    const newContent = [];
    for (const b of m.content) {
      if (b.type === "image") {
        const desc = await describeImage(env, ukeys, b.source, visionModel);
        newContent.push({ type: "text", text: `[图片内容描述]\n${desc}` });
        changed = true;
      } else {
        newContent.push(b);
      }
    }
    out.push({ ...m, content: newContent });
  }
  return { messages: out, changed };
}

async function describeImage(env, ukeys, source, visionModel) {
  const mediaType = source?.media_type || "image/png";
  const data = source?.data || "";
  if (!data) return "(图片数据为空)";
  const prefix = visionModel.split("/")[0];
  const route = pickRoute(prefix, env);
  const upstreamModel = stripBracket(route.stripPrefix ? visionModel.slice(prefix.length + 1) : visionModel);
  const content = [
    { type: "image", source: { type: "base64", media_type: mediaType, data } },
    { type: "text", text: "请用中文详细描述这张图片的内容，包括所有可见文字（OCR）、界面元素、布局。若是截图或表格，请逐行说明关键内容。只输出描述，不要额外说明。" },
  ];
  const miniReq = { model: visionModel, max_tokens: 1500, messages: [{ role: "user", content }] };

  if (route.type === "passthrough") {
    // or/ (openrouter) or ds/ (deepseek) vision model — Anthropic passthrough
    const bearerKey = route.kind === "openrouter" ? ukeys.OPENROUTER_API_KEY : ukeys.DEEPSEEK_API_KEY;
    if (!bearerKey) return "(图片描述失败：视觉模型后端未配置)";
    let resp;
    try {
      resp = await fetchWithTimeout(route.upstream, {
        method: "POST",
        headers: passthroughHeaders(bearerKey),
        body: JSON.stringify({ ...miniReq, model: upstreamModel }),
      }, upstreamTimeoutMs(env));
    } catch (e) {
      return `(图片描述失败：${e.message})`;
    }
    if (!resp.ok) return `(图片描述失败：${resp.status})`;
    let json;
    try { json = await resp.json(); } catch { return "(图片描述失败：响应解析失败)"; }
    const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return text || "(图片描述为空)";
  }

  // og/ vision model (opencode zen) — needs the Anthropic→OpenAI translation,
  // which now forwards image_url parts (see toOpenAIRequest).
  if (!ukeys.OPENCODE_GO_API_KEY) return "(图片描述失败：OPENCODE_GO_API_KEY 未配置)";
  const openaiReq = toOpenAIRequest(miniReq, upstreamModel);
  let resp;
  try {
    resp = await fetchWithTimeout(route.upstream, {
      method: "POST",
      headers: { Authorization: `Bearer ${ukeys.OPENCODE_GO_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(openaiReq),
    }, upstreamTimeoutMs(env));
  } catch (e) {
    return `(图片描述失败：${e.message})`;
  }
  if (!resp.ok) return `(图片描述失败：${resp.status})`;
  let json;
  try { json = await resp.json(); } catch { return "(图片描述失败：响应解析失败)"; }
  return (json.choices?.[0]?.message?.content || "").trim() || "(图片描述为空)";
}

/* ---------------- Gateway web search (og model answers, DeepSeek searches) ---------------- */

/** Pull the search query out of the nested web-search request Claude Code sends. */
function extractWebSearchQuery(messages) {
  const last = [...(messages || [])].reverse().find((m) => m.role === "user");
  let text = "";
  if (last) {
    if (typeof last.content === "string") text = last.content;
    else text = (last.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
  }
  const m = text.match(/query:?\s*([\s\S]*)/i);
  return (m ? m[1].trim() : text.trim()) || "latest news";
}

/**
 * Execute the search via DeepSeek official (its Anthropic endpoint implements
 * Anthropic's web_search server tool server-side), then have the requested og/
 * model answer from the results. Returns an Anthropic-format message whose content
 * carries the server_tool_use + web_search_tool_result blocks (so Claude Code's
 * parser sees real results) plus the og/ model's text answer.
 */
async function runWebSearch(body, env, ukeys, route, upstreamModel, deepseekKey, opencodeGoKey) {
  const query = extractWebSearchQuery(body.messages);
  const searchUrl = "https://api.deepseek.com/anthropic" + VERIFY_PATH;

  let searchJson = {};
  try {
    const sr = await fetchWithTimeout(searchUrl, {
      method: "POST",
      headers: passthroughHeaders(deepseekKey),
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        max_tokens: 500,
        tools: [{ name: "web_search", type: "web_search_20250305" }],
        tool_choice: { type: "tool", name: "web_search" },
        messages: [{ role: "user", content: query }],
      }),
    }, upstreamTimeoutMs(env));
    if (sr.ok) searchJson = await sr.json();
  } catch {}

  const serverToolUses = (searchJson.content || []).filter((b) => b.type === "server_tool_use");
  const resultBlocks = (searchJson.content || []).filter((b) => b.type === "web_search_tool_result");

  let answer = await ogWebSearchAnswer(env, route, upstreamModel, opencodeGoKey, query, resultBlocks);
  if (!answer) {
    // Fall back to DeepSeek's own summary if the og/ model didn't produce one.
    answer = (searchJson.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  }

  return {
    id: crypto.randomUUID(),
    type: "message",
    role: "assistant",
    model: body.model,
    content: [...serverToolUses, ...resultBlocks, { type: "text", text: answer }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: searchJson.usage?.input_tokens || 0,
      output_tokens: (searchJson.usage?.output_tokens || 0) + Math.ceil(answer.length / 4),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: serverToolUses.length },
    },
  };
}

/** Ask the requested og/ model to answer the query from the search result titles/URLs. */
async function ogWebSearchAnswer(env, route, upstreamModel, opencodeGoKey, query, resultBlocks) {
  if (!opencodeGoKey) return "";
  const resultsText = resultBlocks
    .map((rb) => (rb.content || []).map((r) => `- ${r.title}\n  ${r.url}`).join("\n"))
    .join("\n");
  const req = {
    model: upstreamModel,
    max_tokens: 500,
    messages: [{
      role: "user",
      content: `用户查询：${query}\n\n以下是网络搜索结果：\n${resultsText || "(无结果)"}\n\n请根据这些搜索结果，用中文简要、准确地回答用户的问题。如果信息不足，请说明。`,
    }],
  };
  try {
    // Always the OpenAI-format endpoint: this sends an OpenAI body (toOpenAIRequest).
    // For native-Anthropic og models the request route's upstream is now /v1/messages,
    // which would reject an OpenAI body — so pin the chat/completions URL explicitly.
    // NOTE: intentionally direct (not via US_PROXY) — web_search is a gateway
    // background operation, not a user-routed request.
    const resp = await fetchWithTimeout(OG_ZEN_CHAT, {
      method: "POST",
      headers: { Authorization: `Bearer ${opencodeGoKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(toOpenAIRequest(req, upstreamModel)),
    }, upstreamTimeoutMs(env));
    if (!resp.ok) {
      console.error(`ogWebSearchAnswer: zen ${resp.status}`);
      return "";
    }
    const json = await resp.json();
    const text = (json.choices?.[0]?.message?.content || "").trim();
    if (!text) console.error("ogWebSearchAnswer: empty content from zen");
    return text;
  } catch (e) {
    console.error("ogWebSearchAnswer error:", e.message);
    return "";
  }
}

/* ---------------- OpenAI → Anthropic (for og translation) ---------------- */

export function toAnthropicResponse(up, model) {
  const choice = up.choices?.[0];
  const msg = choice?.message || {};
  const blocks = [];
  if (msg.reasoning_content) blocks.push({ type: "thinking", thinking: msg.reasoning_content, signature: "" });
  if (msg.content) blocks.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
    blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name || "unknown", input });
  }
  const stopMap = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens" };
  return {
    id: up.id, type: "message", role: "assistant", model,
    content: blocks,
    stop_reason: stopMap[choice?.finish_reason] || "end_turn", stop_sequence: null,
    usage: {
      input_tokens: up.usage?.prompt_tokens || 0,
      output_tokens: up.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      // zen reports prompt cache hits as usage.prompt_tokens_details.cached_tokens
      // (OpenAI naming), not prompt_cache_hit_tokens — read both so cache hits
      // surface to the client instead of always showing 0.
      cache_read_input_tokens:
        up.usage?.prompt_cache_hit_tokens || up.usage?.prompt_tokens_details?.cached_tokens || 0,
    },
  };
}

/* ---------------- True streaming: OpenAI SSE chunks → Anthropic SSE ---------------- */
// The og/ route used to request zen with stream:false, buffer the entire response,
// then flush it as one Anthropic SSE blob. That made long thinking look frozen and
// could time out on big generations. Instead we stream:true upstream and translate
// each OpenAI chunk to an Anthropic incremental event as it arrives.

const STREAM_STOP_MAP = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens" };

/**
 * Convert an OpenAI chat.completion.chunk stream into an Anthropic message event
 * stream. `upstreamBody` is a ReadableStream of OpenAI SSE (`data: {...}\n\n`,
 * terminated by `data: [DONE]`). Returns a ReadableStream emitting Anthropic SSE.
 */
function streamOgToAnthropic(upstreamBody, clientModel, upstreamModel) {
  const encoder = new TextEncoder();
  const encoderStream = new AnthropicStreamEncoder(clientModel, upstreamModel);

  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readStream = new ReadableStream({
    async pull(controller) {
      while (true) {
        // Emit any pending Anthropic events already queued by the last chunk.
        const pending = encoderStream.take();
        if (pending.length) {
          controller.enqueue(encoder.encode(pending));
          return;
        }
        // Otherwise pull the next upstream bytes.
        const { done, value } = await reader.read();
        if (done) {
          const tail = encoderStream.finish(buffer);
          if (tail) controller.enqueue(encoder.encode(tail));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines; a data line may be split across
        // read chunks, so only consume complete events.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (payload === "[DONE]") continue;
          let chunk;
          try { chunk = JSON.parse(payload); } catch { continue; }
          encoderStream.push(chunk);
          const events = encoderStream.take();
          if (events.length) {
            controller.enqueue(encoder.encode(events));
            return;
          }
        }
      }
    },
  });
  return readStream;
}

/**
 * Stateful translator from OpenAI stream deltas to Anthropic SSE events.
 * Accumulates tool-call arguments by index and tracks which content block is open.
 */
export class AnthropicStreamEncoder {
  constructor(clientModel, upstreamModel) {
    this.clientModel = clientModel;
    this.upstreamModel = upstreamModel;
    this.started = false;
    this.finished = false;
    this.blockIndex = -1;
    this.blockType = null;      // "thinking" | "text" | "tool_use"
    this.openToolInputs = {};   // tool index → accumulated arguments string
    this.pending = [];
    this.lastStopReason = "end_turn";
    this.id = "";
    this.usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  }

  push(chunk) {
    if (this.finished) return;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (!this.id && chunk.id) this.id = chunk.id;
    if (chunk.usage) {
      this.usage.input_tokens = chunk.usage.prompt_tokens || 0;
      this.usage.output_tokens = chunk.usage.completion_tokens || 0;
      // zen reports cache hits as usage.prompt_tokens_details.cached_tokens —
      // read both names, same as toAnthropicResponse.
      this.usage.cache_read_input_tokens =
        chunk.usage.prompt_cache_hit_tokens || chunk.usage.prompt_tokens_details?.cached_tokens || 0;
    }
    if (choice.finish_reason) this.lastStopReason = STREAM_STOP_MAP[choice.finish_reason] || "end_turn";

    if (delta.reasoning_content) {
      this.ensureBlock("thinking", { thinking: delta.reasoning_content, signature: "" });
    }
    if (delta.content) {
      this.ensureBlock("text", { text: delta.content });
    }
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      const fn = tc.function || {};
      this.ensureToolBlock(idx, tc.id, fn.name, fn.arguments || "");
    }
  }

  /** Close all open blocks and append message_delta + message_stop. Call once on stream end. */
  finish(tailBuffer = "") {
    if (this.finished) return null;
    this.finished = true;
    if (tailBuffer.trim()) {
      // A trailing partial event (no blank line yet) — best-effort parse.
      const dataLine = tailBuffer.split("\n").find((l) => l.startsWith("data:"));
      if (dataLine) {
        const payload = dataLine.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try { this.push(JSON.parse(payload)); } catch {}
        }
      }
    }
    // The client expects message_start to be the first event.
    if (!this.started) this.emitStart();
    if (this.blockIndex >= 0) this.closeBlock();
    this.pending.push(sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.lastStopReason, stop_sequence: null },
      usage: { output_tokens: this.usage.output_tokens },
    }));
    this.pending.push(sse("message_stop", { type: "message_stop" }));
    return this.take();
  }

  /** Drain queued Anthropic SSE text. */
  take() {
    if (this.pending.length) {
      const out = this.pending.join("");
      this.pending = [];
      return out;
    }
    return "";
  }

  emitStart() {
    if (this.started) return;
    this.started = true;
    this.pending.push(sse("message_start", {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.upstreamModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...this.usage },
      },
    }));
  }

  ensureBlock(type, block) {
    if (!this.started) this.emitStart();
    if (this.blockType !== type) {
      this.closeBlock();
      this.blockIndex += 1;
      this.blockType = type;
      const contentBlock = type === "thinking" ? { ...block, signature: "" } : { ...block };
      this.pending.push(sse("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: contentBlock,
      }));
      if (type === "thinking") {
        this.pending.push(sse("content_block_delta", {
          type: "content_block_delta",
          index: this.blockIndex,
          delta: { type: "thinking_delta", thinking: block.thinking },
        }));
      } else if (type === "text") {
        this.pending.push(sse("content_block_delta", {
          type: "content_block_delta",
          index: this.blockIndex,
          delta: { type: "text_delta", text: block.text },
        }));
      }
    } else if (type === "thinking") {
      this.pending.push(sse("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "thinking_delta", thinking: block.thinking },
      }));
    } else if (type === "text") {
      this.pending.push(sse("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "text_delta", text: block.text },
      }));
    }
  }

  ensureToolBlock(idx, id, name, argsDelta) {
    if (!this.started) this.emitStart();
    // Tools always open their own block; close any text/thinking block first.
    if (this.blockIndex >= 0 && this.blockType !== "tool_use") this.closeBlock();
    if (this.blockType !== "tool_use") {
      this.blockIndex += 1;
      this.blockType = "tool_use";
      this.pending.push(sse("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "tool_use", id: id || "", name: name || "unknown", input: {} },
      }));
    }
    if (name) {
      // zen may repeat the name on later chunks; emit a partial_json delta only for args.
      this.toolName = name;
    }
    if (argsDelta) {
      const cur = this.openToolInputs[idx] || "";
      const next = cur + argsDelta;
      this.openToolInputs[idx] = next;
      this.pending.push(sse("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "input_json_delta", partial_json: argsDelta },
      }));
    }
  }

  closeBlock() {
    if (this.blockIndex >= 0) {
      this.pending.push(sse("content_block_stop", { type: "content_block_stop", index: this.blockIndex }));
      this.blockIndex = -1;
      this.blockType = null;
    }
  }
}

/* ---------------- Anthropic SSE event stream ---------------- */

function sse(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function toSSE(res) {
  let out = "";
  out += sse("message_start", { type: "message_start", message: { ...res, content: [], stop_reason: null, stop_sequence: null } });
  res.content.forEach((block, i) => {
    // server_tool_use starts with empty input in Anthropic's wire format; the query
    // arrives via input_json_delta. web_search_tool_result carries its full content
    // array inside content_block_start (matches DeepSeek's stream).
    let startBlock = block;
    if (block.type === "server_tool_use") startBlock = { ...block, input: {} };
    out += sse("content_block_start", { type: "content_block_start", index: i, content_block: startBlock });
    if (block.type === "thinking") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: block.thinking } });
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: block.signature || "" } });
    } else if (block.type === "text") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else if (block.type === "server_tool_use") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) } });
    }
    out += sse("content_block_stop", { type: "content_block_stop", index: i });
  });
  out += sse("message_delta", { type: "message_delta", delta: { stop_reason: res.stop_reason, stop_sequence: null }, usage: { output_tokens: res.usage?.output_tokens || 0 } });
  out += sse("message_stop", { type: "message_stop" });
  return out;
}

/* ---------------- Utilities ---------------- */

function jsonOk(data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders } });
}

function jsonError(status, message, type) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

/* ---------------- Public endpoints: health / vale-cli / installers ---------------- */

export async function buildHealth(env) {
  const channels = [];
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

/** Model usable for routing? In the whitelist and (og) breaker not open. */
export async function isModelUsable(env, model) {
  if (!MODELS.some((m) => m.id === model)) return false;
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
export async function resolveAutoModel(env, uid) {
  const chosen = await getUserRoute(env, uid);
  if (chosen && (await isModelUsable(env, chosen))) return chosen;
  return DEFAULT_ROUTE_MODEL;
}

/** UTF-8-safe base64: btoa is Latin1-only and throws on non-ASCII (the vale
 *  CLI is full of Chinese text). Encode to bytes first. */
export function encodeBase64Utf8(text) {
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
export async function valeProbe(env, model) {
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
      return jsonOk({ ok: false, channel: prefix, detail: e.message });
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
    return jsonOk({ ok: false, channel: prefix, detail: e.message });
  }
  return jsonOk({ ok: res.ok, channel: prefix, status: res.status, detail: res.ok ? "" : `upstream ${res.status}` });
}

// POSIX one-liner installer — embeds the vale CLI as base64 (no quoting issues).
export function posixInstaller(b64) {
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
export function psInstaller(b64) {
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

async function serveAssetText(env, assetPath) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return null;
  }
  const res = await env.ASSETS.fetch(new Request(`https://assets.local${assetPath}`));
  return res.ok ? await res.text() : null;
}
