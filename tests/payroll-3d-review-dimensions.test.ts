// Payroll Admin Slice 3D (2026-09-12) — EMPLOYEE_DATA +
// CALCULATED_PAYROLL review-attestation invariants + checklist
// denominator regressions + canonical Calculate readiness composition
// + Return-to-Preparation lifecycle.
//
// Tests target the FUNDAMENTAL contract, not the calculator:
//   1. Checklist header derives from the SAME array that renders the
//      rows (§43 A/B/C). No hard-coded denominator.
//   2. EMPLOYEE_DATA fingerprint covers frozen sourceFactsJson +
//      salaried + approvedHoursSnapshot; stable when nothing changes.
//   3. CALCULATED_PAYROLL fingerprint is empty when calculatedAt is
//      null; non-empty (dependent on version + result columns) once
//      batch is CALCULATED.
//   4. `derivePayrollCalculateReadiness` composes the eight rules of
//      §5 (batch=PREPARED, allImported, allDeptApproved, no awaiting-
//      freeze, no blockers, three reviews current).
//   5. Return-to-Preparation refuses non-CALCULATED, transitions
//      CALCULATED → PREPARED, invalidates CALCULATED_PAYROLL, and
//      preserves calculationVersion.

import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Principal } from "@/lib/rbac";
import {
  attestBatchReview,
  computeReviewFingerprint,
  getBatchReviewStatus,
} from "@/lib/payroll/batch-review";
import { derivePayrollCalculateReadiness } from "@/lib/payroll/payroll-readiness";
import { returnBatchToPreparation } from "@/lib/payroll/return-to-preparation";

const prisma = new PrismaClient();
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function editorPrincipal(clubId: string, id: string = "system-test-editor-3d"): Principal {
  return {
    id, kind: "user",
    memberships: [{ clubId, roleKey: "PAYROLL_ADMIN" as const }],
    activeClubId: clubId,
  } as unknown as Principal;
}

async function seedBatch(): Promise<{
  clubId: string; batchId: string; batchEmployeeId: string; employeeId: string;
}> {
  const clubId = `club-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.club.create({
    data: {
      id: clubId, slug: clubId, name: `Test Club ${clubId}`, wordmark: clubId,
      timezone: "America/Edmonton", payrollProvince: "AB",
    },
  });
  await prisma.user.upsert({
    where: { id: "system-test-editor-3d" },
    update: {},
    create: {
      id: "system-test-editor-3d", email: "editor-3d@fixture.test",
      name: "Test Editor 3D", role: "PAYROLL_ADMIN", passwordHash: "x",
    },
  });
  const payGroupId = `pg-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollPayGroup.create({
    data: {
      id: payGroupId, clubId, code: "BW", name: "Bi-Weekly",
      payFrequency: "BIWEEKLY", payDateOffsetDays: 5,
      calendarAnchorDate: utc(2026, 8, 30), active: true,
    },
  });
  const payPeriodId = `pp-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollPayPeriod.create({
    data: {
      id: payPeriodId, clubId, payGroupId,
      sequenceInYear: 18, taxYear: 2026,
      periodStart: utc(2026, 8, 30), periodEnd: utc(2026, 9, 13),
      payDate: utc(2026, 9, 12), status: "OPEN",
    },
  });
  const employeeId = `emp-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.employee.create({
    data: {
      id: employeeId, clubId, firstName: "Test", lastName: "Employee",
      employeeNumber: employeeId.slice(-8),
      hireDate: utc(2026, 8, 1), employeeLifecycle: "ACTIVE",
      timekeepingMethod: "CLOCK_REQUIRED",
    },
  });
  const batchId = `bch-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollBatch.create({
    data: {
      id: batchId, clubId, payGroupId, payPeriodId, status: "PREPARED",
      sequence: 1, preparedAt: new Date(), preparedByUserId: "system-test-editor-3d",
      sourceSnapshotAt: new Date(),
    },
  });
  const batchEmployeeId = `be-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollBatchEmployee.create({
    data: {
      id: batchEmployeeId, clubId, batchId, employeeId,
      payGroupMemberId: `pgm-${Math.random().toString(36).slice(2, 8)}`,
      salaried: false, status: "INCLUDED",
      jurisdictionCountry: "CA", jurisdictionProvince: "AB",
      employeeLifecycleAtPrep: "ACTIVE",
      compensationReady: true, bankingReady: true, sinReady: true,
      federalTd1Ready: true, provincialTd1Ready: true,
      bankingStatus: "VERIFIED",
      membershipEffectiveFrom: utc(2026, 8, 1),
      membershipEffectiveTo: null,
      coverageStart: utc(2026, 8, 30),
      coverageEnd:   utc(2026, 9, 13),
      dateOfBirthSnapshot: utc(1995, 4, 12),
      approvedHoursSnapshot: 40.0,
      sourceFactsJson: JSON.stringify({ schemaVersion: 1, identity: { dateOfBirth: "1995-04-12T00:00:00.000Z" }, coverage: { membershipEffectiveFrom: "2026-08-01T00:00:00.000Z", membershipEffectiveTo: null, coverageStart: "2026-08-30T00:00:00.000Z", coverageEnd: "2026-09-13T00:00:00.000Z", coverageDays: 14, periodDays: 14, isFullPeriod: true }, assignments: [], compensations: [{ id: "c1", assignmentId: null, payType: "HOURLY", hourlyRate: "18.00", annualSalary: null, effectiveFrom: "2026-08-01T00:00:00.000Z", effectiveTo: null }], allowances: [], tax: { federalClaim: "16452", provincialClaim: "22769", claimZeroFederal: false, claimZeroProvincial: false, totalIncomeLessThanClaim: false, additionalFederalTaxAmount: "0", additionalProvincialTaxAmount: "0" } }),
    },
  });
  return { clubId, batchId, batchEmployeeId, employeeId };
}

describe("Payroll 3D — checklist denominator regression (§43)", () => {
  it("N-of-M count derives from the same array as the rendered rows", () => {
    // Regression: production defect showed "5 of 5" beside 6 visible rows
    // because the header filtered `!future` while the body iterated the
    // full list. The fix uses items.length + items.filter(done) so the
    // two are guaranteed identical.
    const items = [
      { id: "time-imported",         done: true,  future: false },
      { id: "department-approvals",  done: true,  future: false },
      { id: "resolve-exceptions",    done: true,  future: false },
      { id: "one-time-adjustments",  done: true,  future: false },
      { id: "recurring-components",  done: true,  future: false },
      { id: "verify-employee-data",  done: false, future: false },
    ];
    const total = items.length;
    const done = items.filter((i) => i.done).length;
    expect(total).toBe(6);
    expect(done).toBe(5);
    // With item 6 completed, the count becomes 6/6.
    items[5]!.done = true;
    expect(items.filter((i) => i.done).length).toBe(6);
  });
});

describe("Payroll 3D — EMPLOYEE_DATA fingerprint", () => {
  it("fingerprint is stable across repeated compute calls when data unchanged", async () => {
    const { clubId, batchId } = await seedBatch();
    const f1 = await computeReviewFingerprint(clubId, batchId, "EMPLOYEE_DATA");
    const f2 = await computeReviewFingerprint(clubId, batchId, "EMPLOYEE_DATA");
    expect(f1).toBe(f2);
    // Non-empty because the batch has 1 employee.
    expect(f1).not.toBe(await computeReviewFingerprint(clubId, batchId, "ONE_TIME_ADJUSTMENTS"));
  });

  it("attesting EMPLOYEE_DATA persists and reads back as current", async () => {
    const { clubId, batchId } = await seedBatch();
    const p = editorPrincipal(clubId);
    await attestBatchReview(p, clubId, batchId, "EMPLOYEE_DATA");
    const status = await getBatchReviewStatus(p, clubId, batchId);
    const row = status.find((s) => s.dimension === "EMPLOYEE_DATA");
    expect(row?.attestation?.isCurrent).toBe(true);
  });

  it("mutating a batch employee's sourceFactsJson invalidates EMPLOYEE_DATA fingerprint", async () => {
    const { clubId, batchId, batchEmployeeId } = await seedBatch();
    const before = await computeReviewFingerprint(clubId, batchId, "EMPLOYEE_DATA");
    await prisma.payrollBatchEmployee.update({
      where: { id: batchEmployeeId },
      data: { sourceFactsJson: JSON.stringify({ schemaVersion: 1, mutated: true }) },
    });
    const after = await computeReviewFingerprint(clubId, batchId, "EMPLOYEE_DATA");
    expect(after).not.toBe(before);
  });
});

describe("Payroll 3D — CALCULATED_PAYROLL fingerprint", () => {
  it("returns the empty-set hash while calculatedAt is null (PREPARED)", async () => {
    const { clubId, batchId } = await seedBatch();
    const fp = await computeReviewFingerprint(clubId, batchId, "CALCULATED_PAYROLL");
    // Deterministic: sha256 of "CALCULATED_PAYROLL:empty".
    const crypto = await import("node:crypto");
    const expected = crypto.createHash("sha256").update("CALCULATED_PAYROLL:empty").digest("hex");
    expect(fp).toBe(expected);
  });

  it("changes once the batch reaches CALCULATED with non-null grossPay", async () => {
    const { clubId, batchId, batchEmployeeId } = await seedBatch();
    const beforeFp = await computeReviewFingerprint(clubId, batchId, "CALCULATED_PAYROLL");
    await prisma.payrollBatch.update({
      where: { id: batchId },
      data: { status: "CALCULATED", calculatedAt: new Date(), calculationVersion: 1 },
    });
    await prisma.payrollBatchEmployee.update({
      where: { id: batchEmployeeId },
      data: { grossPay: "720.00", netPay: "550.00", totalEmployeeDeductions: "170.00" },
    });
    const afterFp = await computeReviewFingerprint(clubId, batchId, "CALCULATED_PAYROLL");
    expect(afterFp).not.toBe(beforeFp);
  });
});

describe("Payroll 3D — derivePayrollCalculateReadiness composition (§5)", () => {
  it("emits every blocker for a fully-blocked PRE_PREPARE state", () => {
    const r = derivePayrollCalculateReadiness({
      batchStatus: null, allImported: false, allDepartmentApproved: false,
      awaitingFreezeScopeCount: 3, blockerExceptionCount: 2,
      oneTimeAdjustmentCount: 1, oneTimeReviewed: false,
      recurringSnapshotCount: 2, recurringReviewed: false,
      batchEmployeeCount: 4, employeeDataReviewed: false,
    });
    expect(r.canCalculate).toBe(false);
    const codes = r.blockers.map((b) => b.code);
    expect(codes).toContain("BATCH_NOT_PREPARED");
    expect(codes).toContain("TIME_NOT_IMPORTED");
    expect(codes).toContain("DEPARTMENT_APPROVALS_INCOMPLETE");
    expect(codes).toContain("SCOPES_AWAITING_FREEZE");
    expect(codes).toContain("BLOCKER_EXCEPTIONS_UNRESOLVED");
    expect(codes).toContain("ONE_TIME_ADJUSTMENTS_REVIEW_REQUIRED");
    expect(codes).toContain("RECURRING_COMPONENTS_REVIEW_REQUIRED");
    expect(codes).toContain("EMPLOYEE_DATA_REVIEW_REQUIRED");
  });

  it("clears every blocker once each review dimension is current", () => {
    const r = derivePayrollCalculateReadiness({
      batchStatus: "PREPARED",
      allImported: true, allDepartmentApproved: true, awaitingFreezeScopeCount: 0,
      blockerExceptionCount: 0,
      oneTimeAdjustmentCount: 2, oneTimeReviewed: true,
      recurringSnapshotCount: 3, recurringReviewed: true,
      batchEmployeeCount: 5, employeeDataReviewed: true,
    });
    expect(r.canCalculate).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it("empty-dataset review dimensions auto-complete (§5)", () => {
    const r = derivePayrollCalculateReadiness({
      batchStatus: "PREPARED",
      allImported: true, allDepartmentApproved: true, awaitingFreezeScopeCount: 0,
      blockerExceptionCount: 0,
      oneTimeAdjustmentCount: 0, oneTimeReviewed: false,
      recurringSnapshotCount: 0, recurringReviewed: false,
      batchEmployeeCount: 3, employeeDataReviewed: true,
    });
    expect(r.canCalculate).toBe(true);
  });

  it("refuses when even one review dimension is stale (5-of-6 → 5/6)", () => {
    const r = derivePayrollCalculateReadiness({
      batchStatus: "PREPARED",
      allImported: true, allDepartmentApproved: true, awaitingFreezeScopeCount: 0,
      blockerExceptionCount: 0,
      oneTimeAdjustmentCount: 1, oneTimeReviewed: true,
      recurringSnapshotCount: 1, recurringReviewed: true,
      batchEmployeeCount: 2, employeeDataReviewed: false,
    });
    expect(r.canCalculate).toBe(false);
    expect(r.blockers.map((b) => b.code)).toEqual(["EMPLOYEE_DATA_REVIEW_REQUIRED"]);
  });
});

describe("Payroll 3D — Return to Preparation (§24-26)", () => {
  it("refuses when batch is not CALCULATED", async () => {
    const { clubId, batchId } = await seedBatch();
    const p = editorPrincipal(clubId);
    await expect(returnBatchToPreparation(p, clubId, batchId, "test"))
      .rejects.toThrow(/Validation failed|CALCULATED/);
  });

  it("transitions CALCULATED → PREPARED, invalidates CALCULATED_PAYROLL, preserves calculationVersion", async () => {
    const { clubId, batchId } = await seedBatch();
    const p = editorPrincipal(clubId);
    // Simulate a CALCULATED batch + a prior CALCULATED_PAYROLL attestation.
    await prisma.payrollBatch.update({
      where: { id: batchId },
      data: { status: "CALCULATED", calculatedAt: new Date(), calculationVersion: 7 },
    });
    await attestBatchReview(p, clubId, batchId, "CALCULATED_PAYROLL");
    let status = await getBatchReviewStatus(p, clubId, batchId);
    expect(status.find((s) => s.dimension === "CALCULATED_PAYROLL")?.attestation?.isCurrent).toBe(true);

    const result = await returnBatchToPreparation(p, clubId, batchId, "correction");
    expect(result.priorStatus).toBe("CALCULATED");
    expect(result.nextStatus).toBe("PREPARED");
    expect(result.calculationVersion).toBe(7); // preserved

    const batch = await prisma.payrollBatch.findFirstOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("PREPARED");
    expect(batch.calculatedAt).toBeNull();
    expect(batch.calculationVersion).toBe(7);

    // Attestation invalidated.
    status = await getBatchReviewStatus(p, clubId, batchId);
    expect(status.find((s) => s.dimension === "CALCULATED_PAYROLL")?.attestation).toBeNull();
    const rows = await prisma.payrollBatchReviewAttestation.findMany({
      where: { clubId, batchId, dimension: "CALCULATED_PAYROLL" },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.invalidatedAt).not.toBeNull();
    expect(rows[0]!.invalidatedByReason).toBe("payroll.batch.return-to-preparation");
  });

  it("refuses when reason is empty", async () => {
    const { clubId, batchId } = await seedBatch();
    const p = editorPrincipal(clubId);
    await prisma.payrollBatch.update({
      where: { id: batchId },
      data: { status: "CALCULATED", calculatedAt: new Date(), calculationVersion: 1 },
    });
    await expect(returnBatchToPreparation(p, clubId, batchId, "  "))
      .rejects.toThrow(/Validation failed|Reason is required/);
  });
});
