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
 * round-159 additions (device management UX):
 *   POST   /api/devices/<name>/rename       (admin — rename WITHOUT rotating the token)
 *   GET    /api/devices/register-keys       (admin — list unused one-time keys)
 *   DELETE /api/devices/register-keys/<code> (admin — revoke an unused key)
 *   GET    /api/devices/install-cmd         (admin — current npm install version/download)
 *
 * Handler convention: dispatch(ctx, method, path, request, env, url) →
 * handler(request, env, url).
 */
import {
  hasRegKey,
  hasRegGrant,
  getDevice,
  upsertDevice,
  insertDevice,
  deleteDevice,
  renameDevice,
  deleteRegKey,
  deleteRegGrant,
  consumeRegKey,
  createRegKey,
  listRegKeys,
  createPairCode,
  getCfToken,
  maskKey,
  listDevices,
  addPluginLink,
  getPluginByToken,
  removePluginLink,
  listPluginLinks,
  savePluginLinks,
  consumePairCode,
  createWsTicket,
  consumeWsTicket,
  type Device,
} from "../store.ts";
import { parseCookie, randomHex } from "../auth.ts";
import { build101Response, deviceFetch } from "../device-fetch.ts";
import { fetchWithTimeout } from "../reliability.ts";
import { jsonOk, jsonError, readJson } from "../http.ts";
import { requireSession } from "../session.ts";
import { route, type Plugin, type PluginContext } from "./registry.ts";

const DEVICE_BASE = "/api/devices";
const PLUGIN_BASE = "/api/plugins";

/* ---------------- Route handlers (bodies copied verbatim from index.js) ---------------- */

// Public device registration (the Windows install calls this with a one-time
// registration key + the device's {name, hostname, token}). Not session-based:
// the install runs headless on the device machine.
async function handleRegister(request: Request, env: any): Promise<Response> {
  const body = await readJson(request);
  const k = String(body.key || "").toLowerCase();
  // round-115: reject garbage keys BEFORE the claim lock — an attacker
  // firing random keys otherwise burned 2 KV writes per attempt (claim put
  // + finally delete) through a per-IP gate that parallel requests across
  // isolates bypass, exhausting the daily KV write quota (round-102's
  // original concern). Invalid keys are now zero-write.
  if (!k || (!(await hasRegKey(env, k)) && !(await hasRegGrant(env, k)))) {
    return jsonError(403, "Invalid or used registration key", "authorization_error");
  }
  // round-103: single-flight claim (the siblings all have one) — a bare
  // check-then-act on eventually-consistent KV let one reg key register
  // TWO devices under concurrent POSTs.
  const claim = await env.KEYS.get(`regclaim2:${k}`);
  if (claim) return jsonError(403, "Registration key already in use", "authorization_error");
  await env.KEYS.put(`regclaim2:${k}`, "1", { expirationTtl: 60 });
  try {
    // Accept either a live key or the short-lived grant issued when the key
    // was spent at /api/install/tunnel-token (same install, both calls).
    const keyOk = (await hasRegKey(env, k)) || (await hasRegGrant(env, k));
    if (!keyOk) {
      return jsonError(403, "Invalid or used registration key", "authorization_error");
    }
    let device: Device;
    try {
      device = validateDevice(body);
    } catch (e) {
      return jsonError(400, (e as Error).message, "invalid_request");
    }
    // round-68: a one-time-key holder could upsert an EXISTING device name —
    // the register endpoint silently replaced a production device's
    // hostname/token, redirecting console terminal tools + the proxy to the
    // attacker. Refuse when the name is already registered; re-registering
    // an existing device is an admin action.
    if (await getDevice(env, device.name)) {
      return jsonError(
        409,
        `Device '${device.name}' already registered — use the console (admin) to update it`,
        "conflict",
      );
    }
    // round-103: read the device's proxy secret so the gateway proxy can
    // present X-Vale-Auth for /panel/ (token-injection gate).
    try {
      const status = await deviceFetch(env, device, "/api/status");
      if (status && status.resp) {
        const j: any = await status.resp.json().catch(() => null);
        if (j && typeof j.proxy_secret === "string" && j.proxy_secret.length >= 32) {
          device.proxySecret = j.proxy_secret;
        }
      }
    } catch {
      /* best-effort — panel injection just won't work until admin updates */
    }
    // round-122: insertDevice does the existence check INSIDE the lock —
    // the old getDevice→409 check-then-act let two concurrent same-name
    // registrations both pass and the second upsert took over the name.
    device.registeredAt = Date.now();
    const inserted = await insertDevice(env, device);
    if (!inserted) {
      return jsonError(
        409,
        `Device '${device.name}' already registered — use the console (admin) to update it`,
        "conflict",
      );
    }
    await deleteRegKey(env, k); // one-time — consumed only after success
    await deleteRegGrant(env, k);
    return jsonOk({ ok: true, device: { name: device.name, hostname: device.hostname } });
  } finally {
    await env.KEYS.delete(`regclaim2:${k}`).catch(() => {});
  }
}

// round-158: device self-register — the npm-installed agent registers itself
// with its OWN device token (the 64-hex credential from config.yaml). No reg
// key, no admin session: possession of the token IS the device identity.
// Token matches an existing device → idempotent refresh (hostname/name);
// same name + different token → refuse (anti-hijack, mirror round-68).
async function handleSelfRegister(request: Request, env: any): Promise<Response> {
  const body = await readJson(request);
  let device: Device;
  try {
    device = validateDevice(body);
  } catch (e) {
    return jsonError(400, (e as Error).message, "invalid_request");
  }
  if (!/^[0-9a-f]{64}$/i.test(device.token)) {
    return jsonError(403, "Invalid device token", "authorization_error");
  }
  const existing = await getDevice(env, device.name);
  // Anti-hijack: a DIFFERENT token for the same name is normally refused.
  // BUT the device itself can prove identity by reaching its own /api/status
  // through the tunnel (returns proxy_secret) — a reinstall/new config that
  // rotated the token must be allowed to update its record, otherwise the
  // device stays "offline" forever after a reinstall (round-2026-08-29).
  let tokenChanged = existing && existing.token !== device.token;
  try {
    const status = await deviceFetch(env, device, "/api/status");
    if (status && status.resp) {
      const j: any = await status.resp.json().catch(() => null);
      if (j && typeof j.proxy_secret === "string" && j.proxy_secret.length >= 32) {
        device.proxySecret = j.proxy_secret;
        // Device proved it owns the hostname (its own /api/status answered
        // with a fresh proxy_secret through the tunnel) — token update OK.
        tokenChanged = false;
      }
    }
  } catch {
    /* best-effort */
  }
  if (tokenChanged) {
    return jsonError(
      409,
      `Device '${device.name}' already registered with a different token — use the console (admin)`,
      "conflict",
    );
  }
  if (existing && !device.proxySecret && existing.proxySecret) {
    device.proxySecret = existing.proxySecret;
  }
  if (existing) {
    // Idempotent refresh: keep the original registration date.
    await upsertDevice(env, { ...device, registeredAt: existing.registeredAt ?? Date.now() });
  } else {
    const inserted = await insertDevice(env, { ...device, registeredAt: Date.now() });
    if (!inserted) {
      return jsonError(409, `Device '${device.name}' already registered`, "conflict");
    }
  }
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
  // round-115: reject garbage codes BEFORE the claim lock — same KV
  // write-quota exhaustion path as /api/register (claim put + finally
  // delete on every attempt). Invalid codes are now zero-write.
  if (!c || !(await env.KEYS.get(`pair:${c}`))) {
    return jsonError(403, "Invalid or used pairing code", "authorization_error");
  }
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
    } catch {
      /* best-effort */
    }
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
  // round-115: reject garbage tickets BEFORE the claim lock — same KV
  // write-quota exhaustion path as /api/register. Invalid tickets are
  // now zero-write.
  if (!ticket || !(await env.KEYS.get(`plg-ticket:${ticket}`))) {
    return jsonError(403, "Invalid or expired WS ticket", "authorization_error");
  }
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
  // round-106/107: a malformed percent-escape in the device name (e.g. %zz)
  // made decodeURIComponent throw URIError — an unhandled 500. 400 instead.
  const deviceName = decodeDeviceName(proxyMatch[1]!);
  if (deviceName === null) return jsonError(400, "Invalid device name", "invalid_request");
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
    cookieToken = decodeURIComponent(
      parseCookie(request.headers.get("cookie") || "")[`vale_pt_${deviceName}`] || "",
    );
  } catch {
    /* malformed — treat as absent */
  }
  const token = (auth.startsWith("Bearer ") ? auth.slice(7).trim() : "") || qToken || cookieToken;
  const link = token ? await getPluginByToken(env, token) : null;
  if (link && link.device === deviceName) {
    // round-124: a top-level navigation carrying ?token= is the ONLY way
    // the per-device cookie gets minted (the extension Terminal button). The
    // old code proxied the panel and appended Set-Cookie — the token stayed
    // in the omnibox/history until the panel JS scrubbed it, and if the
    // panel failed to boot (device offline → 502 body) it stayed forever.
    // 302 to the SAME url with ?token= stripped + Set-Cookie: the token
    // never reaches the omnibox, the cookie is minted regardless of whether
    // the panel boots, and a refresh/reload re-authenticates via cookie.
    if (qToken && isNav) {
      const clean = new URL(request.url);
      clean.searchParams.delete("token");
      return new Response(null, {
        status: 302,
        headers: {
          Location: clean.pathname + clean.search,
          "Set-Cookie": `vale_pt_${deviceName}=${encodeURIComponent(qToken)}; Path=${DEVICE_BASE}/${deviceName}/proxy; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
          // round-126: a cached 302 would drop the Set-Cookie on a re-pair
          // (stale cookie → panel 401s forever).
          "Cache-Control": "no-store",
        },
      });
    }
    // Never cache a response that carried a token in the URL.
    const resp = await proxyDevice(request, env, d, proxyMatch[2] || "/");
    resp.headers.set("Cache-Control", "no-store");
    return resp;
  }
  // A top-level navigation with a bad/expired token gets a readable page
  // (with a re-pair hint) instead of a raw JSON 401 — the panel's own
  // recovery UI can never load if the bootstrap navigation itself 401s.
  if (!auth && isNav) {
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vale — session expired</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;color:#1d1d1f;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:14px;padding:32px 40px;max-width:400px;text-align:center;box-shadow:0 12px 32px rgba(0,0,0,.12)}h1{font-size:18px;margin:0 0 8px}p{color:#6e6e73;font-size:14px;margin:0 0 4px}.mark{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:10px;background:#1d1d1f;color:#fff;font-weight:700;font-size:24px;margin-bottom:14px}</style></head><body><div class="card"><span class="mark">V</span><h1>Device session expired</h1><p>This device pairing has expired or the browser was restarted.</p><p>Open the Vale extension and re-pair to access the terminal.</p></div></body></html>`,
      { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
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
  if (user.role !== "admin")
    return jsonError(403, "Admin permission required", "authorization_error");
  const devices = await listDevices(env);
  return jsonOk({
    devices: devices.map((d) => ({
      name: d.name,
      hostname: d.hostname,
      token: maskKey(d.token),
      mcp: mcpConfig(d),
      registeredAt: d.registeredAt,
      lastSeenAt: d.lastSeenAt,
      lastVersion: d.lastVersion,
    })),
  });
}

async function handleDevicesAdd(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin")
    return jsonError(403, "Admin permission required", "authorization_error");
  const body = await readJson(request);
  let device: Device;
  try {
    device = validateDevice(body);
  } catch (e) {
    return jsonError(400, (e as Error).message, "invalid_request");
  }
  // New record gets a registration date; an admin update of an existing
  // device keeps the original one (same contract as self-register).
  const existing = await getDevice(env, device.name);
  device = { ...device, registeredAt: existing?.registeredAt ?? Date.now() };
  await upsertDevice(env, device);
  return jsonOk({
    ok: true,
    device: { name: device.name, hostname: device.hostname, token: maskKey(device.token) },
  });
}

async function handleDeviceMcp(request: Request, env: any, url: URL): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin")
    return jsonError(403, "Admin permission required", "authorization_error");
  const path = url.pathname;
  const mcpMatch = path.match(new RegExp(`^${DEVICE_BASE}/([^/]+)/mcp$`))!;
  const devName = decodeDeviceName(mcpMatch[1]!);
  if (devName === null) return jsonError(400, "Invalid device name", "invalid_request");
  const d = await getDevice(env, devName);
  if (!d) return jsonError(404, "Device not found", "not_found_error");
  return jsonOk({ name: d.name, hostname: d.hostname, mcp: mcpConfig(d) });
}

async function handleDeviceDelete(request: Request, env: any, url: URL): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin")
    return jsonError(403, "Admin permission required", "authorization_error");
  const path = url.pathname;
  const delMatch = path.match(new RegExp(`^${DEVICE_BASE}/([^/]+)$`))!;
  const delName = decodeDeviceName(delMatch[1]!);
  if (delName === null) return jsonError(400, "Invalid device name", "invalid_request");
  // round-115: deleteDevice alone left the device's plugin links (30-day TTL)
  // and its live hub socket alive — a same-name re-registration resurrected
  // the old pairing's browser_* control (round-84's revocation hole). Revoke
  // every link for this device and close the hub socket, like handleRevoke.
  const links = await listPluginLinks(env);
  const stale = Object.entries(links).filter(([, l]) => l.device === delName);
  for (const [token] of stale) await removePluginLink(env, token);
  if (stale.length > 0 && env.PLUGIN_HUB) {
    try {
      const id = env.PLUGIN_HUB.idFromName(delName);
      const hub = env.PLUGIN_HUB.get(id);
      const req = new Request("https://hub/close-all", { method: "POST" });
      if (env.DO_AUTH) req.headers.set("x-do-auth", env.DO_AUTH);
      await hub.fetch(req).catch(() => {});
    } catch {
      /* best-effort */
    }
  }
  await deleteDevice(env, delName);
  return jsonOk({ ok: true });
}

// POST /api/devices/<name>/rename — rename (and optionally re-hostname) a
// device WITHOUT rotating the token. The old flow forced delete + re-add,
// which invalidated the device's own config.yaml and every stored MCP
// snippet. Preserves token/proxySecret/metadata; migrates the device's
// plugin links to the new name and closes the OLD name's hub socket (the
// DO is keyed by device name — round-84/92 revocation contract).
async function handleDeviceRename(request: Request, env: any, url: URL): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin")
    return jsonError(403, "Admin permission required", "authorization_error");
  const renMatch = url.pathname.match(new RegExp(`^${DEVICE_BASE}/([^/]+)/rename$`))!;
  const oldName = decodeDeviceName(renMatch[1]!);
  if (oldName === null) return jsonError(400, "Invalid device name", "invalid_request");
  const body = await readJson(request);
  const newName = String(body?.name || "").trim();
  const hostname = String(body?.hostname || "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(newName))
    return jsonError(400, "Device name must be 1-32 chars: letters/digits/_ -", "invalid_request");
  if (hostname && !/^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(hostname))
    return jsonError(400, "hostname must be a domain like d1.agent.saisi.online", "invalid_request");
  const updated = await renameDevice(env, oldName, newName, hostname || undefined);
  if (updated === "not_found") return jsonError(404, "Device not found", "not_found_error");
  if (updated === "name_taken")
    return jsonError(409, `Device '${newName}' already registered`, "conflict");
  const links = await listPluginLinks(env);
  let migrated = false;
  for (const l of Object.values(links)) {
    if (l.device === oldName) {
      l.device = newName;
      migrated = true;
    }
  }
  if (migrated) await savePluginLinks(env, links);
  if (env.PLUGIN_HUB) {
    try {
      const id = env.PLUGIN_HUB.idFromName(oldName);
      const hub = env.PLUGIN_HUB.get(id);
      const req = new Request("https://hub/close-all", { method: "POST" });
      if (env.DO_AUTH) req.headers.set("x-do-auth", env.DO_AUTH);
      await hub.fetch(req).catch(() => {});
    } catch {
      /* best-effort */
    }
  }
  return jsonOk({
    ok: true,
    device: { name: updated.name, hostname: updated.hostname, token: maskKey(updated.token) },
  });
}

// GET /api/devices/register-keys — list outstanding (unused) one-time
// install keys with their KV expiry. They used to be invisible: generate,
// close the tab, and the key lingered until TTL with no way to see or kill it.
async function handleRegKeysList(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin")
    return jsonError(403, "Admin permission required", "authorization_error");
  return jsonOk({ keys: await listRegKeys(env) });
}

// DELETE /api/devices/register-keys/<code> — revoke an unused key before
// its 1h TTL (a key pasted into the wrong chat can be killed immediately).
async function handleRegKeyRevoke(request: Request, env: any, url: URL): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin")
    return jsonError(403, "Admin permission required", "authorization_error");
  const m = url.pathname.match(new RegExp(`^${DEVICE_BASE}/register-keys/([^/]+)$`))!;
  const code = decodeDeviceName(m[1]!);
  if (!code) return jsonError(400, "Invalid key", "invalid_request");
  await deleteRegKey(env, code);
  return jsonOk({ ok: true });
}

// GET /api/devices/install-cmd — the CURRENT npm install version for the
// devices page. The page hardcoded the tgz URL and drifted (it showed
// 1.2.91 while 1.2.101 was live); the version source of truth is the index
// worker's /api/version on agent.saisi.online. Fetched server-side (no CORS
// concerns), cached 5 min in-isolate; a null version tells the UI to fall
// back to its built-in constant.
const INSTALL_SOURCE = "https://agent.saisi.online/api/version";
const INSTALL_CMD_TTL_MS = 5 * 60 * 1000;
let installCmdCache: { at: number; version: string | null; download: string | null } | null = null;

async function handleInstallCmd(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin")
    return jsonError(403, "Admin permission required", "authorization_error");
  if (!installCmdCache || Date.now() - installCmdCache.at > INSTALL_CMD_TTL_MS) {
    let version: string | null = null;
    let download: string | null = null;
    try {
      const res = await fetchWithTimeout(INSTALL_SOURCE, {}, 8000);
      if (res && res.ok) {
        const j: any = await res.json().catch(() => null);
        if (j && typeof j.version === "string") {
          version = j.version;
          download = typeof j.download === "string" ? j.download : null;
        }
      }
    } catch {
      /* upstream unreachable — UI falls back to its built-in version */
    }
    installCmdCache = { at: Date.now(), version, download };
  }
  return jsonOk({
    ok: true,
    version: installCmdCache.version,
    download: installCmdCache.download,
  });
}

// POST /api/devices/register-key — generate a one-time install key.
// (the last admin-gated route still served by index.ts's inline chain)
async function handleRegisterKey(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin")
    return jsonError(403, "Admin permission required", "authorization_error");
  const key = await createRegKey(env);
  return jsonOk({ ok: true, key });
}

// POST /api/plugins/pair — mint a one-time pairing code for a device (admin).
async function handlePair(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin")
    return jsonError(403, "Admin permission required", "authorization_error");
  const { device }: any = (await request.json().catch(() => ({}))) || {};
  const d = device ? await getDevice(env, String(device)) : null;
  if (!d) return jsonError(404, "Device not found", "not_found_error");
  const code = await createPairCode(env, d.name);
  return jsonOk({ code });
}

// POST /api/plugins/unpair — drop all plugin links for a device (admin).
async function handleUnpair(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin")
    return jsonError(403, "Admin permission required", "authorization_error");
  const { device }: any = (await request.json().catch(() => ({}))) || {};
  const links = await listPluginLinks(env);
  for (const [t, l] of Object.entries(links))
    if (l.device === device) await removePluginLink(env, t);
  // round-92: removing the KV links was not enough — the extension's LIVE
  // hub socket kept relaying browser_* commands past the unpair (the socket
  // stays in the DO and its 20s pings keep the idle alarm from ever firing,
  // so alarm()'s token re-validation never runs either). revoke() (round-84)
  // already knew this and calls /close-all; unpair is the same revocation
  // contract and must do the same.
  if (env.PLUGIN_HUB) {
    try {
      const id = env.PLUGIN_HUB.idFromName(device);
      const hub = env.PLUGIN_HUB.get(id);
      const req = new Request("https://hub/close-all", { method: "POST" });
      if (env.DO_AUTH) req.headers.set("x-do-auth", env.DO_AUTH);
      await hub.fetch(req).catch(() => {});
    } catch {
      /* best-effort */
    }
  }
  return jsonOk({ ok: true });
}

/* ---------------- Device module helpers (copied verbatim from index.js) ---------------- */

// round-107: decode a URL-encoded device name, null on malformed escapes
// (a raw decodeURIComponent threw URIError → unhandled 500).
function decodeDeviceName(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

function validateDevice(body: any): Device {
  const name = String(body?.name || "").trim();
  const hostname = String(body?.hostname || "").trim();
  const token = String(body?.token || "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name))
    throw new Error("Device name must be 1-32 chars: letters/digits/_ -");
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(hostname))
    throw new Error("hostname must be a domain like d1.agent.saisi.online");
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
async function proxyDevice(
  request: Request,
  env: any,
  device: Device,
  restPath: string,
): Promise<Response> {
  const url = new URL(request.url);

  // The panel sits behind a tunnel that adds its own x-forwarded-*; don't pass
  // the console's through. deviceFetch injects the Bearer token and strips
  // host/cookie; restPath carries the request query string.
  const headers = new Headers(request.headers);
  headers.delete("x-forwarded-proto");
  headers.delete("x-forwarded-for");
  headers.delete("cf-connecting-ip");
  headers.set("x-forwarded-proto", "https");
  // round-103: the device's /panel/ injects its Bearer token ONLY when the
  // request carries the shared proxy secret (X-Vale-Auth) — the R102 marker
  // header was client-spoofable end-to-end (a direct curl could set it and
  // read the token → /api/tools RCE). The secret is read from the device at
  // registration; only this authenticated proxy path presents it.
  if (device.proxySecret) headers.set("x-vale-auth", device.proxySecret);

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
    // round-132/133: REVERTED the round-131 CSP sandbox — sandbox without
    // allow-same-origin makes the panel origin opaque: localStorage throws
    // SecurityError at mount (white screen) and cookies are never sent (all
    // /proxy/* API calls 401). The sandbox is fundamentally incompatible
    // with the panel's same-origin architecture.
    // ACTUAL INVARIANT (round-133/134): the ADMIN opens-panel flow opens the
    // panel at the DEVICE origin (https://<hostname>/panel/) where no console
    // cookie is reachable — that surface is closed. The console-origin proxy
    // path (/api/devices/<n>/proxy/panel/) remains reachable by BOTH the
    // extension flow AND an admin visiting it directly; device HTML runs at
    // a CONSOLE_HOST origin there and could read console APIs. This is an
    // ACCEPTED trust limitation (opening a device's panel is an explicit
    // trust action; the sandbox alternative breaks the panel entirely), and
    // it applies to every entry point of the proxy path.
    return new Response(rewritten, { status: resp.status, headers: outHeaders });
  }

  // JSON / binary: pass through — EXCEPT strip the proxy_secret (round-104:
  // a plugin-token holder proxying /api/status could read the secret and
  // escalate to the permanent device token, defeating unpair/revoke scope).
  if (resp.body && ct.includes("application/json")) {
    const text = await resp.text();
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object" && "proxy_secret" in j) {
        delete j.proxy_secret;
        const out = JSON.stringify(j);
        if (outHeaders.has("content-length")) {
          outHeaders.set("content-length", String(new TextEncoder().encode(out).length));
        }
        return new Response(out, { status: resp.status, headers: outHeaders });
      }
    } catch {
      /* non-JSON — fall through */
    }
    return new Response(text, { status: resp.status, headers: outHeaders });
  }
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

// Absolute paths a vale-agent panel serves from its own root. When proxied
// through the console they must carry the proxy mount so the SPA's absolute
// paths (/api/*, /app.js, /ui/*, ...) keep resolving through the proxy.
const PANEL_ROOT_PATHS: string[] = [
  "/api/",
  "/mcp",
  "/app.js",
  "/styles.css",
  "/state.js",
  "/ipc.js",
  "/events.js",
  "/transport.js",
  "/view.js",
  "/tabs.js",
  "/browser.js",
  "/term.js",
  "/conn.js",
  "/icons.js",
  "/ui/",
  "/vendor/",
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
  out = out.replace(/window\.__PANEL_TOKEN__\s*=\s*"[^"]*"/g, 'window.__PANEL_TOKEN__=""');
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
    const PUBLIC_LIMIT = 10; // per minute, per IP (round-115: 30 let a single IP burn 60 writes/min through the claim+delete pair)
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
      } catch {
        return false;
      }
    };
    const gate =
      (fn: (request: Request, env: any, ...rest: any[]) => Promise<Response>) =>
      async (request: Request, env: any, ...rest: any[]) => {
        if (publicRateLimited(request)) {
          return jsonError(429, "rate limit exceeded", "rate_limit_error");
        }
        return fn(request, env, ...rest);
      };

    // Public registration flow (index.js order preserved).
    route(ctx, "POST", "/api/register", gate(handleRegister));
    route(ctx, "POST", "/api/devices/self-register", gate(handleSelfRegister));
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
      match: (_m, p) => /^\/api\/devices\/[^/]+\/proxy/.test(p),
      handler: handleDeviceProxy,
    });

    // Admin-gated device module. Exact matches: index.js compared these
    // paths with === and regexes, so prefix matching would capture subpaths
    // that index.js let fall through to 404.
    // round-159: the specific two-segment routes register BEFORE the generic
    // single-segment delete (ordering is not load-bearing today — the regexes
    // do not overlap — but explicit-first keeps it that way).
    ctx.routes.push({
      match: (m, p) => m === "GET" && p === `${DEVICE_BASE}/register-keys`,
      handler: handleRegKeysList,
    });
    ctx.routes.push({
      match: (m, p) => m === "DELETE" && new RegExp(`^${DEVICE_BASE}/register-keys/[^/]+$`).test(p),
      handler: handleRegKeyRevoke,
    });
    ctx.routes.push({
      match: (m, p) => m === "GET" && p === `${DEVICE_BASE}/install-cmd`,
      handler: handleInstallCmd,
    });
    ctx.routes.push({
      match: (m, p) => m === "POST" && new RegExp(`^${DEVICE_BASE}/[^/]+/rename$`).test(p),
      handler: handleDeviceRename,
    });
    ctx.routes.push({
      match: (m, p) => m === "GET" && p === DEVICE_BASE,
      handler: handleDevicesList,
    });
    ctx.routes.push({
      match: (m, p) => m === "POST" && p === DEVICE_BASE,
      handler: handleDevicesAdd,
    });
    ctx.routes.push({
      match: (m, p) => m === "GET" && /^\/api\/devices\/[^/]+\/mcp$/.test(p),
      handler: handleDeviceMcp,
    });
    ctx.routes.push({
      match: (m, p) => m === "DELETE" && /^\/api\/devices\/[^/]+$/.test(p),
      handler: handleDeviceDelete,
    });
    // Admin-gated pairing/install flows (the last routes index.ts still
    // served inline — moved here to complete the plugin migration). Exact
    // matches: a prefix match on /api/plugins/pair would swallow the public
    // /api/plugins/pair/claim registered above.
    ctx.routes.push({
      match: (m, p) => m === "POST" && p === `${DEVICE_BASE}/register-key`,
      handler: handleRegisterKey,
    });
    ctx.routes.push({
      match: (m, p) => m === "POST" && p === `${PLUGIN_BASE}/pair`,
      handler: handlePair,
    });
    ctx.routes.push({
      match: (m, p) => m === "POST" && p === `${PLUGIN_BASE}/unpair`,
      handler: handleUnpair,
    });
  },
} satisfies Plugin;
