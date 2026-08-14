import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build the panel to a SINGLE bundled JS that the agent embeds via
// include_str! (web.rs reads ../resources/panel/panel.js). The output lands
// in ../panel/ (the agent's embedded-asset dir) so the existing
// include_str! paths keep working unchanged.
export default defineConfig({
  plugins: [react()],
  // round-86: the React bundle referenced process.env.NODE_ENV (dev/prod
  // branch checks) — browsers have no `process`, so the panel crashed with
  // "ReferenceError: process is not defined" at load. Define it away.
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  build: {
    outDir: "../panel", // React build IS production now (round-79: core
                        // features migrated — conn/terminal/SSE/modals)
    lib: {
      entry: "src/main.tsx",
      name: "valePanel",
      formats: ["iife"],
      fileName: () => "panel.js",
    },
    target: "es2020",
    minify: "esbuild", // the panel is served over the tunnel; size matters more than readability here
    sourcemap: false,
  },
});
