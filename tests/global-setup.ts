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
  }

  return async () => {
    if (IS_POSTGRES_TEST) return;
    try { if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH); } catch { /* noop */ }
  };
}
