/**
 * store/settings.ts — global settings (console-controlled, e.g. the US_PROXY
 * exit switch), stored under `settings:<name>` in KV.
 */

import { cdel, cget, cset, type Env } from "./cache.ts";

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
  // round-439: booleans canonicalize truthfully — the old `s === "1"` arm
  // stored boolean true (String → "true") as "0", silently INVERTING the
  // switch for any caller passing a real boolean. No current caller does
  // (mePutUsproxy maps to "1"/"0"), so this changes no live bytes.
  const canonical = s === "1" || s === "true" || value === true ? "1" : "0";
  await env.KEYS.put(key, canonical);
  cset(key, canonical); // write-through: the switch takes effect immediately (zero delay within the same isolate)
}
