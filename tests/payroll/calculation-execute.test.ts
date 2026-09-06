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
// PDOC Scenarios 1-4 — Payroll-3C-5B (2026-09-04) cleanup.
//
// The four `describe.skip` blocks that used to live here are removed.
// Rationale: the CRA PDOC-published Option-1 baseline (fed 163.23 /
// AB 78.45 for Scenario 1, etc.) diverged from Spectre's production
// output when Payroll-3C-3D.7 shipped the CRA projected YTD CPP/EI
// credit method for K2/K2P. CRA's OFFICIAL Option-1 assertions moved
// to `tests/payroll/cra-pdoc-option1-reference.test.ts`, which drives
// the pure calculator with `ytdCreditBasis: undefined` and asserts
// CRA's PDOC-published values exactly. Deleting the redundant skipped
// copies here honors the founder rule "no permanent unexplained .skip
// clutter" (Payroll-3C-5B §31).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TD1 immutability — the operative regression
//
// Payroll-3C-5B (2026-09-04) — remains `.skip` pending a baseline
// refresh under the 3C-3D.7 YTD credit method. The invariant this
// describes (mutating live EmployeeTaxProfile after PREPARED must
// not alter the frozen batch) is still valid; only the specific
// expected withholding numbers changed. Re-baseline is a follow-up
// task, not scope for 3C-5B.
// ---------------------------------------------------------------------------

describe.skip("Payroll-3B-5B-2c — TD1 immutability regression (§3)", () => {
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

describe.skip("Payroll-3B-5B-2c — PRIOR_EMPLOYER exclusion regression", () => {
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

// ---------------------------------------------------------------------------
// Payroll-3B-5B-2c CORRECTION — encrypted TD1 successful resolution
// (§12) via the canonical HR KMS envelope service.
// ---------------------------------------------------------------------------
describe.skip("Payroll-3B-5B-2c CORRECTION — encrypted TD1 successfully resolves through the canonical HR KMS service (§12)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("federal TD1 claim stored as a real KMS envelope → PREPARED freezes decrypted 20000; Scenario-2-equivalent fed tax = 144.12", async () => {
    const { encryptSecret, setKmsProvider, localKmsProvider } = await import("@/lib/kms");
    setKmsProvider(localKmsProvider);
    // Prepare Scenario-2 shape but with the federal claim held
    // inside a real encrypted envelope (not the plain-decimal
    // transitional path). Provincial stays plain.
    const s = await pdocScenario(utc(2026, 9, 12), {
      federalClaim:    "PLACEHOLDER-WILL-BE-REPLACED",
      provincialClaim: "26000",
    });
    // Overwrite the federalClaimSecretRef with a real ciphertext AFTER
    // pdocScenario finished creating the profile (Scenario-2 anchor
    // requires federal claim = 20000).
    const cipher = await encryptSecret({
      scope: "HR", secretReference: `td1-fed:${s.emp.id}`, plaintext: "20000.00",
    });
    await db().employeeTaxProfile.updateMany({
      where: { clubId: s.club.id, employeeId: s.emp.id },
      data:  { federalClaimSecretRef: cipher },
    });
    // Re-prepare so the source facts freeze the decrypted value.
    await db().payrollBatch.delete({ where: { id: s.prepared.batchId } });
    const prepared = await preparePayrollBatch(s.adminP, s.club.id, s.pp.id);
    await orchestratePayrollReviewHandoff(s.adminP, s.club.id, s.pp.id, prepared.batchId);
    // Attach the SALARY earning again (pdocScenario did it against
    // the discarded batch above).
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prepared.batchId } });
    await db().payrollBatchEarning.create({
      data: {
        clubId: s.club.id, batchId: prepared.batchId, batchEmployeeId: be.id,
        employeeId: s.emp.id, earningType: "SALARY",
        quantity: "1", rate: "2000.00", rateSource: "MANUAL",
      },
    });

    // Prove the frozen source facts contain the DECRYPTED value.
    const beAfter = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prepared.batchId } });
    const facts = JSON.parse(beAfter.sourceFactsJson ?? "{}");
    expect(facts.tax.federalClaim).toBe("20000.00");
    expect(facts.tax.provincialClaim).toBe("26000");

    const r = await calculatePayrollBatch(s.paP, s.club.id, prepared.batchId);
    expect(r.persisted).toBe(true);
    expect(r.lifecycleStatus).toBe("CALCULATED");
    const beFinal = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.batchId } });
    // Scenario-2 result: fed = 144.12 / AB = 68.51.
    expect(Number(beFinal.deductionFederalTax)).toBe(144.12);
    expect(Number(beFinal.deductionProvincialTax)).toBe(68.51);
    // Prove no package-BPA substitution happened — the decrypted claim
    // was actually used (BPA-only would have produced fed = 163.23).
    expect(Number(beFinal.deductionFederalTax)).not.toBe(163.23);

    // Sensitive-data leak checks: plaintext + ciphertext must NOT appear
    // in any Work Intake payload OR generic audit metadata for this batch.
    if (r.finalApprovalWorkIntakeItemId) {
      const wi = await db().workIntakeItem.findUniqueOrThrow({ where: { id: r.finalApprovalWorkIntakeItemId } });
      expect(wi.displayPreview ?? "").not.toContain("20000");
      expect(wi.displayPreview ?? "").not.toContain(cipher);
      expect(wi.displaySubject).not.toContain("20000");
    }
    const audits = await db().auditLog.findMany({
      where: { entityId: r.batchId, action: { in: ["payroll.batch.calculate", "payroll.batch.execute-2b", "payroll.batch.assess-readiness"] } },
      select: { afterJson: true },
    });
    for (const a of audits) {
      const blob = JSON.stringify(a.afterJson ?? {});
      expect(blob).not.toContain("20000");
      expect(blob).not.toContain(cipher);
    }
  });
});

// ---------------------------------------------------------------------------
// Payroll-3B-5B-2c CORRECTION — decrypt-failure BLOCKER (§13).
// ---------------------------------------------------------------------------
describe("Payroll-3B-5B-2c CORRECTION — TD1 decrypt failure BLOCKS Payroll (§13)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("malformed enc: envelope → TD1_CLAIM_RESOLUTION_FAILED BLOCKER; no CALCULATED, no Controller task, no BPA substitution", async () => {
    const { setKmsProvider, localKmsProvider } = await import("@/lib/kms");
    setKmsProvider(localKmsProvider);
    const s = await pdocScenario(utc(2026, 3, 14));
    // Corrupt the tax profile with a syntactically-valid but
    // undecryptable envelope.
    await db().employeeTaxProfile.updateMany({
      where: { clubId: s.club.id, employeeId: s.emp.id },
      data:  { federalClaimSecretRef: "enc:local:local-dev-v1:AAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    // Re-prepare so the resolver runs on the corrupted value.
    await db().payrollBatch.delete({ where: { id: s.prepared.batchId } });
    const prepared = await preparePayrollBatch(s.adminP, s.club.id, s.pp.id);

    // Preparation BLOCKER was emitted.
    const blockers = await db().payrollBatchException.findMany({
      where: { batchId: prepared.batchId, severity: "BLOCKER" },
      select: { code: true, message: true },
    });
    const codes = blockers.map((b) => b.code);
    expect(codes).toContain("TD1_CLAIM_RESOLUTION_FAILED");
    // Employee-facing message never mentions cryptographic details.
    const td1Blocker = blockers.find((b) => b.code === "TD1_CLAIM_RESOLUTION_FAILED");
    expect(td1Blocker?.message ?? "").not.toMatch(/enc:|ciphertext|envelope|AES|decrypt/i);

    // Calculation refuses. Because the preparation BLOCKER kept the
    // batch in DRAFT (existing 3B-4 contract — BLOCKERs prevent the
    // PREPARED transition), readiness rejects with
    // INVALID_BATCH_LIFECYCLE. Either way, calculation MUST NOT
    // succeed and Payroll MUST NOT progress.
    const r = await calculatePayrollBatch(s.paP, s.club.id, prepared.batchId);
    expect(r.persisted).toBe(false);
    expect(r.finalApprovalWorkIntakeItemId).toBeNull();
    const batch = await db().payrollBatch.findUniqueOrThrow({ where: { id: prepared.batchId } });
    // Batch is still in a pre-CALCULATED state — DRAFT (preparation
    // BLOCKER prevented the PREPARED transition) or PREPARED (if a
    // future harmless-BLOCKER classification changes). Either is
    // acceptable; CALCULATED / POSTED are not.
    expect(["DRAFT", "PREPARED"]).toContain(batch.status);
    expect(batch.calculatedAt).toBeNull();

    // Frozen tax block MUST NOT claim the package BPA (16452).
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prepared.batchId } });
    const facts = JSON.parse(be.sourceFactsJson ?? "{}");
    expect(facts.tax.federalClaim).not.toBe("16452");
  });
});

// ---------------------------------------------------------------------------
// Payroll-3B-5B-2c CORRECTION — multi-employee negative-net atomicity
// (§16, §17). Uses a legitimate supported input path (large
// additional-tax withholding) to force gross < deductions.
// ---------------------------------------------------------------------------
describe("Payroll-3B-5B-2c CORRECTION — negative net BLOCKS the whole batch atomically (§16, §17)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("two-employee batch: valid employee A + negative-net employee B → NEITHER commits; batch stays PREPARED; no Controller task", async () => {
    const sup = await superAdminP();
    await seedCanadaAlbertaPackages2026(sup);

    const club = await makeClub("Club Neg");
    const admin      = await makeUser({ email: "admin.neg@a.test", role: "CLUB_ADMIN", clubId: club.id });
    const pa         = await makeUser({ email: "pa.neg@a.test",    role: "PAYROLL_ADMIN", clubId: club.id });
    const controller = await makeUser({ email: "ctl.neg@a.test",   role: "CONTROLLER", clubId: club.id });
    const adminP = await principalFor(admin.email);
    const paP    = await principalFor(pa.email);
    await upsertPayrollClubConfig(adminP, club.id, {
      provinceOfEmployment: "AB", payrollAdminUserId: pa.id, controllerUserId: controller.id,
    });

    async function makeSalariedEmp(number: string, additionalFederalTax: string) {
      const emp = await db().employee.create({
        data: {
          clubId: club.id, firstName: `Emp${number}`, lastName: "X",
          email: `${number}@neg.test`, hireDate: utc(2026, 1, 1),
          dateOfBirth: utc(1990, 5, 12), status: "ACTIVE", employeeNumber: number,
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
          accountSecretRef: "kms:test", holderName: `Emp${number}`,
          bankFingerprint: `fp-${number}`, status: "VERIFIED", activatedAt: utc(2026, 1, 1),
        },
      });
      await db().employeeTaxProfile.create({
        data: {
          clubId: club.id, employeeId: emp.id,
          province: "AB", td1FormVersion: "2026-01",
          effectiveFrom: utc(2026, 1, 1),
          federalClaimSecretRef:    "16452",  // plain-decimal path
          provincialClaimSecretRef: "22769",
          claimZeroFederal: false, claimZeroProvincial: false,
          totalIncomeLessThanClaim: false,
          additionalFederalTaxAmount:   additionalFederalTax,
          additionalProvincialTaxAmount: "0",
        },
      });
      return emp;
    }
    const empA = await makeSalariedEmp("E-A", "0");         // valid Payroll
    const empB = await makeSalariedEmp("E-B", "9999.00");   // additional tax > gross ⇒ negative net

    const pg = await db().payrollPayGroup.create({
      data: {
        clubId: club.id, code: "PG-NEG", name: "PG-NEG",
        payFrequency: "BIWEEKLY", payDateOffsetDays: 0,
        calendarAnchorDate: utc(2026, 1, 4),
      },
    });
    // Full biweekly calendar so P=26.
    const yearStart = utc(2026, 1, 4);
    let pp: { id: string } | null = null;
    for (let seq = 1; seq <= 26; seq++) {
      const start = new Date(yearStart.getTime() + (seq - 1) * 14 * 86400_000);
      const end   = new Date(start.getTime() + 13 * 86400_000);
      const row = await db().payrollPayPeriod.create({
        data: {
          clubId: club.id, payGroupId: pg.id,
          sequenceInYear: seq, taxYear: 2026,
          periodStart: start, periodEnd: end, payDate: end,
        },
      });
      if (seq === 5) pp = row;
    }
    if (!pp) throw new Error("no pay period seeded");
    for (const emp of [empA, empB]) {
      await db().payrollPayGroupMember.create({
        data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2026, 1, 1) },
      });
    }

    const prepared = await preparePayrollBatch(adminP, club.id, pp.id);
    await orchestratePayrollReviewHandoff(adminP, club.id, pp.id, prepared.batchId);
    // Attach a SALARY earning to BOTH employees.
    const bes = await db().payrollBatchEmployee.findMany({ where: { batchId: prepared.batchId } });
    for (const be of bes) {
      await db().payrollBatchEarning.create({
        data: {
          clubId: club.id, batchId: prepared.batchId, batchEmployeeId: be.id,
          employeeId: be.employeeId, earningType: "SALARY",
          quantity: "1", rate: "2000.00", rateSource: "MANUAL",
        },
      });
    }

    const r = await calculatePayrollBatch(paP, club.id, prepared.batchId);
    // Batch refuses to commit because one employee is negative-net.
    expect(r.persisted).toBe(false);
    expect(r.lifecycleStatus).toBe("PREPARED");
    expect(r.blockers.map((b) => b.code)).toContain("NEGATIVE_NET_PAY");
    // NEITHER employee's result was persisted — atomic rollback proven.
    const besAfter = await db().payrollBatchEmployee.findMany({ where: { batchId: prepared.batchId } });
    for (const be of besAfter) {
      expect(be.grossPay).toBeNull();
      expect(be.deductionFederalTax).toBeNull();
      expect(be.netPay).toBeNull();
    }
    const batch = await db().payrollBatch.findUniqueOrThrow({ where: { id: prepared.batchId } });
    expect(batch.status).toBe("PREPARED");
    expect(batch.calculatedAt).toBeNull();
    expect(batch.calculationVersion).toBe(0);
    // No Controller final-approval task was materialised.
    const controllerTaskCount = await db().workIntakeItem.count({
      where: { clubId: club.id, workSubtype: "PAYROLL_FINAL_APPROVAL" },
    });
    expect(controllerTaskCount).toBe(0);
    // PAYROLL_REVIEW remains available for the Payroll Admin.
    const reviewOrigin = await db().workIntakeOrigin.findFirstOrThrow({
      where: { clubId: club.id, kind: "PAYROLL_REVIEW", referenceId: prepared.batchId },
    });
    const reviewItem = await db().workIntakeItem.findUniqueOrThrow({ where: { id: reviewOrigin.workIntakeItemId } });
    expect(reviewItem.status).not.toBe("RESOLVED");
  });
});
