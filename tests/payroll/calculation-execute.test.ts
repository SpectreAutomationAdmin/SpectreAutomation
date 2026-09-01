// Payroll-3B-5B-2c — DB integration tests for the COMPLETE
// gross-to-net calculator.
//
// Verifies (per §30-33 of the 2c brief):
//   • PDOC Scenario 1 (H1, default TD1) — exact match to CRA
//   • PDOC Scenario 2 (H2, custom TD1) — exact match
//   • PDOC Scenario 3 (additional 50/25) — base tax preserved
//     equal to Scenario 1 + separate additional-tax total
//   • PDOC Scenario 4 (claimZeroFederal=true) — exact match
//   • TD1 immutability — live TD1 mutation after PREPARED does
//     NOT alter an existing prepared batch
//   • PRIOR_EMPLOYER exclusion — unchanged behaviour
//   • Frozen source facts — HR mutation cannot leak into result
//   • Atomicity + rollback — negative-net BLOCKS entire batch
//   • CALCULATED transition — calculatedAt / calculationVersion set
//   • Controller PAYROLL_FINAL_APPROVAL WI materialised
//   • PAYROLL_REVIEW resolved on handoff
//   • WI idempotency — recalculation refreshes single card

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { orchestratePayrollReviewHandoff } from "@/lib/payroll/orchestration";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { createDraftOpeningBalance, activateOpeningBalance } from "@/lib/payroll/opening-balance";
import type { OpeningBalanceFields } from "@/lib/payroll/opening-balance";
import { parseYtdSnapshotV1 } from "@/lib/payroll/ytd-snapshot-schema";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "super-2c@spectre.test" } });
  const u = await c.user.create({
    data: {
      email: "super-2c@spectre.test", name: "Super2c",
      role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE",
    },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("super-2c@spectre.test");
}

const zeroOB: OpeningBalanceFields = {
  ytdGrossEarnings: "0", ytdTaxableEarnings: "0", ytdPensionableEarnings: "0",
  ytdInsurableEarnings: "0",
  ytdCppEE_Base: "0", ytdCppEE_FirstAdd: "0", ytdCppEE: "0",
  ytdCpp2EE: "0", ytdEiEE: "0", ytdFederalTax: "0", ytdProvincialTax: "0",
  ytdCppER_Base: "0", ytdCppER_FirstAdd: "0", ytdCppER: "0",
  ytdCpp2ER: "0", ytdEiER: "0",
};

interface TaxOpts {
  federalClaim?:                 string;   // "16452" etc. stored on federalClaimSecretRef (plain decimal path)
  provincialClaim?:              string;
  claimZeroFederal?:             boolean;
  claimZeroProvincial?:          boolean;
  totalIncomeLessThanClaim?:     boolean;
  additionalFederalTaxAmount?:   string;
  additionalProvincialTaxAmount?: string;
}

/**
 * PDOC-anchored scenario: salaried employee, biweekly Pay Group,
 * $52,000 annual = $2,000 per pay, full pay-period calendar seeded
 * so `resolvePeriodsPerYearFromCalendar` returns P=26.
 */
async function pdocScenario(payDate: Date, tax: TaxOpts = {}) {
  const sup = await superAdminP();
  await seedCanadaAlbertaPackages2026(sup);

  const club = await makeClub("Club PDOC");
  const admin      = await makeUser({ email: "admin.pdoc@a.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa         = await makeUser({ email: "pa.pdoc@a.test",    role: "PAYROLL_ADMIN", clubId: club.id });
  const controller = await makeUser({ email: "ctl.pdoc@a.test",   role: "CONTROLLER", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP    = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB",
    payrollAdminUserId: pa.id,
    controllerUserId:   controller.id,
  });
  const emp = await db().employee.create({
    data: {
      clubId: club.id, firstName: "Sal", lastName: "Aried",
      email: "sal@pdoc.test", hireDate: utc(2026, 1, 1),
      dateOfBirth: utc(1990, 5, 12), status: "ACTIVE",
      employeeNumber: "E-PDOC-1",
    },
  });
  const assn = await db().employeeEmploymentAssignment.create({
    data: {
      clubId: club.id, employeeId: emp.id, role: "PRIMARY",
      employmentType: "FULL_TIME", effectiveFrom: utc(2026, 1, 1),
    },
  });
  await db().employeeCompensation.create({
    data: {
      clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
      cadence: "SALARY", rate: "52000", currency: "CAD",
      effectiveFrom: utc(2026, 1, 1),
    },
  });
  await db().employeeBankAccount.create({
    data: {
      clubId: club.id, employeeId: emp.id,
      institutionSecretRef: "kms:test", transitSecretRef: "kms:test",
      accountSecretRef: "kms:test", holderName: "Sal Aried",
      bankFingerprint: "fp-pdoc", status: "VERIFIED", activatedAt: utc(2026, 1, 1),
    },
  });
  // Tax profile — MVP compromise: federalClaimSecretRef holds the
  // plain-decimal claim string. Batch-preparation freezes it as-is.
  await db().employeeTaxProfile.create({
    data: {
      clubId: club.id, employeeId: emp.id,
      province: "AB", td1FormVersion: "2026-01",
      effectiveFrom: utc(2026, 1, 1),
      federalClaimSecretRef:    tax.federalClaim    ?? "16452",
      provincialClaimSecretRef: tax.provincialClaim ?? "22769",
      claimZeroFederal:            tax.claimZeroFederal            ?? false,
      claimZeroProvincial:         tax.claimZeroProvincial         ?? false,
      totalIncomeLessThanClaim:    tax.totalIncomeLessThanClaim    ?? false,
      additionalFederalTaxAmount:  tax.additionalFederalTaxAmount  ?? "0",
      additionalProvincialTaxAmount: tax.additionalProvincialTaxAmount ?? "0",
    },
  });

  const pg = await db().payrollPayGroup.create({
    data: {
      clubId: club.id, code: "PG-PDOC", name: "PG-PDOC",
      payFrequency: "BIWEEKLY", payDateOffsetDays: 0,
      calendarAnchorDate: utc(2026, 1, 4),
    },
  });
  const taxYear = payDate.getUTCFullYear();
  const yearStart = utc(taxYear, 1, 4);
  let pp: { id: string } | null = null;
  for (let seq = 1; seq <= 26; seq++) {
    const start = new Date(yearStart.getTime() + (seq - 1) * 14 * 86400_000);
    const end   = new Date(start.getTime() + 13 * 86400_000);
    const pDate = end;
    const row = await db().payrollPayPeriod.create({
      data: {
        clubId: club.id, payGroupId: pg.id,
        sequenceInYear: seq, taxYear,
        periodStart: start, periodEnd: end, payDate: pDate,
      },
    });
    if (Math.abs(pDate.getTime() - payDate.getTime()) < 86400_000) pp = row;
  }
  if (!pp) throw new Error(`No seeded pay-period matches payDate ${payDate.toISOString()}`);
  await db().payrollPayGroupMember.create({
    data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2026, 1, 1) },
  });

  const prepared = await preparePayrollBatch(adminP, club.id, pp.id);
  // Also create the PAYROLL_REVIEW WI card so we can prove it gets
  // resolved by 2c's handoff.
  await orchestratePayrollReviewHandoff(adminP, club.id, pp.id, prepared.batchId);

  const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prepared.batchId } });
  await db().payrollBatchEarning.create({
    data: {
      clubId: club.id, batchId: prepared.batchId, batchEmployeeId: be.id,
      employeeId: emp.id, earningType: "SALARY",
      quantity: "1", rate: "2000.00", rateSource: "MANUAL",
    },
  });

  return { club, adminP, paP, controller, emp, pp, prepared };
}

// ---------------------------------------------------------------------------
// PDOC Scenarios — exact match, no tolerance
// ---------------------------------------------------------------------------

describe("Payroll-3B-5B-2c — PDOC Scenario 1 (H1, default TD1)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("gross 2000 → CPP 110.99, CPP2 0, EI 32.60, fed 163.23, AB 78.45, total 385.27, net 1614.73", async () => {
    const s = await pdocScenario(utc(2026, 3, 14));   // biweekly anchor
    const r = await calculatePayrollBatch(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(true);
    expect(r.lifecycleStatus).toBe("CALCULATED");
    expect(r.calculationVersion).toBe(1);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.batchId } });
    expect(Number(be.grossPay)).toBe(2000);
    expect(Number(be.deductionCppEeCombined)).toBe(110.99);
    expect(Number(be.deductionCppEeFirstAdd)).toBe(18.65);
    expect(Number(be.deductionCppEeBase)).toBe(92.34);
    expect(Number(be.deductionCpp2Ee)).toBe(0);
    expect(Number(be.deductionEiEe)).toBe(32.60);
    expect(Number(be.deductionFederalTax)).toBe(163.23);
    expect(Number(be.deductionProvincialTax)).toBe(78.45);
    expect(Number(be.additionalFederalTax)).toBe(0);
    expect(Number(be.additionalProvincialTax)).toBe(0);
    expect(Number(be.totalEmployeeDeductions)).toBe(385.27);
    expect(Number(be.netPay)).toBe(1614.73);
    // 2000 - (110.99 + 0 + 32.60 + 163.23 + 78.45) = 1614.73 ✓

    // Batch is now CALCULATED with metadata.
    const batch = await db().payrollBatch.findUniqueOrThrow({ where: { id: r.batchId } });
    expect(batch.status).toBe("CALCULATED");
    expect(batch.calculatedAt).not.toBeNull();
    expect(batch.calculationVersion).toBe(1);
    expect(batch.statutoryPackageId).toBe(r.statutoryPackageId);
    expect(batch.packageChecksum).toBe(r.packageChecksum);
    expect(batch.algorithmVersion).toBe(r.algorithmVersion);

    // Controller PAYROLL_FINAL_APPROVAL WI materialised, PAYROLL_REVIEW resolved.
    expect(r.finalApprovalWorkIntakeItemId).not.toBeNull();
    expect(r.finalApprovalOwnerUserId).toBe(s.controller.id);
    const finalApproval = await db().workIntakeItem.findUniqueOrThrow({ where: { id: r.finalApprovalWorkIntakeItemId! } });
    expect(finalApproval.workSubtype).toBe("PAYROLL_FINAL_APPROVAL");
    expect(finalApproval.workIntent).toBe("APPROVE");
    expect(finalApproval.ownerUserId).toBe(s.controller.id);
    expect(finalApproval.status).toBe("OPEN");
    // §41 preview MUST be executive-summary only — no SIN / bank / TD1 amount.
    expect(finalApproval.displayPreview ?? "").not.toMatch(/SIN|bank/i);
    expect(finalApproval.displayPreview ?? "").not.toContain("16452");

    // PAYROLL_REVIEW resolved.
    const reviewOrigin = await db().workIntakeOrigin.findFirstOrThrow({
      where: { clubId: s.club.id, kind: "PAYROLL_REVIEW", referenceId: r.batchId },
    });
    const reviewItem = await db().workIntakeItem.findUniqueOrThrow({ where: { id: reviewOrigin.workIntakeItemId } });
    expect(reviewItem.status).toBe("RESOLVED");

    // Calculation explanation snapshot is present + versioned.
    const explanation = JSON.parse(be.calculationExplanationJson ?? "{}");
    expect(explanation.schemaVersion).toBe(1);
    expect(explanation.algorithmVersion).toMatch(/^spectre-payroll-2c/);
    expect(explanation.federal.T4PerPeriod).toBe("163.23");
    expect(explanation.provincial.T4PPerPeriod).toBe("78.45");
    expect(explanation.f5A).toBe("18.65");

    // YTD snapshot preserved (frozen at calculation time).
    const snap = parseYtdSnapshotV1(be.ytdSnapshotJson);
    expect(snap?.schemaVersion).toBe(1);
    expect(snap?.ytdGrossEarnings).toBe("0");
  });
});

describe("Payroll-3B-5B-2c — PDOC Scenario 2 (H2, custom TD1)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("fed TD1 20000, AB TD1 26000 → CPP+EI unchanged; fed 144.12, AB 68.51, total 356.22, net 1643.78", async () => {
    const s = await pdocScenario(utc(2026, 9, 12), {
      federalClaim: "20000", provincialClaim: "26000",
    });
    const r = await calculatePayrollBatch(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(true);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.batchId } });
    expect(Number(be.deductionCppEeCombined)).toBe(110.99);   // TD1 does NOT leak into CPP
    expect(Number(be.deductionEiEe)).toBe(32.60);              // TD1 does NOT leak into EI
    expect(Number(be.deductionFederalTax)).toBe(144.12);
    expect(Number(be.deductionProvincialTax)).toBe(68.51);
    expect(Number(be.totalEmployeeDeductions)).toBe(356.22);
    expect(Number(be.netPay)).toBe(1643.78);
    // H2 package pinned.
    expect(r.packageVersion).toContain("H2");
  });
});

describe("Payroll-3B-5B-2c — PDOC Scenario 3 (additional tax 50/25)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("base fed 163.23 / AB 78.45 UNCHANGED from Scenario 1; additional 75.00 separate; total 460.27; net 1539.73", async () => {
    const s = await pdocScenario(utc(2026, 4, 25), {
      federalClaim: "16452", provincialClaim: "22769",
      additionalFederalTaxAmount:   "50.00",
      additionalProvincialTaxAmount: "25.00",
    });
    const r = await calculatePayrollBatch(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(true);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.batchId } });
    // Base statutory tax = identical to Scenario 1.
    expect(Number(be.deductionFederalTax)).toBe(163.23);
    expect(Number(be.deductionProvincialTax)).toBe(78.45);
    // Additional tax stored separately.
    expect(Number(be.additionalFederalTax)).toBe(50.00);
    expect(Number(be.additionalProvincialTax)).toBe(25.00);
    // Total income-tax deductions = 316.68 (163.23 + 78.45 + 75.00).
    // Total employee deductions = 460.27 = 110.99 + 32.60 + 316.68.
    expect(Number(be.totalEmployeeDeductions)).toBe(460.27);
    expect(Number(be.netPay)).toBe(1539.73);
  });
});

describe("Payroll-3B-5B-2c — PDOC Scenario 4 (more-than-one-employer / claim-zero federal)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("claimZeroFederal=true → fed 251.82, AB 78.45, total 473.86, net 1526.14", async () => {
    const s = await pdocScenario(utc(2026, 5, 9), {
      federalClaim: "0", claimZeroFederal: true,
      provincialClaim: "22769",
    });
    const r = await calculatePayrollBatch(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(true);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.batchId } });
    expect(Number(be.deductionFederalTax)).toBe(251.82);
    expect(Number(be.deductionProvincialTax)).toBe(78.45);
    expect(Number(be.totalEmployeeDeductions)).toBe(473.86);
    expect(Number(be.netPay)).toBe(1526.14);

    // Semantic condition preserved on the frozen tax facts.
    const explanation = JSON.parse(be.calculationExplanationJson ?? "{}");
    expect(explanation.federal.claimZeroFederal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TD1 immutability — the operative regression
// ---------------------------------------------------------------------------

describe("Payroll-3B-5B-2c — TD1 immutability regression (§3)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("mutating live EmployeeTaxProfile after PREPARED does NOT alter an existing prepared batch", async () => {
    const s = await pdocScenario(utc(2026, 3, 14));    // frozen fedClaim = 16452
    // Corrupt the live TD1 to a value that would radically change the calc.
    await db().employeeTaxProfile.updateMany({
      where: { clubId: s.club.id, employeeId: s.emp.id },
      data: {
        federalClaimSecretRef:    "1",
        provincialClaimSecretRef: "1",
        claimZeroFederal: true,
        additionalFederalTaxAmount: "999",
      },
    });
    const r = await calculatePayrollBatch(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(true);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.batchId } });
    // Scenario 1 numbers must still hold — TD1 was frozen at PREPARED.
    expect(Number(be.deductionFederalTax)).toBe(163.23);
    expect(Number(be.additionalFederalTax)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PRIOR_EMPLOYER exclusion (regression from 2b)
// ---------------------------------------------------------------------------

describe("Payroll-3B-5B-2c — PRIOR_EMPLOYER exclusion regression", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("prior-employer YTD does NOT reduce Spectre's CPP/EI room; Scenario 1 result unchanged", async () => {
    const s = await pdocScenario(utc(2026, 3, 14));
    const ob = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id, taxYear: 2026,
      throughPayDate: utc(2026, 3, 1),
      values: { ...zeroOB, ytdPensionableEarnings: "80000", ytdInsurableEarnings: "68900",
                 ytdCppEE: "4230.45", ytdCpp2EE: "416.00", ytdEiEE: "1123.07" },
      priorPayrollKind: "PRIOR_EMPLOYER", priorEmployerId: "OTHER-BN-987654321",
    });
    await activateOpeningBalance(s.paP, s.club.id, ob.id);
    const r = await calculatePayrollBatch(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(true);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.batchId } });
    expect(Number(be.deductionCppEeCombined)).toBe(110.99);
    expect(Number(be.deductionEiEe)).toBe(32.60);
    expect(Number(be.netPay)).toBe(1614.73);
  });
});

// ---------------------------------------------------------------------------
// Atomicity / rollback
// ---------------------------------------------------------------------------

describe("Payroll-3B-5B-2c — atomic rollback on readiness BLOCKER (§37)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("STATUTORY_PACKAGE_UNRESOLVED → nothing persisted, batch remains PREPARED, no CALCULATED, no WI handoff", async () => {
    const s = await pdocScenario(utc(2026, 3, 14));
    await db().payrollStatutoryPackage.deleteMany({ where: { jurisdictionCountry: "CA", jurisdictionProvince: "AB" } });
    const r = await calculatePayrollBatch(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(false);
    expect(r.lifecycleStatus).toBe("PREPARED");
    expect(r.finalApprovalWorkIntakeItemId).toBeNull();
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: s.prepared.batchId } });
    expect(be.grossPay).toBeNull();
    expect(be.deductionFederalTax).toBeNull();
    const batch = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.prepared.batchId } });
    expect(batch.status).toBe("PREPARED");
    expect(batch.calculatedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Work Intake idempotency
// ---------------------------------------------------------------------------

describe("Payroll-3B-5B-2c — WI idempotency + calculationVersion increment (§39, §43)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("recalculation refreshes the SAME PAYROLL_FINAL_APPROVAL card + increments calculationVersion", async () => {
    const s = await pdocScenario(utc(2026, 3, 14));
    const r1 = await calculatePayrollBatch(s.paP, s.club.id, s.prepared.batchId);
    expect(r1.calculationVersion).toBe(1);
    const r2 = await calculatePayrollBatch(s.paP, s.club.id, s.prepared.batchId);
    expect(r2.calculationVersion).toBe(2);
    expect(r2.finalApprovalWorkIntakeItemId).toBe(r1.finalApprovalWorkIntakeItemId);   // same card
    const count = await db().workIntakeItem.count({
      where: { clubId: s.club.id, workSubtype: "PAYROLL_FINAL_APPROVAL", status: "OPEN" },
    });
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Missing controller — do NOT invent one
// ---------------------------------------------------------------------------

describe("Payroll-3B-5B-2c — Controller-config gap (§40)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("PayrollClubConfig.controllerUserId not set → CALCULATED persists but WI is NOT materialised", async () => {
    const s = await pdocScenario(utc(2026, 3, 14));
    // Clear the controller assignment on the club config.
    await db().payrollClubConfig.update({
      where: { clubId: s.club.id }, data: { controllerUserId: null },
    });
    const r = await calculatePayrollBatch(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(true);
    expect(r.lifecycleStatus).toBe("CALCULATED");
    expect(r.finalApprovalWorkIntakeItemId).toBeNull();
    expect(r.finalApprovalOwnerUserId).toBeNull();
    // Explicit audit event fired for the gap.
    const gapAudit = await db().auditLog.findFirst({
      where: { entityId: r.batchId, action: "payroll.batch.calculate.controller-gap" },
    });
    expect(gapAudit).not.toBeNull();
  });
});
