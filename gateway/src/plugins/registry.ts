/**
 * Vale gateway plugin registry — DSH/Cordis-style plugin core.
 *
 * A plugin is `{ name, deps: [], setup(ctx) }`. setup() registers routes and
 * api entries on the shared context; deps are resolved by registration order,
 * so a plugin can call `ctx.api.<dep>` during its own setup (e.g. auth reads
 * translate's resolveAutoModel). The whole gateway routes through this
 * registry — index.ts is a thin bootstrap that builds the context, registers
 * the plugin list, and dispatches.
 *
 * Environment: Cloudflare Workers (JS/TS only). This module is dependency-
 * free — the same shape works in the browser (panel) and the extension.
 *
 * (The parallel container.ts/types.ts "lifecycle" implementation was removed:
 * it was never wired in — its dispatch was a placeholder returning null — and
 * the duplicated PluginContext type let plugins drift between two contracts.)
 *
 * DIRECTORY CONTRACT (layering review 2026-09-06): plugins/ holds (1) the
 * route plugins themselves, (2) this framework, and (3) each plugin's
 * EXCLUSIVE collaborator modules — device-proxy.ts (devices only),
 * translate-vision.ts + model-route.ts (translate only). A module with two
 * live consumers is NOT a private collaborator: it belongs in src/ as
 * foundation. Currently every collaborator has exactly one consumer, which
 * is what keeps them here; revisit on the first second consumer.
 */

/** Workers env bindings — the shape we touch (typed loosely; full bindings live in wrangler config). */
export type PluginEnv = Record<string, any>;

/** Response helpers the plugins share (jsonOk/jsonError/readJson/CORS). */
export interface PluginHelpers {
  jsonOk: (body: any, headers?: Record<string, string>) => Response;
  jsonError: (status: number, message: string, code?: string) => Response;
  readJson: (request: Request) => Promise<any>;
  CORS_HEADERS: Record<string, string>;
}

/** A registered route: match() decides whether the handler serves it. */
export interface PluginRoute {
  match: (method: string, path: string) => boolean;
  handler: (...args: any[]) => any;
}

/** Cross-plugin event emitter (fire-and-forget listeners). */
export type PluginListener = (payload: unknown) => void | Promise<void>;

/** The shared context injected into every plugin's setup(). */
export interface PluginContext {
  /** Cloudflare Workers env bindings (null while bootstrapping). */
  env: PluginEnv | null;
  /** Cross-cutting utilities (jsonOk, jsonError, readJson, CORS). */
  helpers: PluginHelpers;
  /** Registered routes (first-match wins). */
  routes: PluginRoute[];
  /** Named capabilities plugins expose to each other (ctx.api.<dep>). */
  api: Record<string, unknown>;
  /** Plugin-configurable values (writable in setup). */
  config: Record<string, unknown>;
  /** Cross-plugin event bus. */
  events: Map<string, Set<PluginListener>>;
}

/** A plugin: declared deps + setup that registers routes/api on the ctx. */
export interface Plugin {
  name: string;
  deps?: string[];
  setup: (ctx: PluginContext) => void | Promise<void>;
}

/**
 * Build the shared plugin context. `env` is the Workers env (bindings),
 * `helpers` the cross-cutting utilities.
 */
export function createPluginContext(env: PluginEnv | null, helpers: PluginHelpers): PluginContext {
  return {
    env,
    helpers,
    routes: [],
    api: {},
    config: {},
    events: new Map(),
  };
}

/** Register plugins in dependency order. Each plugin's `deps` names must be
 *  provided by another plugin in the same list; a stable topological sort
 *  runs first so a plugin's setup() ALWAYS sees its declared deps already
 *  registered on ctx.api (e.g. auth's ctx.api.translate). The historical
 *  contract was "registration order = dependency order" — an implicit,
 *  unenforced convention that silently broke when the caller's array order
 *  drifted (auth was listed before translate, so its setup read
 *  ctx.api.translate as undefined and `/api/me/route`'s effective model
 *  permanently degraded to the raw stored route). Route dispatch order is
 *  preserved EXCEPT that a dependency now always precedes its consumers;
 *  same-level plugins keep their caller-array relative order (stable).
 *  A dep name that is in no provided plugin is tolerated (external source);
 *  a genuine dependency CYCLE throws — fail loudly instead of silently
 *  degrading setup. */
export function registerPlugins(ctx: PluginContext, plugins: Plugin[]): void {
  const byName = new Map<string, Plugin>();
  for (const p of plugins) if (p?.name) byName.set(p.name, p);
  const done = new Set<string>();
  let remaining = plugins.filter((p) => p && typeof p.setup === "function");
  // Upper bound: at most remaining.length passes can emit; extra passes
  // mean a no-progress pass (cycle). length² + length + 1 is a strict bound
  // on the loop's total iterations.
  let guard = remaining.length * remaining.length + remaining.length + 1;
  while (remaining.length > 0) {
    if (--guard <= 0) {
      const names = remaining.map((p) => p?.name || "(unnamed)").join(", ");
      throw new Error(
        `plugin dependency cycle among: ${names} (deps resolve only against plugins in the same list)`,
      );
    }
    const next: Plugin[] = [];
    for (const p of remaining) {
      const unmet = (p.deps || []).filter(
        (d) => byName.has(d) && !done.has(d), // absent-from-list deps are tolerated
      );
      if (unmet.length > 0) {
        next.push(p);
        continue;
      }
      p.setup(ctx);
      if (p.name) done.add(p.name);
    }
    remaining = next;
  }
}

/** Route dispatch: first registered plugin whose match() returns true wins. */
export function dispatch(
  ctx: PluginContext,
  method: string,
  path: string,
  ...rest: unknown[]
): any {
  for (const r of ctx.routes) {
    if (r.match(method, path)) return r.handler.apply(null, rest as any[]);
  }
  return null;
}

/** Convenience: register a prefix-matched route on the context. */
export function route(
  ctx: PluginContext,
  methods: string | string[],
  pathPrefix: string,
  handler: (...args: any[]) => any,
): void {
  const ms = Array.isArray(methods) ? methods : [methods];
  ctx.routes.push({
    match: (m, p) => ms.includes(m) && p.startsWith(pathPrefix),
    handler,
  });
}

/** Emit a cross-plugin event (fire-and-forget; listeners may be async). */
export function emit(ctx: PluginContext, name: string, payload: unknown): void {
  const listeners = ctx.events.get(name);
  if (!listeners) return;
  for (const fn of listeners) {
    try {
      Promise.resolve(fn(payload)).catch(() => {});
    } catch {
      /* listener error */
    }
  }
}

/** Subscribe to a cross-plugin event. Returns an unsubscribe fn. */
export function on(ctx: PluginContext, name: string, fn: PluginListener): () => void {
  if (!ctx.events.has(name)) ctx.events.set(name, new Set());
  ctx.events.get(name)!.add(fn);
  return () => ctx.events.get(name)?.delete(fn);
}
