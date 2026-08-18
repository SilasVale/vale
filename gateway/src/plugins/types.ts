/**
 * Plugin system types — DSH/Cordis-style lifecycle-managed plugins.
 *
 * A plugin is `{ name, deps, setup(ctx) }` with lifecycle callbacks.
 * The container manages dependency resolution, lifecycle (setup → ready → dispose),
 * and hot-reload in development mode.
 */

/** Plugin lifecycle state */
export type PluginState = "pending" | "setting-up" | "ready" | "disposed" | "error";

/** Workers env bindings — the shape we touch (typed loosely; full bindings live in wrangler config). */
export interface PluginEnv {
  [key: string]: any;
}

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
  /** Cloudflare Workers env bindings. */
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
  /** Reference to the container (for lifecycle management). */
  container: PluginContainer;
}

/** A plugin: declared deps + setup that registers routes/api on the ctx. */
export interface Plugin {
  name: string;
  deps?: string[];
  setup: (ctx: PluginContext) => void | Promise<void>;
  /** Called when all plugins are set up. */
  ready?: (ctx: PluginContext) => void | Promise<void>;
  /** Called when the plugin is being torn down (HMR or shutdown). */
  dispose?: (ctx: PluginContext) => void | Promise<void>;
}

/** Plugin container — manages plugin lifecycle. */
export interface PluginContainer {
  /** Register a plugin. */
  register(plugin: Plugin): void;
  /** Start all plugins (setup → ready). */
  start(env: PluginEnv | null, helpers: PluginHelpers): Promise<void>;
  /** Dispose all plugins (reverse order). */
  dispose(): Promise<void>;
  /** Dispatch a request to the first matching route. */
  dispatch(request: Request, env: PluginEnv | null): Promise<Response | null>;
  /** Get plugin state. */
  getState(pluginName: string): PluginState;
  /** Hot-reload a single plugin (dispose → re-setup). */
  hotReload(pluginName: string, newPlugin: Plugin): Promise<void>;
}
