# ADR 0001: Gateway uses a single plugin core; index.ts is only a front door

Status: Adopted ｜ Date: 2026-08-21 ｜ Scope: `gateway/src`

## Background

vale-gate has been evolving toward the DSH/Cordis plugin model. round-73 introduced `plugins/registry.ts`
(`{ name, deps, setup(ctx) }` + a route table + the ctx.api capability surface), but the migration was incremental:

1. `index.ts` (formerly index.js) kept the full inline console handling chain: plugin routes match first,
   and a miss falls through to the inline implementation — **two copies of code for the same responsibility**.
2. The duplicated code has already caused real regressions: round-99 (the plugin's /v1 implementation was never reached; 800 lines
   of dead code kept drifting), round-120 (the inline handleGatewayImpl was a stale copy),
   round-88 (the mcp plugin's hand-written session gate missed the sess-revoked blacklist).
3. Session validation `requireSession/sessionSecret` is duplicated **4 times**; the upstream route table
   `pickRoute/passthroughHeaders` is duplicated **2 times** and the behavior has diverged (for the or/ channel,
   probing and actual forwarding take different upstreams when US_PROXY is enabled).
4. A second, never-wired "lifecycle container" exists (container.ts/types.ts): its dispatch
   is a placeholder that returns null, and coexisting with the registry it creates two PluginContext contracts.

## Decision

1. **Complete the migration, remove the dual track**: all `/api/*`, `/mcp`, `/v1/*` routes exist only in plugins;
   `index.ts` shrinks to a pure front door (host routing, HTTPS redirect, static assets, public tooling endpoints,
   plugin-context assembly). 1569 lines → ~400 lines.
2. **Singleton cross-cutting concerns**: create `src/session.ts` (the single session-validation implementation) and
   `src/upstream.ts` (the single channel route-table implementation), imported by both plugins and index.
3. **Delete the unused second plugin system** (container.ts/types.ts/built-in); the registry
   is self-contained and the single definition of the contract; also delete all `.js` re-export shims, point wrangler main
   straight at `src/index.ts`, and have tests import the real modules instead of barrel files.
4. **Unified design system for the console UI**: all views converge on one class vocabulary + shared components
   (PageHeader/Card/Badge/Modal, etc.), dark mode and hash routing.

## Consequences

- Positive: a new capability = adding or modifying one plugin file; session and routing semantics have a single source of truth;
  tests target modules directly; net deletion of ~1500 lines.
- Negative/cost: plugin registration order is dependency order (auth depends on translate's api capability),
  so order comments must be maintained at the registration list; the prefix-matching `route()` helper is sensitive
  to subpaths, and dynamic routes always use exact match (the devices plugin already sets the precedent).

## Verification

- `node --test`: 173 passed / 0 failed (covers console API, proxy auth, MCP, plugin-hub).
- `npx wrangler deploy --dry-run`: bundling and DO export checks pass.
