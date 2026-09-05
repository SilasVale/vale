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
export async function isModelUsable(env: any, model: string, uid: string): Promise<boolean> {
  if (!MODELS.some((m) => m.id === model)) return false;
  const userKeys: any = await getUserKeys(env, uid).catch(() => ({}));
  const prefix = model.split("/")[0] + "/";
  if (prefix === "og/" && !(userKeys.OPENCODE_GO_API_KEY || env.OPENCODE_GO_API_KEY)) return false;
  if (prefix === "ds/" && !(userKeys.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY)) return false;
  if (prefix === "qw/" && !(userKeys.QWEN_API_KEY || env.QWEN_API_KEY)) return false;
  if (prefix === "or/" && !(userKeys.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY)) return false;
  // nv/ and gmi/ are pure BYOK — the /v1 handler reads ONLY the user's key
  // blob (no env fallback), so a missing user key means every request 502s.
  if (prefix === "nv/" && !userKeys.NVAPI_KEY) return false;
  if (prefix === "gmi/" && !userKeys.GMI_API_KEY) return false;
  // cm/ — Command Code is pure BYOK too; without a user key every request 502s.
  if (prefix === "cm/" && !(userKeys.CMD_API_KEY || env.CMD_API_KEY)) return false;
  // amd/ — Radeon Cloud free pool, the rc-… key belongs to the user who added
  // it (a missing key 502s; a shared-pool 429 is the upstream's, not a 502).
  if (prefix === "amd/" && !(userKeys.AMD_API_KEY || env.AMD_API_KEY)) return false;
  if (model.startsWith("og/")) return !(await isChannelDegraded(env));
  return true;
}

// Default channel when the user hasn't made a selection: the stable,
// cheapest direct channel (DeepSeek official).
const DEFAULT_ROUTE_MODEL = "ds/deepseek-v4-flash";

/**
 * Resolve Claude Code's fixed `auto` model name to this user's chosen
 * channel (per-user route selection). Falls back to the default channel
 * (ds/deepseek-v4-flash) when unset or unusable.
 */
export async function resolveAutoModel(env: any, uid: string): Promise<string> {
  const chosen = await getUserRoute(env, uid);
  if (chosen && (await isModelUsable(env, chosen, uid))) return chosen;
  // round-100: this plugin IS the live /v1 path (R99 made handleGateway
  // dispatch plugins first) — the usable-fallback fix landed only in the
  // now-unreachable index.ts copy, so a BYOK user without a DeepSeek key
  // still got a guaranteed 502 on model=auto. Fall back to the first
  // usable channel.
  for (const m of [
    DEFAULT_ROUTE_MODEL,
    "qw/qwen3.8-max-preview",
    "qw/qwen3.8-flash",
    "og/deepseek-v4-flash",
    "or/openai/gpt-5.6-luna:floor[1m]",
  ]) {
    if (await isModelUsable(env, m, uid)) return m;
  }
  return DEFAULT_ROUTE_MODEL;
}
