/**
 * store.js — KV persistence layer
 *
 * Multi-user BYOK relay:
 *   user:<id>          → user record {id, username, role, enabled, createdAt, passwordHash, salt, token}
 *   username:<name>    → userId (uniqueness + fast lookup)  [kept for compat; not used]
 *   token:<gatewayToken> → userId (client x-api-key resolution)
 *   ukeys:<id>         → that user's own backend keys {DEEPSEEK_API_KEY, OPENCODE_GO_API_KEY, OPENROUTER_API_KEY}
 *   invite:<code>      → "1" (one-time registration invite)
 *   _admin_seeded      → "1" (admin seeded marker)
 *
 * Compat migration: the admin account is seeded from the existing CLIENT_KEY (gateway
 * token) + backend keys, so the user's local settings.json (x-api-key = CLIENT_KEY)
 * keeps working without changes.
 */

import { hashPassword, randomHex } from "./auth.js";

export const ADMIN_USERNAME = "admin";
export const ADMIN_ID = "admin"; // user ID = username → readable KV keys
export const USER_KEY_NAMES = ["DEEPSEEK_API_KEY", "OPENCODE_GO_API_KEY", "OPENROUTER_API_KEY", "QWEN_API_KEY"];

/* ---- Per-isolate TTL cache ----
 *
 * Reads go through this cache (24h TTL); every write refreshes the cache
 * immediately (write-through), so admin changes take effect instantly on the
 * hot isolate. The TTL only backstops cross-isolate consistency: after 24h a
 * cached value is re-read from KV even if no write touched this isolate.
 * KV read volume is thus decoupled from request volume — each key costs at
 * most one read per day per isolate, instead of one read per request.
 */
const CACHE_TTL = 24 * 60 * 60 * 1000;
const __c = new Map(); // kvKey -> { v, exp }; v may be null (cached "not found")
function cget(k) {
  const e = __c.get(k);
  if (!e) return undefined;
  if (e.exp <= Date.now()) { __c.delete(k); return undefined; }
  return e.v;
}
function cset(k, v) {
  if (__c.size >= 512) __c.delete(__c.keys().next().value); // bound cache size
  __c.set(k, { v, exp: Date.now() + CACHE_TTL });
}
function cdel(...ks) { for (const k of ks) __c.delete(k); }

async function getJSON(env, key) {
  if (!env.KEYS) return null;
  const raw = await env.KEYS.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function putJSON(env, key, val) {
  if (!env.KEYS) return;
  await env.KEYS.put(key, JSON.stringify(val));
}

/* ---- Admin seeding ---- */
let seeded = false;
export async function seedAdmin(env) {
  if (!env.KEYS || seeded) return;
  seeded = true;

  // v1 → v2 migration: random-ID schema → "username as KV key" schema
  // (user:u-admin / ukeys:u-admin / token:*→u-admin  →  user:admin / ukeys:admin / token:*→admin)
  const oldAdmin = await env.KEYS.get("user:u-admin");
  if (oldAdmin) {
    try {
      const admin = JSON.parse(oldAdmin);
      admin.id = ADMIN_ID;
      await env.KEYS.put(`user:${ADMIN_ID}`, JSON.stringify(admin));
      cset(`user:${ADMIN_ID}`, admin);
      await env.KEYS.delete("user:u-admin");
      if (admin.token && (await env.KEYS.get(`token:${admin.token}`)) === "u-admin") {
        await env.KEYS.put(`token:${admin.token}`, ADMIN_ID);
        cset(`token:${admin.token}`, ADMIN_ID);
      }
      const uks = await env.KEYS.get("ukeys:u-admin");
      if (uks) {
        await env.KEYS.put(`ukeys:${ADMIN_ID}`, uks);
        let parsed = null;
        try { parsed = JSON.parse(uks); } catch {}
        cset(`ukeys:${ADMIN_ID}`, parsed || {});
        await env.KEYS.delete("ukeys:u-admin");
      }
      await env.KEYS.delete("username:admin");
    } catch (e) { /* a failed migration must not block startup */ }
  }

  if (await env.KEYS.get("_admin_seeded")) return;

  const legacyToken = (await env.KEYS.get("CLIENT_KEY")) || env.CLIENT_KEY || "";
  const admin = {
    id: ADMIN_ID,
    username: ADMIN_USERNAME,
    role: "admin",
    enabled: true,
    createdAt: Date.now(),
    token: legacyToken,
  };
  await env.KEYS.put(`user:${ADMIN_ID}`, JSON.stringify(admin));
  cset(`user:${ADMIN_ID}`, admin);
  if (legacyToken) {
    await env.KEYS.put(`token:${legacyToken}`, ADMIN_ID);
    cset(`token:${legacyToken}`, ADMIN_ID);
  }

  const ukeys = {};
  for (const n of USER_KEY_NAMES) {
    const v = (await env.KEYS.get(n)) || env[n] || "";
    if (v) ukeys[n] = v;
  }
  await env.KEYS.put(`ukeys:${ADMIN_ID}`, JSON.stringify(ukeys));
  cset(`ukeys:${ADMIN_ID}`, ukeys);
  await env.KEYS.put("_admin_seeded", "1");
}

/* ---- Users ---- */

export function generateGatewayToken() {
  return randomHex(24);
}

export async function createUser(env, { username, password, inviteCode, role = "user" }) {
  if (!env.KEYS) throw new Error("KV not bound");
  const name = String(username || "").trim();
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(name)) throw new Error("Username must be 2-32 chars: letters/digits/_ . -");
  if (!password || String(password).length < 6) throw new Error("Password must be at least 6 chars");
  if (await env.KEYS.get(`user:${name}`)) throw new Error("Username already taken");

  if (role !== "admin") {
    if (!inviteCode || !(await env.KEYS.get(`invite:${String(inviteCode).trim()}`))) {
      throw new Error("Invalid invite code");
    }
    await env.KEYS.delete(`invite:${String(inviteCode).trim()}`);
  }

  const salt = randomHex(16);
  const passwordHash = await hashPassword(String(password), salt);
  const token = generateGatewayToken();
  // user ID = username → readable KV keys: user:<name> / ukeys:<name> / token:<t> → <name>
  const user = { id: name, username: name, role, enabled: true, createdAt: Date.now(), passwordHash, salt, token };
  await env.KEYS.put(`user:${name}`, JSON.stringify(user));
  await env.KEYS.put(`token:${token}`, name);
  cset(`user:${name}`, user);
  cset(`token:${token}`, name);
  return { id: name, username: name, role, token };
}

export async function getUser(env, id) {
  const key = `user:${id}`;
  const hit = cget(key);
  if (hit !== undefined) return hit;
  const u = await getJSON(env, key);
  cset(key, u); // caches null too — no zombie lookups
  return u;
}

export async function findUserByUsername(env, username) {
  return getUser(env, String(username || "").trim());
}

export async function findUserByToken(env, token) {
  if (!token) return null;
  const tkey = `token:${String(token)}`;
  let name = cget(tkey);
  if (name === undefined) {
    name = env.KEYS ? await env.KEYS.get(tkey) : null;
    cset(tkey, name);
  }
  if (!name) return null;
  return getUser(env, name);
}

export async function listUsers(env) {
  if (!env.KEYS) return [];
  const { keys } = await env.KEYS.list({ prefix: "user:" });
  const out = [];
  for (const k of keys) {
    const u = await getJSON(env, k.name);
    if (u) out.push(u);
  }
  return out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function setUserEnabled(env, id, enabled) {
  // read-modify-write: read raw KV (not cache) so the write is based on the
  // latest value, then refresh the cache with the new object (write-through)
  const u = await getJSON(env, `user:${id}`);
  if (!u) throw new Error("User not found");
  u.enabled = !!enabled;
  await env.KEYS.put(`user:${id}`, JSON.stringify(u));
  cset(`user:${id}`, u);
  return u;
}

export async function regenerateToken(env, id) {
  const u = await getJSON(env, `user:${id}`);
  if (!u) throw new Error("User not found");
  if (u.token) {
    await env.KEYS.delete(`token:${u.token}`);
    cdel(`token:${u.token}`);
  }
  u.token = generateGatewayToken();
  await env.KEYS.put(`user:${id}`, JSON.stringify(u));
  await env.KEYS.put(`token:${u.token}`, id);
  cset(`user:${id}`, u);
  cset(`token:${u.token}`, id);
  return u.token;
}

/* ---- Per-user backend keys ---- */

export async function getUserKeys(env, id) {
  const key = `ukeys:${id}`;
  const hit = cget(key);
  if (hit !== undefined) return hit;
  const ukeys = (await getJSON(env, key)) || {};
  // Admin fallback: fall back to Worker secrets when not explicitly configured
  if (id === ADMIN_ID && env.KEYS) {
    for (const n of USER_KEY_NAMES) {
      if (!ukeys[n]) ukeys[n] = (await env.KEYS.get(n)) || env[n] || null;
    }
  }
  cset(key, ukeys);
  return ukeys;
}

export async function setUserKey(env, id, name, value) {
  const ukeys = (await getJSON(env, `ukeys:${id}`)) || {};
  ukeys[name] = String(value).trim();
  await env.KEYS.put(`ukeys:${id}`, JSON.stringify(ukeys));
  cset(`ukeys:${id}`, ukeys);
  return ukeys;
}

export async function deleteUserKey(env, id, name) {
  const ukeys = (await getJSON(env, `ukeys:${id}`)) || {};
  delete ukeys[name];
  await env.KEYS.put(`ukeys:${id}`, JSON.stringify(ukeys));
  cset(`ukeys:${id}`, ukeys);
  return ukeys;
}

/* ---- Per-user route selection (model=auto) ---- */

export async function getUserRoute(env, id) {
  const key = `route:${id}`;
  const hit = cget(key);
  if (hit !== undefined) return hit;
  const v = (await env.KEYS.get(key)) || null;
  cset(key, v);
  return v;
}

export async function setUserRoute(env, id, model) {
  const key = `route:${id}`;
  if (model === null || model === undefined || model === "") {
    await env.KEYS.delete(key);
    cdel(key);
    return;
  }
  await env.KEYS.put(key, String(model));
  cset(key, String(model)); // write-through：切换立即生效（同 isolate 零延迟）
}

/* ---- Admin password (stored in KV as plaintext so the console can show/change it) ---- */

/** Read the admin password: KV is authoritative; migrate from the Worker secret once if absent */
export async function getAdminPassword(env) {
  const key = "auth:admin_password";
  const hit = cget(key);
  if (hit !== undefined) return hit;
  if (!env.KEYS) return env.ADMIN_PASSWORD || "";
  let v = await env.KEYS.get(key);
  if (!v && env.ADMIN_PASSWORD) {
    // one-time migration from the Worker secret — cache the written value
    v = env.ADMIN_PASSWORD;
    await env.KEYS.put(key, v);
  }
  v = v || "";
  cset(key, v);
  return v;
}

export async function setAdminPassword(env, value) {
  if (!env.KEYS) throw new Error("KV not bound");
  const v = String(value);
  await env.KEYS.put("auth:admin_password", v);
  cset("auth:admin_password", v);
}

/* ---- Invites ---- */

export async function createInvite(env) {
  const code = randomHex(5).toUpperCase();
  await env.KEYS.put(`invite:${code}`, "1");
  return code;
}

/* ---- Devices (Vale Command device registry, admin-managed) ----
 *
 * devices:v1 → JSON array of { name, hostname, token }
 *   name     → device id (also the console key), e.g. "d1"
 *   hostname → the device's public host, e.g. "d1.command.saisi.online"
 *   token    → the vale-command Bearer token (MCP + panel auth). Stored here so
 *              the console can show the MCP config and the proxy can inject it
 *              server-side; NEVER auto-dispensed to non-admin callers.
 */

const DEVICES_KEY = "devices:v1";

async function readDevicesRaw(env) {
  if (!env.KEYS) return [];
  const raw = await env.KEYS.get(DEVICES_KEY);
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}

export async function listDevices(env) {
  const hit = cget(DEVICES_KEY);
  if (hit !== undefined) return hit;
  const arr = await readDevicesRaw(env);
  cset(DEVICES_KEY, arr);
  return arr;
}

export async function saveDevices(env, devices) {
  if (!env.KEYS) return;
  await env.KEYS.put(DEVICES_KEY, JSON.stringify(devices));
  cset(DEVICES_KEY, devices); // covers upsertDevice / deleteDevice / /api/register
}

export async function getDevice(env, name) {
  const devs = await listDevices(env);
  return devs.find((d) => d.name === name) || null;
}

export async function upsertDevice(env, device) {
  // read-modify-write: merge against raw KV so a stale cache can't drop
  // devices added by another isolate; saveDevices then refreshs the cache
  const devs = await readDevicesRaw(env);
  const i = devs.findIndex((d) => d.name === device.name);
  if (i >= 0) devs[i] = device; else devs.push(device);
  await saveDevices(env, devs);
  return device;
}

export async function deleteDevice(env, name) {
  const devs = await readDevicesRaw(env);
  const out = devs.filter((d) => d.name !== name);
  await saveDevices(env, out);
  return out.length !== devs.length;
}

/* ---- Device registration keys ----
 *
 * One-time keys the admin generates in the console and pastes into the Windows
 * install ($env:VALE_REG_KEY). The install script calls POST /api/register with
 * the key + the device's {name, hostname, token}, so a device appears in the
 * console without copying the token by hand. regkey:<code> → "1".
 */

export async function createRegKey(env) {
  const code = randomHex(8).toLowerCase();
  if (env.KEYS) await env.KEYS.put(`regkey:${code}`, "1");
  return code;
}

export async function hasRegKey(env, code) {
  if (!env.KEYS || !code) return false;
  return !!(await env.KEYS.get(`regkey:${String(code).toLowerCase()}`));
}

export async function deleteRegKey(env, code) {
  if (!env.KEYS || !code) return;
  await env.KEYS.delete(`regkey:${String(code).toLowerCase()}`);
}

/* ---- Cloudflare tunnel API token (account-level, admin-managed) ----
 *
 * cf:api_token — the API token used by the Windows install to set up the
 * Cloudflare tunnel (Tunnel:Edit + Zone:DNS:Edit). Stored here so the install
 * can fetch it with a registration key instead of the user pasting it on the
 * machine. Account-level credential: admin-only read/write in the console.
 */

export async function getCfToken(env) {
  const key = "cf:api_token";
  const hit = cget(key);
  if (hit !== undefined) return hit;
  const v = (env.KEYS ? (await env.KEYS.get(key)) : null) || "";
  cset(key, v);
  return v;
}

export async function setCfToken(env, value) {
  if (!env.KEYS) throw new Error("KV not bound");
  const v = String(value || "").trim();
  if (v) {
    await env.KEYS.put("cf:api_token", v);
    cset("cf:api_token", v);
  } else {
    await env.KEYS.delete("cf:api_token");
    cdel("cf:api_token");
  }
  return v;
}

/* ---- Masking ---- */

export function maskKey(v) {
  if (!v) return "not configured";
  if (v.length <= 6) return v[0] + "…" + v.slice(-2);
  return v.slice(0, 3) + "…" + v.slice(-4);
}
