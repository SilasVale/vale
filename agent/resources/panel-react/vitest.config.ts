import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // round-138: vite.config 的 NODE_ENV=production define 会泄漏进测试
  // (vitest 复用同一解析管线),testing-library 的 act() 在 production
  // React 下直接抛错。测试环境显式钉回 development。
  define: {
    "process.env.NODE_ENV": '"development"',
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
