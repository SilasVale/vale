import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // round-138: vite.config's NODE_ENV=production define leaks into tests
  // (vitest reuses the same pipeline), and testing-library's act() throws
  // under production React. Explicitly pin tests back to development.
  define: {
    "process.env.NODE_ENV": '"development"',
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
