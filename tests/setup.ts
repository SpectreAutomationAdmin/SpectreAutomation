// Vitest setup.
//
// We use an isolated SQLite database for tests. CRITICAL: env mutations must
// happen at module top-level, *before* any test file imports resolve. Once
// src/lib/env.ts has validated and src/lib/prisma.ts has constructed its
// PrismaClient, DATABASE_URL changes are no longer respected.

import { execSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(process.cwd(), "prisma/test.db");

// Sprint 2 B4.1 (2026-07-19) — respect a PostgreSQL DATABASE_URL when
// the pg-validate harness (scripts/pg-validate.mjs) has set one. In
// that mode we skip the SQLite `db push` and assume the harness has
// applied migrations already.
const IS_POSTGRES_TEST = (process.env.DATABASE_URL ?? "").startsWith("postgres");

// ----- Top-level (pre-import) env setup ------------------------------------
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: IS_POSTGRES_TEST
    ? process.env.DATABASE_URL
    : `file:${TEST_DB_PATH.replace(/\\/g, "/")}`,
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

beforeAll(() => {
  if (IS_POSTGRES_TEST) {
    // The pg-validate harness has already applied migrations to a
    // fresh Postgres database. Nothing to do here.
    return;
  }
  // Fresh SQLite schema. `prisma db push --force-reset` is idempotent.
  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  execSync("npx prisma db push --skip-generate --accept-data-loss --force-reset", {
    stdio: "ignore",
    env: { ...process.env },
  });
});

afterAll(() => {
  if (IS_POSTGRES_TEST) return;
  // Best-effort SQLite cleanup. If a process still holds the file
  // (Windows), leave it.
  try { if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// Per-file timing instrumentation.
//
// The Vitest default reporter prints per-file durations in its summary
// at end-of-run. The custom line below adds a stderr signal *as each
// file finishes* so the slowest suites are obvious during a long
// `test:db:serial` run even if stdout is buffered / truncated.
//
//   [test-timing] file finished in 75.2s
//
// The reporter line immediately above identifies which file just
// completed; pairing the two gives an obvious slow-file scan signal
// without depending on Vitest internal APIs to resolve the test path.
//
// Set DISABLE_TEST_TIMING=1 to silence (e.g. for CI snapshot diffs).
// ---------------------------------------------------------------------------
const fileStartedAt = Date.now();
afterAll(() => {
  if (process.env.DISABLE_TEST_TIMING === "1") return;
  const elapsedS = ((Date.now() - fileStartedAt) / 1000).toFixed(1);
  process.stderr.write(`[test-timing] file finished in ${elapsedS}s\n`);
});
