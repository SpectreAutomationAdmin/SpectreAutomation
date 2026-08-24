// HR-2C Employment Corrections (2026-08-24) — Backfill legacy
// employees into the canonical EmployeeEmploymentAssignment model.
//
// Idempotent. Safe for staging and eventual production.
//
// For every Employee with ZERO EmployeeEmploymentAssignment rows,
// creates a single PRIMARY assignment from the employee's legacy
// Employee fields (departmentId, positionId, employmentType,
// managerEmployeeId), using hireDate → expectedStartDate → createdAt
// as the effectiveFrom fallback. Employees with any existing
// assignment are skipped.
//
// Employees whose legacy fields are entirely blank (no dept, no
// position, no employmentType) are also skipped — do NOT fabricate
// a synthetic role from nothing.
//
// Runs from inside the deployed container:
//   flyctl ssh sftp put scripts/hr-2c-employment-backfill.mjs \
//     //app/hr-2c-employment-backfill.mjs --app spectre-staging
//   flyctl ssh console --app spectre-staging --command \
//     "sh -c 'cd /app && DATABASE_URL=\"\$DIRECT_DATABASE_URL\" node hr-2c-employment-backfill.mjs'"
//
// Emits one JSON summary line at exit.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "SEASONAL", "CONTRACT"];

async function main() {
  const employees = await prisma.employee.findMany({
    where: { status: { not: "TERMINATED" } },
    select: {
      id: true,
      clubId: true,
      employeeNumber: true,
      departmentId: true,
      positionId: true,
      managerEmployeeId: true,
      employmentType: true,
      hireDate: true,
      expectedStartDate: true,
      createdAt: true,
    },
  });

  let considered = 0;
  let alreadyHadAssignment = 0;
  let skippedNoLegacyData = 0;
  let backfilled = 0;
  const errors = [];

  for (const e of employees) {
    considered++;
    try {
      const existing = await prisma.employeeEmploymentAssignment.findFirst({
        where: { employeeId: e.id },
        select: { id: true },
      });
      if (existing) {
        alreadyHadAssignment++;
        continue;
      }
      const hasAnyLegacyData =
        e.departmentId != null ||
        e.positionId != null ||
        (e.employmentType != null && e.employmentType.length > 0);
      if (!hasAnyLegacyData) {
        skippedNoLegacyData++;
        continue;
      }
      const employmentType =
        e.employmentType && EMPLOYMENT_TYPES.includes(e.employmentType)
          ? e.employmentType
          : "FULL_TIME";
      const effectiveFrom = e.hireDate ?? e.expectedStartDate ?? e.createdAt;
      await prisma.employeeEmploymentAssignment.create({
        data: {
          clubId: e.clubId,
          employeeId: e.id,
          role: "PRIMARY",
          departmentId: e.departmentId,
          positionId: e.positionId,
          managerEmployeeId: e.managerEmployeeId,
          employmentType,
          effectiveFrom,
          effectiveTo: null,
          notes: "Backfilled by hr-2c-employment-backfill.mjs.",
          createdByUserId: null,
        },
      });
      backfilled++;
    } catch (err) {
      errors.push({ employeeId: e.id, employeeNumber: e.employeeNumber, error: String(err) });
    }
  }

  console.log(JSON.stringify({
    ok: errors.length === 0,
    considered,
    alreadyHadAssignment,
    skippedNoLegacyData,
    backfilled,
    errors,
  }, null, 2));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(JSON.stringify({ ok: false, error: String(e) }));
    await prisma.$disconnect();
    process.exit(1);
  });
