// Gate B — HR canonical batch.
//
// Founder-mandated canonical command: `npm run gate:hr`.
// Standalone config (does NOT extend the root via mergeConfig, which
// arrays-merge the `include` list).

import { defineConfig } from "vitest/config";
import path from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: [
      "tests/hr/**/*.test.ts",
      "tests/hr/**/*.test.tsx",
    ],
    setupFiles: ["tests/setup.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Critical: HR tests share the SQLite dev.db and reset it
    // between files; without this, files running concurrently
    // produce SQLITE_BUSY / row-not-found flakes.
    fileParallelism: false,
  },
});
