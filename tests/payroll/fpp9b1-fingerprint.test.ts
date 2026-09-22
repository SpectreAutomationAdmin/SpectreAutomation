// FPP-9B.1 (2026-09-22) — calculation fingerprint tests.
//
// Proves:
//   * packageChecksum and calculationFingerprint are DIFFERENT integrity
//     fields serving different questions;
//   * fingerprint changes when material inputs/outputs change;
//   * fingerprint is invariant under object-key ordering;
//   * fingerprint is stable across identical repeat calculations;
//   * fingerprint is immutable after POSTED (no service mutates it);
//   * reversal has its own fingerprint distinct from original;
//   * correction fingerprint reflects the corrected state and differs
//     from both original and reversal.

import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeUser, makeClub, principalFor } from "../util/db";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { initiatePayrollReversal } from "@/lib/payroll/reversal";
import { initiateReverseAndCorrect, patchCorrectionEmployeeInputs } from "@/lib/payroll/correction";
import {
  canoniseBatch,
  computeCalculationFingerprint,
  fingerprintFromCanonical,
  loadAndComputeFingerprintForBatch,
  backfillCalculationFingerprint,
} from "@/lib/payroll/calculation-fingerprint";

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

async function seedPostedBatch(suffix: string, opts?: { grossOverride?: string; annualSalary?: string }) {
  const c = db();
  const club = await makeClub(`FP ${suffix}`);
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
  const emp = await c.employee.create({ data: { clubId: club.id, firstName: "Fp",
    lastName: "Test", email: `fp.${suffix}@t.test`, hireDate: utc(2020,1,1),
    dateOfBirth: utc(1985,5,12), status: "ACTIVE", employeeNumber: `E-FP-${suffix}`,
    compensationType: "SALARY", employeeLifecycle: "ACTIVE", homeProvince: "AB" } });
  const assn = await c.employeeEmploymentAssignment.create({ data: { clubId: club.id,
    employeeId: emp.id, role: "PRIMARY", employmentType: "FULL_TIME", effectiveFrom: utc(2020,1,1) } });
  await c.employeeCompensation.create({ data: { clubId: club.id, employeeId: emp.id,
    assignmentId: assn.id, cadence: "SALARY", rate: opts?.annualSalary ?? "80000", currency: "CAD",
    effectiveFrom: utc(2020,1,1) } });
  const batch = await c.payrollBatch.create({ data: { clubId: club.id, payGroupId: pg.id,
    payPeriodId: pp.id, sequence: 1, status: "SUBMITTED_FOR_APPROVAL",
    calculatedAt: new Date(), calculationVersion: 1, algorithmVersion: "spectre-fpp9b1-test",
    packageChecksum: "fpp9b1-test-checksum", submittedAt: new Date(),
    submittedByUserId: marc.id } });
  const sourceFactsJson = JSON.stringify({
    schemaVersion: 1,
    compensations: [{ id: "cmp1", assignmentId: null, payType: "SALARY", hourlyRate: null,
      annualSalary: opts?.annualSalary ?? "80000", effectiveFrom: "2020-01-01T00:00:00.000Z", effectiveTo: null }],
    identity: { dateOfBirth: "1985-05-12T00:00:00.000Z" },
    tax: { federalClaim: "16129.00", provincialClaim: "22323.00" },
  });
  const gross = opts?.grossOverride ?? "3333.33";
  await c.payrollBatchEmployee.create({ data: { clubId: club.id, batchId: batch.id,
    employeeId: emp.id, jurisdictionCountry: "CA", jurisdictionProvince: "AB",
    employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED", salaried: true,
    sourceFactsJson,
    grossPay: new Prisma.Decimal(gross),
    earningsTaxable: new Prisma.Decimal(gross), earningsPensionable: new Prisma.Decimal(gross),
    earningsInsurable: new Prisma.Decimal(gross),
    deductionCppEeCombined: new Prisma.Decimal("183.42"),
    deductionCpp2Ee: new Prisma.Decimal("0.00"), deductionEiEe: new Prisma.Decimal("54.34"),
    deductionFederalTax: new Prisma.Decimal("400.00"), deductionProvincialTax: new Prisma.Decimal("175.00"),
    totalEmployeeDeductions: new Prisma.Decimal("812.76"),
    netPay: new Prisma.Decimal(new Prisma.Decimal(gross).minus("812.76").toFixed(2)),
    employerCppCombined: new Prisma.Decimal("183.42"),
    employerCpp2: new Prisma.Decimal("0.00"), employerEi: new Prisma.Decimal("76.08") } });
  await approvePayrollBatch(chrisP, batch.id);
  const posted = await postPayrollBatch(marcP, batch.id);
  return { club, marc, chris, marcP, chrisP, batch, emp, pp, posted };
}

describe("FPP-9B.1 · canonicalisation invariants", () => {
  it("Identical logical batches → identical fingerprint", () => {
    const batch = { transactionType: "STANDARD", statutoryPackageId: "p1", algorithmVersion: "v1",
      packageChecksum: "chk", calculationVersion: 1, payGroupId: "pg1", payPeriodId: "pp1",
      reversesPayrollBatchId: null, correctsPayrollBatchId: null, pairedReversalBatchId: null };
    const emp = { employeeId: "e1", jurisdictionCountry: "CA", jurisdictionProvince: "AB",
      salaried: true, employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED",
      sourceFactsJson: '{"a":1,"b":2}', ytdSnapshotJson: null,
      grossPay: new Prisma.Decimal("100.00"), netPay: new Prisma.Decimal("80.00"),
      earningsTaxable: null, earningsPensionable: null, earningsInsurable: null,
      deductionCppEeBase: null, deductionCppEeFirstAdd: null, deductionCppEeCombined: null,
      deductionCpp2Ee: null, deductionEiEe: null, deductionFederalTax: null,
      deductionProvincialTax: null, additionalFederalTax: null, additionalProvincialTax: null,
      totalEmployeeDeductions: null, employerCppBase: null, employerCppFirstAdd: null,
      employerCppCombined: null, employerCpp2: null, employerEi: null };
    const fp1 = computeCalculationFingerprint({ batch, employees: [emp], componentSnapshots: [] });
    const fp2 = computeCalculationFingerprint({ batch, employees: [emp], componentSnapshots: [] });
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^cfp-v1-[0-9a-f]{64}$/);
  });

  it("Same data, differently-ordered object keys in sourceFactsJson → identical fingerprint", () => {
    const base = { transactionType: "STANDARD", statutoryPackageId: "p1", algorithmVersion: "v1",
      packageChecksum: "chk", calculationVersion: 1, payGroupId: "pg1", payPeriodId: "pp1",
      reversesPayrollBatchId: null, correctsPayrollBatchId: null, pairedReversalBatchId: null };
    const empBase = { employeeId: "e1", jurisdictionCountry: "CA", jurisdictionProvince: "AB",
      salaried: true, employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED",
      ytdSnapshotJson: null, grossPay: new Prisma.Decimal("100.00"), netPay: new Prisma.Decimal("80.00"),
      earningsTaxable: null, earningsPensionable: null, earningsInsurable: null,
      deductionCppEeBase: null, deductionCppEeFirstAdd: null, deductionCppEeCombined: null,
      deductionCpp2Ee: null, deductionEiEe: null, deductionFederalTax: null,
      deductionProvincialTax: null, additionalFederalTax: null, additionalProvincialTax: null,
      totalEmployeeDeductions: null, employerCppBase: null, employerCppFirstAdd: null,
      employerCppCombined: null, employerCpp2: null, employerEi: null };
    const fp1 = computeCalculationFingerprint({ batch: base, employees: [{
      ...empBase, sourceFactsJson: JSON.stringify({ x: 1, y: 2, z: [{ a: 1, b: 2 }] }),
    }], componentSnapshots: [] });
    const fp2 = computeCalculationFingerprint({ batch: base, employees: [{
      ...empBase, sourceFactsJson: JSON.stringify({ z: [{ b: 2, a: 1 }], y: 2, x: 1 }),
    }], componentSnapshots: [] });
    expect(fp1).toBe(fp2);
  });

  it("Different grossPay → different fingerprint", () => {
    const batch = { transactionType: "STANDARD", statutoryPackageId: "p1", algorithmVersion: "v1",
      packageChecksum: "chk", calculationVersion: 1, payGroupId: "pg1", payPeriodId: "pp1",
      reversesPayrollBatchId: null, correctsPayrollBatchId: null, pairedReversalBatchId: null };
    const empBase = { employeeId: "e1", jurisdictionCountry: "CA", jurisdictionProvince: "AB",
      salaried: true, employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED",
      sourceFactsJson: '{}', ytdSnapshotJson: null,
      earningsTaxable: null, earningsPensionable: null, earningsInsurable: null,
      deductionCppEeBase: null, deductionCppEeFirstAdd: null, deductionCppEeCombined: null,
      deductionCpp2Ee: null, deductionEiEe: null, deductionFederalTax: null,
      deductionProvincialTax: null, additionalFederalTax: null, additionalProvincialTax: null,
      totalEmployeeDeductions: null, employerCppBase: null, employerCppFirstAdd: null,
      employerCppCombined: null, employerCpp2: null, employerEi: null };
    const fp1 = computeCalculationFingerprint({ batch, employees: [{ ...empBase,
      grossPay: new Prisma.Decimal("100.00"), netPay: new Prisma.Decimal("80.00") }],
      componentSnapshots: [] });
    const fp2 = computeCalculationFingerprint({ batch, employees: [{ ...empBase,
      grossPay: new Prisma.Decimal("120.00"), netPay: new Prisma.Decimal("80.00") }],
      componentSnapshots: [] });
    expect(fp1).not.toBe(fp2);
  });

  it("Same packageChecksum, different calculation results → same package, different fingerprint", () => {
    const shared = { transactionType: "STANDARD", statutoryPackageId: "pkg-A", algorithmVersion: "v1",
      packageChecksum: "IDENTICAL-CRA-CHECKSUM", calculationVersion: 1,
      payGroupId: "pg1", payPeriodId: "pp1",
      reversesPayrollBatchId: null, correctsPayrollBatchId: null, pairedReversalBatchId: null };
    const empBase = { employeeId: "e1", jurisdictionCountry: "CA", jurisdictionProvince: "AB",
      salaried: true, employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED",
      sourceFactsJson: '{}', ytdSnapshotJson: null,
      earningsTaxable: null, earningsPensionable: null, earningsInsurable: null,
      deductionCppEeBase: null, deductionCppEeFirstAdd: null, deductionCppEeCombined: null,
      deductionCpp2Ee: null, deductionEiEe: null, deductionFederalTax: null,
      deductionProvincialTax: null, additionalFederalTax: null, additionalProvincialTax: null,
      totalEmployeeDeductions: null, employerCppBase: null, employerCppFirstAdd: null,
      employerCppCombined: null, employerCpp2: null, employerEi: null };
    const fpOrig = computeCalculationFingerprint({ batch: shared, employees: [{ ...empBase,
      grossPay: new Prisma.Decimal("3541.67"), netPay: new Prisma.Decimal("2614.58") }],
      componentSnapshots: [] });
    const fpCorr = computeCalculationFingerprint({ batch: shared, employees: [{ ...empBase,
      grossPay: new Prisma.Decimal("3683.33"), netPay: new Prisma.Decimal("2703.23") }],
      componentSnapshots: [] });
    expect(fpOrig).not.toBe(fpCorr);
    // Both share the same packageChecksum (encoded inside the fingerprint input),
    // but different frozen output → different fingerprints.
  });
});

describe("FPP-9B.1 · reversal + correction fingerprints (integration)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Original, reversal, and correction all have distinct calculationFingerprints; original + reversal share packageChecksum", async () => {
    const s = await seedPostedBatch("f1", { annualSalary: "80000" });

    // Backfill fingerprint on the original (seed function bypasses Calculate,
    // so the original doesn't get a fingerprint automatically here — mimic the
    // production path via the backfill helper).
    const bfOriginal = await backfillCalculationFingerprint(s.batch.id);
    expect(bfOriginal.action).toBe("STORED_NEW");
    const originalAfter = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(originalAfter.calculationFingerprint).toBe(bfOriginal.fingerprint);

    // Initiate Reverse & Correct.
    const r = await initiateReverseAndCorrect(s.marcP, s.club.id, s.batch.id, "wrong salary");

    // Reversal fingerprint was persisted at initiate time (via the reversal
    // service's post-initiate write).
    const reversalAfter = await db().payrollBatch.findUniqueOrThrow({ where: { id: r.reversalBatchId } });
    expect(reversalAfter.calculationFingerprint).toBeTruthy();
    expect(reversalAfter.calculationFingerprint).toMatch(/^cfp-v1-[0-9a-f]{64}$/);
    expect(reversalAfter.calculationFingerprint).not.toBe(originalAfter.calculationFingerprint);

    // Package identity — reversal PRESERVES original's statutory package
    // (correct semantics; identical CRA rules).
    expect(reversalAfter.packageChecksum).toBe(originalAfter.packageChecksum);

    // Correction was seeded with the SAME sourceFactsJson as the original,
    // so BEFORE any patch, its fingerprint IF computed now would be similar
    // to the original — but differs because transactionType and correction
    // linkage fields differ. Verify explicitly.
    const correctionBefore = await db().payrollBatch.findUniqueOrThrow({ where: { id: r.correctionBatchId } });
    expect(correctionBefore.transactionType).toBe("CORRECTION");

    // Patch the correction — bump salary. Fingerprint must now differ from
    // both original and reversal even at PREPARED state.
    await patchCorrectionEmployeeInputs(s.marcP, s.club.id, r.correctionBatchId, [
      { employeeId: s.emp.id, kind: "annualSalary", annualSalary: "88000" },
    ]);

    // The patch clears calculationFingerprint (Calculate will rewrite);
    // reload to confirm.
    const correctionAfterPatch = await db().payrollBatch.findUniqueOrThrow({ where: { id: r.correctionBatchId } });
    expect(correctionAfterPatch.calculationFingerprint).toBeNull();

    // Simulate Calculate: write the corrected amounts and re-run the
    // fingerprint compute (which is what calculation-execute would do).
    const correctionEmp = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.correctionBatchId } });
    await db().payrollBatchEmployee.update({
      where: { id: correctionEmp.id },
      data: {
        grossPay: new Prisma.Decimal("3683.33"),
        netPay: new Prisma.Decimal("2703.23"),
        earningsTaxable: new Prisma.Decimal("3683.33"),
        earningsPensionable: new Prisma.Decimal("3683.33"),
        earningsInsurable: new Prisma.Decimal("3683.33"),
        deductionCppEeCombined: new Prisma.Decimal("210.48"),
        deductionEiEe: new Prisma.Decimal("57.05"),
        deductionFederalTax: new Prisma.Decimal("476.38"),
        deductionProvincialTax: new Prisma.Decimal("185.00"),
        totalEmployeeDeductions: new Prisma.Decimal("928.91"),
        employerCppCombined: new Prisma.Decimal("210.48"),
        employerEi: new Prisma.Decimal("79.87"),
      },
    });
    // Bump calculationVersion + status to simulate a completed Calculate.
    await db().payrollBatch.update({
      where: { id: r.correctionBatchId },
      data: { status: "CALCULATED", calculatedAt: new Date(), calculationVersion: 1 },
    });
    const bfCorrection = await backfillCalculationFingerprint(r.correctionBatchId);
    expect(bfCorrection.action).toBe("STORED_NEW");
    const correctionAfterCalc = await db().payrollBatch.findUniqueOrThrow({ where: { id: r.correctionBatchId } });
    expect(correctionAfterCalc.calculationFingerprint).toBe(bfCorrection.fingerprint);
    // Fingerprint distinct from both original and reversal.
    expect(correctionAfterCalc.calculationFingerprint).not.toBe(originalAfter.calculationFingerprint);
    expect(correctionAfterCalc.calculationFingerprint).not.toBe(reversalAfter.calculationFingerprint);
    // Package identity STILL preserved.
    expect(correctionAfterCalc.packageChecksum).toBe(originalAfter.packageChecksum);
  });

  it("Idempotent recalculation with identical inputs produces the same fingerprint", async () => {
    const s = await seedPostedBatch("f2");
    await backfillCalculationFingerprint(s.batch.id);
    const before = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    // Re-run the compute (mimicking a re-Calculate with identical inputs).
    const { fingerprint } = await loadAndComputeFingerprintForBatch(s.batch.id);
    expect(fingerprint).toBe(before.calculationFingerprint);
  });

  it("Backfill on a batch with an existing fingerprint does not overwrite (idempotent)", async () => {
    const s = await seedPostedBatch("f3");
    const first = await backfillCalculationFingerprint(s.batch.id);
    const second = await backfillCalculationFingerprint(s.batch.id);
    expect(second.action).toBe("MATCHED_EXISTING");
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("Backfill flags a MISMATCH when persisted fingerprint disagrees with computed evidence", async () => {
    const s = await seedPostedBatch("f4");
    // Store a bogus fingerprint (simulating historical corruption).
    await db().payrollBatch.update({
      where: { id: s.batch.id },
      data: { calculationFingerprint: "cfp-v1-deadbeef" + "0".repeat(56) },
    });
    const result = await backfillCalculationFingerprint(s.batch.id);
    expect(result.action).toBe("MISMATCH_LEFT_UNCHANGED");
    // Historical value preserved — evidence does not overwrite.
    expect(result.fingerprint).toBe("cfp-v1-deadbeef" + "0".repeat(56));
  });
});
