// Payroll Admin Slice 3C acceptance hotfix (2026-09-12) — synthetic
// PREPARED batch fixture for end-to-end UI acceptance on Coulee.
//
// The founder's real Coulee Bi-Weekly pay group carries blockers on
// Chris/Lise/etc. that legitimately hold the founder period in
// DRAFT. To exercise the one-time adjustment write path, this
// fixture creates:
//
//   1. A dedicated pay group  `3C-ACCEPT`  (BIWEEKLY) at Coulee.
//   2. A dedicated pay period `Aug 30 – Sep 12, 2026` inside it.
//   3. Sole membership for `Riley Reconcile` (the hourly fixture
//      created earlier — CLOCK_REQUIRED, HOURLY $18/hr).
//   4. Runs `preparePayrollBatch` via the domain service so the
//      batch reaches PREPARED (Riley has no BLOCKER exceptions —
//      only bank/SIN/TD1 warnings which don't gate PREPARED).
//   5. Ensures a `BONUS` payroll component exists in the club
//      catalogue for the Add-Adjustment picker to have a target.
//
// Idempotent: skips rows that already exist. Only writes rows
// tagged with the fixture-only pay-group code `3C-ACCEPT`.

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const COULEE = "cmrvdeny7000144372ktmmg9c";
const PAY_GROUP_CODE = "3C-ACCEPT";
const PAY_GROUP_NAME = "3C Acceptance (Bi-Weekly)";
// Sep 27 – Oct 10 chosen so the period does NOT intersect Riley's
// existing Sep 2 + Sep 4 clock activity. That means the batch has
// no departments-with-time to approve → `assertPreconditions`
// skips the approval gate → Prepare reaches PREPARED regardless
// of the founder period's Grounds approval state.
const PERIOD_START = new Date(Date.UTC(2026, 8, 27)); // Sep 27, 2026
const PERIOD_END   = new Date(Date.UTC(2026, 9, 11)); // Oct 11, 2026 (exclusive)
const PAY_DATE     = new Date(Date.UTC(2026, 9, 10)); // Oct 10, 2026
const RILEY_EMAIL  = "riley.reconcile@fixture.spectre.test";
const BONUS_CODE   = "3C_ACCEPT_BONUS";

async function main() {
  console.log(`\n== Payroll 3C acceptance-hotfix fixture @ ${new Date().toISOString()} ==`);

  // ---- Ensure the 3C-ACCEPT pay group exists ----
  let payGroup = await prisma.payrollPayGroup.findFirst({
    where: { clubId: COULEE, code: PAY_GROUP_CODE },
    select: { id: true },
  });
  if (!payGroup) {
    payGroup = await prisma.payrollPayGroup.create({
      data: {
        clubId: COULEE, code: PAY_GROUP_CODE, name: PAY_GROUP_NAME,
        payFrequency: "BIWEEKLY", payDateOffsetDays: 5,
        calendarAnchorDate: new Date(Date.UTC(2026, 7, 30)), active: true,
      },
      select: { id: true },
    });
    console.log(`  + Created pay group ${PAY_GROUP_CODE}: ${payGroup.id}`);
  } else {
    console.log(`  = Pay group ${PAY_GROUP_CODE} exists: ${payGroup.id}`);
  }

  // ---- Ensure the Sep 27 – Oct 10 pay period exists ----
  //
  // A prior version of this fixture used Aug 30 – Sep 12; if that
  // period exists we void any batch on it and update the dates in
  // place, since the schema uniques on (clubId, payGroupId, taxYear,
  // sequenceInYear) prevent duplicates.
  let payPeriod = await prisma.payrollPayPeriod.findFirst({
    where: { clubId: COULEE, payGroupId: payGroup.id, sequenceInYear: 18, taxYear: 2026 },
    select: { id: true, periodStart: true },
  });
  if (payPeriod && payPeriod.periodStart.getTime() !== PERIOD_START.getTime()) {
    // Void any non-VOIDED batches on this period so its dates can be
    // updated safely.
    await prisma.payrollBatch.updateMany({
      where: { payPeriodId: payPeriod.id, status: { not: "VOIDED" } },
      data:  { status: "VOIDED", voidedAt: new Date(), voidReason: "3C-acceptance fixture repointed dates" },
    });
    await prisma.payrollPayPeriod.update({
      where: { id: payPeriod.id },
      data:  { periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE },
    });
    console.log(`  ~ Repointed pay period to Sep 27 – Oct 10: ${payPeriod.id}`);
  } else if (!payPeriod) {
    payPeriod = await prisma.payrollPayPeriod.create({
      data: {
        clubId: COULEE, payGroupId: payGroup.id,
        sequenceInYear: 18, taxYear: 2026,
        periodStart: PERIOD_START, periodEnd: PERIOD_END,
        payDate: PAY_DATE, status: "OPEN",
      },
      select: { id: true, periodStart: true },
    });
    console.log(`  + Created pay period Sep 27 – Oct 10: ${payPeriod.id}`);
  } else {
    console.log(`  = Pay period exists: ${payPeriod.id}`);
  }

  // ---- Ensure Riley is on this pay group ----
  const riley = await prisma.employee.findFirst({
    where: { clubId: COULEE, personalEmail: RILEY_EMAIL },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!riley) {
    throw new Error(`Riley Reconcile (${RILEY_EMAIL}) not found. Run scripts/payroll-3b-hourly-acceptance-fixture.mjs first.`);
  }
  const existingMember = await prisma.payrollPayGroupMember.findFirst({
    where: { clubId: COULEE, employeeId: riley.id, payGroupId: payGroup.id },
    select: { id: true },
  });
  if (!existingMember) {
    await prisma.payrollPayGroupMember.create({
      data: {
        clubId: COULEE, employeeId: riley.id, payGroupId: payGroup.id,
        effectiveFrom: new Date(Date.UTC(2026, 7, 24)),
      },
    });
    console.log(`  + Added Riley to ${PAY_GROUP_CODE}`);
  } else {
    console.log(`  = Riley already on ${PAY_GROUP_CODE}`);
  }

  // ---- Ensure the BONUS payroll component exists ----
  const bonus = await prisma.payrollComponent.findFirst({
    where: { clubId: COULEE, code: BONUS_CODE },
    select: { id: true },
  });
  if (!bonus) {
    await prisma.payrollComponent.create({
      data: {
        clubId: COULEE, code: BONUS_CODE, displayName: "3C Acceptance Bonus",
        category: "ADDITIONAL_EARNING", side: "EMPLOYEE",
        cashEffect: "INCREASES_NET_PAY",
        calculationMethod: "FIXED_AMOUNT",
        taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
        displaySection: "EARNINGS", displayOrder: 100,
        statutoryTreatmentSource: "CUSTOM",
        active: true,
      },
    });
    console.log(`  + Created ${BONUS_CODE} payroll component`);
  } else {
    console.log(`  = ${BONUS_CODE} exists`);
  }

  // ---- Ensure PayrollClubConfig exists (required by Prepare) ----
  const cfg = await prisma.payrollClubConfig.findUnique({ where: { clubId: COULEE } });
  if (!cfg) {
    console.log("  ! Coulee has no PayrollClubConfig — Prepare will refuse.");
  } else {
    console.log(`  = PayrollClubConfig exists (provinceOfEmployment=${cfg.provinceOfEmployment})`);
  }

  // ---- Check whether a batch already exists ----
  const existingBatch = await prisma.payrollBatch.findFirst({
    where: { clubId: COULEE, payPeriodId: payPeriod.id, status: { not: "VOIDED" } },
    select: { id: true, status: true, sequence: true, _count: { select: { employees: true, exceptions: true } } },
  });
  console.log(`\nExisting non-VOIDED batch on 3C-ACCEPT period:`, existingBatch ? JSON.stringify(existingBatch) : "none");

  console.log(`\n== Summary ==`);
  console.log(`  Pay group:       ${payGroup.id} (${PAY_GROUP_CODE})`);
  console.log(`  Pay period:      ${payPeriod.id} (Sep 27 – Oct 10, 2026)`);
  console.log(`  Riley:           ${riley.id}`);
  console.log(`  Bonus component: ${BONUS_CODE}`);
  console.log(`\nNext step: navigate to /app/admin/payroll?payPeriodId=${payPeriod.id}`);
  console.log(`and click Prepare Payroll. Riley alone → PREPARED batch → adjustment write flow unlocked.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
