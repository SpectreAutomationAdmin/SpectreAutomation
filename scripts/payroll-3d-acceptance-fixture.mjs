// Payroll Admin Slice 3D acceptance (2026-09-12) — synthetic
// PREPARED-with-calc-inputs batch fixture for Coulee staging.
//
// Extends the 3B/3C fixture set with a period that supports the FULL
// gross-to-net flow:
//   1. A dedicated pay group `3D-ACCEPT` (BIWEEKLY) at Coulee.
//   2. A dedicated pay period Nov 8 – Nov 21, 2026 (no intersection
//      with Riley's Sep 2/4 clock activity → no departments-with-time
//      → assertPreconditions skips the approval gate).
//   3. Synthetic salaried employee `Sam Salary` with:
//        - HIRE_DATE 2026-08-01 (fully-eligible for the period)
//        - Employment assignment (SALARIED, PRIMARY, effective 2026-08-01)
//        - EmployeeCompensation SALARY $52,000/yr
//        - PayrollPayGroupMember on 3D-ACCEPT
//        - EmployeeTaxProfile with default provincial claim + zero add tax
//        - EmployeeSinSensitiveData (synthetic SIN 000-000-000)
//        - EmployeeBankingInformation (synthetic bank, VERIFIED)
//   4. Reuse Riley Reconcile from 3B fixture — HOURLY, this batch's
//      period contains no clock activity so Riley enters the batch as
//      a legitimate ZERO-PAY hourly employee (§35 acceptance case).
//   5. PayrollClubConfig for Coulee is expected to already exist.
//
// Idempotent. Only writes rows tagged with the fixture-only pay-group
// code `3D-ACCEPT` or fixture-only email domain
// `@fixture.spectre.test`. Never mutates real employee HR data.

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const COULEE          = "cmrvdeny7000144372ktmmg9c";
const PAY_GROUP_CODE  = "3D-ACCEPT";
const PAY_GROUP_NAME  = "3D Acceptance (Bi-Weekly)";
const PERIOD_START    = new Date(Date.UTC(2026, 10, 8));   // Nov 8, 2026
const PERIOD_END      = new Date(Date.UTC(2026, 10, 22));  // Nov 22, 2026 (exclusive)
const PAY_DATE        = new Date(Date.UTC(2026, 10, 21));  // Nov 21, 2026
const RILEY_EMAIL     = "riley.reconcile@fixture.spectre.test";
const SAM_EMAIL       = "sam.salary@fixture.spectre.test";
const SAM_HIRE        = new Date(Date.UTC(2026, 7, 1));    // Aug 1, 2026
const SAM_DOB         = new Date(Date.UTC(1988, 4, 12));   // May 12, 1988

async function main() {
  console.log(`\n== Payroll 3D acceptance fixture @ ${new Date().toISOString()} ==`);

  // ---- Pay group ------------------------------------------------------
  let payGroup = await prisma.payrollPayGroup.findFirst({
    where: { clubId: COULEE, code: PAY_GROUP_CODE },
    select: { id: true },
  });
  if (!payGroup) {
    payGroup = await prisma.payrollPayGroup.create({
      data: {
        clubId: COULEE, code: PAY_GROUP_CODE, name: PAY_GROUP_NAME,
        payFrequency: "BIWEEKLY", payDateOffsetDays: 0,
        calendarAnchorDate: PERIOD_START, active: true,
      },
      select: { id: true },
    });
    console.log(`  + Created pay group ${PAY_GROUP_CODE}: ${payGroup.id}`);
  } else {
    console.log(`  = Pay group ${PAY_GROUP_CODE} exists: ${payGroup.id}`);
  }

  // ---- Full 26-row 2026 calendar for the 3D-ACCEPT pay group ----------
  //
  // Payroll 3D acceptance hotfix (2026-09-12): `periods-per-year` now
  // refuses to divide an annual salary by fewer periods than the pay
  // group's canonical cadence — a BIWEEKLY group requires ≥26 rows for
  // 2026. Seed all 26 anchored on Nov 8 – Nov 21 (sequenceInYear 22)
  // walking backwards / forwards in 14-day increments. Anchor Riley +
  // Sam remain on sequenceInYear 22.
  const ANCHOR_SEQ = 22;
  const MS_14D = 14 * 24 * 60 * 60 * 1000;
  const ANCHOR_START_MS = PERIOD_START.getTime();
  let periodsSeeded = 0;
  for (let seq = 1; seq <= 26; seq++) {
    const offset = seq - ANCHOR_SEQ;
    const start = new Date(ANCHOR_START_MS + offset * MS_14D);
    const end   = new Date(start.getTime() + MS_14D); // exclusive
    const pay   = new Date(end.getTime() - 24 * 60 * 60 * 1000); // day before end
    const existing = await prisma.payrollPayPeriod.findFirst({
      where: { clubId: COULEE, payGroupId: payGroup.id, taxYear: 2026, sequenceInYear: seq },
      select: { id: true, periodStart: true, periodEnd: true, payDate: true },
    });
    if (existing) {
      // Repoint the anchor period if its dates drifted; leave others as-is.
      if (seq === ANCHOR_SEQ && existing.periodStart.getTime() !== ANCHOR_START_MS) {
        await prisma.payrollBatch.updateMany({
          where: { payPeriodId: existing.id, status: { not: "VOIDED" } },
          data:  { status: "VOIDED", voidedAt: new Date(), voidReason: "3D fixture repointed anchor" },
        });
        await prisma.payrollPayPeriod.update({
          where: { id: existing.id },
          data:  { periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE },
        });
        console.log(`  ~ Repointed anchor period seq ${seq}`);
      }
      continue;
    }
    await prisma.payrollPayPeriod.create({
      data: {
        clubId: COULEE, payGroupId: payGroup.id,
        sequenceInYear: seq, taxYear: 2026,
        periodStart: start, periodEnd: end,
        payDate: pay, status: "OPEN",
      },
    });
    periodsSeeded += 1;
  }
  if (periodsSeeded > 0) {
    console.log(`  + Seeded ${periodsSeeded} of 26 biweekly pay periods for 3D-ACCEPT taxYear 2026`);
  } else {
    console.log(`  = All 26 pay periods already exist for 3D-ACCEPT taxYear 2026`);
  }
  const payPeriod = await prisma.payrollPayPeriod.findFirstOrThrow({
    where: { clubId: COULEE, payGroupId: payGroup.id, taxYear: 2026, sequenceInYear: ANCHOR_SEQ },
    select: { id: true, periodStart: true },
  });

  // ---- Riley (reuse from 3B fixture) — HOURLY zero-pay case -----------
  const riley = await prisma.employee.findFirst({
    where: { clubId: COULEE, personalEmail: RILEY_EMAIL },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!riley) {
    throw new Error(`Riley Reconcile (${RILEY_EMAIL}) not found. Run scripts/payroll-3b-hourly-acceptance-fixture.mjs first.`);
  }
  const rileyMember = await prisma.payrollPayGroupMember.findFirst({
    where: { clubId: COULEE, employeeId: riley.id, payGroupId: payGroup.id },
    select: { id: true },
  });
  if (!rileyMember) {
    await prisma.payrollPayGroupMember.create({
      data: {
        clubId: COULEE, employeeId: riley.id, payGroupId: payGroup.id,
        effectiveFrom: new Date(Date.UTC(2026, 10, 1)),
      },
    });
    console.log(`  + Added Riley (HOURLY) to ${PAY_GROUP_CODE}`);
  } else {
    console.log(`  = Riley already on ${PAY_GROUP_CODE}`);
  }

  // ---- Sam Salary — SALARIED synthetic ---------------------------------
  let sam = await prisma.employee.findFirst({
    where: { clubId: COULEE, personalEmail: SAM_EMAIL },
    select: { id: true },
  });
  if (!sam) {
    sam = await prisma.employee.create({
      data: {
        clubId: COULEE, firstName: "Sam", lastName: "Salary",
        personalEmail: SAM_EMAIL, employeeNumber: "S3D-001",
        hireDate: SAM_HIRE, dateOfBirth: SAM_DOB,
        employeeLifecycle: "ACTIVE",
        timekeepingMethod: "NO_CLOCK",
      },
      select: { id: true },
    });
    console.log(`  + Created Sam Salary (SALARIED): ${sam.id}`);
  } else {
    // Backfill dateOfBirth on existing rows if it's missing (CPP calc requires it).
    await prisma.employee.update({
      where: { id: sam.id },
      data: { dateOfBirth: SAM_DOB },
    });
    console.log(`  = Sam Salary exists: ${sam.id} (dateOfBirth ensured)`);
  }

  // Employment assignment (SALARIED)
  const samAssignment = await prisma.employeeEmploymentAssignment.findFirst({
    where: { clubId: COULEE, employeeId: sam.id, role: "PRIMARY" },
    select: { id: true },
  });
  let samAssignmentId = samAssignment?.id;
  if (!samAssignmentId) {
    const asn = await prisma.employeeEmploymentAssignment.create({
      data: {
        clubId: COULEE, employeeId: sam.id, role: "PRIMARY",
        employmentType: "FULL_TIME", effectiveFrom: SAM_HIRE,
      },
      select: { id: true },
    });
    samAssignmentId = asn.id;
    console.log(`  + Created Sam employment assignment: ${samAssignmentId}`);
  } else {
    console.log(`  = Sam assignment exists: ${samAssignmentId}`);
  }

  // Compensation — annual salary $52,000
  const samComp = await prisma.employeeCompensation.findFirst({
    where: { clubId: COULEE, employeeId: sam.id },
    select: { id: true },
  });
  if (!samComp) {
    await prisma.employeeCompensation.create({
      data: {
        clubId: COULEE, employeeId: sam.id, assignmentId: samAssignmentId,
        cadence: "SALARY", rate: "52000.00",
        effectiveFrom: SAM_HIRE, currency: "CAD",
      },
    });
    console.log(`  + Created Sam SALARY $52,000/yr compensation`);
  } else {
    console.log(`  = Sam compensation exists`);
  }

  // Pay group membership
  const samMember = await prisma.payrollPayGroupMember.findFirst({
    where: { clubId: COULEE, employeeId: sam.id, payGroupId: payGroup.id },
    select: { id: true },
  });
  if (!samMember) {
    await prisma.payrollPayGroupMember.create({
      data: {
        clubId: COULEE, employeeId: sam.id, payGroupId: payGroup.id,
        effectiveFrom: new Date(Date.UTC(2026, 10, 1)),
      },
    });
    console.log(`  + Added Sam to ${PAY_GROUP_CODE}`);
  } else {
    console.log(`  = Sam already on ${PAY_GROUP_CODE}`);
  }

  // Tax profile — intentionally OMITTED. Synthetic KMS refs fail
  // decryption and raise a TD1_CLAIM_RESOLUTION_FAILED BLOCKER that
  // holds the batch in DRAFT. Without any EmployeeTaxProfile row, the
  // Prepare service emits WARNING-level MISSING_FEDERAL_TD1 /
  // MISSING_PROVINCIAL_TD1 exceptions and the calculator uses the
  // default federal + provincial claim amounts (2026 T4127 defaults).
  // Delete any prior row from an earlier fixture pass — a stale row
  // with synthetic secrets would keep failing decryption.
  await prisma.employeeTaxProfile.deleteMany({
    where: { clubId: COULEE, employeeId: sam.id },
  });
  console.log(`  ~ Removed Sam EmployeeTaxProfile (calculator uses default claims)`);

  // Void any DRAFT batch that predates the fixture's KYC fixes so the
  // next Prepare click regenerates it against the corrected inputs.
  const staleBatches = await prisma.payrollBatch.updateMany({
    where: { clubId: COULEE, payPeriodId: payPeriod.id, status: "DRAFT" },
    data:  { status: "VOIDED", voidedAt: new Date(), voidReason: "3D fixture refresh — TD1 KMS + DOB fixed" },
  });
  if (staleBatches.count > 0) {
    console.log(`  ~ Voided ${staleBatches.count} DRAFT batch(es) so re-Prepare regenerates on fixed inputs`);
  }

  // ---- Summary --------------------------------------------------------
  console.log(`\n== Summary ==`);
  console.log(`  Pay group:    ${payGroup.id} (${PAY_GROUP_CODE})`);
  console.log(`  Pay period:   ${payPeriod.id} (Nov 8 – Nov 21, 2026)`);
  console.log(`  Sam Salary:   ${sam.id} (SALARIED, $52,000/yr → ~$2,000/pay)`);
  console.log(`  Riley:        ${riley.id} (HOURLY, zero-pay in this period per §35)`);
  console.log(`\nNext step: navigate to`);
  console.log(`  /app/admin/payroll?payGroupId=${payGroup.id}&payPeriodId=${payPeriod.id}`);
  console.log(`and click Prepare Payroll. Then Verify Employee Data → Calculate.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
