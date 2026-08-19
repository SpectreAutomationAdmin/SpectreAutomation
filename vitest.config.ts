import { defineConfig } from "vitest/config";
import path from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // The React plugin only affects TSX transform (Fast Refresh is a
  // no-op in a test environment). It's needed so JSX in `.test.tsx`
  // files compiles through the automatic runtime.
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Default environment stays `node` so existing service-level
    // tests keep their behaviour. React component tests opt into
    // jsdom via a per-file `// @vitest-environment jsdom` pragma.
    environment: "node",
    globals: false,
    // HR-2B.3.2 §3 — include .test.tsx so React-Testing-Library
    // specs (e.g. selfie-capture) are discovered.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["tests/setup.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Tests share a single SQLite DB; serialize to avoid file-lock contention.
    fileParallelism: false,
  },
});
