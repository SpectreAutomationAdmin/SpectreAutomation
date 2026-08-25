// HR mobile-hotfix (2026-08-30) — repair employees created before
// the alwaysCreate guard landed. Idempotent: iterates Employee rows
// with zero EmployeeEmploymentAssignment records and provisions a
// PRIMARY assignment from whatever legacy fields exist (department /
// position / employmentType / hireDate / expectedStartDate).
//
// Usage:
//   node scripts/hr-repair-missing-primary-assignments.mjs                 # dry-run
//   node scripts/hr-repair-missing-primary-assignments.mjs --commit        # apply
//   node scripts/hr-repair-missing-primary-assignments.mjs --commit --club=<slug>
//
// Never runs against production. Report is safe to paste — no SIN,
// no banking, no personal data beyond employee number + name.

import { PrismaClient } from "@prisma/client";

const args = new Set(process.argv.slice(2));
const commit = args.has("--commit");
const clubSlugMatch = process.argv.find((a) => a.startsWith("--club="));
const clubSlug = clubSlugMatch ? clubSlugMatch.split("=")[1] : null;

const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "SEASONAL", "CONTRACT"];

const prisma = new PrismaClient();

async function main() {
  const clubs = clubSlug
    ? await prisma.club.findMany({ where: { slug: clubSlug } })
    : await prisma.club.findMany();
  console.log(`Scanning ${clubs.length} club(s). Mode: ${commit ? "COMMIT" : "DRY-RUN"}\n`);

  let scanned = 0;
  let repaired = 0;
  let skippedHasAssignment = 0;
  for (const club of clubs) {
    const employees = await prisma.employee.findMany({
      where: { clubId: club.id },
      select: {
        id: true, clubId: true, employeeNumber: true, firstName: true, lastName: true,
        departmentId: true, positionId: true, managerEmployeeId: true,
        employmentType: true, hireDate: true, expectedStartDate: true, createdAt: true,
      },
    });
    for (const emp of employees) {
      scanned++;
      const existing = await prisma.employeeEmploymentAssignment.findFirst({
        where: { employeeId: emp.id }, select: { id: true },
      });
      if (existing) { skippedHasAssignment++; continue; }
      const effectiveFrom = emp.hireDate ?? emp.expectedStartDate ?? emp.createdAt;
      const employmentType = emp.employmentType && EMPLOYMENT_TYPES.includes(emp.employmentType)
        ? emp.employmentType : "FULL_TIME";
      console.log(`  Repair: club="${club.slug}" employee="${emp.employeeNumber} ${emp.firstName} ${emp.lastName}" primary→ dept=${emp.departmentId ?? "-"} pos=${emp.positionId ?? "-"} type=${employmentType} effectiveFrom=${effectiveFrom.toISOString().slice(0,10)}`);
      if (commit) {
        await prisma.employeeEmploymentAssignment.create({
          data: {
            clubId: emp.clubId, employeeId: emp.id,
            role: "PRIMARY",
            departmentId: emp.departmentId,
            positionId: emp.positionId,
            managerEmployeeId: emp.managerEmployeeId,
            employmentType,
            effectiveFrom, effectiveTo: null,
            notes: "HR mobile-hotfix (2026-08-30) — repair of missing PRIMARY assignment; provisioned from legacy Employee fields.",
          },
        });
      }
      repaired++;
    }
  }
  console.log(`\nScanned ${scanned} employees. ${repaired} needed a PRIMARY. ${skippedHasAssignment} already had at least one assignment.`);
  console.log(commit ? "COMMIT complete." : "Dry-run only. Re-run with --commit to apply.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
