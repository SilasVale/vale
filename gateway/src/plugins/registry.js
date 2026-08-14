/**
 * Vale gateway plugin registry (round-73) — DSH/Cordis-style plugin core.
 *
 * A plugin is `{ name, deps: [], setup(ctx) }`. setup() registers routes and
 * api entries on the shared context; deps are resolved before setup runs so
 * a plugin can call `ctx.api.<dep>` during its own setup. The whole gateway
 * routes through this registry — index.js becomes a thin bootstrap that
 * builds the context, registers the plugin list, and dispatches.
 *
 * Why (from the DSH comparison): the old index.js was a 90KB single
 * dispatcher where every route lived inline. Adding a capability meant
 * editing the core file. With plugins, each capability (auth, devices,
 * translate, admin, mcp, proxy) is an isolated module with explicit deps.
 */

/**
 * Build the shared plugin context. `env` is the Workers env (bindings),
 * `helpers` the cross-cutting utilities (jsonOk/jsonError/readJson/CORS).
 */
export function createPluginContext(env, helpers) {
  return {
    env,
    helpers,
    routes: [],            // { match(method, path), handler }
    api: {},               // named capabilities plugins expose to each other
    config: {},            // plugin-configurable values (writable in setup)
    events: new Map(),     // name → Set<listener> (cross-plugin signals)
  };
}

/**
 * Register plugins in order; each plugin's deps must already be registered
 * (or the deps resolve to ctx.api entries set by earlier plugins).
 */
export function registerPlugins(ctx, plugins) {
  for (const plugin of plugins) {
    if (!plugin || typeof plugin.setup !== "function") continue;
    plugin.setup(ctx);
  }
}

/**
 * Route dispatch: first registered plugin whose match() returns true wins.
 * Returns the handler's result, or null when nothing matched (caller 404s).
 */
export function dispatch(ctx, method, path, ...rest) {
  for (const r of ctx.routes) {
    if (r.match(method, path)) return r.handler(...rest);
  }
  return null;
}

/** Convenience: register a route on the context. */
export function route(ctx, methods, pathPrefix, handler) {
  const ms = Array.isArray(methods) ? methods : [methods];
  ctx.routes.push({
    match: (m, p) => ms.includes(m) && p.startsWith(pathPrefix),
    handler,
  });
}

/** Emit a cross-plugin event (fire-and-forget; listeners may be async). */
export function emit(ctx, name, payload) {
  const listeners = ctx.events.get(name);
  if (!listeners) return;
  for (const fn of listeners) {
    try { Promise.resolve(fn(payload)).catch(() => {}); } catch {}
  }
}

/** Subscribe to a cross-plugin event. Returns an unsubscribe fn. */
export function on(ctx, name, fn) {
  if (!ctx.events.has(name)) ctx.events.set(name, new Set());
  ctx.events.get(name).add(fn);
  return () => ctx.events.get(name)?.delete(fn);
}
