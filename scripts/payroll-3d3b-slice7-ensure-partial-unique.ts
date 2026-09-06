// Payroll-3D-3B Slice 7 (2026-09-06) — ensure the timesheet-approval
// scope partial unique on WorkIntakeOrigin exists in whatever DB is
// connected. Mirrors scripts/payroll-3d3b-ensure-partial-unique.ts.

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS "WorkIntakeOrigin_timesheet_approval_primary_key"
  ON "WorkIntakeOrigin" ("clubId", "kind", "referenceId")
  WHERE "role" = 'PRIMARY'
    AND "kind" IN (
      'PAYROLL_TIMESHEET_APPROVAL',
      'PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP'
    );
`;

async function main() {
  await prisma.$executeRawUnsafe(DDL);
  console.log("Payroll-3D-3B Slice 7 scope-approval partial unique ensured.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
