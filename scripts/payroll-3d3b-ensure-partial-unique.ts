// Payroll-3D-3B Slice 1 (2026-09-06) — ensure the correction-review
// partial unique on WorkIntakeOrigin exists in whatever DB is
// connected.
//
// Prisma cannot express partial unique with an IN predicate in
// schema.prisma. Prod runs the canonical Postgres migration
// (prisma-postgres/migrations/20260911_payroll_3d3b_correction_review_partial_unique).
// Dev SQLite is re-synced with `prisma db push`, which does NOT carry
// raw-SQL migrations. Run this script after any `db push` or
// `db:reset` to restore the invariant.
//
// Postgres and SQLite (v3.8+) share the same partial-index DDL, so a
// single statement works everywhere.
//
// Idempotent — safe to rerun.

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS "WorkIntakeOrigin_timeclock_correction_primary_key"
  ON "WorkIntakeOrigin" ("clubId", "kind", "referenceId")
  WHERE "role" = 'PRIMARY'
    AND "kind" IN (
      'TIMECLOCK_CORRECTION_REVIEW',
      'TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP'
    );
`;

async function main() {
  await prisma.$executeRawUnsafe(DDL);
  console.log("Payroll-3D-3B partial unique index ensured.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
