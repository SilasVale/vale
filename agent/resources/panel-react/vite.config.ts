import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build the panel to a SINGLE bundled JS that the agent embeds via
// include_str! (web.rs reads ../resources/panel/panel.js). The output lands
// in ../panel/ (the agent's embedded-asset dir) so the existing
// include_str! paths keep working unchanged.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../panel",
    emptyOutDir: false, // keep index.html / panel.css / vendor/ (managed by hand)
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
