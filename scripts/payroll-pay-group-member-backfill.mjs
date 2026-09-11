// Payroll 3A hotfix (2026-09-11) — one-shot backfill for ACTIVE Coulee
// Ridge employees who are missing a PayrollPayGroupMember row.
//
// SAFETY:
//   - reads ONLY: Employee, EmployeeEmploymentAssignment,
//     EmployeeCompensation, PayrollPayGroup, PayrollPayGroupMember
//   - does NOT read: SIN, banking, TD1, compensation amounts
//   - writes ONLY new PayrollPayGroupMember rows
//   - IDEMPOTENT: skips employees who already have any membership row
//     for the target pay group
//   - runs against Coulee only (COULEE_ID hard-coded)
//   - only fires if the club has exactly one active PayrollPayGroup
//
// USAGE:
//   node scripts/payroll-pay-group-member-backfill.mjs dry-run
//   node scripts/payroll-pay-group-member-backfill.mjs execute
//
// The dry-run prints the table of employees the script would touch;
// execute performs the writes and prints the same table with resulting
// membership ids. Both modes exit non-zero on any error.

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const COULEE_ID = "cmrvdeny7000144372ktmmg9c";
const mode = (process.argv[2] || "").toLowerCase();
if (!["dry-run", "execute"].includes(mode)) {
  console.error("USAGE: node scripts/payroll-pay-group-member-backfill.mjs dry-run|execute");
  process.exit(2);
}

async function main() {
  console.log(`\n== Payroll pay-group member backfill (${mode.toUpperCase()}) ==`);

  const club = await prisma.club.findUnique({ where: { id: COULEE_ID }, select: { id: true, name: true } });
  if (!club) throw new Error(`Coulee club not found: ${COULEE_ID}`);
  console.log(`Tenant: ${club.name} (${club.id})`);

  const payGroups = await prisma.payrollPayGroup.findMany({
    where: { clubId: COULEE_ID, active: true },
    select: { id: true, code: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  if (payGroups.length !== 1) {
    throw new Error(`Refusing to backfill: expected exactly 1 active pay group, found ${payGroups.length}`);
  }
  const payGroup = payGroups[0];
  console.log(`Pay Group: ${payGroup.name} (${payGroup.code} · ${payGroup.id})\n`);

  // Enumerate every ACTIVE employee at Coulee lacking any membership row for this pay group.
  const employees = await prisma.employee.findMany({
    where: {
      clubId: COULEE_ID,
      employeeLifecycle: "ACTIVE",
      NOT: { payrollPayGroupMemberships: { some: { payGroupId: payGroup.id } } },
    },
    select: {
      id: true, firstName: true, lastName: true, hireDate: true,
      employmentAssignments: {
        where: { OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] },
        orderBy: { effectiveFrom: "asc" },
        select: { effectiveFrom: true },
        take: 1,
      },
      compensations: {
        where: { OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] },
        orderBy: { effectiveFrom: "asc" },
        select: { effectiveFrom: true },
        take: 1,
      },
    },
  });

  const now = new Date();
  const plan = employees.map((e) => {
    let effectiveFrom = null;
    let source = "";
    if (e.hireDate) { effectiveFrom = e.hireDate; source = "EMPLOYEE_HIRE_DATE"; }
    else if (e.employmentAssignments[0]?.effectiveFrom) {
      effectiveFrom = e.employmentAssignments[0].effectiveFrom;
      source = "EARLIEST_ACTIVE_EMPLOYMENT_ASSIGNMENT";
    }
    else if (e.compensations[0]?.effectiveFrom) {
      effectiveFrom = e.compensations[0].effectiveFrom;
      source = "EARLIEST_ACTIVE_COMPENSATION";
    }
    else { effectiveFrom = now; source = "BACKFILL_NOW"; }
    return {
      employeeId: e.id,
      displayName: `${e.firstName} ${e.lastName}`.trim(),
      payGroupId: payGroup.id,
      effectiveFromIso: effectiveFrom.toISOString(),
      effectiveFromSource: source,
    };
  });

  console.log(`Plan (${plan.length} employees):`);
  for (const row of plan) {
    console.log(`  - ${row.displayName.padEnd(24)} eff=${row.effectiveFromIso.slice(0,10)}  src=${row.effectiveFromSource}  (empId=${row.employeeId})`);
  }
  if (plan.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  if (mode === "dry-run") {
    console.log("\nDry-run only; no writes performed.");
    return;
  }

  // execute
  let created = 0, skipped = 0;
  for (const row of plan) {
    const existing = await prisma.payrollPayGroupMember.findFirst({
      where: { clubId: COULEE_ID, payGroupId: payGroup.id, employeeId: row.employeeId },
      select: { id: true },
    });
    if (existing) { skipped++; continue; }
    const created_ = await prisma.payrollPayGroupMember.create({
      data: {
        clubId: COULEE_ID,
        payGroupId: payGroup.id,
        employeeId: row.employeeId,
        effectiveFrom: new Date(row.effectiveFromIso),
        effectiveTo: null,
        notes: `Auto-assigned by 3A backfill (source: ${row.effectiveFromSource}).`,
        createdByUserId: null, // system backfill; audit is scripted here, not via audit()
      },
      select: { id: true },
    });
    console.log(`  + created ${created_.id} for ${row.displayName}`);
    created++;
  }
  console.log(`\nDone. created=${created} already_member=${skipped}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
