// Shim — index migrated to TypeScript (index.ts). wrangler.jsonc main stays
// "src/index.js", so this re-exports everything the old file exported.
// `export *` alone drops the default export (the Worker entry) — the default
// is re-exported explicitly, same pattern as the plugin shims.
export { default } from "./index.ts";
export * from "./index.ts";
