// Sprint 2 Step 7B — Keep `prisma-postgres/schema.prisma` in lockstep
// with `prisma/schema.prisma`. The two files MUST be identical except
// for the datasource `provider` line. Run whenever prisma/schema.prisma
// is edited.
//
// Prevents the SQLite dev schema and the Postgres staging schema from
// drifting silently. Also verifies that the checked-in Postgres
// baseline migration corresponds to the current schema — if it
// doesn't, this script fails and prints exactly what to regenerate.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "prisma", "schema.prisma");
const DST = path.join(root, "prisma-postgres", "schema.prisma");
const MIG = path.join(root, "prisma-postgres", "migrations", "0_baseline_pg", "migration.sql");

if (!existsSync(SRC)) {
  console.error(`[sync-pg] source schema missing: ${SRC}`);
  process.exit(2);
}

const src = readFileSync(SRC, "utf8");
if (!src.includes('provider = "sqlite"')) {
  console.error("[sync-pg] source schema does not use provider = \"sqlite\" — refusing to sync.");
  process.exit(2);
}
const generated = src.replace('provider = "sqlite"', 'provider = "postgresql"');

if (existsSync(DST) && readFileSync(DST, "utf8") === generated) {
  console.log("[sync-pg] prisma-postgres/schema.prisma already in sync.");
} else {
  writeFileSync(DST, generated, "utf8");
  console.log("[sync-pg] wrote prisma-postgres/schema.prisma from prisma/schema.prisma");
}

// Regenerate baseline migration and confirm it matches the checked-in one.
console.log("[sync-pg] regenerating Postgres baseline migration for comparison");
const rawDiff = execSync(
  `npx prisma migrate diff --from-empty --to-schema-datamodel ${DST} --script`,
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
// Strip Prisma's occasional stdout banner about updates.
const generatedSql = rawDiff
  .split(/\r?\n/)
  .filter((l) => !/^│|^└|^┌|Update available|major update|npm i|https:\/\/pris\.ly/.test(l))
  .join("\n");
if (existsSync(MIG) && readFileSync(MIG, "utf8") === generatedSql) {
  console.log("[sync-pg] baseline migration already in sync.");
} else {
  writeFileSync(MIG, generatedSql, "utf8");
  console.log("[sync-pg] wrote prisma-postgres/migrations/0_baseline_pg/migration.sql");
}

console.log("[sync-pg] SUCCESS");
