# Workflow: Plugin System Rewrite — Full Cordis Model

**Trigger:** Manual (after workflow 01 is complete)
**Checkpoint:** Yes — after lifecycle hooks are working, after DI container is tested, after HMR proof-of-concept.
**Push right:** Yes — implement the full system, then present summary.

## Objective

Rewrite the gateway plugin system to match DSH's cordis model: DI container, lifecycle hooks (setup/ready/dispose), dependency resolution, HMR support, and profile/bundle layering. This replaces the current thin registry in `gateway/src/plugins/registry.ts`.

## Reference

DSH uses `@deepseek-ai/cordis` (a DI container with lifecycle management). We won't import cordis directly (it's a DSH internal), but we'll replicate its core patterns:

- **Container** — owns plugin instances, manages their lifecycle.
- **Plugin** — `{ name, deps, setup(ctx) }` with lifecycle callbacks.
- **Context** — shared state bag (env, helpers, routes, api, config, events).
- **Lifecycle** — `setup` → `ready` → `dispose` (with error handling).
- **HMR** — in development, a plugin file change triggers dispose → re-setup.

## Steps

### Step 1: Define the core types

Create `gateway/src/plugins/types.ts`:

```typescript
/** Plugin lifecycle state */
export type PluginState = "pending" | "setting-up" | "ready" | "disposed" | "error";

/** The shared context injected into every plugin. */
export interface PluginContext {
  /** Cloudflare Workers env bindings. */
  env: Record<string, unknown> | null;
  /** Cross-cutting utilities (jsonOk, jsonError, readJson, CORS). */
  helpers: PluginHelpers;
  /** Registered routes (first-match wins). */
  routes: PluginRoute[];
  /** Named capabilities plugins expose to each other. */
  api: Record<string, unknown>;
  /** Plugin-configurable values (writable during setup). */
  config: Record<string, unknown>;
  /** Cross-plugin event bus. */
  events: Map<string, Set<PluginListener>>;
  /** Reference to the container (for lifecycle management). */
  container: PluginContainer;
}

/** Response helpers shared across plugins. */
export interface PluginHelpers {
  jsonOk: (body: unknown, headers?: Record<string, string>) => Response;
  jsonError: (status: number, message: string, code?: string) => Response;
  readJson: (request: Request) => Promise<unknown>;
  CORS_HEADERS: Record<string, string>;
}

/** A registered route. */
export interface PluginRoute {
  match: (method: string, path: string) => boolean;
  handler: (request: Request, env: Record<string, unknown> | null, ctx: PluginContext) => Response | Promise<Response>;
}

/** Cross-plugin event listener. */
export type PluginListener = (payload: unknown) => void | Promise<void>;

/** A plugin declaration. */
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
  start(env: Record<string, unknown> | null, helpers: PluginHelpers): Promise<void>;
  /** Dispose all plugins (reverse order). */
  dispose(): Promise<void>;
  /** Dispatch a request to the first matching route. */
  dispatch(request: Request, env: Record<string, unknown> | null): Promise<Response | null>;
  /** Get plugin state. */
  getState(pluginName: string): PluginState;
  /** Hot-reload a single plugin (dispose → re-setup). */
  hotReload(pluginName: string, newPlugin: Plugin): Promise<void>;
}
```

### Step 2: Implement the container

Create `gateway/src/plugins/container.ts`:

Key behaviors:
1. **Dependency resolution** — `register()` topologically sorts plugins by `deps`. If a cycle is detected, throw a clear error with the cycle path.
2. **Lifecycle management** — `start()` calls `setup()` in dependency order, then `ready()` in the same order. Track state per plugin.
3. **Dispose** — `dispose()` calls `dispose()` in **reverse** order. Wrap each in try/catch so one failure doesn't block others.
4. **Error handling** — If a plugin's `setup()` throws, mark it as `"error"` and continue with the next plugin (don't crash the whole gateway). Log the error.
5. **HMR** — `hotReload()` calls `dispose()` on the old plugin, removes its routes/api entries, then calls `setup()` + `ready()` on the new one.
6. **Route dispatch** — `dispatch()` iterates routes in registration order, first match wins. Returns `null` if no match (let the gateway fall through to its default handler).

Implementation:

```typescript
import type { Plugin, PluginContext, PluginContainer, PluginState, PluginHelpers, PluginRoute } from "./types.ts";

export function createContainer(): PluginContainer {
  const plugins: Map<string, Plugin> = new Map();
  const states: Map<string, PluginState> = new Map();
  const contexts: Map<string, PluginContext> = new Map();
  const routes: PluginRoute[] = [];
  let started = false;

  // ... (implement register, start, dispose, dispatch, hotReload, getState)
}
```

### Step 3: Migrate existing plugins

The current gateway has these modules that act as implicit plugins:
- `auth.ts` — password hashing, session tokens
- `channels.js` / `channels.ts` — WebSocket channels
- `body-scan.js` / `body-scan.ts` — request body scanning
- `plugins/registry.ts` — the current registry (to be replaced)

Each becomes a proper plugin:

```typescript
// gateway/src/plugins/built-in/auth.ts
import type { Plugin } from "../types.ts";

export const authPlugin: Plugin = {
  name: "auth",
  deps: [],
  setup(ctx) {
    // Register auth-related routes (login, logout, session verify)
    // Expose auth API: ctx.api.auth = { verify, issue, hash }
  },
  ready(ctx) {
    // All plugins set up — auth is ready to serve
  },
  async dispose(ctx) {
    // Clean up any auth state
  },
};
```

Create similar plugins for:
- `channelsPlugin` (deps: `["auth"]`)
- `bodyScanPlugin` (deps: [])
- `sourceViewerPlugin` (deps: []) — serves the existing `public/code/` static files

### Step 4: Rewrite the gateway entry point

Update `gateway/src/index.ts` (or create it if it doesn't exist) to use the new container:

```typescript
import { createContainer } from "./plugins/container.ts";
import { authPlugin } from "./plugins/built-in/auth.ts";
import { channelsPlugin } from "./plugins/built-in/channels.ts";
// ... other plugins

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const container = createContainer();
    // Register all built-in plugins
    container.register(authPlugin);
    container.register(channelsPlugin);
    // ...
    await container.start(env, { jsonOk, jsonError, readJson, CORS_HEADERS });
    
    const response = await container.dispatch(request, env);
    if (response) return response;
    
    // Default 404
    return new Response("Not Found", { status: 404 });
  },
};
```

**Note:** In production, the container should be created once and reused across requests (module-level singleton). In development (HMR), it can be recreated per request for simplicity.

### Step 5: Add HMR support (development only)

In development mode (detected via `env.DEBUG` or `wrangler dev`), watch `src/plugins/built-in/*.ts` for changes. On change:
1. Find the plugin by filename.
2. Call `container.hotReload(name, newPlugin)`.
3. Log the reload.

This can be a simple file watcher in the dev entry point, or a wrangler middleware.

### Step 6: Profile/bundle layering (future-proof stub)

Add a `loadProfile(configPath: string)` function that reads a YAML/JSON profile file and applies it as a config layer on top of the container's `config` map. Don't implement the full DSH profile system yet — just the interface:

```typescript
export interface Profile {
  name: string;
  bundles: string[];  // plugin bundle names to load
  patch: Record<string, unknown>;  // config overrides
}

export function loadProfile(configPath: string): Profile {
  // Read and parse the profile file
  // Return the profile object
}
```

This is a stub for future work — the full profile system (bundles from npm, patch layering, CLI flags) comes later.

## Commit strategy

- `feat(gateway): add plugin types with lifecycle hooks`
- `feat(gateway): implement plugin container with DI and lifecycle`
- `refactor(gateway): migrate auth/channels/body-scan to plugin format`
- `refactor(gateway): rewrite gateway entry point to use plugin container`
- `feat(gateway): add HMR support for plugins in dev mode`
- `feat(gateway): add profile stub for future bundle layering`

## Done criteria

- The plugin container manages plugin lifecycle (setup → ready → dispose).
- Dependencies are resolved in topological order.
- HMR works in development (file change → dispose → re-setup).
- All existing functionality (auth, channels, body-scan, source viewer) works through the new plugin system.
- TypeScript strict mode passes.
- ESLint + Prettier pass.
