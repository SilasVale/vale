/**
 * store/regkeys.ts — one-time device registration keys + short-lived grants.
 */

import { randomHex } from "../auth.ts";
import type { Env } from "./cache.ts";

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
