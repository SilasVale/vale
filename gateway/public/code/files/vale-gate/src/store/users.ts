/**
 * store/users.ts — user accounts, gateway tokens, per-user backend keys,
 * per-user route selection (RouteDO), invites, and key masking.
 */

import { hashPassword, randomHex } from "../auth.ts";
import { cdel, cget, cset, withKeyLock, type Env } from "./cache.ts";

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
  // AMD Radeon Cloud (developer.amd.com.cn/radeon) — free BYOK pool, the key
  // is the "rc-…" token from the Radeon developer console.
  "AMD_API_KEY",
];

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

/// Locked read-modify-write of a user's key map: load under the per-user
/// key lock, apply `mutate`, persist to KV and refresh the cache. setUserKey
/// and deleteUserKey used to each inline this skeleton.
async function updateUserKeys(
  env: Env,
  id: string,
  mutate: (ukeys: Record<string, any>) => void,
): Promise<Record<string, any>> {
  return withKeyLock(`ukeys:${id}`, async () => {
    const ukeys = (await getJSON(env, `ukeys:${id}`)) || {};
    mutate(ukeys);
    await env.KEYS.put(`ukeys:${id}`, JSON.stringify(ukeys));
    cset(`ukeys:${id}`, ukeys);
    return ukeys;
  });
}

export async function setUserKey(
  env: Env,
  id: string,
  name: string,
  value: string,
): Promise<Record<string, any>> {
  return updateUserKeys(env, id, (ukeys) => {
    ukeys[name] = String(value).trim();
  });
}

export async function deleteUserKey(
  env: Env,
  id: string,
  name: string,
): Promise<Record<string, any>> {
  return updateUserKeys(env, id, (ukeys) => {
    delete ukeys[name];
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
// Attach the DO shared secret when configured (RouteDO now enforces it).
function routeHeaders(env: any, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (env.DO_AUTH) h["x-do-auth"] = env.DO_AUTH;
  return h;
}

export async function getUserRoute(env: Env, id: string): Promise<string | null> {
  // RouteDO answers 401 PLAIN TEXT when DO_AUTH is unset/mismatched (so a
  // bare res.json() throws SyntaxError), and the stub throws outright when
  // the ROUTE binding is missing — either way fall back to the legacy KV key
  // instead of throwing at callers that only handle null (resolveAutoModel).
  let doReachable = false;
  try {
    const res = await routeStub(env).fetch(`https://route/route?uid=${encodeURIComponent(id)}`, {
      headers: routeHeaders(env),
    });
    if (res.ok) {
      doReachable = true;
      const data: any = await res.json().catch(() => null);
      if (data && data.model != null) return data.model;
    }
  } catch {
    /* DO unavailable — legacy KV fallback below */
  }
  // Legacy KV fallback (one-time migration).
  const legacy = env.KEYS ? await env.KEYS.get(`route:${id}`) : null;
  if (legacy) {
    // Migrate into the DO only while it is reachable — otherwise the
    // copy-back + KV delete below would drop the only surviving copy.
    if (doReachable) {
      await setUserRoute(env, id, legacy).catch(() => {});
      await env.KEYS.delete(`route:${id}`).catch(() => {});
    }
    return legacy;
  }
  return null;
}

export async function setUserRoute(
  env: Env,
  id: string,
  model: string | null | undefined,
): Promise<void> {
  // Same DO-unavailable cases as getUserRoute: never throw a bare fetch /
  // SyntaxError at console callers — persist to the legacy KV key so the
  // choice survives and migrates into the DO on the next reachable read.
  try {
    if (model === null || model === undefined || model === "") {
      const res = await routeStub(env).fetch(`https://route/route?uid=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: routeHeaders(env),
      });
      if (res.ok) return;
    } else {
      const res = await routeStub(env).fetch("https://route/route", {
        method: "PUT",
        headers: routeHeaders(env, { "content-type": "application/json" }),
        body: JSON.stringify({ uid: id, model: String(model) }),
      });
      if (res.ok) return;
    }
  } catch {
    /* DO unavailable — legacy KV fallback below */
  }
  if (!env.KEYS)
    throw new Error("config_error: route store unavailable (RouteDO unreachable, no KV)");
  if (model === null || model === undefined || model === "") {
    await env.KEYS.delete(`route:${id}`);
  } else {
    await env.KEYS.put(`route:${id}`, String(model));
  }
}

/* ---- Invites ---- */

export async function createInvite(env: Env): Promise<string> {
  const code = randomHex(5).toUpperCase();
  // 7-day TTL: an invite shared in chat must not stay valid forever.
  await env.KEYS.put(`invite:${code}`, "1", { expirationTtl: 7 * 24 * 60 * 60 });
  return code;
}

/* ---- Masking ---- */

export function maskKey(v: string): string {
  if (!v) return "not configured";
  if (v.length <= 6) return v[0] + "…" + v.slice(-2);
  return v.slice(0, 3) + "…" + v.slice(-4);
}

/** Per-key configured/masked status for the console (shared by the auth
 *  plugin's /api/me and the admin plugin's user list — was copy-pasted in
 *  both with subtly different types). */
export function userKeysStatus(
  ukeys: Record<string, any>,
): Record<string, { configured: boolean; masked: string }> {
  const out: Record<string, { configured: boolean; masked: string }> = {};
  for (const n of USER_KEY_NAMES) {
    const v = ukeys?.[n];
    out[n] = { configured: !!v, masked: maskKey(v || "") };
  }
  return out;
}
