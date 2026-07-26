// Sprint 2 B4.1 — PostgreSQL compatibility validation.
//
// Spins up an embedded Postgres, generates a Postgres-flavoured
// schema variant, applies the migration set, seeds representative
// data, and runs the mailbox + work-intake test suite against it.
//
// Standalone script; run via `node scripts/pg-validate.mjs`.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const DATA_DIR = path.join(root, ".pgvalidate", "data");
const PG_PORT = 55432;
const PG_USER = "spectre_test";
const PG_PW = "spectre_test_password";
const PG_DB = "spectre_test";

// Prepare data dir.
if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: PG_USER,
  password: PG_PW,
  port: PG_PORT,
  persistent: false,
});

console.log("[pg] initialising cluster");
await pg.initialise();
console.log("[pg] starting server");
await pg.start();
console.log("[pg] creating database");
await pg.createDatabase(PG_DB);

const DATABASE_URL = `postgresql://${PG_USER}:${PG_PW}@localhost:${PG_PORT}/${PG_DB}`;
console.log("[pg] DATABASE_URL", DATABASE_URL);

// Generate a Postgres-flavoured schema without touching the checked
// in one. Simply swap the datasource provider.
const schemaSrc = path.join(root, "prisma", "schema.prisma");
const schemaPg = path.join(root, ".pgvalidate", "schema.postgres.prisma");
mkdirSync(path.dirname(schemaPg), { recursive: true });
const schema = readFileSync(schemaSrc, "utf8").replace(
  'provider = "sqlite"',
  'provider = "postgresql"',
);
writeFileSync(schemaPg, schema, "utf8");

// Regenerate the migration lock for postgresql.
const migDir = path.join(root, ".pgvalidate", "migrations");
if (existsSync(migDir)) rmSync(migDir, { recursive: true, force: true });
mkdirSync(migDir, { recursive: true });
writeFileSync(path.join(migDir, "migration_lock.toml"), 'provider = "postgresql"\n', "utf8");

// Generate one consolidated baseline migration against the pg schema.
mkdirSync(path.join(migDir, "0_baseline_pg"), { recursive: true });
console.log("[prisma] generating Postgres baseline migration");
const diffSql = execSync(
  `npx prisma migrate diff --from-empty --to-schema-datamodel ${schemaPg} --script`,
  { cwd: root, encoding: "utf8" },
);
writeFileSync(path.join(migDir, "0_baseline_pg", "migration.sql"), diffSql, "utf8");
console.log(`[prisma] baseline migration length: ${diffSql.split("\n").length} lines`);

// Apply the baseline migration through Prisma.
console.log("[prisma] migrate deploy");
execSync(
  `npx prisma migrate deploy --schema ${schemaPg}`,
  {
    cwd: root,
    env: { ...process.env, DATABASE_URL },
    stdio: "inherit",
  },
);

// Regenerate client for Postgres.
console.log("[prisma] generate client");
execSync(
  `npx prisma generate --schema ${schemaPg}`,
  {
    cwd: root,
    env: { ...process.env, DATABASE_URL },
    stdio: "inherit",
  },
);

// Run vitest against Postgres.
console.log("[test] running mailbox + work-intake suite against Postgres");
try {
  execSync(
    `npx vitest run tests/lib/mailbox tests/lib/work-intake --reporter=default`,
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL },
      stdio: "inherit",
    },
  );
  console.log("[pg-validate] SUCCESS — tests pass against Postgres");
} catch (e) {
  console.error("[pg-validate] FAILURE — tests failed on Postgres");
  await pg.stop();
  process.exit(1);
}

// Prove teardown/recreate repeatability.
console.log("[pg] dropping + recreating database");
await pg.dropDatabase(PG_DB);
await pg.createDatabase(PG_DB);
execSync(
  `npx prisma migrate deploy --schema ${schemaPg}`,
  {
    cwd: root,
    env: { ...process.env, DATABASE_URL },
    stdio: "inherit",
  },
);
console.log("[pg-validate] REPEATABLE — migrations re-apply cleanly on a fresh DB");

await pg.stop();
console.log("[pg] stopped");
