/**
 * store/plugins.ts — plugin (extension) link registry (plugins:v1).
 */

import { cget, cset, withKeyLock, type Env } from "./cache.ts";

export interface PluginLink {
  device: string;
  createdAt: number;
  expiresAt: number;
}

/* ---------------- Plugin (extension) registry ----------------
 *
 * plugins:v1 → JSON map token → { device, createdAt }. Device links are
 * revoked on device delete/rename (extension-era pairing removed
 * round-340/345); getPluginByToken still guards the device reverse proxy.
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

/**
 * Fresh KV read of the plugin map INSIDE the caller's withKeyLock, bypassing
 * the isolate cache. Every mutating path (sweep / remove / migrate / revoke-
 * for-device) used to hand-roll the same lock + read + parse prologue; a
 * stale cached blob rewritten inside the lock resurrects links another
 * isolate revoked (the round-122 class). Returns null when the stored blob
 * is corrupt — callers MUST abort without writing (a null treated as {}
 * would delete every link).
 */
async function readFreshPluginLinks(env: Env): Promise<Record<string, PluginLink> | null> {
  const raw = await env.KEYS.get(PLUGIN_KEY);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}
// Plugin links expire after PLUGIN_LINK_TTL_MS (30 days) — a leaked extension
// token must not grant permanent remote control of a device's browser
// (chrome.debugger can read/write/click/type on any tab).
export const PLUGIN_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function getPluginByToken(env: Env, token: string): Promise<PluginLink | null> {
  const map = await listPluginLinks(env);
  const link = map[token] || null;
  if (!link) return null;
  // round-122: a MISSING expiresAt is treated as expired — links created
  // before the 30-day TTL feature shipped ({device, createdAt} only) were
  // never expiring, granting permanent browser_* control (the exact hole
  // the TTL exists to close). One-time sweep on read.
  if (!link.expiresAt || link.expiresAt < Date.now()) {
    // Extension audit L3: this sweep wrote WITHOUT the PLUGIN_KEY lock and
    // from the isolate-cached map — a stale isolate could rewrite its whole
    // outdated blob, RESURRECTING links another isolate had revoked/paired
    // in the cache window. Sweep inside the lock against a FRESH KV read,
    // re-checking expiry before deleting.
    await withKeyLock(PLUGIN_KEY, async () => {
      const fresh = await readFreshPluginLinks(env);
      if (!fresh) return;
      const cand = fresh[token];
      if (cand && (!cand.expiresAt || cand.expiresAt < Date.now())) {
        delete fresh[token];
        await env.KEYS.put(PLUGIN_KEY, JSON.stringify(fresh));
      }
    });
    return null;
  }
  return link;
}
export async function removePluginLink(env: Env, token: string): Promise<void> {
  // Lock + FRESH KV read (not the isolate-cached map): the old code read
  // the cached blob inside the lock and wrote it back whole, resurrecting
  // links another isolate had revoked/paired in the cache window — the
  // same class the getPluginByToken sweep fixed. Same shape below.
  return withKeyLock(PLUGIN_KEY, async () => {
    const fresh = await readFreshPluginLinks(env);
    if (!fresh) return;
    if (fresh[token]) {
      delete fresh[token];
      await env.KEYS.put(PLUGIN_KEY, JSON.stringify(fresh));
      cset(PLUGIN_KEY, fresh);
    }
  });
}

/// Re-point every plugin link from oldName to newName (device rename).
/// Same lock + fresh-read discipline as removePluginLink above.
export async function migratePluginLinks(
  env: Env,
  oldName: string,
  newName: string,
): Promise<boolean> {
  return withKeyLock(PLUGIN_KEY, async () => {
    const fresh = await readFreshPluginLinks(env);
    if (!fresh) return false;
    let migrated = false;
    for (const l of Object.values(fresh)) {
      if (l.device === oldName) {
        l.device = newName;
        migrated = true;
      }
    }
    if (migrated) {
      await env.KEYS.put(PLUGIN_KEY, JSON.stringify(fresh));
      cset(PLUGIN_KEY, fresh);
    }
    return migrated;
  });
}

/// Revoke every plugin link paired to a device (device delete path).
/// Same lock + fresh-read discipline: listing the cached map here can
/// miss links paired by another isolate inside the cache window and
/// leave their 30-day browser control alive after the device is gone.
export async function removePluginLinksForDevice(env: Env, device: string): Promise<number> {
  return withKeyLock(PLUGIN_KEY, async () => {
    const fresh = await readFreshPluginLinks(env);
    if (!fresh) return 0;
    let n = 0;
    for (const [token, l] of Object.entries(fresh)) {
      if (l.device === device) {
        delete fresh[token];
        n++;
      }
    }
    if (n > 0) {
      await env.KEYS.put(PLUGIN_KEY, JSON.stringify(fresh));
      cset(PLUGIN_KEY, fresh);
    }
    return n;
  });
}
