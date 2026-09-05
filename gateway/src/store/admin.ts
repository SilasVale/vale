/**
 * store/admin.ts — admin seeding (process-once) + the hashed admin password.
 *
 * The `seeded` module flag and __resetSeedForTests live HERE and only here:
 * seedAdmin must seed once per process (test/security-fixes.test.mjs's header
 * relies on that semantics), so this module must never be duplicated.
 */

import { hashPassword, randomHex, verifyPassword } from "../auth.ts";
import { cget, cset, type Env } from "./cache.ts";
import { ADMIN_ID, ADMIN_USERNAME, USER_KEY_NAMES, generateGatewayToken } from "./users.ts";

/* ---- Admin seeding ---- */
let seeded = false;
/** Test hook: reset the process-once seed flag so a second seedAdmin call in
 *  the same process really runs (the backfill test heals one env, then must
 *  prove a healthy env is untouched). Never called in production. */
export function __resetSeedForTests(): void {
  seeded = false;
}
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

  const legacyToken = (await env.KEYS.get("CLIENT_KEY")) || env.CLIENT_KEY || "";

  // Empty-token backfill (bricked-deploy migration): deployments seeded
  // BEFORE the mint fix have user:admin with token:"" + _admin_seeded="1" —
  // the early-return below then locks them out FOREVER (bootstrap and
  // reset-password 403 on `!admin?.token`, register/login 500). Heal exactly
  // like fresh: mint + remap. This state is unreachable in healthy
  // deployments (no valid session could ever have existed with an empty
  // token — findUserByToken("") is always null), so no hijack is possible.
  // A record with a NON-empty token is left completely untouched.
  try {
    const existingRaw = await env.KEYS.get(`user:${ADMIN_ID}`);
    if (existingRaw) {
      const existing = JSON.parse(existingRaw);
      if (existing && !existing.token) {
        const adminToken = legacyToken || generateGatewayToken();
        existing.token = adminToken;
        await env.KEYS.put(`user:${ADMIN_ID}`, JSON.stringify(existing));
        cset(`user:${ADMIN_ID}`, existing);
        await env.KEYS.put(`token:${adminToken}`, ADMIN_ID);
        cset(`token:${adminToken}`, ADMIN_ID);
        await env.KEYS.put("_admin_seeded", "1");
      }
    }
  } catch {
    /* a failed backfill must not block startup */
  }

  if (await env.KEYS.get("_admin_seeded")) return;
  // Fresh deploy with no CLIENT_KEY anywhere: mint a random gateway token
  // instead of seeding token:"". An empty token made the admin account
  // unusable — the initial-password bootstrap (PUT /api/admin/password) and
  // POST /api/auth/reset-password both 403 on `!admin?.token`, while
  // register/login 500 with "Admin password not configured": a fresh console
  // with no secrets had NO path to a first session (fresh-deploy lockout).
  // The deployer reads the minted value from KV (`user:admin`) and uses it
  // as the bootstrap adminKey. Existing deployments are untouched (they
  // return early on _admin_seeded above).
  const adminToken = legacyToken || generateGatewayToken();
  const admin = {
    id: ADMIN_ID,
    username: ADMIN_USERNAME,
    role: "admin",
    enabled: true,
    createdAt: Date.now(),
    token: adminToken,
  };
  await env.KEYS.put(`user:${ADMIN_ID}`, JSON.stringify(admin));
  cset(`user:${ADMIN_ID}`, admin);
  await env.KEYS.put(`token:${adminToken}`, ADMIN_ID);
  cset(`token:${adminToken}`, ADMIN_ID);

  const ukeys: Record<string, string> = {};
  for (const n of USER_KEY_NAMES) {
    const v = (await env.KEYS.get(n)) || env[n] || "";
    if (v) ukeys[n] = v;
  }
  await env.KEYS.put(`ukeys:${ADMIN_ID}`, JSON.stringify(ukeys));
  cset(`ukeys:${ADMIN_ID}`, ukeys);
  await env.KEYS.put("_admin_seeded", "1");
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
