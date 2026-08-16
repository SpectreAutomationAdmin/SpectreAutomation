// Vitest 4 globalSetup: runs ONCE before the whole test run, ONCE after.
//
// Split from tests/setup.ts because Vitest 4's module evaluator loads
// setupFiles in a context where the runner isn't registered yet, so
// top-level `beforeAll`/`afterAll` calls throw with
// "Vitest failed to find the runner". globalSetup runs in its own
// context, must NOT import from "vitest", and owns lifecycle hooks
// that used to live at the top of tests/setup.ts.
//
// Semantic change from the prior Vitest-3-shaped code: the SQLite
// schema is reset ONCE at start-of-run instead of once per file.
// Per-test data cleanup still runs from tests/util/db.ts::resetDb().
// Schema doesn't change between files, so this is faster and safe.

import { execSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import path from "node:path";

const TEST_DB_PATH = path.resolve(process.cwd(), "prisma/test.db");
const IS_POSTGRES_TEST = (process.env.DATABASE_URL ?? "").startsWith("postgres");

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!IS_POSTGRES_TEST) {
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    execSync("npx prisma db push --skip-generate --accept-data-loss --force-reset", {
      stdio: "ignore",
      env: {
        ...process.env,
        DATABASE_URL: `file:${TEST_DB_PATH.replace(/\\/g, "/")}`,
      },
    });
    // HR-1H (2026-08-16) — Prisma cannot declare partial unique
    // indexes for SQLite in its schema DSL. `db push` reads the
    // schema (not migrations), so we replay the partial-unique DDL
    // here so vitest exercises the same invariant that prisma migrate
    // applies in production Postgres. Keep this list in lock-step
    // with prisma/migrations/*_partial_unique/*.sql.
    await applyPartialUniqueIndexes(TEST_DB_PATH);
  }

  return async () => {
    if (IS_POSTGRES_TEST) return;
    try { if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH); } catch { /* noop */ }
  };
}

async function applyPartialUniqueIndexes(dbPath: string): Promise<void> {
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({
    datasources: { db: { url: `file:${dbPath.replace(/\\/g, "/")}` } },
  });
  try {
    await client.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeBankAccount_employeeId_verified_key" ` +
        `ON "EmployeeBankAccount" ("employeeId") WHERE status = 'VERIFIED';`,
    );
  } finally {
    await client.$disconnect();
  }
}
