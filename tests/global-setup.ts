// Vitest 4 globalSetup: runs ONCE before the whole test run, ONCE after.
//
// 2026-08-20 · Test-workflow optimization
// -----------------------------------------
// This file now creates a SCHEMA-ONLY TEMPLATE database at
// `prisma/test-template.db`. Each vitest worker (per VITEST_POOL_ID)
// copies the template on its first setup so it gets its own private
// SQLite file. That lets `fileParallelism: true` run safely without
// cross-file DB contention — the 45-minute Gate B (single-thread) is
// the root cause of the "45-minute HR gate" performance defect.
//
// The template is created ONCE per test-run. Worker copies happen in
// tests/setup.ts (per-file). resetDb() in tests/util/db.ts still runs
// per-test to wipe table data — it operates on the worker's private DB
// so there's no cross-worker contention.
//
// Cleanup: worker DBs are all removed at the end of the run below
// (in the teardown returned function).
//
// Split from tests/setup.ts because Vitest 4's module evaluator loads
// setupFiles in a context where the runner isn't registered yet, so
// top-level `beforeAll`/`afterAll` calls throw with
// "Vitest failed to find the runner". globalSetup runs in its own
// context, must NOT import from "vitest", and owns lifecycle hooks
// that used to live at the top of tests/setup.ts.

import { execSync } from "node:child_process";
import { readdirSync, rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// Template DB (schema-only). Workers copy from here.
const TEMPLATE_DB_PATH = path.resolve(process.cwd(), "prisma/test-template.db");
// Legacy shared DB — kept the same file name so IS_POSTGRES_TEST paths
// (pg-validate harness) still work identically. In SQLite mode this
// file is now only used at globalSetup time to run `prisma db push`
// before being renamed to the template path.
const LEGACY_SHARED_DB_PATH = path.resolve(process.cwd(), "prisma/test.db");
const WORKER_DB_DIR = path.resolve(process.cwd(), "prisma/test-workers");

const IS_POSTGRES_TEST = (process.env.DATABASE_URL ?? "").startsWith("postgres");

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (IS_POSTGRES_TEST) return async () => { /* pg-validate manages its own lifecycle */ };

  // Ensure worker DB directory exists + is empty before this run.
  if (existsSync(WORKER_DB_DIR)) {
    for (const f of readdirSync(WORKER_DB_DIR)) {
      try { rmSync(path.join(WORKER_DB_DIR, f)); } catch { /* noop */ }
    }
  } else {
    mkdirSync(WORKER_DB_DIR, { recursive: true });
  }

  // Rebuild the template DB from schema.
  if (existsSync(LEGACY_SHARED_DB_PATH)) rmSync(LEGACY_SHARED_DB_PATH);
  if (existsSync(TEMPLATE_DB_PATH)) rmSync(TEMPLATE_DB_PATH);
  execSync("npx prisma db push --skip-generate --accept-data-loss --force-reset", {
    stdio: "ignore",
    env: {
      ...process.env,
      DATABASE_URL: `file:${LEGACY_SHARED_DB_PATH.replace(/\\/g, "/")}`,
    },
  });
  await applyPartialUniqueIndexes(LEGACY_SHARED_DB_PATH);
  // Promote the freshly-pushed schema to the template. Fs `renameSync`
  // works because both paths are on the same filesystem.
  (await import("node:fs")).renameSync(LEGACY_SHARED_DB_PATH, TEMPLATE_DB_PATH);

  return async () => {
    // Best-effort teardown — worker DBs + template.
    try { if (existsSync(WORKER_DB_DIR)) {
      for (const f of readdirSync(WORKER_DB_DIR)) {
        try { rmSync(path.join(WORKER_DB_DIR, f)); } catch { /* noop */ }
      }
    } } catch { /* noop */ }
    try { if (existsSync(TEMPLATE_DB_PATH)) rmSync(TEMPLATE_DB_PATH); } catch { /* noop */ }
  };
}

async function applyPartialUniqueIndexes(dbPath: string): Promise<void> {
  // HR-1H (2026-08-16) — Prisma cannot declare partial unique indexes
  // for SQLite in its schema DSL. `db push` reads the schema (not
  // migrations), so we replay the partial-unique DDL here so vitest
  // exercises the same invariant that prisma migrate applies in
  // production Postgres. Keep this list in lock-step with
  // prisma/migrations/*_partial_unique/*.sql.
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({
    datasources: { db: { url: `file:${dbPath.replace(/\\/g, "/")}` } },
  });
  try {
    await client.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeBankAccount_employeeId_verified_key" ` +
        `ON "EmployeeBankAccount" ("employeeId") WHERE status = 'VERIFIED';`,
    );
    // Payroll-3C-4A (2026-09-09) — recurring-assignment uniqueness.
    // One-time adjustment rows carry sourceAssignmentId = NULL and are
    // deliberately excluded so an employee can have many one-time rows.
    await client.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "PayrollBatchComponentSnapshot_recurring_assignment_unique" ` +
        `ON "PayrollBatchComponentSnapshot" ("batchEmployeeId", "sourceAssignmentId") ` +
        `WHERE "sourceAssignmentId" IS NOT NULL;`,
    );
    // Scheduling Foundation (2026-09-07) — partial-uniques on
    // ShiftAssignment (one ASSIGNED per shift) and ShiftOpportunity
    // (one OPEN per shift). Same reason as the two above: Prisma's
    // schema DSL can't declare them, but the migration SQL DOES,
    // so `db push` needs the replay here for parity.
    await client.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "ShiftAssignment_shiftId_active_unique" ` +
        `ON "ShiftAssignment" ("clubId", "shiftId") WHERE "state" = 'ASSIGNED';`,
    );
    await client.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "ShiftOpportunity_shiftId_open_unique" ` +
        `ON "ShiftOpportunity" ("clubId", "shiftId") WHERE "state" = 'OPEN';`,
    );
  } finally {
    await client.$disconnect();
  }
}
