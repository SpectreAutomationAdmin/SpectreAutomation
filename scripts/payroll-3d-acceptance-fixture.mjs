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

  // ---- Pay period Nov 8 – Nov 21 --------------------------------------
  let payPeriod = await prisma.payrollPayPeriod.findFirst({
    where: { clubId: COULEE, payGroupId: payGroup.id, taxYear: 2026, sequenceInYear: 22 },
    select: { id: true, periodStart: true },
  });
  if (payPeriod && payPeriod.periodStart.getTime() !== PERIOD_START.getTime()) {
    await prisma.payrollBatch.updateMany({
      where: { payPeriodId: payPeriod.id, status: { not: "VOIDED" } },
      data:  { status: "VOIDED", voidedAt: new Date(), voidReason: "3D fixture repointed dates" },
    });
    await prisma.payrollPayPeriod.update({
      where: { id: payPeriod.id },
      data:  { periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE },
    });
    console.log(`  ~ Repointed pay period to Nov 8 – Nov 21: ${payPeriod.id}`);
  } else if (!payPeriod) {
    payPeriod = await prisma.payrollPayPeriod.create({
      data: {
        clubId: COULEE, payGroupId: payGroup.id,
        sequenceInYear: 22, taxYear: 2026,
        periodStart: PERIOD_START, periodEnd: PERIOD_END,
        payDate: PAY_DATE, status: "OPEN",
      },
      select: { id: true, periodStart: true },
    });
    console.log(`  + Created pay period Nov 8 – Nov 21: ${payPeriod.id}`);
  } else {
    console.log(`  = Pay period exists: ${payPeriod.id}`);
  }

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
        hireDate: SAM_HIRE, employeeLifecycle: "ACTIVE",
        timekeepingMethod: "NO_CLOCK",
      },
      select: { id: true },
    });
    console.log(`  + Created Sam Salary (SALARIED): ${sam.id}`);
  } else {
    console.log(`  = Sam Salary exists: ${sam.id}`);
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

  // Tax profile — federal + provincial claim
  const samTax = await prisma.employeeTaxProfile.findFirst({
    where: { clubId: COULEE, employeeId: sam.id },
    select: { id: true },
  });
  if (!samTax) {
    await prisma.employeeTaxProfile.create({
      data: {
        clubId: COULEE, employeeId: sam.id,
        federalClaimSecretRef: "kms://synthetic/sam-3d-fed",
        provincialClaimSecretRef: "kms://synthetic/sam-3d-prov",
        additionalFederalTaxAmount: "0",
        additionalProvincialTaxAmount: "0",
        claimZeroFederal: false, claimZeroProvincial: false,
        totalIncomeLessThanClaim: false,
      },
    });
    console.log(`  + Created Sam EmployeeTaxProfile (synthetic KMS refs)`);
  } else {
    console.log(`  = Sam EmployeeTaxProfile exists`);
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
