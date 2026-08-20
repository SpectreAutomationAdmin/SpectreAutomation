// Vitest setupFiles: runs per-worker, BEFORE each file's imports resolve.
//
// CRITICAL: env mutations must happen at module top-level, before any test
// file imports resolve. Once src/lib/env.ts has validated and
// src/lib/prisma.ts has constructed its PrismaClient, DATABASE_URL changes
// are no longer respected.
//
// 2026-08-20 · Test-workflow optimization
// -----------------------------------------
// Every vitest worker (identified by VITEST_POOL_ID) now uses its OWN
// SQLite file at `prisma/test-workers/w<POOL_ID>.db`, copied from the
// template that globalSetup wrote. This lets `fileParallelism: true`
// run safely — files that share a worker still share a DB (each
// worker's `resetDb()` wipes between test-files), but different
// workers never touch each other's DB, so there's zero cross-file
// contention and no more `SQLITE_BUSY` cascades.
//
// If VITEST_POOL_ID is absent (e.g. someone ran a plain `vitest` with a
// pool that doesn't set it, or a single-file invocation), we fall back
// to `w0` — same file for every invocation, functionally identical to
// the legacy single-DB behaviour.

import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";

const TEMPLATE_DB_PATH = path.resolve(process.cwd(), "prisma/test-template.db");
const WORKER_DB_DIR = path.resolve(process.cwd(), "prisma/test-workers");

const IS_POSTGRES_TEST = (process.env.DATABASE_URL ?? "").startsWith("postgres");

if (!IS_POSTGRES_TEST) {
  const poolId = process.env.VITEST_POOL_ID ?? "0";
  const workerDbPath = path.join(WORKER_DB_DIR, `w${poolId}.db`);
  // Copy template → worker DB on first use. copyFileSync is atomic on
  // Windows for these small files; a concurrent second setup call in
  // the same worker is safe because setup.ts runs once per worker
  // process/thread lifecycle.
  if (!existsSync(workerDbPath)) {
    if (!existsSync(TEMPLATE_DB_PATH)) {
      // Ran outside globalSetup (e.g. a direct file invocation). Fall
      // back to a legacy DB path so the test can still run.
      throw new Error(
        "test template DB missing — did globalSetup run? Try: rm -rf prisma/test-template.db prisma/test-workers && vitest run",
      );
    }
    copyFileSync(TEMPLATE_DB_PATH, workerDbPath);
  }
  process.env.DATABASE_URL = `file:${workerDbPath.replace(/\\/g, "/")}`;
}

Object.assign(process.env, {
  NODE_ENV: "test",
  SPECTRE_SESSION_SECRET:
    process.env.SPECTRE_SESSION_SECRET ??
    "test-only-secret-thats-at-least-32-characters-long-xx",
  SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME ?? "spectre_session_test",
  TRUST_PROXY: "false",
  // Sprint 2 B2 — flip the mailbox integration on for the test env
  // so the /connect + /callback + /disconnect service can run in
  // mocked round-trip tests. Real Microsoft is never called; every
  // test injects MockMicrosoftDelegatedProvider.
  MAILBOX_INTEGRATION_ENABLED: process.env.MAILBOX_INTEGRATION_ENABLED ?? "true",
});
