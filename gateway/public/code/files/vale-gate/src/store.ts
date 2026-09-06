/**
 * store.ts — KV persistence layer (migrated from store.js, logic verbatim)
 *
 * Multi-user BYOK relay:
 *   user:<id>          → user record {id, username, role, enabled, createdAt, passwordHash, salt, token}
 *   username:<name>    → userId (uniqueness + fast lookup)  [kept for compat; not used]
 *   token:<gatewayToken> → userId (client x-api-key resolution)
 *   ukeys:<id>         → that user's own backend keys {DEEPSEEK_API_KEY, OPENCODE_GO_API_KEY, OPENROUTER_API_KEY}
 *   invite:<code>      → "1" (one-time registration invite)
 *   _admin_seeded      → "1" (admin seeded marker)
 *
 * Compat migration: the admin account is seeded from the existing CLIENT_KEY (gateway
 * token) + backend keys, so the user's local settings.json (x-api-key = CLIENT_KEY)
 * keeps working without changes.
 *
 * Split by domain (structure refactor): the implementation now lives in
 * src/store/<domain>.ts and this module is a pure re-export shim, so every
 * existing `from "../store.ts"` (or "./store.ts") import keeps working.
 * Dependency order is one-way (cache → entities → aggregates):
 *   store/cache.ts     per-isolate KV cache + per-key write locks — the
 *                      SINGLE process-global instance; all siblings import
 *                      cget/cset/cdel from it, never their own copies
 *   store/users.ts     users / tokens / per-user keys / RouteDO routes /
 *                      invites / masking
 *   store/admin.ts     admin seeding (process-once `seeded` flag) + hashed
 *                      admin password
 *   store/settings.ts  global settings (console toggles, e.g. US_PROXY)
 *   store/devices.ts   device registry (devices:v1) + CF tunnel API token
 *   store/regkeys.ts   one-time device registration keys / grants
 *   store/plugins.ts   plugin-link registry (plugins:v1)
 *   store/grants.ts    one-time device-panel grants (panelgrant:<code>)
 */
export * from "./store/cache.ts";
export * from "./store/users.ts";
export * from "./store/admin.ts";
export * from "./store/settings.ts";
export * from "./store/devices.ts";
export * from "./store/regkeys.ts";
export * from "./store/plugins.ts";
export * from "./store/grants.ts";
