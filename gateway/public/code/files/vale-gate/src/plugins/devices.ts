/**
 * devices plugin (round-73 migration) — Vale Agent device registry, reverse
 * proxy, registration keys flow. (Extension pairing endpoints removed
 * round-340 — the browser extension was deleted round-262.)
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
 *   <any> /api/devices/<name>/proxy/<rest>  (admin session OR device token)
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
  getCfToken,
  maskKey,
  listDevices,
  getPluginByToken,
  migratePluginLinks,
  removePluginLinksForDevice,
  type Device,
} from "../store.ts";
import { parseCookie, safeEq } from "../auth.ts";
import { build101Response, deviceFetch } from "../device-fetch.ts";
import { fetchWithTimeout } from "../reliability.ts";
import { jsonOk, jsonError, readJson, stampCors } from "../http.ts";
import { requireSession } from "../session.ts";
import { route, type Plugin, type PluginContext } from "./registry.ts";

const DEVICE_BASE = "/api/devices";

// Upload hardening (see proxyUploadToWorker): max accepted upload size and
// the upstream response headers that must never be re-served at the
// console origin.
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const UPLOAD_STRIP_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "set-cookie2",
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
]);

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
    // A one-time-key holder is untrusted: constrain the claimed hostname to
    // the agent-host suffix (same gate as handleSelfRegister) — validateDevice
    // alone accepts any RFC domain, so hostname=evil.com would register and
    // the proxy/deviceFetch path would then dial it with the device token.
    {
      const hostErr = hostAllowError(device.hostname, env);
      if (hostErr) return jsonError(400, hostErr, "invalid_request");
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
  {
    const hostErr = hostAllowError(device.hostname, env);
    if (hostErr) return jsonError(400, hostErr, "invalid_request");
  }
  // SECURITY (round: gateway CRITICAL): the old proof fetched
  // deviceFetch(env, device, "/api/status") using the CALLER-SUPPLIED
  // hostname, so an attacker POSTing {name:"d1", hostname:"evil.com",
  // token:<random>} had THEIR server answer with any 32-char proxy_secret,
  // "proving" ownership and overwriting the real d1's record (hostname +
  // token). Every console/proxy/MCP call then redirected to the attacker,
  // whose responses the worker re-served AT THE CONSOLE ORIGIN. For an
  // existing record, identity can only be proven against the STORED
  // hostname, and only by returning the STORED proxy_secret.
  const existing = await getDevice(env, device.name);
  if (existing) {
    // Refresh-only on the public endpoint: hostname is immutable here
    // (moving a device's tunnel is an admin/console operation).
    if (device.hostname.toLowerCase() !== existing.hostname.toLowerCase()) {
      return jsonError(
        409,
        `Device '${device.name}' hostname is fixed — change it from the console (admin)`,
        "conflict",
      );
    }
    const sameToken = safeEq(existing.token, device.token);
    if (!sameToken) {
      // Token rotation needs proof from the STORED tunnel that the caller
      // is the same physical device: its /api/status must answer with the
      // proxy_secret already on record.
      let proved = false;
      if (existing.proxySecret) {
        try {
          const status = await deviceFetch(env, existing, "/api/status");
          const j: any = status?.resp ? await status.resp.json().catch(() => null) : null;
          if (j && typeof j.proxy_secret === "string" && j.proxy_secret === existing.proxySecret) {
            proved = true;
          }
        } catch {
          /* best-effort — a dead/changed tunnel simply cannot rotate here */
        }
      }
      if (!proved) {
        return jsonError(
          409,
          `Device '${device.name}' already registered with a different token — use the console (admin)`,
          "conflict",
        );
      }
      device.proxySecret = existing.proxySecret;
    } else {
      if (!device.proxySecret && existing.proxySecret) device.proxySecret = existing.proxySecret;
    }
    // Idempotent refresh: keep the original registration date + hostname.
    await upsertDevice(env, {
      ...device,
      hostname: existing.hostname,
      registeredAt: existing.registeredAt ?? Date.now(),
    });
    return jsonOk({ ok: true, device: { name: device.name, hostname: existing.hostname } });
  }
  // New device: still constrained to the agent-host suffix (SSRF) and to
  // proving it serves its claimed hostname before it can be proxied.
  const hostErr = hostAllowError(device.hostname, env);
  if (hostErr) return jsonError(400, hostErr, "invalid_request");
  if (!device.proxySecret) {
    try {
      const status = await deviceFetch(env, device, "/api/status");
      const j: any = status?.resp ? await status.resp.json().catch(() => null) : null;
      if (j && typeof j.proxy_secret === "string" && j.proxy_secret.length >= 32) {
        device.proxySecret = j.proxy_secret;
      }
    } catch {
      /* best-effort */
    }
  }
  const inserted = await insertDevice(env, { ...device, registeredAt: Date.now() });
  if (!inserted) {
    return jsonError(409, `Device '${device.name}' already registered`, "conflict");
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

// ---- File upload proxy ----
// POST /api/upload — device token or admin session → proxy to index worker
// (which holds the R2 UPLOAD_KEY). Device uses its existing Bearer token —
// no new credential to deploy. This enables the device → AI file transfer
// path: device uploads to R2 → returns URL → AI reads URL directly.
async function handleFileUpload(request: Request, env: any, _url: URL): Promise<Response> {
  const user = await requireSession(request, env);
  const auth = String(request.headers.get("authorization") || "");

  // Admin session: allow
  if (user && user.role === "admin") {
    return await proxyUploadToWorker(request, env);
  }

  // Device token: accept a paired plugin-link token OR the device's own
  // config token (possession of the token IS the device identity —
  // same rule as self-register). Scan the small device registry.
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return jsonError(401, "Not logged in or missing device token", "authentication_error");
  }
  const link = await getPluginByToken(env, token);
  let ok = !!link;
  if (!ok) {
    try {
      const devices = await listDevices(env);
      ok = devices.some(
        (d: any) => typeof d.token === "string" && d.token.length >= 32 && safeEq(d.token, token),
      );
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    return jsonError(401, "Invalid device token", "authentication_error");
  }
  return await proxyUploadToWorker(request, env);
}

// Proxy the multipart upload to the index worker, injecting the UPLOAD_KEY.
async function proxyUploadToWorker(request: Request, env: any): Promise<Response> {
  const indexWorkerUrl = env.INDEX_WORKER_URL || "https://agent.saisi.online";
  const uploadUrl = `${indexWorkerUrl}/api/upload`;

  // Size bound: an unbounded passthrough turns the gateway into a free
  // large-file relay (subrequest memory + egress). 25MB is far above any
  // legitimate update payload. Bodies without a declared length (chunked)
  // are still bounded by the platform's own request-body ceiling.
  const declared = Number(request.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) {
    return jsonError(413, "Upload too large (max 25MB)", "invalid_request");
  }

  // Rebuild the request with the UPLOAD_KEY header for the index worker.
  // Forward a MINIMAL header set: Authorization is the only credential the
  // index worker needs, and Content-Type must survive verbatim (the multipart
  // boundary in it is how the worker's formData() splits parts). Everything
  // else — notably the client's Cookie header and the inbound Content-Length
  // (the runtime reframes the forwarded stream itself; a stale manual value
  // corrupts the upstream framing) — stays on this side: the index
  // worker is a separate origin and must never see console cookies.
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${env.UPLOAD_KEY || ""}`);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

  const resp = await fetchWithTimeout(
    uploadUrl,
    {
      method: "POST",
      headers,
      body: request.body,
    },
    60000,
  );

  // Never re-serve the upstream's response headers verbatim: a Set-Cookie
  // from the index worker would plant a foreign cookie on the console
  // origin, and hop-by-hop framing headers are the runtime's job.
  const outHeaders = new Headers();
  resp.headers.forEach((value, key) => {
    if (!UPLOAD_STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) outHeaders.append(key, value);
  });
  return new Response(resp.body, {
    status: resp.status,
    headers: outHeaders,
  });
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
  const user = await requireSession(request, env);
  if (!d) {
    // round: the 404 here was an UNAUTHENTICATED device-name oracle (probe
    // names → 404 vs 401). Unveil existence only to admin sessions.
    if (user && user.role === "admin") return jsonError(404, "Device not found", "not_found_error");
    return jsonError(401, "Not logged in or invalid plugin token", "authentication_error");
  }
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
  // every link for this device and close the hub socket.
  await removePluginLinksForDevice(env, delName);
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
    return jsonError(
      400,
      "hostname must be a domain like d1.agent.saisi.online",
      "invalid_request",
    );
  const updated = await renameDevice(env, oldName, newName, hostname || undefined);
  if (updated === "not_found") return jsonError(404, "Device not found", "not_found_error");
  if (updated === "name_taken")
    return jsonError(409, `Device '${newName}' already registered`, "conflict");
  // Lock + fresh-read migration (store helper): the old inline code read
  // the isolate-cached map with no lock and wrote it back whole.
  await migratePluginLinks(env, oldName, newName);
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
// worker's /api/version on https://<dist-host>. Fetched server-side (no CORS
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

/// Devices are always cloudflared tunnels on the agent host domain; an
/// unvalidated hostname turns the worker into an SSRF proxy (it injects
/// Authorization + x-vale-auth into https://<hostname>…) AND re-serves that
/// host's responses at the console origin. Enforce a suffix allowlist,
/// overridable per-deployment via DEVICE_HOST_SUFFIX.
function hostAllowError(hostname: string, env: any): string | null {
  const suffix = (env?.DEVICE_HOST_SUFFIX || ".agent.saisi.online").toLowerCase();
  const h = hostname.toLowerCase();
  if (!h.endsWith(suffix) || h.length <= suffix.length) {
    return `hostname must be under ${suffix}`;
  }
  return null;
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
  // Strip inbound FIRST: a client-sent x-vale-auth must never ride through
  // when the record has no proxySecret (the header is ours to mint).
  headers.delete("x-vale-auth");
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
  // CORS: reflect-if-allowlisted (console origins + loopback) with Vary —
  // NO wildcard. The proxied panel runs at the console origin and can read
  // console APIs (accepted trust limitation, round-133/134 note below), so
  // an arbitrary cross-origin reader must not be invited in on top of that.
  stampCors(request, outHeaders);
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
  out = out.replace(
    /window\.__PANEL_TOKEN__\s*=\s*(?:"[^"]*"|'[^']*')/g,
    'window.__PANEL_TOKEN__=""',
  );
  return out;
}

/* ---------------- Plugin definition ---------------- */

export default {
  name: "devices",
  deps: [],
  setup(ctx: PluginContext) {
    // round-102: every public one-shot endpoint (register, tunnel-token —
    // extension pair/claim removed round-340) costs KV WRITES — an attacker
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
    // Device reverse-proxy — checked BEFORE the admin-gated device routes,
    // exactly like index.js (it also authenticates with the paired plugin
    // token, so it lives above the session gate).
    ctx.routes.push({
      match: (_m, p) => /^\/api\/devices\/[^/]+\/proxy/.test(p),
      handler: handleDeviceProxy,
    });

    // File upload: device token or admin session → proxy to index worker
    // (which holds the R2 UPLOAD_KEY). Device uses its existing Bearer
    // token — no new credential to deploy.
    ctx.routes.push({
      match: (m, p) => m === "POST" && p === "/api/upload",
      handler: handleFileUpload,
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
    // Admin-gated install flows (the last routes index.ts still served
    // inline — moved here to complete the plugin migration).
    ctx.routes.push({
      match: (m, p) => m === "POST" && p === `${DEVICE_BASE}/register-key`,
      handler: handleRegisterKey,
    });
  },
} satisfies Plugin;
