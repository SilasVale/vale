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
 * Panel grants (one-time, so the permanent device token never rides in a URL):
 *   POST /api/devices/<name>/panel-grant    (admin — mint a 120s single-use grant)
 *   POST /api/devices/panel-grant/redeem    (device token — agent consumes a grant)
 *
 * Handler convention: dispatch(ctx, method, path, request, env, url) →
 * handler(request, env, url).
 *
 * The reverse-proxy handler (handleDeviceProxy + proxyDevice +
 * rewriteDeviceBody) was extracted verbatim to ./device-proxy.ts — this
 * module keeps the route wiring and imports the shared DEVICE_BASE /
 * decodeDeviceName helpers from there.
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
  createPanelGrant,
  getPanelGrant,
  deletePanelGrant,
  type Device,
} from "../store.ts";
import { safeEq } from "../auth.ts";
import { deviceFetch } from "../device-fetch.ts";
import { fetchWithTimeout } from "../reliability.ts";
import { jsonOk, jsonError, readJson } from "../http.ts";
import { requireSession, requireAdmin } from "../session.ts";
import { route, type Plugin, type PluginContext } from "./registry.ts";
import { createIpRateLimiter } from "../lib/ratelimit.ts";
// The device reverse-proxy lives in its own module (extracted verbatim);
// DEVICE_BASE + decodeDeviceName are shared helpers that moved with it so
// module deps stay one-way (devices.ts → device-proxy.ts, no cycle).
import { handleDeviceProxy, DEVICE_BASE, decodeDeviceName } from "./device-proxy.ts";

// Upload hardening (see proxyUploadToWorker): max accepted upload size and
// the upstream response headers that must never be re-served at the
// console origin.
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/// 409 conflict envelope for a name that is already registered — the
/// register pre-check (round-68) and the in-lock insertDevice retry
/// (round-122) used to each inline the same jsonError.
function alreadyRegisteredConflict(name: string): Response {
  return jsonError(
    409,
    `Device '${name}' already registered — use the console (admin) to update it`,
    "conflict",
  );
}
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
    const device = validatedDeviceOrError(body);
    if (device instanceof Response) return device;
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
      return alreadyRegisteredConflict(device.name);
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
      return alreadyRegisteredConflict(device.name);
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
  const device = validatedDeviceOrError(body);
  if (device instanceof Response) return device;
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

// ---- Device module (Vale Agent registry) ----
// (the reverse-proxy route lives in device-proxy.ts — registered below,
//  before the session gate — it also accepts the paired plugin token)
// GET    /api/devices                        → list (token masked)
// POST   /api/devices                        → add/update {name, hostname, token}
// DELETE /api/devices/<name>                 → remove
// GET    /api/devices/<name>/mcp             → MCP config for a device (with token)
// The session gate below is verbatim from handleConsole (requireSession 401
// check, then the admin 403 check) — the device module sat after both.
async function handleDevicesList(request: Request, env: any): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;
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
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  const device = validatedDeviceOrError(body);
  if (device instanceof Response) return device;
  // New record gets a registration date; an admin update of an existing
  // device keeps the original one (same contract as self-register).
  const existing = await getDevice(env, device.name);
  const toSave = { ...device, registeredAt: existing?.registeredAt ?? Date.now() };
  await upsertDevice(env, toSave);
  return jsonOk({
    ok: true,
    device: { name: toSave.name, hostname: toSave.hostname, token: maskKey(toSave.token) },
  });
}

async function handleDeviceMcp(request: Request, env: any, url: URL): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;
  const path = url.pathname;
  const mcpMatch = path.match(new RegExp(`^${DEVICE_BASE}/([^/]+)/mcp$`))!;
  const devName = decodeDeviceName(mcpMatch[1]!);
  if (devName === null) return jsonError(400, "Invalid device name", "invalid_request");
  const d = await getDevice(env, devName);
  if (!d) return jsonError(404, "Device not found", "not_found_error");
  return jsonOk({ name: d.name, hostname: d.hostname, mcp: mcpConfig(d) });
}

// POST /api/devices/<name>/panel-grant — mint a ONE-TIME panel grant (admin
// session). The console's "open panel" used to fetch the MCP config, extract
// the device's PERMANENT 64-hex token and open
// https://<host>/panel/?token=<token> — the credential rode in the browser
// history/journal, any logs and the referer chain. Now the console mints a
// 120s single-use grant bound to this device and opens
// https://<host>/panel/?grant=<code>; the AGENT redeems it against this
// endpoint with its own Bearer token and injects the token server-side. The
// panel URL is derived exactly like mcpConfig() (same hostname source).
async function handleDevicePanelGrant(request: Request, env: any, url: URL): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;
  const m = url.pathname.match(new RegExp(`^${DEVICE_BASE}/([^/]+)/panel-grant$`))!;
  const devName = decodeDeviceName(m[1]!);
  if (devName === null) return jsonError(400, "Invalid device name", "invalid_request");
  const d = await getDevice(env, devName);
  if (!d) return jsonError(404, "Device not found", "not_found_error");
  const code = await createPanelGrant(env, d.name);
  return jsonOk({ ok: true, url: `https://${d.hostname}/panel/?grant=${code}` });
}

// POST /api/devices/panel-grant/redeem — the AGENT consumes a panel grant.
// Auth: the device's own Bearer token (possession of the token IS the device
// identity — same rule as /api/upload's device path and self-register): scan
// the small device registry for a safeEq token match, never a short-circuit
// compare. The grant must belong to the caller: a leaked/grabbed grant code
// is worthless from any other device, and the 403 doesn't distinguish
// "wrong device" from "wrong code" beyond what the status codes already say.
//
// CONCURRENCY: check-then-delete on eventually-consistent KV means two
// concurrent redeems can BOTH pass the get before either delete lands (KV
// has no atomic swap). Single-use is therefore best-effort — the same class
// the tunnel-token flow accepted before its claim lock; here the blast
// radius is one extra panel response within a 120s TTL, gated by a
// device-token Bearer the attacker doesn't have. The delete runs FIRST so a
// crash between delete and respond fails closed (no grant left to retry).
async function handlePanelGrantRedeem(request: Request, env: any): Promise<Response> {
  const auth = String(request.headers.get("authorization") || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return jsonError(401, "Missing device token", "authentication_error");
  // KV read failure → null → 401 (fail closed, like handleFileUpload's catch).
  let caller: Device | null = null;
  try {
    const devices = await listDevices(env);
    caller =
      devices.find(
        (d) => typeof d.token === "string" && d.token.length >= 32 && safeEq(d.token, token),
      ) ?? null;
  } catch {
    /* caller stays null */
  }
  if (!caller) return jsonError(401, "Invalid device token", "authentication_error");
  const body = await readJson(request);
  const code = String(body?.grant || "").trim();
  const grant = await getPanelGrant(env, code); // malformed/unknown/expired → null → 404
  if (!grant) return jsonError(404, "Grant not found or expired", "not_found_error");
  if (grant.device !== caller.name)
    return jsonError(403, "Grant does not match this device", "authorization_error");
  await deletePanelGrant(env, code);
  return jsonOk({ ok: true });
}

async function handleDeviceDelete(request: Request, env: any, url: URL): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;
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
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;
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
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;
  return jsonOk({ keys: await listRegKeys(env) });
}

// DELETE /api/devices/register-keys/<code> — revoke an unused key before
// its 1h TTL (a key pasted into the wrong chat can be killed immediately).
async function handleRegKeyRevoke(request: Request, env: any, url: URL): Promise<Response> {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;
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
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;
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
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;
  const key = await createRegKey(env);
  return jsonOk({ ok: true, key });
}

/* ---------------- Device module helpers (copied verbatim from index.js) ---------------- */

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

/** validateDevice wrapped as a 400 Response — the reg-key, self-register and
 *  admin-add handlers used to inline the same try/catch around it. */
function validatedDeviceOrError(body: any): Device | Response {
  try {
    return validateDevice(body);
  } catch (e) {
    return jsonError(400, (e as Error).message, "invalid_request");
  }
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
    const publicRateLimited = createIpRateLimiter({
      name: "pub-rate",
      limit: 10, // per minute, per IP (round-115: 30 let a single IP burn 60 writes/min through the claim+delete pair)
      windowMs: 60_000,
    });
    const gate =
      (fn: (request: Request, env: any, ...rest: any[]) => Promise<Response>) =>
      async (request: Request, env: any, ...rest: any[]) => {
        if (await publicRateLimited(request)) {
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

    // Panel-grant redeem: the AGENT consumes a one-time panel grant with its
    // own device Bearer token (no session — device-token auth, like
    // /api/upload's device path). Registered alongside the other
    // non-session routes; see handlePanelGrantRedeem for the auth + race
    // notes. (Path is disjoint from the mint route below: /panel-grant vs
    // /panel-grant/redeem.)
    ctx.routes.push({
      match: (m, p) => m === "POST" && p === "/api/devices/panel-grant/redeem",
      handler: handlePanelGrantRedeem,
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
      match: (m, p) => m === "POST" && new RegExp(`^${DEVICE_BASE}/[^/]+/panel-grant$`).test(p),
      handler: handleDevicePanelGrant,
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
