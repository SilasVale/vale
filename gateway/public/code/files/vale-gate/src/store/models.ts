/**
 * store/models.ts — the model catalogue as DATA, not compiled code.
 *
 * WHY THIS EXISTS. Until now the catalogue was `MODEL_REGISTRY` in
 * `src/channels.ts`: a TypeScript constant, so adding or retiring a model meant
 * editing source, rebuilding and redeploying the worker. DSH — the harness this
 * gateway serves — does it by editing `~/.dsh/settings.yaml` and restarting: a
 * CONFIG FILE, no rebuild. That is the real difference, and it is the one worth
 * closing. (DSH has no "add model" UI either; it has no runtime catalogue API at
 * all. The advantage is data-vs-code, not a screen.)
 *
 * TWO THINGS ARE STORED HERE, both in the KEYS namespace:
 *
 *   models:custom    ModelSpec[]  — models added from the console
 *   models:disabled  string[]     — BUILT-IN ids switched off from the console
 *
 * WHY DISABLING IS SEPARATE FROM DELETING. A built-in record carries six facets
 * (advertised id, wire slug, US-egress policy, web-search capability, health
 * card, vision) that no form should have to re-derive — and a record DELETED
 * from KV could not be brought back. Disabling keeps the record and its facets
 * and simply stops advertising and routing it, which is what "retire this model"
 * actually means. Deleting is for models this store owns.
 *
 * WHAT A CUSTOM MODEL INHERITS. A new record names its CHANNEL by prefix, and
 * inherits `ownedBy` from it. `wire` stays unset unless the admin supplies one,
 * because a wire slug on a non-`og/` prefix is silently ignored by
 * `wireModelName` — a trap `channels.ts` pins in a comment. Everything else
 * defaults to the conservative value.
 */
import { cget, cset, cdel, type Env } from "./cache.ts";
import { MODEL_REGISTRY, ROUTE_INFO, type ModelSpec } from "../channels.ts";

const CUSTOM_KEY = "models:custom";
const DISABLED_KEY = "models:disabled";

/** Read a JSON array from KV, tolerating anything malformed — a catalogue that
 *  cannot be parsed must degrade to "nothing extra", never to a 500 that takes
 *  the whole gateway down. */
async function readList<T>(env: Env, key: string): Promise<T[]> {
  const hit = cget(key);
  if (hit !== undefined) return Array.isArray(hit) ? (hit as T[]) : [];
  let out: T[] = [];
  try {
    const raw = await env.KEYS.get(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out = parsed as T[];
    }
  } catch {
    // Malformed or unreadable: no custom entries. Deliberately silent to the
    // CALLER, but not to the operator — the console shows what it can serve.
  }
  cset(key, out);
  return out;
}

async function writeList(env: Env, key: string, value: unknown[]): Promise<void> {
  await env.KEYS.put(key, JSON.stringify(value));
  cset(key, value);
}

/** Built-in ids switched off from the console. */
export async function disabledModels(env: Env): Promise<Set<string>> {
  return new Set(await readList<string>(env, DISABLED_KEY));
}

/** Models added from the console. */
export async function customModels(env: Env): Promise<ModelSpec[]> {
  return readList<ModelSpec>(env, CUSTOM_KEY);
}

/** Every id the gateway currently advertises — built-ins minus disabled, plus custom. */
export async function advertisedIds(env: Env): Promise<string[]> {
  const off = await disabledModels(env);
  const custom = await customModels(env);
  return [
    ...MODEL_REGISTRY.filter((m) => !off.has(m.id)).map((m) => m.id),
    ...custom.map((m) => m.id),
  ];
}

/** Is this id advertised right now? The gate for BOTH setting a route and using one. */
export async function isAdvertised(env: Env, id: string): Promise<boolean> {
  return (await advertisedIds(env)).includes(id);
}

/**
 * The catalogue as the console and `/api/admin/public` need it: the static routes
 * with their per-channel model lists filtered, plus one synthetic entry per
 * prefix that only custom models use.
 */
export async function catalogue(env: Env): Promise<{
  models: string[];
  routes: { prefix: string; backend: string; desc: string; models: string[] }[];
}> {
  const custom = await customModels(env);
  const ids = await advertisedIds(env);

  /**
   * THE BARE-vs-PREFIXED TRAP, again — and this time it is handled once, here.
   *
   * `ROUTE_INFO[].models` holds BARE names ("mimo-v2.5") while the disabled set
   * holds FULL advertised ids ("og/mimo-v2.5"). Comparing them directly matches
   * nothing, which is the same mismatch that made the console's Models page set the
   * wrong channel (round 58) and left its default card permanently empty (round 65).
   * The full id of a bare entry is its prefix + the entry; `"none"` is the server's
   * sentinel for unprefixed names and keeps them bare.
   */
  const fullId = (prefix: string, bare: string) => (prefix === "none" ? bare : prefix + bare);

  const routes = ROUTE_INFO.map((r) => ({
    ...r,
    models: r.models.filter((bare) => {
      const id = fullId(r.prefix, bare);
      // Gone from the advertised set for ANY reason — disabled, or replaced by a
      // custom record of the same id — means gone from this channel's list too.
      return ids.includes(id) && !custom.some((c) => c.id === id);
    }),
  }));

  // A custom model on a prefix with no static route still needs somewhere to appear,
  // or the gateway would advertise an id under no channel at all.
  for (const c of custom) {
    const cut = c.id.indexOf("/");
    const prefix = cut > 0 ? c.id.slice(0, cut + 1) : "none";
    const bare = cut > 0 ? c.id.slice(cut + 1) : c.id;
    const existing = routes.find((r) => r.prefix === prefix);
    if (existing) {
      if (!existing.models.includes(bare)) existing.models.push(bare);
    } else {
      routes.push({
        prefix,
        backend: prefix === "none" ? "Command Code (default)" : prefix,
        desc: "Added from the console.",
        models: [bare],
      });
    }
  }

  return { models: ids, routes };
}

/** Switch a BUILT-IN model off (or back on). Custom models are deleted, not disabled. */
export async function setModelDisabled(env: Env, id: string, disabled: boolean): Promise<string[]> {
  const cur = await disabledModels(env);
  if (disabled) cur.add(id);
  else cur.delete(id);
  const next = [...cur].sort();
  await writeList(env, DISABLED_KEY, next);
  return next;
}

/** Add (or replace) a model the console owns. */
export async function putCustomModel(env: Env, spec: ModelSpec): Promise<ModelSpec[]> {
  const cur = await customModels(env);
  const next = [...cur.filter((m) => m.id !== spec.id), spec];
  await writeList(env, CUSTOM_KEY, next);
  return next;
}

/** Remove a model this store owns. Returns false when the id is not custom. */
export async function deleteCustomModel(env: Env, id: string): Promise<boolean> {
  const cur = await customModels(env);
  const next = cur.filter((m) => m.id !== id);
  if (next.length === cur.length) return false;
  await writeList(env, CUSTOM_KEY, next);
  return true;
}

/** Where a model comes from — the console needs this to offer the right action. */
export function isBuiltIn(id: string): boolean {
  return MODEL_REGISTRY.some((m) => m.id === id);
}

/** Forget the per-isolate cache (tests, and any explicit resync). */
export function dropModelCache(): void {
  cdel(CUSTOM_KEY, DISABLED_KEY);
}
