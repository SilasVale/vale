import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: "/",
  root: ".",
  // Pin client bundles to React's production build — independent of any
  // ambient NODE_ENV (a stray NODE_ENV=development in the deploying shell
  // otherwise ships React's dev warning branches and doubles bundle size).
  // Scoped to `build` so `vite dev` keeps normal dev behavior.
  ...(command === "build"
    ? { define: { "process.env.NODE_ENV": JSON.stringify("production") } }
    : {}),
  build: {
    outDir: "../public",
    emptyOutDir: false,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
}));
