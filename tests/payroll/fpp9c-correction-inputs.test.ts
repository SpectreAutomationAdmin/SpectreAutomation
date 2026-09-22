// FPP-9C (2026-09-22) — multi-input correction + comparison + mismatch audit.

import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeUser, makeClub, principalFor } from "../util/db";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { initiateReverseAndCorrect, patchCorrectionEmployeeInputs } from "@/lib/payroll/correction";
import { buildCorrectionComparison } from "@/lib/payroll/correction-comparison";
import { backfillCalculationFingerprint } from "@/lib/payroll/calculation-fingerprint";
import { ConflictError, ValidationError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function seedGl(clubId: string) {
  const c = db();
  const acct = async (n: string, name: string, type: "EXPENSE" | "LIABILITY") =>
    c.account.create({ data: { clubId, accountNumber: n, name, type,
      normalBalance: type === "EXPENSE" ? "DEBIT" : "CREDIT",
      isActive: true, allowManualPosting: false } });
  const salary = await acct("5100", "Salary Expense", "EXPENSE");
  const erCpp  = await acct("5110", "Employer CPP", "EXPENSE");
  const erEi   = await acct("5120", "Employer EI", "EXPENSE");
  const netPay = await acct("2100", "Net Pay Payable", "LIABILITY");
  const cpp    = await acct("2110", "CPP Payable", "LIABILITY");
  const ei     = await acct("2120", "EI Payable", "LIABILITY");
  const fed    = await acct("2130", "Fed Tax Payable", "LIABILITY");
  const prov   = await acct("2140", "AB Tax Payable", "LIABILITY");
  return c.payrollGlAccountingProfile.create({ data: {
    clubId, salaryExpenseAccountId: salary.id,
    employerCppExpenseAccountId: erCpp.id, employerEiExpenseAccountId: erEi.id,
    netPayPayableAccountId: netPay.id, cppPayableAccountId: cpp.id, eiPayableAccountId: ei.id,
    federalTaxPayableAccountId: fed.id, provincialTaxPayableAccountId: prov.id,
  } });
}

async function seedPostedBatch(suffix: string) {
  const c = db();
  const club = await makeClub(`9C ${suffix}`);
  const marc = await makeUser({ email: `marc-${suffix}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const chris = await makeUser({ email: `chris-${suffix}@t.test`, role: "CONTROLLER", clubId: club.id });
  const marcP = await principalFor(marc.email);
  const chrisP = await principalFor(chris.email);
  const profile = await seedGl(club.id);
  const fy = await c.fiscalYear.create({ data: { clubId: club.id, label: "FY2026",
    startDate: utc(2026,1,1), endDate: utc(2026,12,31), status: "OPEN" } });
  await c.fiscalPeriod.create({ data: { clubId: club.id, fiscalYearId: fy.id,
    label: "FY2026-M09", startDate: utc(2026,9,1), endDate: utc(2026,9,30),
    sequence: 9, status: "OPEN" } });
  await c.payrollClubConfig.create({ data: { clubId: club.id, enabled: true,
    provinceOfEmployment: "AB", payrollAdminUserId: marc.id, controllerUserId: chris.id,
    glAccountingProfileId: profile.id } });
  const pg = await c.payrollPayGroup.create({ data: { clubId: club.id, code: "SAL-SM",
    name: "Salaried SM", payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 0,
    calendarAnchorDate: utc(2026, 9, 1) } });
  const pp = await c.payrollPayPeriod.create({ data: { clubId: club.id, payGroupId: pg.id,
    sequenceInYear: 17, taxYear: 2026, periodStart: utc(2026,9,1),
    periodEnd: utc(2026,9,16), payDate: utc(2026,9,16) } });
  const emp = await c.employee.create({ data: { clubId: club.id, firstName: "Nine",
    lastName: "Charlie", email: `9c.${suffix}@t.test`, hireDate: utc(2020,1,1),
    dateOfBirth: utc(1985,5,12), status: "ACTIVE", employeeNumber: `E-9C-${suffix}`,
    compensationType: "SALARY", employeeLifecycle: "ACTIVE", homeProvince: "AB" } });
  const assn = await c.employeeEmploymentAssignment.create({ data: { clubId: club.id,
    employeeId: emp.id, role: "PRIMARY", employmentType: "FULL_TIME", effectiveFrom: utc(2020,1,1) } });
  await c.employeeCompensation.create({ data: { clubId: club.id, employeeId: emp.id,
    assignmentId: assn.id, cadence: "SALARY", rate: "80000", currency: "CAD",
    effectiveFrom: utc(2020,1,1) } });
  // Create a PayrollComponent for the ONE_TIME_BONUS + CELL_PHONE so patches can find them.
  await c.payrollComponent.create({ data: {
    clubId: club.id, code: "ONE_TIME_BONUS", displayName: "One-Time Bonus",
    category: "EARNING", side: "EMPLOYER", cashEffect: "ADD",
    displaySection: "EARNINGS", displayOrder: 100,
    calculationMethod: "FIXED_AMOUNT", statutoryTreatmentSource: "CUSTOM",
    taxableEffect: "INCLUDE", cppPensionableEffect: "INCLUDE", eiInsurableEffect: "INCLUDE",
    active: true } });
  await c.payrollComponent.create({ data: {
    clubId: club.id, code: "PHONE_DEDUCTION", displayName: "Phone Deduction",
    category: "DEDUCTION", side: "EMPLOYEE", cashEffect: "SUBTRACT",
    displaySection: "DEDUCTIONS", displayOrder: 200,
    calculationMethod: "FIXED_AMOUNT", statutoryTreatmentSource: "CUSTOM",
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    active: true } });

  const sourceFactsJson = JSON.stringify({
    schemaVersion: 1,
    compensations: [{ id: "cmp1", payType: "SALARY", annualSalary: "80000", effectiveFrom: "2020-01-01T00:00:00.000Z" }],
    allowances: [{ allowanceType: "CELL_PHONE", amount: "37.50" }],
  });
  const batch = await c.payrollBatch.create({ data: { clubId: club.id, payGroupId: pg.id,
    payPeriodId: pp.id, sequence: 1, status: "SUBMITTED_FOR_APPROVAL",
    calculatedAt: new Date(), calculationVersion: 1, algorithmVersion: "spectre-9c-test",
    packageChecksum: "9c-test-checksum", submittedAt: new Date(),
    submittedByUserId: marc.id } });
  const be = await c.payrollBatchEmployee.create({ data: { clubId: club.id, batchId: batch.id,
    employeeId: emp.id, jurisdictionCountry: "CA", jurisdictionProvince: "AB",
    employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED", salaried: true, sourceFactsJson,
    grossPay: new Prisma.Decimal("3333.33"),
    earningsTaxable: new Prisma.Decimal("3333.33"),
    earningsPensionable: new Prisma.Decimal("3333.33"),
    earningsInsurable: new Prisma.Decimal("3333.33"),
    deductionCppEeCombined: new Prisma.Decimal("183.42"), deductionCpp2Ee: new Prisma.Decimal("0.00"),
    deductionEiEe: new Prisma.Decimal("54.34"),
    deductionFederalTax: new Prisma.Decimal("400.00"), deductionProvincialTax: new Prisma.Decimal("175.00"),
    totalEmployeeDeductions: new Prisma.Decimal("812.76"), netPay: new Prisma.Decimal("2520.57"),
    employerCppCombined: new Prisma.Decimal("183.42"), employerCpp2: new Prisma.Decimal("0.00"),
    employerEi: new Prisma.Decimal("76.08") } });
  await approvePayrollBatch(chrisP, batch.id);
  const posted = await postPayrollBatch(marcP, batch.id);
  return { club, marc, chris, marcP, chrisP, batch, emp, be, pp, posted };
}

describe("FPP-9C · multi-input correction patches", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Correction is seeded from ORIGINAL's frozen sourceFactsJson (not the employee's current profile)", async () => {
    const s = await seedPostedBatch("s1");
    // Employee profile drift: change current EmployeeCompensation to something different.
    await db().employeeCompensation.updateMany({ where: { employeeId: s.emp.id }, data: { rate: "99999" } });
    const r = await initiateReverseAndCorrect(s.marcP, s.club.id, s.batch.id, "seed test");
    const corrBe = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.correctionBatchId } });
    const facts = JSON.parse(corrBe.sourceFactsJson ?? "{}");
    // Correction seed reflects FROZEN original ($80000), not drifted current profile ($99999).
    expect(facts.compensations[0].annualSalary).toBe("80000");
    expect(facts.allowances).toEqual([{ allowanceType: "CELL_PHONE", amount: "37.50" }]);
  });

  it("annualSalary patch changes sourceFactsJson.compensations[0] and clears calculationFingerprint", async () => {
    const s = await seedPostedBatch("s2");
    const r = await initiateReverseAndCorrect(s.marcP, s.club.id, s.batch.id, "salary patch");
    await db().payrollBatch.update({ where: { id: r.correctionBatchId },
      data: { status: "CALCULATED", calculationFingerprint: "cfp-v1-existing", calculatedAt: new Date() } });
    await patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "annualSalary", annualSalary: "88400" },
    ]);
    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: r.correctionBatchId } });
    expect(after.status).toBe("PREPARED");
    expect(after.calculationFingerprint).toBeNull();
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.correctionBatchId } });
    expect(JSON.parse(be.sourceFactsJson ?? "{}").compensations[0].annualSalary).toBe("88400");
  });

  it("RETURNED_FOR_CORRECTION is editable (Controller return workflow)", async () => {
    const s = await seedPostedBatch("s2b");
    const r = await initiateReverseAndCorrect(s.marcP, s.club.id, s.batch.id, "return path");
    // Simulate the state after Controller RETURN — status=RETURNED_FOR_CORRECTION,
    // fingerprint still stored from the pre-return Calculate.
    await db().payrollBatch.update({ where: { id: r.correctionBatchId },
      data: { status: "RETURNED_FOR_CORRECTION", calculationFingerprint: "cfp-v1-preRetun", calculatedAt: new Date() } });
    await patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "annualSalary", annualSalary: "91234" },
    ]);
    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: r.correctionBatchId } });
    expect(after.status).toBe("PREPARED");
    expect(after.calculationFingerprint).toBeNull();
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.correctionBatchId } });
    expect(JSON.parse(be.sourceFactsJson ?? "{}").compensations[0].annualSalary).toBe("91234");
  });

  it("allowance ADD / UPDATE / REMOVE mutates sourceFactsJson.allowances", async () => {
    const s = await seedPostedBatch("s3");
    const r = await initiateReverseAndCorrect(s.marcP, s.club.id, s.batch.id, "allowance test");
    // ADD a second allowance
    await patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "allowance", operation: "ADD", allowanceType: "VEHICLE", amount: "125.00" },
    ]);
    let be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.correctionBatchId } });
    let allowances = JSON.parse(be.sourceFactsJson ?? "{}").allowances;
    expect(allowances).toHaveLength(2);
    expect(allowances.find((a: any) => a.allowanceType === "VEHICLE").amount).toBe("125.00");
    // ADD again should fail
    await expect(patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "allowance", operation: "ADD", allowanceType: "VEHICLE", amount: "150.00" },
    ])).rejects.toBeInstanceOf(ValidationError);
    // UPDATE
    await patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "allowance", operation: "UPDATE", allowanceType: "VEHICLE", amount: "175.00" },
    ]);
    be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.correctionBatchId } });
    allowances = JSON.parse(be.sourceFactsJson ?? "{}").allowances;
    expect(allowances.find((a: any) => a.allowanceType === "VEHICLE").amount).toBe("175.00");
    // REMOVE
    await patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "allowance", operation: "REMOVE", allowanceType: "VEHICLE" },
    ]);
    be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.correctionBatchId } });
    allowances = JSON.parse(be.sourceFactsJson ?? "{}").allowances;
    expect(allowances.some((a: any) => a.allowanceType === "VEHICLE")).toBe(false);
    expect(allowances).toHaveLength(1);  // original CELL_PHONE remains
    // REMOVE non-existent should fail
    await expect(patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "allowance", operation: "REMOVE", allowanceType: "VEHICLE" },
    ])).rejects.toBeInstanceOf(ValidationError);
  });

  it("oneTimeEarning ADD creates a PayrollBatchComponentSnapshot with correct provenance + category", async () => {
    const s = await seedPostedBatch("s4");
    const r = await initiateReverseAndCorrect(s.marcP, s.club.id, s.batch.id, "bonus test");
    await patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "oneTimeEarning", operation: "ADD",
        componentCode: "ONE_TIME_BONUS", amount: "500.00" },
    ]);
    const snap = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: r.correctionBatchId, componentCode: "ONE_TIME_BONUS" },
    });
    expect(snap.provenance).toBe("ONE_TIME_PAYROLL_ADJUSTMENT");
    expect(snap.category).toBe("EARNING");
    expect(snap.resolvedAmount?.toString()).toBe("500");
    // ADD twice fails
    await expect(patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "oneTimeEarning", operation: "ADD",
        componentCode: "ONE_TIME_BONUS", amount: "600.00" },
    ])).rejects.toBeInstanceOf(ValidationError);
    // UPDATE
    await patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "oneTimeEarning", operation: "UPDATE",
        componentCode: "ONE_TIME_BONUS", amount: "750.00" },
    ]);
    const snapAfter = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: r.correctionBatchId, componentCode: "ONE_TIME_BONUS" },
    });
    expect(snapAfter.resolvedAmount?.toString()).toBe("750");
    // REMOVE
    await patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "oneTimeEarning", operation: "REMOVE",
        componentCode: "ONE_TIME_BONUS" },
    ]);
    const snapGone = await db().payrollBatchComponentSnapshot.findFirst({
      where: { batchId: r.correctionBatchId, componentCode: "ONE_TIME_BONUS" },
    });
    expect(snapGone).toBeNull();
  });

  it("deduction patch creates snapshot with EMPLOYEE side + DEDUCTION category", async () => {
    const s = await seedPostedBatch("s5");
    const r = await initiateReverseAndCorrect(s.marcP, s.club.id, s.batch.id, "deduction test");
    await patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "deduction", operation: "ADD",
        componentCode: "PHONE_DEDUCTION", amount: "25.00" },
    ]);
    const snap = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: r.correctionBatchId, componentCode: "PHONE_DEDUCTION" },
    });
    expect(snap.category).toBe("DEDUCTION");
    expect(snap.side).toBe("EMPLOYEE");
    expect(snap.resolvedAmount?.toString()).toBe("25");
  });

  it("ADD of unknown componentCode is refused (no silent creation)", async () => {
    const s = await seedPostedBatch("s6");
    const r = await initiateReverseAndCorrect(s.marcP, s.club.id, s.batch.id, "unknown");
    await expect(patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "oneTimeEarning", operation: "ADD",
        componentCode: "NOT_A_REAL_COMPONENT", amount: "100.00" },
    ])).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("FPP-9C · comparison service", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Builds Original vs Corrected vs Change with employee + component sections", async () => {
    const s = await seedPostedBatch("cmp1");
    const r = await initiateReverseAndCorrect(s.marcP, s.club.id, s.batch.id, "compare test");
    // Add a bonus on the correction to create a delta (component ADDED).
    await patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "oneTimeEarning", operation: "ADD",
        componentCode: "ONE_TIME_BONUS", amount: "500.00" },
    ]);
    // Simulate Calculate: nudge the correction's calculated grossPay so employee-level shows change.
    const corrBe = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.correctionBatchId } });
    await db().payrollBatchEmployee.update({
      where: { id: corrBe.id },
      data: {
        grossPay: new Prisma.Decimal("3833.33"),
        netPay: new Prisma.Decimal("3000.00"),
        earningsTaxable: new Prisma.Decimal("3833.33"),
      },
    });
    const cmp = await buildCorrectionComparison(r.correctionBatchId);
    expect(cmp.changedEmployeeCount).toBe(1);
    expect(cmp.unchangedEmployeeCount).toBe(0);
    expect(cmp.employees[0].fields.gross.original).toBe("3333.33");
    expect(cmp.employees[0].fields.gross.corrected).toBe("3833.33");
    expect(cmp.employees[0].fields.gross.change).toBe("500.00");
    expect(cmp.employees[0].fields.gross.changed).toBe(true);
    // Component-level: ONE_TIME_BONUS ADDED
    const bonus = cmp.components.find(c => c.componentCode === "ONE_TIME_BONUS");
    expect(bonus?.operation).toBe("ADDED");
    expect(bonus?.change).toBe("500.00");
    // Totals
    expect(cmp.totals.grossChange).toBe("500.00");
  });
});

describe("FPP-9C · fingerprint mismatch durable audit", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("MISMATCH_LEFT_UNCHANGED persists a FingerprintMismatchEvent (idempotent on repeat detection)", async () => {
    const s = await seedPostedBatch("mm1");
    // Store a bogus fingerprint on the batch to force mismatch.
    await db().payrollBatch.update({
      where: { id: s.batch.id },
      data: { calculationFingerprint: "cfp-v1-deadbeef" + "0".repeat(56) },
    });
    const first = await backfillCalculationFingerprint(s.batch.id, { detectionContext: "test-1" });
    expect(first.action).toBe("MISMATCH_LEFT_UNCHANGED");
    expect(first.mismatchEventId).toBeTruthy();
    // Second detection with the same (stored, recomputed) pair is idempotent — no duplicate row.
    const second = await backfillCalculationFingerprint(s.batch.id, { detectionContext: "test-2" });
    expect(second.mismatchEventId).toBe(first.mismatchEventId);
    const rows = await db().fingerprintMismatchEvent.count({ where: { batchId: s.batch.id } });
    expect(rows).toBe(1);
    const row = await db().fingerprintMismatchEvent.findFirstOrThrow({ where: { batchId: s.batch.id } });
    expect(row.storedFingerprint).toBe("cfp-v1-deadbeef" + "0".repeat(56));
    expect(row.actionTaken).toBe("HISTORICAL_VALUE_LEFT_UNCHANGED");
  });
});
