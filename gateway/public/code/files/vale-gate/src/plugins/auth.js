// Shim: index.js still does `import authPlugin from "./plugins/auth.js"`
// (default import). `export *` alone drops the default export and esbuild
// fails the build with "No matching export ... for import default" — so the
// default is re-exported explicitly until index.js migrates to .ts.
export * from "./auth.ts";
export { default } from "./auth.ts";
