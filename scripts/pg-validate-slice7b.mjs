// Payroll-3D-3B Slice 7C (2026-09-06) — Postgres validator for the
// shared scope-version CAS.
//
// Mirrors scripts/pg-validate.mjs but scopes the test run to the
// Slice 7B concurrency suite + the Slice 7C attribution/currency
// tests. Proves that the CAS + upsert paths compose correctly under
// REAL PostgreSQL transaction semantics — no SQLSTATE 25P02, no
// P2002 poisoning, atomic ON CONFLICT DO UPDATE for ensureScopeState
// / bumpScopeVersion, clean updateMany count=0 for casScopeVersion.
//
// Run: node scripts/pg-validate-slice7b.mjs

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const DATA_DIR = path.join(root, ".pgvalidate-slice7b", "data");
const PG_PORT = 55433;
const PG_USER = "spectre_test_7c";
const PG_PW = "spectre_test_password";
const PG_DB = "spectre_test_7c";

if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: PG_USER,
  password: PG_PW,
  port: PG_PORT,
  persistent: false,
});

console.log("[pg7c] initialising cluster");
await pg.initialise();
console.log("[pg7c] starting server");
await pg.start();
console.log("[pg7c] creating database");
await pg.createDatabase(PG_DB);

const DATABASE_URL = `postgresql://${PG_USER}:${PG_PW}@localhost:${PG_PORT}/${PG_DB}`;
console.log("[pg7c] DATABASE_URL", DATABASE_URL);

const schemaSrc = path.join(root, "prisma", "schema.prisma");
const schemaPg = path.join(root, ".pgvalidate-slice7b", "schema.postgres.prisma");
mkdirSync(path.dirname(schemaPg), { recursive: true });
const schema = readFileSync(schemaSrc, "utf8").replace(
  'provider = "sqlite"',
  'provider = "postgresql"',
);
writeFileSync(schemaPg, schema, "utf8");

const migDir = path.join(root, ".pgvalidate-slice7b", "migrations");
if (existsSync(migDir)) rmSync(migDir, { recursive: true, force: true });
mkdirSync(migDir, { recursive: true });
writeFileSync(path.join(migDir, "migration_lock.toml"), 'provider = "postgresql"\n', "utf8");
mkdirSync(path.join(migDir, "0_baseline_pg"), { recursive: true });

console.log("[prisma] generating Postgres baseline migration");
const diffSql = execSync(
  `npx prisma migrate diff --from-empty --to-schema-datamodel ${schemaPg} --script`,
  { cwd: root, encoding: "utf8" },
);
writeFileSync(path.join(migDir, "0_baseline_pg", "migration.sql"), diffSql, "utf8");

console.log("[prisma] migrate deploy");
execSync(
  `npx prisma migrate deploy --schema ${schemaPg}`,
  { cwd: root, env: { ...process.env, DATABASE_URL }, stdio: "inherit" },
);

console.log("[prisma] generate client");
execSync(
  `npx prisma generate --schema ${schemaPg}`,
  { cwd: root, env: { ...process.env, DATABASE_URL }, stdio: "inherit" },
);

console.log("[test] Slice 7B/7C CAS suite against REAL PostgreSQL");
let exitCode = 0;
try {
  execSync(
    `npx vitest run tests/work-intake/slice7b-scope-version-cas.test.ts tests/work-intake/slice7c-postgres-attribution.test.ts --reporter=default`,
    { cwd: root, env: { ...process.env, DATABASE_URL }, stdio: "inherit" },
  );
  console.log("[pg7c] SUCCESS — Slice 7B/7C tests pass against real Postgres");
} catch (e) {
  console.error("[pg7c] FAILURE — Slice 7B/7C tests failed on Postgres");
  exitCode = 1;
}

// Restore the sqlite Prisma client so subsequent local dev + local
// test runs don't accidentally target the (now-stopped) embedded
// Postgres — the earlier `prisma generate --schema=...postgres...`
// leaves a Postgres-flavoured client in node_modules until we
// regenerate against the checked-in sqlite schema.
try {
  console.log("[pg7c] restoring sqlite Prisma client");
  execSync(`npx prisma generate`, { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[pg7c] failed to regenerate sqlite client — run `npx prisma generate` manually before running local tests");
}

await pg.stop();
console.log("[pg7c] stopped");
process.exit(exitCode);
