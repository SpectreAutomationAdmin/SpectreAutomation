// Vitest setupFiles: runs per-test-file, BEFORE each file's imports resolve.
//
// CRITICAL: env mutations must happen at module top-level, before any test
// file imports resolve. Once src/lib/env.ts has validated and
// src/lib/prisma.ts has constructed its PrismaClient, DATABASE_URL changes
// are no longer respected.
//
// DB schema lifecycle (schema reset before all tests, cleanup after) lives
// in tests/global-setup.ts. Vitest 4's module evaluator loads setupFiles
// in a context where the runner isn't yet registered, so top-level
// `beforeAll`/`afterAll` calls throw "Vitest failed to find the runner".
// globalSetup owns those hooks. Per-test data cleanup still runs from
// tests/util/db.ts::resetDb().

import path from "node:path";

const TEST_DB_PATH = path.resolve(process.cwd(), "prisma/test.db");

// Sprint 2 B4.1 (2026-07-19) — respect a PostgreSQL DATABASE_URL when
// the pg-validate harness (scripts/pg-validate.mjs) has set one. In
// that mode we skip the SQLite `db push` and assume the harness has
// applied migrations already.
const IS_POSTGRES_TEST = (process.env.DATABASE_URL ?? "").startsWith("postgres");

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
