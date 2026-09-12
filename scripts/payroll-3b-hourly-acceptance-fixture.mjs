// Payroll 3B acceptance-hotfix (2026-09-12) — synthetic hourly-employee
// acceptance fixture for Coulee Ridge staging.
//
// Creates the minimum Coulee-scoped rows needed to drive the FULL
// clock-to-payroll flow through the UI:
//   • Grounds manager employee record (linked to the existing
//     grounds.manager@fixture.spectre.test user).
//   • Hourly employee "Riley Reconcile" with:
//       - timekeepingMethod = CLOCK_REQUIRED
//       - EmployeeEmploymentAssignment on the Grounds department
//         with managerEmployeeId set (so the manager path resolves)
//       - HOURLY EmployeeCompensation
//       - PayrollPayGroupMember on the Coulee Bi-Weekly pay group
//   • Two completed CLOCK_IN/CLOCK_OUT sessions in the Aug 30 –
//     Sep 12 founder pay period so a manager has real reviewable
//     time on the Approvals tab.
//
// Idempotent: skips rows that already exist. Never touches real
// employee data. Only writes rows tagged with the fixture-only
// email domain (`@fixture.spectre.test`).

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const COULEE            = "cmrvdeny7000144372ktmmg9c";
const GROUNDS_DEPT_ID   = "cms26rrl3000q3dssktern2oq";
const BW_PAY_GROUP_ID   = "cmtjc2u2b000bgnjudym510so";
const FOUNDER_PP_ID     = "cmtjc2wud001bgnjugkqrdz2r"; // Aug 30 – Sep 12
const GROUNDS_MGR_EMAIL = "grounds.manager@fixture.spectre.test";
const RILEY_EMAIL       = "riley.reconcile@fixture.spectre.test";

const utc = (y, m, d, hh = 0, mm = 0) => new Date(Date.UTC(y, m - 1, d, hh, mm));

async function main() {
  console.log(`\n== Payroll 3B hourly-acceptance fixture @ ${new Date().toISOString()} ==`);

  // ---- Grounds manager Employee record --------------------------------
  const mgrUser = await prisma.user.findFirst({
    where: { email: GROUNDS_MGR_EMAIL },
    select: { id: true },
  });
  if (!mgrUser) {
    throw new Error(`Grounds manager user ${GROUNDS_MGR_EMAIL} not found on Coulee staging.`);
  }
  let mgrEmployee = await prisma.employee.findFirst({
    where: { clubId: COULEE, userId: mgrUser.id },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!mgrEmployee) {
    mgrEmployee = await prisma.employee.create({
      data: {
        clubId: COULEE, userId: mgrUser.id,
        firstName: "Grounds", lastName: "Manager (Fixture)",
        employeeNumber: `E-GRD-MGR-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        hireDate: utc(2026, 1, 1),
        employeeLifecycle: "ACTIVE",
        timekeepingMethod: "SALARIED_NO_CLOCK",
      },
      select: { id: true, firstName: true, lastName: true },
    });
    console.log(`  + Created Grounds Manager employee: ${mgrEmployee.id}`);
  } else {
    console.log(`  = Grounds Manager employee already exists: ${mgrEmployee.id}`);
  }

  // ---- Riley Reconcile hourly employee --------------------------------
  let riley = await prisma.employee.findFirst({
    where: { clubId: COULEE, personalEmail: RILEY_EMAIL },
    select: { id: true },
  });
  if (!riley) {
    riley = await prisma.employee.create({
      data: {
        clubId: COULEE,
        firstName: "Riley", lastName: "Reconcile",
        personalEmail: RILEY_EMAIL,
        employeeNumber: `E-RILEY-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        hireDate: utc(2026, 8, 24),
        dateOfBirth: utc(1995, 4, 12),
        employeeLifecycle: "ACTIVE",
        timekeepingMethod: "CLOCK_REQUIRED",
      },
      select: { id: true },
    });
    console.log(`  + Created hourly employee Riley Reconcile: ${riley.id}`);
  } else {
    console.log(`  = Riley Reconcile already exists: ${riley.id}`);
  }

  // ---- Assignment on Grounds with managerEmployeeId -------------------
  let asn = await prisma.employeeEmploymentAssignment.findFirst({
    where: { clubId: COULEE, employeeId: riley.id, role: "PRIMARY", effectiveTo: null },
    select: { id: true, departmentId: true, managerEmployeeId: true },
  });
  if (!asn) {
    asn = await prisma.employeeEmploymentAssignment.create({
      data: {
        clubId: COULEE, employeeId: riley.id, role: "PRIMARY",
        departmentId: GROUNDS_DEPT_ID,
        managerEmployeeId: mgrEmployee.id,
        employmentType: "PART_TIME",
        effectiveFrom: utc(2026, 8, 24),
      },
      select: { id: true, departmentId: true, managerEmployeeId: true },
    });
    console.log(`  + Created Riley PRIMARY assignment on Grounds: ${asn.id}`);
  } else if (asn.departmentId !== GROUNDS_DEPT_ID || asn.managerEmployeeId !== mgrEmployee.id) {
    await prisma.employeeEmploymentAssignment.update({
      where: { id: asn.id },
      data: { departmentId: GROUNDS_DEPT_ID, managerEmployeeId: mgrEmployee.id },
    });
    console.log(`  ~ Repointed Riley PRIMARY assignment: dept=Grounds, manager=${mgrEmployee.id}`);
  } else {
    console.log(`  = Riley PRIMARY assignment already correct: ${asn.id}`);
  }
  const rileyAssignmentId = asn.id;

  // ---- Hourly compensation --------------------------------------------
  const comp = await prisma.employeeCompensation.findFirst({
    where: { clubId: COULEE, employeeId: riley.id },
  });
  if (!comp) {
    await prisma.employeeCompensation.create({
      data: {
        clubId: COULEE, employeeId: riley.id,
        assignmentId: null, // employee-wide, matches HR write path
        cadence: "HOURLY",
        rate: "18.00", currency: "CAD",
        effectiveFrom: utc(2026, 8, 24),
      },
    });
    console.log(`  + Created HOURLY comp $18.00/hr`);
  } else {
    console.log(`  = HOURLY comp already exists`);
  }

  // ---- PayrollPayGroupMember on Bi-Weekly -----------------------------
  const member = await prisma.payrollPayGroupMember.findFirst({
    where: { clubId: COULEE, employeeId: riley.id, payGroupId: BW_PAY_GROUP_ID },
  });
  if (!member) {
    await prisma.payrollPayGroupMember.create({
      data: {
        clubId: COULEE, employeeId: riley.id, payGroupId: BW_PAY_GROUP_ID,
        effectiveFrom: utc(2026, 8, 24),
      },
    });
    console.log(`  + Assigned Riley to Bi-Weekly pay group`);
  } else {
    console.log(`  = Riley already assigned to Bi-Weekly pay group`);
  }

  // ---- Two completed clock sessions in the founder period -------------
  //
  // Session A: 2026-09-02 09:00 – 17:00 MDT (Sep 02 15:00 – 23:00 UTC)
  // Session B: 2026-09-04 09:00 – 17:00 MDT (Sep 04 15:00 – 23:00 UTC)
  //
  // Inserting TimeClockEvent rows directly is the standard fixture
  // shortcut used in tests/payroll/fixtures — it bypasses the CAS
  // state-machine that would otherwise require pairs to arrive on
  // the wire, but the materialiser will still pair these on read.
  const sessions = [
    { in_: new Date("2026-09-02T15:00:00Z"), out_: new Date("2026-09-02T23:00:00Z") },
    { in_: new Date("2026-09-04T15:00:00Z"), out_: new Date("2026-09-04T23:00:00Z") },
  ];
  for (const s of sessions) {
    const existing = await prisma.timeClockEvent.findFirst({
      where: {
        clubId: COULEE, employeeId: riley.id,
        kind: "CLOCK_IN", occurredAt: s.in_,
      },
    });
    if (existing) {
      console.log(`  = Clock-in already present @ ${s.in_.toISOString()}`);
      continue;
    }
    await prisma.timeClockEvent.create({
      data: {
        clubId: COULEE, employeeId: riley.id,
        employmentAssignmentId: rileyAssignmentId,
        kind: "CLOCK_IN", occurredAt: s.in_,
        source: "EMPLOYEE_PORTAL",
      },
    });
    await prisma.timeClockEvent.create({
      data: {
        clubId: COULEE, employeeId: riley.id,
        employmentAssignmentId: rileyAssignmentId,
        kind: "CLOCK_OUT", occurredAt: s.out_,
        source: "EMPLOYEE_PORTAL",
      },
    });
    console.log(`  + Session ${s.in_.toISOString()} – ${s.out_.toISOString()} (8h)`);
  }

  console.log(`\n== Summary ==`);
  console.log(`  Riley Reconcile:     ${riley.id}`);
  console.log(`  Grounds Manager:     ${mgrEmployee.id} (user=${mgrUser.id})`);
  console.log(`  Assignment:          ${rileyAssignmentId} (Grounds, PRIMARY, managerEmployeeId set)`);
  console.log(`  Pay group:           ${BW_PAY_GROUP_ID} (Bi-Weekly)`);
  console.log(`  Pay period:          ${FOUNDER_PP_ID} (Aug 30 – Sep 12)`);
  console.log(`  Clock sessions:      2 × 8h in the founder period`);
  console.log(`\nNext step: sign in as ${GROUNDS_MGR_EMAIL} OR as Payroll Admin,`);
  console.log(`open /app/admin/payroll/time?payPeriodId=${FOUNDER_PP_ID}&departmentId=${GROUNDS_DEPT_ID}&scope=timesheet`);
  console.log(`to materialize Riley's timesheet and drive the approve → freeze flow.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
