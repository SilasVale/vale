import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build the panel to a SINGLE bundled JS that the agent embeds via
// include_str! (web.rs reads ../resources/panel/panel.js). The output lands
// in ../panel/ (the agent's embedded-asset dir) so the existing
// include_str! paths keep working unchanged.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist", // do NOT overwrite the production panel.js until the
                    // React build is feature-complete — a future round flips
                    // this to ../panel once parity is reached
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
