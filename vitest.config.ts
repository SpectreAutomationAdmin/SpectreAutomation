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
    // FPP-1 §4 (2026-09-20) — per-worker DB isolation. tests/setup.ts
    // hands each vitest worker its OWN SQLite file at
    // `prisma/test-workers/w<VITEST_POOL_ID>.db` (copied from the
    // schema-only template built by tests/global-setup.ts). Turning
    // fileParallelism on lets workers run in parallel without sharing
    // a DB, which fixes the cross-file `RolePermission P2003` cascade
    // documented in the FPP-1 acceptance closeout: one file's leaked
    // roleKey → the next file's `seedRbac` upsert failing on FK.
    // Within a worker files still run serially; the DB it owns is
    // reset+seeded before each test as before.
    fileParallelism: true,
    // Keep test-writer complexity low: use vitest's default `forks`
    // pool with a modest concurrency ceiling. The bottleneck is
    // SQLite reset/seed cost (~1-3s per file), so 4 workers on
    // Windows is a comfortable ceiling — higher counts hit
    // File-System write contention on prisma/test-workers/.
    maxWorkers: 4,
  },
});
