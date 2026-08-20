// Gate 2 — HR domain regression.
//
// Founder-mandated canonical command: `npm run gate:hr:domain`.
// Covers the HR domain suites that share the same DB schema + are
// most likely to reveal cross-service regressions from a substantial
// HR slice, WITHOUT running the source-contract-heavy files that are
// covered by faster batches.
//
// Trades a smaller test set for faster feedback than gate:hr:full:
//   * tests/hr/security-compliance  — auth / tenant / KMS / audit
//   * tests/hr/admin-workflows       — CRUD + admin UX contracts
//   * tests/hr/cross-cutting          — shared invariants (rbac
//                                       snapshot, payrate exclusive
//                                       writer, tenant matrix, audit
//                                       plaintext leak sweep)
//   * tests/mission-control-integration-sentinel — combined MC+HR contract
//
// Use before staging deploy of a substantial slice; NOT required for
// every focused incremental change (see gate:hr:touched for that).

import { defineConfig } from "vitest/config";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { cpus } from "node:os";

const MAX_WORKERS = Math.max(2, Math.min(cpus().length - 2, 10));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "node",
    globals: false,
    include: [
      "tests/hr/security-compliance/**/*.test.ts",
      "tests/hr/admin-workflows/**/*.test.ts",
      "tests/hr/admin-workflows/**/*.test.tsx",
      "tests/hr/cross-cutting/**/*.test.ts",
      "tests/mission-control-integration-sentinel.test.ts",
    ],
    setupFiles: ["tests/setup.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: true,
    pool: "forks",
    maxWorkers: MAX_WORKERS,
    isolate: false,
  },
});
