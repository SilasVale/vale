/**
 * store.ts — KV persistence layer (migrated from store.js, logic verbatim)
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

import { hashPassword, verifyPassword, randomHex } from "./auth.ts";

/** Workers env bindings — the shape we touch (loosely typed, same style as
 *  registry.ts). */
interface Env {
  [key: string]: any;
}

export interface User {
  id: string;
  username: string;
  role: string;
  enabled: boolean;
  createdAt: number;
  passwordHash?: string;
  salt?: string;
  token?: string;
}

export interface Device {
  name: string;
  hostname: string;
  token: string;
  /// round-103: the device's proxy secret (X-Vale-Auth) — read from the
  /// device at registration so the gateway proxy can present it and the
  /// agent will inject the panel token ONLY for gateway-authenticated
  /// requests (the R102 marker header was client-spoofable).
  proxySecret?: string;
  /// Console-visible metadata. All optional so pre-existing records keep
  /// loading; they are filled opportunistically (registration / status
  /// probes) under the KV write budget — see touchDeviceSeen.
  registeredAt?: number;
  lastSeenAt?: number;
  lastVersion?: string;
}

export interface PluginLink {
  device: string;
  createdAt: number;
  expiresAt: number;
}

export const ADMIN_USERNAME = "admin";
export const ADMIN_ID = "admin"; // user ID = username → readable KV keys
export const USER_KEY_NAMES = [
  "DEEPSEEK_API_KEY",
  "OPENCODE_GO_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_API_KEY",
  // NVIDIA NIM (build.nvidia.com) — translate.ts already read NVAPI_KEY from
  // the ukeys blob, but it was never listed here so the console couldn't
  // manage it. Listed now (key management parity).
  "NVAPI_KEY",
  // GMI Cloud Inference Engine (api.gmi-serving.com) — MiniMax Week free tier.
  "GMI_API_KEY",
  // Command Code (api.commandcode.ai/provider) — GOAT plan & up. Same key
  // works for the CLI and the Provider API (Go plan has no API access).
  "CMD_API_KEY",
];

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
// Security-critical keys get a short TTL so admin changes (disable user,
// regenerate token, flip US_PROXY, change password) propagate across
// isolates within a minute instead of up to 24h. KV reads are cheap — a few
// hundred per key per isolate per day.
const AUTH_CACHE_TTL = 60 * 1000;
// "devices:" + "plugins:" join the short-TTL set (round-55/56): a device
// registered via /api/register (or a plugin token paired) on a COLD isolate
// stayed invisible on hot isolates for up to 24h — /proxy and /mcp 404'd on
// the new device. Plugin tokens gate chrome.debugger-level device control —
// a revoked link must propagate within a minute, not a day.
const AUTH_PREFIXES = [
  "settings:",
  "token:",
  "user:",
  "ukeys:",
  "auth:",
  "route:",
  "devices:",
  "plugins:",
  "cf:",
];
const __c = new Map<string, { v: any; exp: number }>(); // kvKey -> { v, exp }; v may be null (cached "not found")
function cget(k: string): any {
  const e = __c.get(k);
  if (!e) return undefined;
  if (e.exp <= Date.now()) {
    __c.delete(k);
    return undefined;
  }
  return e.v;
}
function cset(k: string, v: any): void {
  if (__c.size >= 512) __c.delete(__c.keys().next().value!); // bound cache size
  const ttl = AUTH_PREFIXES.some((p) => k.startsWith(p)) ? AUTH_CACHE_TTL : CACHE_TTL;
  __c.set(k, { v, exp: Date.now() + ttl });
}
function cdel(...ks: string[]): void {
  for (const k of ks) __c.delete(k);
}
/** Test hook: wipe the module-level 24h caches (settings/route/keys). Never
 *  called in production — tests that flip global settings (e.g. US_PROXY)
 *  would otherwise read a stale cached value from an earlier test. */
export function __clearCaches(): void {
  __c.clear();
}

// Per-key single-flight queue: concurrent read-modify-write on the same KV
// blob (ukeys:<id>, devices:v1, plugins:v1) previously LOST updates — two
// requests both read the pre-write value and the second put clobbered the
// first's record. Serializing per key makes same-isolate writes atomic
// (Workers isolates are single-threaded; the queue bridges the awaits).
// round-122: settled chains are pruned opportunistically — the old size
// bound deleted the OLDEST key (always a hot key like devices:v1 whose
// chain could be pending), letting a new caller run CONCURRENTLY with the
// queued writers (the exact lost-update the queue prevents). Evict only
// chains that are no longer in flight: a chain is settled once it resolves,
// so wrap each stored promise to self-prune on completion.
const __locks = new Map<string, Promise<any>>();
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = __locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Self-prune on settle (round-124: the first attempt compared against
  // `next` but stored the .finally() wrapper — a DIFFERENT object, so the
  // prune never fired and every key accumulated until the 512 bound evicted
  // the oldest (hot, possibly-pending) chain). Capture the stored wrapper
  // and compare against it.
  const stored = next
    .catch(() => {})
    .finally(() => {
      if (__locks.get(key) === stored) __locks.delete(key);
    });
  __locks.set(key, stored);
  // Hard bound for pathological distinct-key bursts: evict the oldest key,
  // accepting that a pending chain there loses its queue (its own RMW still
  // completes; only a NEW caller for that key can now race it). Far rarer
  // than the old always-hit-hot-key eviction.
  if (__locks.size > 512) __locks.delete(__locks.keys().next().value!);
  return next;
}

async function getJSON(env: Env, key: string): Promise<any> {
  if (!env.KEYS) return null;
  const raw = await env.KEYS.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ---- Admin seeding ---- */
let seeded = false;
export async function seedAdmin(env: Env): Promise<void> {
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
        try {
          parsed = JSON.parse(uks);
        } catch {
          /* malformed JSON */
        }
        cset(`ukeys:${ADMIN_ID}`, parsed || {});
        await env.KEYS.delete("ukeys:u-admin");
      }
      await env.KEYS.delete("username:admin");
    } catch {
      /* a failed migration must not block startup */
    }
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

  const ukeys: Record<string, string> = {};
  for (const n of USER_KEY_NAMES) {
    const v = (await env.KEYS.get(n)) || env[n] || "";
    if (v) ukeys[n] = v;
  }
  await env.KEYS.put(`ukeys:${ADMIN_ID}`, JSON.stringify(ukeys));
  cset(`ukeys:${ADMIN_ID}`, ukeys);
  await env.KEYS.put("_admin_seeded", "1");
}

/* ---- Users ---- */

export function generateGatewayToken(): string {
  return randomHex(24);
}

export async function createUser(
  env: Env,
  {
    username,
    password,
    inviteCode,
    role = "user",
  }: { username: string; password: string; inviteCode?: string; role?: string },
): Promise<any> {
  if (!env.KEYS) throw new Error("KV not bound");
  const name = String(username || "").trim();
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(name))
    throw new Error("Username must be 2-32 chars: letters/digits/_ . -");
  if (!password || String(password).length < 6)
    throw new Error("Password must be at least 6 chars");
  // round-107: serialize the WHOLE create per name — a bare check left a
  // window where concurrent same-name registrations both passed and
  // overwrote each other's record while both tokens stayed live.
  return withKeyLock(`user:${name}`, async () => {
    if (await env.KEYS.get(`user:${name}`)) throw new Error("Username already taken");

    if (role !== "admin") {
      const code = String(inviteCode || "").trim();
      // round-94/95: invite consumption is serialized per code (the TTL
      // claim bounds cross-isolate races).
      const r = await withKeyLock(`invclaim:${code}`, async () => {
        const claim = await env.KEYS.get(`invclaim:${code}`);
        if (claim) throw new Error("Invite code already in use");
        await env.KEYS.put(`invclaim:${code}`, "1", { expirationTtl: 60 });
        if (!(await env.KEYS.get(`invite:${code}`))) {
          await env.KEYS.delete(`invclaim:${code}`);
          throw new Error("Invalid invite code");
        }
        await env.KEYS.delete(`invite:${code}`);
      });
      void r;
    }

    const salt = randomHex(16);
    const passwordHash = await hashPassword(String(password), salt);
    const token = generateGatewayToken();
    // user ID = username → readable KV keys: user:<name> / ukeys:<name> / token:<t> → <name>
    const user = {
      id: name,
      username: name,
      role,
      enabled: true,
      createdAt: Date.now(),
      passwordHash,
      salt,
      token,
    };
    await env.KEYS.put(`user:${name}`, JSON.stringify(user));
    await env.KEYS.put(`token:${token}`, name);
    cset(`user:${name}`, user);
    cset(`token:${token}`, name);
    return { id: name, username: name, role, token };
  });
}

export async function getUser(env: Env, id: string): Promise<User | null> {
  const key = `user:${id}`;
  const hit = cget(key);
  if (hit !== undefined) return hit;
  const u = await getJSON(env, key);
  cset(key, u); // caches null too — no zombie lookups
  return u;
}

export async function findUserByUsername(env: Env, username: string): Promise<User | null> {
  return getUser(env, String(username || "").trim());
}

export async function findUserByToken(env: Env, token: string): Promise<User | null> {
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

export async function listUsers(env: Env): Promise<User[]> {
  if (!env.KEYS) return [];
  const { keys } = await env.KEYS.list({ prefix: "user:" });
  const out: any[] = [];
  for (const k of keys) {
    const u = await getJSON(env, k.name);
    if (u) out.push(u);
  }
  return out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function setUserEnabled(env: Env, id: string, enabled: boolean): Promise<User> {
  // round-122: serialize on the same key as createUser/regenerateToken — the
  // unlocked read-modify-write let an enable/disable land with a stale token
  // value (regenerate's delete of token:T1 then made the record's T1 dead:
  // x-api-key stops working while the console still shows T1).
  return withKeyLock(`user:${id}`, async () => {
    // read-modify-write: read raw KV (not cache) so the write is based on the
    // latest value, then refresh the cache with the new object (write-through)
    const u = await getJSON(env, `user:${id}`);
    if (!u) throw new Error("User not found");
    u.enabled = !!enabled;
    await env.KEYS.put(`user:${id}`, JSON.stringify(u));
    cset(`user:${id}`, u);
    return u;
  });
}

export async function regenerateToken(env: Env, id: string): Promise<string> {
  return withKeyLock(`user:${id}`, async () => {
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
    // A concurrent regenerate could have left a survivor mapping (token:T2
    // still live after T3 won) — sweep any other mapping for this user.
    const newToken = u.token;
    try {
      const list = await env.KEYS.list({ prefix: "token:" });
      for (const k of list.keys || []) {
        if (k.name === `token:${newToken}`) continue;
        const v = await env.KEYS.get(k.name);
        if (v === id) {
          await env.KEYS.delete(k.name);
          cdel(k.name);
        }
      }
    } catch {
      /* best-effort sweep */
    }
    return newToken;
  });
}

/* ---- Per-user backend keys ---- */

export async function getUserKeys(env: Env, id: string): Promise<Record<string, any>> {
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

export async function setUserKey(
  env: Env,
  id: string,
  name: string,
  value: string,
): Promise<Record<string, any>> {
  return withKeyLock(`ukeys:${id}`, async () => {
    const ukeys = (await getJSON(env, `ukeys:${id}`)) || {};
    ukeys[name] = String(value).trim();
    await env.KEYS.put(`ukeys:${id}`, JSON.stringify(ukeys));
    cset(`ukeys:${id}`, ukeys);
    return ukeys;
  });
}

export async function deleteUserKey(
  env: Env,
  id: string,
  name: string,
): Promise<Record<string, any>> {
  return withKeyLock(`ukeys:${id}`, async () => {
    const ukeys = (await getJSON(env, `ukeys:${id}`)) || {};
    delete ukeys[name];
    await env.KEYS.put(`ukeys:${id}`, JSON.stringify(ukeys));
    cset(`ukeys:${id}`, ukeys);
    return ukeys;
  });
}

/* ---- Per-user route selection (model=auto) ----
 * Stored in RouteDO (Durable Object) instead of KV for strong cross-isolate
 * consistency. KV's eventual consistency caused stale reads on isolates that
 * didn't handle the PUT, making model=auto requests use the old route.
 *
 * Lazy migration: route selections written before RouteDO existed live in KV
 * under `route:<id>`. On a DO miss, fall back to the legacy KV key once; if
 * found, copy it into the DO and delete the KV key (migration is complete). */

function routeStub(env: any) {
  return env.ROUTE.get(env.ROUTE.idFromName("global"));
}

export async function getUserRoute(env: Env, id: string): Promise<string | null> {
  const res = await routeStub(env).fetch(`https://route/route?uid=${encodeURIComponent(id)}`);
  const data: any = await res.json();
  if (data.model != null) return data.model;
  // Legacy KV fallback (one-time migration).
  const legacy = env.KEYS ? await env.KEYS.get(`route:${id}`) : null;
  if (legacy) {
    await setUserRoute(env, id, legacy);
    await env.KEYS.delete(`route:${id}`).catch(() => {});
    return legacy;
  }
  return null;
}

export async function setUserRoute(
  env: Env,
  id: string,
  model: string | null | undefined,
): Promise<void> {
  if (model === null || model === undefined || model === "") {
    await routeStub(env).fetch(`https://route/route?uid=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return;
  }
  await routeStub(env).fetch("https://route/route", {
    method: "PUT",
    body: JSON.stringify({ uid: id, model: String(model) }),
  });
}

/* ---- Global settings (console-controlled, e.g. US_PROXY exit switch) ---- */

/** Read a global setting; falls back to a Worker secret/env of the same name
 *  so the console toggle can override (and persist) a bootstrap value. */
/** Normalize a raw setting value to the canonical form: "1" = on, null = off.
 *  "0"/"false" (explicit OFF persisted by the console) → null; anything else
 *  passes through. (round-95/96) */
function normalizeSetting(v: string | null | undefined): string | null {
  if (v !== null && v !== undefined && (v === "0" || v === "false")) return null;
  return v as string | null;
}

export async function getGlobalSetting(env: Env, name: string): Promise<string | null> {
  const key = `settings:${name}`;
  const hit = cget(key);
  if (hit !== undefined) return normalizeSetting(hit);
  let v = await env.KEYS.get(key);
  if (v === null || v === undefined) v = env[name] ? String(env[name]) : null;
  // round-95: normalize AT THE READ — an explicit OFF is persisted as "0"
  // (shadows the env var, round-94), but every consumer (the real /v1 path in
  // index.ts, the console GET, the probes) used raw truthiness, which treats
  // "0" as ON. Returning a canonical value here fixes ALL consumers at once:
  // "1" = on, null = off.
  // round-96: the CACHE HIT path (above) bypassed this normalization — the
  // isolate that just wrote the "0" (setGlobalSetting write-through-caches
  // the raw value) kept reading "0" as ON for the cache TTL, so the console
  // PUT response bounced back enabled:true and /v1 routing used the proxy.
  v = normalizeSetting(v);
  cset(key, v);
  return v;
}

/** Normalize a global-setting value to a boolean: "0"/"false"/""/null are
 *  off, anything else on. Consumers must use this instead of raw truthiness —
 *  an explicit OFF is persisted as "0" (see setGlobalSetting) which is
 *  truthy as a string. (round-94) */
export function globalSettingEnabled(v: string | null | undefined): boolean {
  return !(v === null || v === undefined || v === "" || v === "0" || v === "false");
}

export async function setGlobalSetting(env: Env, name: string, value: any): Promise<void> {
  const key = `settings:${name}`;
  // round-94: an explicit OFF was stored as a KV delete — getGlobalSetting
  // then fell back to the Worker var of the same name, so a setting with an
  // env fallback (US_PROXY as a wrangler var) could be turned ON but never
  // OFF (the toggle bounced straight back). Distinguish "no value set"
  // (delete → env fallback) from "explicitly off" (persist "0", which
  // shadows the var). getGlobalSetting's falsy handling treats "0" as off.
  if (value === null || value === undefined || value === "") {
    await env.KEYS.delete(key);
    cdel(key);
    return;
  }
  const s = String(value);
  // round-96: persist the CANONICAL value ("1" or "0") — the raw string is
  // cached write-through and a raw "0" in the cache bypassed the read-side
  // normalization on this isolate (see getGlobalSetting).
  const canonical = s === "1" ? "1" : "0";
  await env.KEYS.put(key, canonical);
  cset(key, canonical); // write-through: the switch takes effect immediately (zero delay within the same isolate)
}

/* ---- Admin password (stored hashed — never plaintext) ----
 *
 * Previously stored plaintext in KV and returned verbatim by
 * GET /api/admin/password. Now: PBKDF2 (same scheme as user passwords via
 * auth.js); getAdminPassword returns the stored hash, hasAdminPassword
 * tells the console whether one is set, verifyAdminPassword compares a
 * candidate. No raw value is ever exposed.
 */

/** Read the admin password hash: KV is authoritative; migrate from the Worker secret once if absent */
export async function getAdminPassword(env: Env): Promise<string> {
  const key = "auth:admin_password";
  const hit = cget(key);
  if (hit !== undefined) return hit;
  if (!env.KEYS)
    return env.ADMIN_PASSWORD ? `legacy:${await hashPassword(env.ADMIN_PASSWORD, "legacy")}` : "";
  let v = await env.KEYS.get(key);
  if (!v && env.ADMIN_PASSWORD) {
    // one-time migration from the Worker secret — store HASHED in the same
    // `salt:hash` format verifyAdminPassword expects. A bare hash (no colon)
    // made verification permanently fail — admin locked out of the console.
    v = `legacy:${await hashPassword(env.ADMIN_PASSWORD, "legacy")}`;
    await env.KEYS.put(key, v);
  }
  v = v || "";
  cset(key, v);
  return v;
}

export async function hasAdminPassword(env: Env): Promise<boolean> {
  return !!(await getAdminPassword(env));
}

/** Compare a candidate password against the stored hash. */
export async function verifyAdminPassword(env: Env, candidate: string): Promise<boolean> {
  const stored = await getAdminPassword(env);
  if (!stored) return false;
  // Stored as `salt:hash` — reuse the same PBKDF2 verify as user accounts.
  const [salt, hash] = stored.split(":");
  return verifyPassword(candidate || "", salt || "", hash || "");
}

export async function setAdminPassword(env: Env, value: string): Promise<void> {
  if (!env.KEYS) throw new Error("KV not bound");
  const salt = randomHex(8);
  const v = `${salt}:${await hashPassword(String(value), salt)}`;
  await env.KEYS.put("auth:admin_password", v);
  cset("auth:admin_password", v);
}

/* ---- Invites ---- */

export async function createInvite(env: Env): Promise<string> {
  const code = randomHex(5).toUpperCase();
  // 7-day TTL: an invite shared in chat must not stay valid forever.
  await env.KEYS.put(`invite:${code}`, "1", { expirationTtl: 7 * 24 * 60 * 60 });
  return code;
}

/* ---- Devices (Vale Agent device registry, admin-managed) ----
 *
 * devices:v1 → JSON array of { name, hostname, token }
 *   name     → device id (also the console key), e.g. "d1"
 *   hostname → the device's public host, e.g. "d1.agent.saisi.online"
 *   token    → the vale-agent Bearer token (MCP + panel auth). Stored here so
 *              the console can show the MCP config and the proxy can inject it
 *              server-side; NEVER auto-dispensed to non-admin callers.
 */

const DEVICES_KEY = "devices:v1";

async function readDevicesRaw(env: Env): Promise<Device[]> {
  if (!env.KEYS) return [];
  const raw = await env.KEYS.get(DEVICES_KEY);
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export async function listDevices(env: Env): Promise<Device[]> {
  const hit = cget(DEVICES_KEY);
  if (hit !== undefined) return hit;
  const arr = await readDevicesRaw(env);
  cset(DEVICES_KEY, arr);
  return arr;
}

export async function saveDevices(env: Env, devices: Device[]): Promise<void> {
  if (!env.KEYS) return;
  await env.KEYS.put(DEVICES_KEY, JSON.stringify(devices));
  cset(DEVICES_KEY, devices); // covers upsertDevice / deleteDevice / /api/register
}

export async function getDevice(env: Env, name: string): Promise<Device | null> {
  const devs = await listDevices(env);
  return devs.find((d) => d.name === name) || null;
}

export async function upsertDevice(env: Env, device: Device): Promise<Device> {
  // Serialized RMW: two concurrent writes used to both read [] and the
  // second save clobbered the first's device (registry loss → proxy 404).
  return withKeyLock(DEVICES_KEY, async () => {
    const devs = await readDevicesRaw(env);
    const i = devs.findIndex((d) => d.name === device.name);
    if (i >= 0) {
      // round-106: an admin edit REPLACED the whole record and wiped
      // proxySecret — /panel/ token injection broke permanently until
      // re-registration. Preserve the secret unless the caller sets one.
      if (!device.proxySecret && devs[i]!.proxySecret) {
        device = { ...device, proxySecret: devs[i]!.proxySecret };
      }
      devs[i] = device;
    } else {
      devs.push(device);
    }
    await saveDevices(env, devs);
    return device;
  });
}

/** Insert a device ONLY if the name is not already registered (round-122:
 *  /api/register's getDevice→409 guard was check-then-act — two concurrent
 *  same-name registrations both passed and the serialized upserts ended with
 *  the second party's hostname/token pointing at the name (device takeover,
 *  the exact round-68 hijack). The existence check now runs INSIDE the
 *  DEVICES_KEY critical section. Returns null when the name exists. */
export async function insertDevice(env: Env, device: Device): Promise<Device | null> {
  return withKeyLock(DEVICES_KEY, async () => {
    const devs = await readDevicesRaw(env);
    if (devs.some((d) => d.name === device.name)) return null;
    devs.push(device);
    await saveDevices(env, devs);
    return device;
  });
}

export async function deleteDevice(env: Env, name: string): Promise<boolean> {
  return withKeyLock(DEVICES_KEY, async () => {
    const devs = await readDevicesRaw(env);
    const out = devs.filter((d) => d.name !== name);
    await saveDevices(env, out);
    return out.length !== devs.length;
  });
}

/** Rename a device (and optionally re-hostname it) PRESERVING the token,
 *  proxySecret and metadata — the old flow forced delete + re-add, which
 *  rotated the token and invalidated the device's own config.yaml. Callers
 *  still own the plugin-link migration + hub socket close (see devices.ts
 *  handleDeviceRename). Returns the updated device, or an error string:
 *  "not_found" | "name_taken". */
export async function renameDevice(
  env: Env,
  oldName: string,
  newName: string,
  hostname?: string,
): Promise<Device | "not_found" | "name_taken"> {
  return withKeyLock(DEVICES_KEY, async () => {
    const devs = await readDevicesRaw(env);
    const i = devs.findIndex((d) => d.name === oldName);
    if (i < 0) return "not_found";
    if (devs.some((d, j) => j !== i && d.name === newName)) return "name_taken";
    const updated: Device = {
      ...devs[i]!,
      name: newName,
      ...(hostname ? { hostname } : {}),
    };
    devs[i] = updated;
    await saveDevices(env, devs);
    return updated;
  });
}

/** Bounded-write "last seen" touch from the status probe loop. The probe
 *  runs every 30s per device — writing KV per poll would burn the daily
 *  write quota (round-102 discipline), so the record is written ONLY when
 *  the agent version changed or the last write is over an hour old. The
 *  cheap cached-list check short-circuits before any lock or raw KV read. */
const SEEN_WRITE_INTERVAL_MS = 60 * 60 * 1000;

export async function touchDeviceSeen(env: Env, name: string, version?: string): Promise<void> {
  const devs = await listDevices(env); // cached read — no KV cost when warm
  const d = devs.find((x) => x.name === name);
  if (!d) return;
  const now = Date.now();
  const versionChanged = !!version && version !== d.lastVersion;
  const staleSeen = !d.lastSeenAt || now - d.lastSeenAt > SEEN_WRITE_INTERVAL_MS;
  if (!versionChanged && !staleSeen) return;
  await withKeyLock(DEVICES_KEY, async () => {
    const raw = await readDevicesRaw(env);
    const i = raw.findIndex((x) => x.name === name);
    if (i < 0) return;
    raw[i] = { ...raw[i]!, lastSeenAt: now, ...(version ? { lastVersion: version } : {}) };
    await saveDevices(env, raw);
  });
}

/* ---- Device registration keys ----
 *
 * One-time keys the admin generates in the console and pastes into the Windows
 * install ($env:VALE_REG_KEY). The install script calls POST /api/register with
 * the key + the device's {name, hostname, token}, so a device appears in the
 * console without copying the token by hand. regkey:<code> → "1".
 *
 * Keys expire after 1h and are SPENT at their first authenticated use. The
 * tunnel-token endpoint consumes the key (it hands back the account-level
 * Cloudflare API token, so it must not be harvestable repeatedly) and issues
 * a short-lived grant; /api/register accepts either the live key or the
 * grant, so a real install (tunnel-token → register) completes on one key.
 */

const REGKEY_TTL = 60 * 60; // 1h — bounded window for a leaked key
const REGGRANT_TTL = 15 * 60; // 15 min — same-install register handoff

export async function createRegKey(env: Env): Promise<string> {
  const code = randomHex(8).toLowerCase();
  if (env.KEYS) await env.KEYS.put(`regkey:${code}`, "1", { expirationTtl: REGKEY_TTL });
  return code;
}

export async function hasRegKey(env: Env, code: string): Promise<boolean> {
  if (!env.KEYS || !code) return false;
  return !!(await env.KEYS.get(`regkey:${String(code).toLowerCase()}`));
}

export async function hasRegGrant(env: Env, code: string): Promise<boolean> {
  if (!env.KEYS || !code) return false;
  return !!(await env.KEYS.get(`reggrant:${String(code).toLowerCase()}`));
}

export async function deleteRegKey(env: Env, code: string): Promise<void> {
  if (!env.KEYS || !code) return;
  await env.KEYS.delete(`regkey:${String(code).toLowerCase()}`);
}

export async function deleteRegGrant(env: Env, code: string): Promise<void> {
  if (!env.KEYS || !code) return;
  await env.KEYS.delete(`reggrant:${String(code).toLowerCase()}`);
}

/// Spend a registration key: delete it and issue a short-lived grant so the
/// same install can still complete /api/register.
export async function consumeRegKey(env: Env, code: string): Promise<void> {
  const k = String(code).toLowerCase();
  if (!env.KEYS || !k) return;
  await env.KEYS.delete(`regkey:${k}`);
  await env.KEYS.put(`reggrant:${k}`, "1", { expirationTtl: REGGRANT_TTL });
}

/// List outstanding (unused) registration keys with their remaining TTL.
/// Admin-triggered and rare, so the KV list operation is acceptable; the
/// alternative (mirroring keys into a second KV record) doubles the write
/// cost of every key generation for no real gain.
export async function listRegKeys(env: Env): Promise<{ code: string; expiresAt: number }[]> {
  if (!env.KEYS) return [];
  const res = await env.KEYS.list({ prefix: "regkey:" });
  // KV list() keeps returning the NAMES of expired-but-not-yet-reaped keys
  // (value gone, entry visible until compaction) — the devices page showed a
  // pile of dead "unused keys". Filter to genuinely live ones.
  const now = Date.now();
  return (res.keys as { name: string; expiration?: number }[])
    .map((k) => ({
      code: k.name.slice("regkey:".length),
      expiresAt: (k.expiration || 0) * 1000,
    }))
    .filter((k) => k.expiresAt > now);
}

/* ---------------- Plugin (extension) registry ----------------
 *
 * plugins:v1 → JSON map token → { device, createdAt }. The browser extension
 * on a device's Chrome pairs via a one-time code (pair:<code>, 10min TTL),
 * receives a plugin token, and trades it for one-time WS tickets
 * (plg-ticket:<t>, 60s TTL) when connecting to the PluginHubDO.
 */

const PLUGIN_KEY = "plugins:v1";

export async function listPluginLinks(env: Env): Promise<Record<string, PluginLink>> {
  // Cached like every other KV read (round-55): the WS ticket path used to
  // read + parse the whole plugin table on EVERY ticket — the same pattern
  // devices:v1 follows (24h write-through cache).
  const cached = cget(PLUGIN_KEY);
  if (cached !== undefined) return cached;
  const raw = await env.KEYS.get(PLUGIN_KEY);
  let map: Record<string, PluginLink> = {};
  if (raw) {
    try {
      map = JSON.parse(raw);
    } catch {
      map = {};
    }
  }
  cset(PLUGIN_KEY, map);
  return map;
}
export async function savePluginLinks(env: Env, map: Record<string, PluginLink>): Promise<void> {
  await env.KEYS.put(PLUGIN_KEY, JSON.stringify(map));
  cset(PLUGIN_KEY, map); // write-through — same-isolate reads stay fresh
}
// Plugin links expire after PLUGIN_LINK_TTL_MS (30 days) — a leaked extension
// token must not grant permanent remote control of a device's browser
// (chrome.debugger can read/write/click/type on any tab).
export const PLUGIN_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function addPluginLink(env: Env, token: string, device: string): Promise<void> {
  return withKeyLock(PLUGIN_KEY, async () => {
    const map = await listPluginLinks(env);
    map[token] = { device, createdAt: Date.now(), expiresAt: Date.now() + PLUGIN_LINK_TTL_MS };
    await savePluginLinks(env, map);
  });
}
export async function getPluginByToken(env: Env, token: string): Promise<PluginLink | null> {
  const map = await listPluginLinks(env);
  const link = map[token] || null;
  if (!link) return null;
  // round-122: a MISSING expiresAt is treated as expired — links created
  // before the 30-day TTL feature shipped ({device, createdAt} only) were
  // never expiring, granting permanent browser_* control (the exact hole
  // the TTL exists to close). One-time sweep on read.
  if (!link.expiresAt || link.expiresAt < Date.now()) {
    // Expired — drop it (lazy cleanup) and treat as unknown.
    delete map[token];
    await savePluginLinks(env, map);
    return null;
  }
  return link;
}
export async function removePluginLink(env: Env, token: string): Promise<void> {
  return withKeyLock(PLUGIN_KEY, async () => {
    const map = await listPluginLinks(env);
    if (map[token]) {
      delete map[token];
      await savePluginLinks(env, map);
    }
  });
}

// One-time pairing code (console admin generates; extension claims).
export async function createPairCode(env: Env, device: string): Promise<string> {
  const code = randomHex(6).toUpperCase();
  await env.KEYS.put(`pair:${code}`, device, { expirationTtl: 600 });
  return code;
}
export async function consumePairCode(env: Env, code: string): Promise<string | null> {
  const device = await env.KEYS.get(`pair:${code}`);
  if (!device) return null;
  await env.KEYS.delete(`pair:${code}`);
  return device;
}

// One-time short-lived WS ticket (extension trades its plugin token for this).
export async function createWsTicket(env: Env, device: string): Promise<string> {
  const ticket = randomHex(16);
  await env.KEYS.put(`plg-ticket:${ticket}`, device, { expirationTtl: 60 });
  return ticket;
}
export async function consumeWsTicket(env: Env, ticket: string): Promise<string | null> {
  const device = await env.KEYS.get(`plg-ticket:${ticket}`);
  if (!device) return null;
  await env.KEYS.delete(`plg-ticket:${ticket}`);
  return device;
}

/* ---- Cloudflare tunnel API token (account-level, admin-managed) ----
 *
 * cf:api_token — the API token used by the Windows install to set up the
 * Cloudflare tunnel (Tunnel:Edit + Zone:DNS:Edit). Stored here so the install
 * can fetch it with a registration key instead of the user pasting it on the
 * machine. Account-level credential: admin-only read/write in the console.
 */

export async function getCfToken(env: Env): Promise<string> {
  const key = "cf:api_token";
  const hit = cget(key);
  if (hit !== undefined) return hit;
  const v = (env.KEYS ? await env.KEYS.get(key) : null) || "";
  cset(key, v);
  return v;
}

export async function setCfToken(env: Env, value: string): Promise<string> {
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

export function maskKey(v: string): string {
  if (!v) return "not configured";
  if (v.length <= 6) return v[0] + "…" + v.slice(-2);
  return v.slice(0, 3) + "…" + v.slice(-4);
}
