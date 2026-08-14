// Shim — implementation migrated to translate.ts. index.js still imports
// "./plugins/translate.js" until index.js itself migrates, so re-export both
// the named exports AND the default (the plugin object registerPlugins needs).
export * from "./translate.ts";
export { default } from "./translate.ts";
