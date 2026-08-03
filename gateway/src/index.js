/**
 * vale-gate — Cloudflare Worker unified AI gateway (multi-user BYOK relay) + device console
 *
 * Routes by model-name prefix to different backends, each user bringing their own
 * backend keys (Bring Your Own Key):
 *
 *   or/<model>   → OpenRouter (proxied via the openrouter-proxy CF Worker)
 *   ds/<model>   → DeepSeek official (api.deepseek.com/anthropic, Bearer passthrough)
 *   og/<model>   → OpenCode Go (opencode.ai/zen/go, Anthropic↔OpenAI translation)
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

import { seedAdmin, createUser, getUser, findUserByUsername, findUserByToken, listUsers, setUserEnabled, regenerateToken, getUserKeys, setUserKey, deleteUserKey, createInvite, getAdminPassword, setAdminPassword, maskKey, ADMIN_ID, USER_KEY_NAMES, listDevices, getDevice, upsertDevice, deleteDevice, createRegKey, hasRegKey, deleteRegKey, getCfToken, setCfToken } from "./store.js";
import { verifyPassword, issueSessionToken, verifySessionToken, parseCookie, sessionCookieHeader, clearSessionCookieHeader, SESSION_COOKIE } from "./auth.js";

const VERIFY_PATH = "/v1/messages";
const COUNT_PATH = "/v1/messages/count_tokens";
const AUTH_BASE = "/api/auth";
const ADMIN_BASE = "/api/admin";
const ME_BASE = "/api/me";
const DEVICE_BASE = "/api/devices";

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
];

// Route info shown in the console ("model routing" section). Public, no keys.
const ROUTE_INFO = [
  {
    prefix: "og/",
    backend: "OpenCode Go",
    desc: "opencode.ai/zen/go — Anthropic↔OpenAI translation, tool calls & thinking",
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
    prefix: "none",
    backend: "DeepSeek Official (default)",
    desc: "fallback route",
    models: ["deepseek-v4-flash"],
  },
];

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

      await seedAdmin(env);

      // ---- Console API ----
      if (isPageHost && path.startsWith("/api/")) {
        return await handleConsole(request, env, url);
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
  // GET    /api/devices                        → list (token masked)
  // POST   /api/devices                        → add/update {name, hostname, token}
  // POST   /api/devices/register-key           → generate a one-time install key
  // DELETE /api/devices/<name>                 → remove
  // GET    /api/devices/<name>/mcp             → MCP config for a device (with token)
  // <any>  /api/devices/<name>/proxy/<rest>    → reverse-proxy to the device panel
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
  const proxyMatch = path.match(new RegExp(`^${DEVICE_BASE}/([^/]+)/proxy(.*)$`));
  if (proxyMatch) {
    const d = await getDevice(env, decodeURIComponent(proxyMatch[1]));
    if (!d) return jsonError(404, "Device not found", "not_found_error");
    return await proxyDevice(request, env, d, proxyMatch[2] || "/");
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

async function handleGateway(request, env, url) {
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

  const body = await request.json();
  const model = body.model || "";
  const prefix = model.split("/")[0];
  const route = pickRoute(prefix, env);
  const upstreamModel = stripBracket(route.stripPrefix ? model.slice(prefix.length + 1) : model);

  // ---- Gateway-side vision pre-processing ----
  // Text-only models (deepseek, minimax, ...) can't see images. When a request
  // carries image blocks and the target model isn't on the vision-capable
  // allowlist, describe each image with the configured vision model (default
  // og/mimo-v2.5) and swap the image blocks for that text, so any model can
  // answer image questions. count_tokens skips this.
  if (isMessages) {
    const prep = await preprocessImages(body.messages, env, ukeys, model, upstreamModel);
    if (prep.changed) body.messages = prep.messages;
  }

  // or/ goes through the openrouter-proxy using "this user's" OpenRouter key (BYOK)
  if (route.kind === "openrouter" && !openRouterKey) {
    return jsonError(502, "OPENROUTER_API_KEY not configured — add your own key in the console", "config_error");
  }
  // ds / no prefix use this user's DeepSeek key
  const bearerKey = route.kind === "openrouter" ? openRouterKey : deepseekKey;

  // count_tokens
  if (isCount) {
    if (route.type === "translate") {
      return jsonOk({ input_tokens: Math.ceil(JSON.stringify(body.messages || []).length / 4) });
    }
    if (route.kind === "deepseek" && !deepseekKey) {
      return jsonError(502, "DEEPSEEK_API_KEY not configured — add your own key in the console", "config_error");
    }
    const upstream = await fetch(route.upstream.replace(VERIFY_PATH, COUNT_PATH), {
      method: "POST",
      headers: passthroughHeaders(bearerKey),
      body: JSON.stringify({ ...body, model: upstreamModel }),
    });
    if (!upstream.ok) return jsonError(upstream.status, "count_tokens upstream failed", "api_error");
    const json = await upstream.json();
    return jsonOk({ input_tokens: json.input_tokens || Math.ceil(JSON.stringify(body.messages || []).length / 4) });
  }

  // ---- POST /v1/messages ----
  // Passthrough routes (or/ds): the upstream already speaks the Anthropic protocol,
  // forward the body unchanged + stream the response.
  if (route.type === "passthrough") {
    if (route.kind === "deepseek" && !deepseekKey) {
      return jsonError(502, "DEEPSEEK_API_KEY not configured — add your own key in the console", "config_error");
    }
    const upstream = await fetch(route.upstream, {
      method: "POST",
      headers: passthroughHeaders(bearerKey),
      body: JSON.stringify({ ...body, model: upstreamModel }),
    });
    if (!upstream.ok) {
      let message = `Upstream ${upstream.status}`;
      try {
        const err = await upstream.json();
        message = err.error?.message || message;
      } catch {}
      return jsonError(upstream.status, message, "api_error");
    }
    const headers = new Headers(upstream.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // Translation route (og): Anthropic → OpenAI → zen/go, then reshape back to Anthropic SSE
  if (!opencodeGoKey) {
    return jsonError(502, "OPENCODE_GO_API_KEY not configured — add your own key in the console", "config_error");
  }
  const openaiReq = toOpenAIRequest(body, upstreamModel);
  const upstream = await fetch(route.upstream, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opencodeGoKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(openaiReq),
  });
  if (!upstream.ok) {
    let message = `Upstream ${upstream.status}`;
    try {
      const err = await upstream.json();
      message = err.error?.message || message;
    } catch {}
    return jsonError(upstream.status, message, "api_error");
  }
  const anthropicRes = toAnthropicResponse(await upstream.json(), upstreamModel);
  if (body.stream) {
    return new Response(toSSE(anthropicRes), {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...CORS_HEADERS },
    });
  }
  return jsonOk(anthropicRes);
}

/* ---------------- Device module helpers ---------------- */

function validateDevice(body) {
  const name = String(body?.name || "").trim();
  const hostname = String(body?.hostname || "").trim();
  const token = String(body?.token || "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error("Device name must be 1-32 chars: letters/digits/_ -");
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(hostname)) throw new Error("hostname must be a domain like d1.command.saisi.online");
  if (token.length < 8) throw new Error("Token must be at least 8 chars");
  return { name, hostname, token };
}

/** Claude Code MCP config snippet for a device (the only place the raw token is returned). */
function mcpConfig(d) {
  const url = `https://${d.hostname}/mcp`;
  const snippet = {
    mcpServers: {
      "vale-command": { type: "http", url, headers: { Authorization: `Bearer ${d.token}` } },
    },
  };
  return { url, json: JSON.stringify(snippet, null, 2) };
}

/** Reverse-proxy to the device panel, injecting the Bearer token server-side. */
async function proxyDevice(request, env, device, restPath) {
  const url = new URL(request.url);
  const upstream = new URL(`https://${device.hostname}${restPath}`);
  upstream.search = url.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cookie");            // the console session belongs to valegate
  headers.delete("x-forwarded-proto");
  headers.delete("x-forwarded-for");
  headers.delete("cf-connecting-ip");
  headers.set("x-forwarded-proto", "https");
  headers.set("Authorization", `Bearer ${device.token}`);

  let resp;
  try {
    resp = await fetch(upstream.toString(), {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    });
  } catch (e) {
    return jsonError(502, `Device unreachable: ${e.message}`, "proxy_error");
  }

  const outHeaders = new Headers(resp.headers);
  outHeaders.set("Access-Control-Allow-Origin", "*");
  const ct = String(outHeaders.get("content-type") || "").toLowerCase();

  // Streaming (SSE / octet-stream / 101): pass the body through untouched.
  if (resp.body && (ct.includes("text/event-stream") || ct.includes("application/octet-stream") || resp.status === 101)) {
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

// Absolute paths a vale-command panel serves from its own root. When proxied
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
      const res = await fetchWithTimeout("https://opencode.ai/zen/go/v1/chat/completions", {
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

async function fetchWithTimeout(url, init = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- Routing ---------------- */

// Claude Code appends a [context-window] marker (e.g. [1m]) to model names and strips it
// before sending; strip it here too as a safety net so a literal "[1m]" never hits zen/OpenRouter.
function stripBracket(s) {
  return s.replace(/\[[^\]]*\]$/, "");
}

function pickRoute(prefix, env) {
  switch (prefix) {
    case "or":
      return {
        type: "passthrough",
        kind: "openrouter", // passes through the user's own OPENROUTER_API_KEY
        stripPrefix: true,
        upstream: (env.OPENROUTER_PROXY_URL || "https://openrouter.example.com/api/proxy") + VERIFY_PATH,
      };
    case "ds":
      return {
        type: "passthrough",
        kind: "deepseek",
        stripPrefix: true,
        upstream: "https://api.deepseek.com/anthropic" + VERIFY_PATH,
      };
    case "og":
      return {
        type: "translate",
        kind: "opencode",
        stripPrefix: true,
        upstream: "https://opencode.ai/zen/go/v1/chat/completions",
      };
    default:
      // No prefix / unknown prefix → DeepSeek official
      return {
        type: "passthrough",
        kind: "deepseek",
        stripPrefix: false,
        upstream: "https://api.deepseek.com/anthropic" + VERIFY_PATH,
      };
  }
}

function passthroughHeaders(bearerKey) {
  const h = new Headers();
  h.set("Content-Type", "application/json");
  // Do not forward the client's auth header — use this user's own key
  if (bearerKey) h.set("Authorization", `Bearer ${bearerKey}`);
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

  const out = { model, messages, stream: false };
  if (req.max_tokens) out.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || {} },
    }));
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
      resp = await fetch(route.upstream, {
        method: "POST",
        headers: passthroughHeaders(bearerKey),
        body: JSON.stringify({ ...miniReq, model: upstreamModel }),
      });
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
    resp = await fetch(route.upstream, {
      method: "POST",
      headers: { Authorization: `Bearer ${ukeys.OPENCODE_GO_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(openaiReq),
    });
  } catch (e) {
    return `(图片描述失败：${e.message})`;
  }
  if (!resp.ok) return `(图片描述失败：${resp.status})`;
  let json;
  try { json = await resp.json(); } catch { return "(图片描述失败：响应解析失败)"; }
  return (json.choices?.[0]?.message?.content || "").trim() || "(图片描述为空)";
}

/* ---------------- OpenAI → Anthropic (for og translation) ---------------- */

function toAnthropicResponse(up, model) {
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
      cache_read_input_tokens: up.usage?.prompt_cache_hit_tokens || 0,
    },
  };
}

/* ---------------- Anthropic SSE event stream ---------------- */

function sse(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function toSSE(res) {
  let out = "";
  out += sse("message_start", { type: "message_start", message: { ...res, content: [], stop_reason: null, stop_sequence: null } });
  res.content.forEach((block, i) => {
    out += sse("content_block_start", { type: "content_block_start", index: i, content_block: { ...block } });
    if (block.type === "thinking") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: block.thinking } });
    } else if (block.type === "text") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    out += sse("content_block_stop", { type: "content_block_stop", index: i });
  });
  out += sse("message_delta", { type: "message_delta", delta: { stop_reason: res.stop_reason, stop_sequence: null }, usage: { output_tokens: res.usage.output_tokens } });
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
