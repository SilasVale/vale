/**
 * Vale gateway plugin registry — DSH/Cordis-style plugin core.
 *
 * Re-exports types from ./types.ts for backward compatibility.
 * New code should import from ./types.ts directly.
 *
 * A plugin is `{ name, deps: [], setup(ctx) }`. setup() registers routes and
 * api entries on the shared context; deps are resolved before setup runs so
 * a plugin can call `ctx.api.<dep>` during its own setup. The whole gateway
 * routes through this registry — index.ts becomes a thin bootstrap that
 * builds the context, registers the plugin list, and dispatches.
 *
 * Environment: Cloudflare Workers (JS/TS only). This module is dependency-
 * free — the same shape works in the browser (panel) and the extension.
 */

// Re-export all types from the types module for backward compatibility
export type {
  PluginEnv,
  PluginHelpers,
  PluginRoute,
  PluginListener,
  PluginContext,
  Plugin,
  PluginState,
  PluginContainer,
} from "./types.ts";

// Re-export container
export { createContainer } from "./container.ts";

// Re-export built-in plugins
export { sourceViewerPlugin } from "./built-in/source-viewer.ts";

/**
 * Build the shared plugin context. `env` is the Workers env (bindings),
 * `helpers` the cross-cutting utilities.
 */
import type {
  PluginEnv,
  PluginHelpers,
  PluginContext,
  PluginListener,
  PluginRoute,
  Plugin,
} from "./types.ts";

export function createPluginContext(env: PluginEnv | null, helpers: PluginHelpers): PluginContext {
  // Build a minimal container for backward compatibility
  const routes: PluginRoute[] = [];
  const ctx: PluginContext = {
    env,
    helpers,
    routes,
    api: {},
    config: {},
    events: new Map(),
    container: {
      register: () => {},
      start: async () => {},
      dispose: async () => {},
      dispatch: () => null as any,
      getState: () => "pending",
      hotReload: async () => {},
    },
  };
  return ctx;
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
