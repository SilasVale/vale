/**
 * devices plugin (round-73 migration) — Vale Agent device registry, reverse
 * proxy, registration keys flow, and extension pairing.
 *
 * Extracted VERBATIM from gateway/src/index.js (handleConsole) — the bodies
 * of every handler and helper below are byte-for-byte the inline blocks that
 * used to live in the dispatcher, including their comments. Zero logic
 * change: each handler re-derives path/method from (request, env, url) and
 * the session-gated routes re-apply the exact requireSession + admin gate
 * that handleConsole applied before them.
 *
 * Routes (same method + path as index.js had):
 *   POST /api/register                      (public — one-time reg key)
 *   POST /api/install/tunnel-token          (public — reg key gated CF token)
 *   POST /api/plugins/pair/claim            (public — pairing code → plugin token)
 *   POST /api/plugins/revoke                (public — plugin token revocation)
 *   POST /api/plugins/ws-ticket             (public — plugin token → WS ticket)
 *   GET  /api/plugins/ws                    (public — ticket-gated WS upgrade)
 *   <any> /api/devices/<name>/proxy/<rest>  (admin session OR paired token)
 *   GET  /api/devices                       (admin session)
 *   POST /api/devices                       (admin session — add/update)
 *   GET  /api/devices/<name>/mcp            (admin session)
 *   DELETE /api/devices/<name>              (admin session)
 *
 * Handler convention: dispatch(ctx, method, path, request, env, url) →
 * handler(request, env, url).
 */
import { hasRegKey, hasRegGrant, getDevice, upsertDevice, deleteDevice, deleteRegKey, deleteRegGrant, consumeRegKey, getCfToken, getAdminPassword, getUser, maskKey, listDevices, addPluginLink, getPluginByToken, removePluginLink, consumePairCode, createWsTicket, consumeWsTicket, type User, type Device } from "../store.ts";
import { parseCookie, SESSION_COOKIE, verifySessionToken, randomHex } from "../auth.ts";
import { build101Response, deviceFetch } from "../device-fetch.ts";
import { jsonOk, jsonError, readJson } from "../http.ts";
import { route, type Plugin, type PluginContext } from "./registry.ts";

const DEVICE_BASE = "/api/devices";
const PLUGIN_BASE = "/api/plugins";

/* ---------------- Session auth (copied from index.js) ---------------- */

// Session HMAC key: prefer the dedicated high-entropy SESSION_SECRET (wrangler
// secret) over the admin password. Using the password directly lets any invited
// user offline-brute-force it from their own signed cookie (HMAC-SHA256 is not
// memory-hard); with SESSION_SECRET set, the password is never a signing key.
function sessionSecret(env: any, adminPassword: string): string {
  return env.SESSION_SECRET || adminPassword;
}

async function requireSession(request: Request, env: any): Promise<User | null> {
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

/* ---------------- Route handlers (bodies copied verbatim from index.js) ---------------- */

// Public device registration (the Windows install calls this with a one-time
// registration key + the device's {name, hostname, token}). Not session-based:
// the install runs headless on the device machine.
async function handleRegister(request: Request, env: any): Promise<Response> {
  const body = await readJson(request);
  // Accept either a live key or the short-lived grant issued when the key
  // was spent at /api/install/tunnel-token (same install, both calls).
  const keyOk = (await hasRegKey(env, body.key)) || (await hasRegGrant(env, body.key));
  if (!keyOk) {
    return jsonError(403, "Invalid or used registration key", "authorization_error");
  }
  let device: Device;
  try { device = validateDevice(body); } catch (e) { return jsonError(400, (e as Error).message, "invalid_request"); }
  // round-68: a one-time-key holder could upsert an EXISTING device name —
  // the register endpoint silently replaced a production device's
  // hostname/token, redirecting console terminal tools + the proxy to the
  // attacker. Refuse when the name is already registered; re-registering
  // an existing device is an admin action.
  if (await getDevice(env, device.name)) {
    return jsonError(409, `Device '${device.name}' already registered — use the console (admin) to update it`, "conflict");
  }
  await upsertDevice(env, device);
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
async function handleTunnelToken(request: Request, env: any): Promise<Response> {
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
async function handlePairClaim(request: Request, env: any): Promise<Response> {
  const { code } = ((await request.json().catch(() => ({}))) || {}) as any;
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
async function handleRevoke(request: Request, env: any): Promise<Response> {
  const auth = String(request.headers.get("authorization") || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return jsonError(401, "Missing plugin token", "authentication_error");
  // round-84: a revoked link must not keep browser_* control over a LIVE WS —
  // the hub never re-validated the token after handshake, so a revoked/
  // expired link kept executing commands indefinitely. Find the device the
  // link belonged to and close its hub socket.
  const link = await getPluginByToken(env, token);
  await removePluginLink(env, token);
  if (link && env.PLUGIN_HUB) {
    try {
      const id = env.PLUGIN_HUB.idFromName(link.device);
      const hub = env.PLUGIN_HUB.get(id);
      const req = new Request("https://hub/close-all", { method: "POST" });
      if (env.DO_AUTH) req.headers.set("x-do-auth", env.DO_AUTH);
      await hub.fetch(req).catch(() => {});
    } catch { /* best-effort */ }
  }
  return jsonOk({ ok: true });
}

// Public: the extension trades its plugin token for a one-time WS ticket
// here (no admin session — the plugin token is the credential). The ticket
// keeps the long-lived token out of the /ws URL and is consumed once.
async function handleWsTicket(request: Request, env: any): Promise<Response> {
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
async function handleWs(request: Request, env: any, url: URL): Promise<Response> {
  const device = url.searchParams.get("device") || "";
  const ticket = url.searchParams.get("ticket") || "";
  // round-92: consumeWsTicket was check-then-delete on eventually-consistent
  // KV — two concurrent /ws handshakes with the SAME ticket both passed and
  // opened two sockets, one of which the hub then replaced (churn + a second
  // socket that was briefly live). Same single-flight claim lock the pair/
  // claim and reg-key routes already use.
  const claim = await env.KEYS.get(`plgclaim:${ticket}`);
  if (claim) return jsonError(403, "WS ticket already in use", "authorization_error");
  await env.KEYS.put(`plgclaim:${ticket}`, "1", { expirationTtl: 60 });
  const ok = await consumeWsTicket(env, ticket);
  if (!ok || ok !== device) {
    await env.KEYS.delete(`plgclaim:${ticket}`);
    return jsonError(403, "Invalid or expired WS ticket", "authorization_error");
  }
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
async function handleDeviceProxy(request: Request, env: any, url: URL): Promise<Response> {
  const path = url.pathname;
  // The `if (proxyMatch)` guard from index.js is the route's match fn below —
  // the handler is only reached when the regex matched.
  const proxyMatch = path.match(new RegExp(`^${DEVICE_BASE}/([^/]+)/proxy(.*)$`))!;
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

// ---- Device module (Vale Agent registry) ----
// (the reverse-proxy route lives in its own section above, before the
//  session gate — it also accepts the paired plugin token)
// GET    /api/devices                        → list (token masked)
// POST   /api/devices                        → add/update {name, hostname, token}
// DELETE /api/devices/<name>                 → remove
// GET    /api/devices/<name>/mcp             → MCP config for a device (with token)
// The session gate below is verbatim from handleConsole (requireSession 401
// check, then the admin 403 check) — the device module sat after both.
async function handleDevicesList(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin") return jsonError(403, "Admin permission required", "authorization_error");
  const devices = await listDevices(env);
  return jsonOk({
    devices: devices.map((d) => ({
      name: d.name, hostname: d.hostname,
      token: maskKey(d.token), mcp: mcpConfig(d),
    })),
  });
}

async function handleDevicesAdd(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin") return jsonError(403, "Admin permission required", "authorization_error");
  const body = await readJson(request);
  let device: Device;
  try { device = validateDevice(body); } catch (e) { return jsonError(400, (e as Error).message, "invalid_request"); }
  await upsertDevice(env, device);
  return jsonOk({ ok: true, device: { name: device.name, hostname: device.hostname, token: maskKey(device.token) } });
}

async function handleDeviceMcp(request: Request, env: any, url: URL): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin") return jsonError(403, "Admin permission required", "authorization_error");
  const path = url.pathname;
  const mcpMatch = path.match(new RegExp(`^${DEVICE_BASE}/([^/]+)/mcp$`))!;
  const d = await getDevice(env, decodeURIComponent(mcpMatch[1]));
  if (!d) return jsonError(404, "Device not found", "not_found_error");
  return jsonOk({ name: d.name, hostname: d.hostname, mcp: mcpConfig(d) });
}

async function handleDeviceDelete(request: Request, env: any, url: URL): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin") return jsonError(403, "Admin permission required", "authorization_error");
  const path = url.pathname;
  const delMatch = path.match(new RegExp(`^${DEVICE_BASE}/([^/]+)$`))!;
  await deleteDevice(env, decodeURIComponent(delMatch[1]));
  return jsonOk({ ok: true });
}

/* ---------------- Device module helpers (copied verbatim from index.js) ---------------- */

function validateDevice(body: any): Device {
  const name = String(body?.name || "").trim();
  const hostname = String(body?.hostname || "").trim();
  const token = String(body?.token || "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error("Device name must be 1-32 chars: letters/digits/_ -");
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(hostname)) throw new Error("hostname must be a domain like d1.agent.saisi.online");
  if (token.length < 8) throw new Error("Token must be at least 8 chars");
  return { name, hostname, token };
}

/** Claude Code MCP config snippet for a device (the only place the raw token is returned). */
function mcpConfig(d: Device): { url: string; json: string } {
  const url = `https://${d.hostname}/mcp`;
  const snippet = {
    mcpServers: {
      "vale-agent": { type: "http", url, headers: { Authorization: `Bearer ${d.token}` } },
    },
  };
  return { url, json: JSON.stringify(snippet, null, 2) };
}

/** Reverse-proxy to the device panel, injecting the Bearer token server-side. */
async function proxyDevice(request: Request, env: any, device: Device, restPath: string): Promise<Response> {
  const url = new URL(request.url);

  // The panel sits behind a tunnel that adds its own x-forwarded-*; don't pass
  // the console's through. deviceFetch injects the Bearer token and strips
  // host/cookie; restPath carries the request query string.
  const headers = new Headers(request.headers);
  headers.delete("x-forwarded-proto");
  headers.delete("x-forwarded-for");
  headers.delete("cf-connecting-ip");
  headers.set("x-forwarded-proto", "https");
  // round-102: mark this request as gateway-proxied. The device's /panel/
  // injects its Bearer token ONLY when this header is present — a direct
  // navigation to dN.agent.saisi.online/panel/ (no proxy) previously got
  // the token injected for any internet user (full device RCE through
  // /api/tools with the leaked token). The gateway proxy is the only
  // authenticated path (admin session or plugin link).
  headers.set("x-vale-proxy", "1");

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
const PANEL_ROOT_PATHS: string[] = [
  "/api/", "/mcp", "/app.js", "/styles.css", "/state.js", "/ipc.js",
  "/events.js", "/transport.js", "/view.js", "/tabs.js", "/browser.js",
  "/term.js", "/conn.js", "/icons.js", "/ui/", "/vendor/",
];

function rewriteDeviceBody(text: string, name: string): string {
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

/* ---------------- Plugin definition ---------------- */

export default {
  name: "devices",
  deps: [],
  setup(ctx: PluginContext) {
    // round-102: every public one-shot endpoint (register, tunnel-token,
    // pair/claim, ws-ticket, ws handshake) costs KV WRITES — an attacker
    // firing random codes can exhaust the Free-plan daily KV write quota
    // (the same reason login and probe are gated). Per-IP gate, in-memory
    // like probeRateLimited (no per-request KV writes).
    const PUBLIC_LIMIT = 30; // per minute, per IP
    const PUBLIC_WINDOW_MS = 60000;
    const __publicRate = new Map(); // `ip:${bucket}` → count
    const publicRateLimited = (request: Request) => {
      try {
        const ip = request?.headers?.get?.("cf-connecting-ip") || "unknown";
        const bucket = Math.floor(Date.now() / PUBLIC_WINDOW_MS);
        const key = `pub-rate:${ip}:${bucket}`;
        const hit = __publicRate.get(key) || 0;
        if (hit >= PUBLIC_LIMIT) return true;
        __publicRate.set(key, hit + 1);
        if (__publicRate.size > 4096) __publicRate.delete(__publicRate.keys().next().value);
        return false;
      } catch { return false; }
    };
    const gate = (fn: (request: Request, env: any, ...rest: any[]) => Promise<Response>) =>
      async (request: Request, env: any, ...rest: any[]) => {
        if (publicRateLimited(request)) {
          return jsonError(429, "rate limit exceeded", "rate_limit_error");
        }
        return fn(request, env, ...rest);
      };

    // Public registration flow (index.js order preserved).
    route(ctx, "POST", "/api/register", gate(handleRegister));
    route(ctx, "POST", "/api/install/tunnel-token", gate(handleTunnelToken));
    route(ctx, "POST", `${PLUGIN_BASE}/pair/claim`, gate(handlePairClaim));
    route(ctx, "POST", `${PLUGIN_BASE}/revoke`, handleRevoke);
    route(ctx, "POST", `${PLUGIN_BASE}/ws-ticket`, gate(handleWsTicket));
    // index.js compared the ws path with === — register an exact match
    // (a prefix match would also swallow GET /api/plugins/ws-ticket).
    ctx.routes.push({
      match: (m, p) => m === "GET" && p === `${PLUGIN_BASE}/ws`,
      handler: gate(handleWs),
    });

    // Device reverse-proxy — checked BEFORE the admin-gated device routes,
    // exactly like index.js (it also authenticates with the paired plugin
    // token, so it lives above the session gate).
    ctx.routes.push({
      match: (m, p) => /^\/api\/devices\/[^/]+\/proxy/.test(p),
      handler: handleDeviceProxy,
    });

    // Admin-gated device module. Exact matches: index.js compared these
    // paths with === and regexes, so prefix matching would capture subpaths
    // that index.js let fall through to 404.
    ctx.routes.push({ match: (m, p) => m === "GET" && p === DEVICE_BASE, handler: handleDevicesList });
    ctx.routes.push({ match: (m, p) => m === "POST" && p === DEVICE_BASE, handler: handleDevicesAdd });
    ctx.routes.push({
      match: (m, p) => m === "GET" && /^\/api\/devices\/[^/]+\/mcp$/.test(p),
      handler: handleDeviceMcp,
    });
    ctx.routes.push({
      match: (m, p) => m === "DELETE" && /^\/api\/devices\/[^/]+$/.test(p),
      handler: handleDeviceDelete,
    });
  },
} satisfies Plugin;
