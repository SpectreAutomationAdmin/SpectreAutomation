// Gate A — Mission Control canonical batch.
//
// Founder-mandated canonical command: `npm run gate:mission-control`.
// Standalone config (does NOT extend the root via mergeConfig, which
// arrays-merge the `include` list). Root shell config still applies
// via re-declaration of setupFiles / aliases / fileParallelism.
//
// Every stale-test drift found during the 2026-08-19 reconciliation
// was fixed against the WIP-authoritative code that is on this
// branch; this file collects them into one deterministic batch that
// must be green before any staging deploy.
//
// The list is INCLUSIVE not exhaustive — new Mission Control /
// mailbox / Member tests are picked up automatically by the prefix
// globs. Add a specific path only when the test lives outside those
// prefixes but belongs to the Mission Control contract.

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
      // High-signal integration sentinel — pins the founder-contract
      // shell + Work Intake + AP projection + HR-coexistence surface.
      "tests/mission-control-integration-sentinel.test.ts",
      // Mission Control test surface.
      "tests/mission-control-*.test.ts",
      // Mailbox / Outlook / MSAL / delta-sync / classifier hardening.
      "tests/mailbox-*.test.ts",
      "tests/lib/mailbox/**/*.test.ts",
      // Member Database (Phase 20).
      "tests/member-*.test.ts",
      // Phase 4R confidence + multi-allocation integrity gates.
      "tests/phase4r-*.test.ts",
      // Chrome breadcrumb — pins Phase 4R rev-5 breadcrumb taxonomy.
      "tests/chrome-breadcrumb.test.ts",
    ],
    setupFiles: ["tests/setup.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Critical: HR + Mission Control tests share the SQLite dev.db
    // and reset it between files; without this, files running
    // concurrently produce SQLITE_BUSY / row-not-found flakes.
    fileParallelism: false,
  },
});
