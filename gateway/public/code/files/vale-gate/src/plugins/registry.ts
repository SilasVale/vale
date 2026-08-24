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

/** Register plugins in order; each plugin's setup runs immediately. */
export function registerPlugins(ctx: PluginContext, plugins: Plugin[]): void {
  for (const plugin of plugins) {
    if (!plugin || typeof plugin.setup !== "function") continue;
    plugin.setup(ctx);
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
