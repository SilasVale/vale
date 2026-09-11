/**
 * model-route — per-user auto-model resolution (structure refactor: extracted
 * verbatim from plugins/translate.ts). translate.ts re-exports these so the
 * existing consumers keep their import paths: src/index.ts's `export {
 * resolveAutoModel, isModelUsable }`, auth.ts's cross-plugin
 * `ctx.api.translate.resolveAutoModel`, and health.test.mjs's direct import.
 */

import { MODELS } from "../channels.ts";
import { getUserKeys, getUserRoute } from "../store.ts";
import { isChannelDegraded } from "../reliability.ts";

/** Model usable for routing? In the whitelist, (og) breaker not open, AND
 *  the REQUESTING user's key for that channel is configured — a channel
 *  without a key 502s every request, so model=auto must not route to it.
 *  round-68: the old code checked ADMIN_ID's keys — a BYOK user with only an
 *  og key was told og was "unusable" (the admin lacks it) and routed to ds,
 *  which the user lacks → 502 on every model=auto request. */

// SOLID Round-26 (OCP): per-channel key rules are DATA — adding a channel
// registers one entry instead of appending another if-line (nv/gmi/cm/amd
// each arrived as a new line). userKey is always required; envKey null
// means pure BYOK (the /v1 handler reads ONLY the user's key blob there).
export interface ChannelKeyRule {
  userKey: string;
  envKey: string | null;
}

export const CHANNEL_KEY_RULES: Record<string, ChannelKeyRule> = {
  og: { userKey: "OPENCODE_GO_API_KEY", envKey: "OPENCODE_GO_API_KEY" },
  ds: { userKey: "DEEPSEEK_API_KEY", envKey: "DEEPSEEK_API_KEY" },
  qw: { userKey: "QWEN_API_KEY", envKey: "QWEN_API_KEY" },
  or: { userKey: "OPENROUTER_API_KEY", envKey: "OPENROUTER_API_KEY" },
  nv: { userKey: "NVAPI_KEY", envKey: null },
  gmi: { userKey: "GMI_API_KEY", envKey: null },
  cm: { userKey: "CMD_API_KEY", envKey: "CMD_API_KEY" },
  amd: { userKey: "AMD_API_KEY", envKey: "AMD_API_KEY" },
};

/** OCP extension point: new channels register here — no edit to isModelUsable. */
export function registerChannelKey(prefix: string, rule: ChannelKeyRule): void {
  CHANNEL_KEY_RULES[prefix] = rule;
}

export async function isModelUsable(env: any, model: string, uid: string): Promise<boolean> {
  if (!MODELS.some((m) => m.id === model)) return false;
  const userKeys: any = await getUserKeys(env, uid).catch(() => ({}));
  const key = model.split("/")[0] || "";
  const rule = Object.prototype.hasOwnProperty.call(CHANNEL_KEY_RULES, key)
    ? (CHANNEL_KEY_RULES[key] as ChannelKeyRule)
    : null;
  if (rule) {
    // nv/gmi carry envKey null (pure BYOK — the /v1 handler reads ONLY the
    // user's key blob, so a missing user key means every request 502s);
    // every other channel also honors its env-level key.
    const hasUser = !!userKeys[rule.userKey];
    const hasEnv = rule.envKey ? !!env[rule.envKey] : false;
    if (!hasUser && !hasEnv) return false;
  }
  if (model.startsWith("og/")) return !(await isChannelDegraded(env));
  return true;
}

// Default channel when the user hasn't made a selection. 2026-09-10 (V4
// retirement): this used to be ds/deepseek-v4-flash — the official key is now
// out of balance (402 on every request) and its V4 names are retired, so the
// default moved to Command Code's V4.1 Flash, the model the whole catalog
// standardised on (and the one the console's health badge recommends).
export const DEFAULT_ROUTE_MODEL = "cm/deepseek/deepseek-v4.1-flash";

/** The fallback ladder for `auto`, in PRIORITY ORDER.
 *
 * Exported so the registry can check it (SOLID R121). The ORDER here is the
 * meaning — the default channel first, then alternatives — so this is NOT
 * derived from MODELS the way ROUTE_INFO's per-route lists are. What it must
 * be is SUBSET of the catalogue: a ladder entry that is not advertised (a
 * typo, or a model removed from the catalogue) would be a fallback that can
 * never satisfy `isModelUsable`, and the ladder would skip it in silence. */
export const AUTO_FALLBACK_LADDER: string[] = [
  DEFAULT_ROUTE_MODEL,
  "qw/qwen3.8-max-preview",
  "qw/qwen3.8-flash",
  "og/deepseek-v4.1-flash",
  "or/openai/gpt-5.6-luna:floor[1m]",
];

/**
 * Resolve Claude Code's fixed `auto` model name to this user's chosen
 * channel (per-user route selection). Falls back to the default channel
 * (cm/deepseek/deepseek-v4.1-flash) when unset or unusable.
 */
export async function resolveAutoModel(env: any, uid: string): Promise<string> {
  const chosen = await getUserRoute(env, uid);
  if (chosen && (await isModelUsable(env, chosen, uid))) return chosen;
  // round-100: this plugin IS the live /v1 path (R99 made handleGateway
  // dispatch plugins first) — the usable-fallback fix landed only in the
  // now-unreachable index.ts copy, so a BYOK user without a DeepSeek key
  // still got a guaranteed 502 on model=auto. Fall back to the first
  // usable channel.
  for (const m of AUTO_FALLBACK_LADDER) {
    if (await isModelUsable(env, m, uid)) return m;
  }
  return DEFAULT_ROUTE_MODEL;
}
