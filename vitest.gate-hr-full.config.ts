// Gate 3 — HR full regression (renamed from vitest.gate-hr.config.ts).
//
// Founder-mandated canonical command: `npm run gate:hr:full`.
// Runs the entire tests/hr suite with per-worker SQLite isolation
// enabled via `pool: "forks"` + `fileParallelism: true`. Every worker
// gets its own DB copied from the schema template built by
// tests/global-setup.ts — no cross-worker contention.
//
// Use this before merge to `main`, before production deployment, or
// after any change with broad blast radius (schema, security,
// authentication, canonical service). Not the inner-loop.
//
// Target runtime: was ~45 min single-thread → expect ~6-10 min with
// per-worker isolation on a 12-CPU machine.

import { defineConfig } from "vitest/config";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { cpus } from "node:os";

// Leave 2 CPUs headroom for OS + main process on a bounded box; cap
// so ultra-large hosts don't create hundreds of DB files.
const MAX_WORKERS = Math.max(2, Math.min(cpus().length - 2, 10));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "node",
    globals: false,
    include: [
      "tests/hr/**/*.test.ts",
      "tests/hr/**/*.test.tsx",
    ],
    setupFiles: ["tests/setup.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Per-worker DB isolation makes this safe:
    fileParallelism: true,
    // Vitest 4: `pool: "forks"` = each worker is a separate process
    // with its own process.env. tests/setup.ts assigns DATABASE_URL
    // based on VITEST_POOL_ID so every fork gets its own SQLite file.
    // (poolOptions was removed in v4 — controls are top-level now.)
    pool: "forks",
    maxWorkers: MAX_WORKERS,
    // `isolate: false` reuses each fork's module registry (and Prisma
    // client) across files → avoids paying a ~5-10s cold-start per
    // file. resetDb() (per-file) still wipes tables on the shared
    // worker DB, so files are DATA-isolated within a fork.
    isolate: false,
  },
});
