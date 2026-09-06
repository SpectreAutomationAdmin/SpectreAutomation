// Payroll-3C-4A (2026-09-09) — ensure the partial unique index on
// PayrollBatchComponentSnapshot exists in whatever DB is connected.
//
// Prisma cannot express a `WHERE column IS NOT NULL` partial unique
// index in the schema (it renders a plain index only). Prod runs the
// canonical Postgres migration
// (prisma-postgres/migrations/20260909_payroll_3c4a_recurring_snapshot_partial_unique).
// Dev SQLite is re-synced with `prisma db push`, which does NOT
// carry the raw migration. Run this script after any `db push` or
// `db:reset` to restore the guarantee.
//
// Both Postgres and SQLite support partial unique indexes with the
// same syntax, so a single DDL works everywhere.
//
// Idempotent — safe to rerun.

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollBatchComponentSnapshot_recurring_assignment_unique"
ON "PayrollBatchComponentSnapshot" ("batchEmployeeId", "sourceAssignmentId")
WHERE "sourceAssignmentId" IS NOT NULL;
`;

async function main() {
  await prisma.$executeRawUnsafe(DDL);
  console.log("Payroll-3C-4A partial unique index ensured.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
