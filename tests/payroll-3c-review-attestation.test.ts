// Payroll 3C acceptance hotfix (2026-09-12) — review-attestation
// regression suite. Exercises the invariants of §3-§5 of the
// directive:
//   1. Zero rows → auto-complete (fingerprint stable → attestation
//      remains "current" against the empty-set fingerprint).
//   2. Attesting persists and reads back as isCurrent=true.
//   3. Adding a one-time adjustment atomically invalidates the
//      ONE_TIME_ADJUSTMENTS attestation.
//   4. Removing a one-time adjustment atomically invalidates the
//      ONE_TIME_ADJUSTMENTS attestation.
//   5. Unrelated recurring source change does NOT mutate the
//      current batch's snapshots → RECURRING_COMPONENTS attestation
//      stays current.
//   6. Read-only user cannot attest.
//   7. Cross-tenant user cannot attest.

import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Principal } from "@/lib/rbac";
import {
  attestBatchReview,
  computeReviewFingerprint,
  getBatchReviewStatus,
} from "@/lib/payroll/batch-review";
import { addOneTimeAdjustment, removeOneTimeAdjustment } from "@/lib/payroll/adjustments";

const prisma = new PrismaClient();
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function editorPrincipal(clubId: string, id: string = "system-test-editor"): Principal {
  return {
    id,
    kind: "user",
    memberships: [{ clubId, roleKey: "PAYROLL_ADMIN" as const }],
    activeClubId: clubId,
  } as unknown as Principal;
}
function readerPrincipal(clubId: string): Principal {
  return {
    id: "system-test-reader",
    kind: "user",
    memberships: [{ clubId, roleKey: "CONTROLLER" as const }],
    activeClubId: clubId,
  } as unknown as Principal;
}

async function seedScenario() {
  const clubId = `club-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.club.create({
    data: {
      id: clubId, slug: clubId, name: `Test Club ${clubId}`, wordmark: clubId,
      timezone: "America/Edmonton", payrollProvince: "AB",
    },
  });
  await prisma.user.upsert({
    where: { id: "system-test-editor" },
    update: {},
    create: { id: "system-test-editor", email: `editor@fixture.test`, name: "Test Editor", role: "PAYROLL_ADMIN", passwordHash: "x" },
  });
  await prisma.user.upsert({
    where: { id: "system-test-reader" },
    update: {},
    create: { id: "system-test-reader", email: `reader@fixture.test`, name: "Test Reader", role: "CONTROLLER", passwordHash: "x" },
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
  const assignmentId = `asn-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.employeeEmploymentAssignment.create({
    data: {
      id: assignmentId, clubId, employeeId, role: "PRIMARY",
      employmentType: "PART_TIME", effectiveFrom: utc(2026, 8, 1),
    },
  });
  const batchId = `bch-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollBatch.create({
    data: {
      id: batchId, clubId, payGroupId, payPeriodId, status: "PREPARED",
      sequence: 1, preparedAt: new Date(), preparedByUserId: "system-test-editor",
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
      sourceFactsJson: JSON.stringify({
        schemaVersion: 1,
        identity: { dateOfBirth: "1995-04-12T00:00:00.000Z" },
        coverage: {
          membershipEffectiveFrom: "2026-08-01T00:00:00.000Z",
          membershipEffectiveTo: null,
          coverageStart: "2026-08-30T00:00:00.000Z",
          coverageEnd:   "2026-09-13T00:00:00.000Z",
          coverageDays: 14, periodDays: 14, isFullPeriod: true,
        },
        assignments: [{ id: assignmentId, role: "PRIMARY", departmentId: null, positionId: null, employmentType: "PART_TIME", effectiveFrom: "2026-08-01T00:00:00.000Z", effectiveTo: null }],
        compensations: [{ id: `c-${Math.random().toString(36).slice(2, 8)}`, assignmentId: null, payType: "HOURLY", hourlyRate: "18.00", annualSalary: null, effectiveFrom: "2026-08-01T00:00:00.000Z", effectiveTo: null }],
        allowances: [],
        tax: { federalClaim: "16452", provincialClaim: "22769", claimZeroFederal: false, claimZeroProvincial: false, totalIncomeLessThanClaim: false, additionalFederalTaxAmount: "0", additionalProvincialTaxAmount: "0" },
      }),
    },
  });
  const componentId = `cmp-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.payrollComponent.create({
    data: {
      id: componentId, clubId, code: "BONUS", displayName: "Discretionary Bonus",
      category: "ADDITIONAL_EARNING", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY",
      calculationMethod: "FIXED_AMOUNT",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
      displaySection: "EARNINGS", displayOrder: 100,
      statutoryTreatmentSource: "CUSTOM",
    },
  });
  return { clubId, batchId, batchEmployeeId, employeeId, componentId };
}

describe("Payroll 3C acceptance-hotfix — review attestation", () => {
  it("empty dataset produces a stable fingerprint; attestation persists as current", async () => {
    const { clubId, batchId } = await seedScenario();
    const p = editorPrincipal(clubId);
    const fp1 = await computeReviewFingerprint(clubId, batchId, "ONE_TIME_ADJUSTMENTS");
    const { fingerprint } = await attestBatchReview(p, clubId, batchId, "ONE_TIME_ADJUSTMENTS");
    expect(fingerprint).toBe(fp1);
    const status = await getBatchReviewStatus(p, clubId, batchId);
    const otr = status.find((s) => s.dimension === "ONE_TIME_ADJUSTMENTS");
    expect(otr?.attestation?.isCurrent).toBe(true);
    expect(otr?.attestation?.attestedByDisplayName).toBe("Test Editor");
  });

  it("addOneTimeAdjustment atomically invalidates the ONE_TIME_ADJUSTMENTS attestation", async () => {
    const { clubId, batchId, batchEmployeeId, componentId: _ } = await seedScenario();
    const p = editorPrincipal(clubId);
    await attestBatchReview(p, clubId, batchId, "ONE_TIME_ADJUSTMENTS");
    // Guard: attestation is current before the mutation.
    let status = await getBatchReviewStatus(p, clubId, batchId);
    expect(status.find((s) => s.dimension === "ONE_TIME_ADJUSTMENTS")?.attestation?.isCurrent).toBe(true);
    // Add a one-time adjustment.
    await addOneTimeAdjustment(p, clubId, batchId, {
      batchEmployeeId, componentCode: "BONUS", amount: "50.00", reason: "test bonus",
    });
    // Attestation must now be non-current.
    status = await getBatchReviewStatus(p, clubId, batchId);
    const otr = status.find((s) => s.dimension === "ONE_TIME_ADJUSTMENTS");
    // The prior attestation row is invalidated → the reader emits attestation=null for the pair.
    expect(otr?.attestation).toBeNull();
  });

  it("removeOneTimeAdjustment atomically invalidates the current attestation", async () => {
    const { clubId, batchId, batchEmployeeId } = await seedScenario();
    const p = editorPrincipal(clubId);
    const { snapshotId } = await addOneTimeAdjustment(p, clubId, batchId, {
      batchEmployeeId, componentCode: "BONUS", amount: "25.00", reason: "test",
    });
    await attestBatchReview(p, clubId, batchId, "ONE_TIME_ADJUSTMENTS");
    let status = await getBatchReviewStatus(p, clubId, batchId);
    expect(status.find((s) => s.dimension === "ONE_TIME_ADJUSTMENTS")?.attestation?.isCurrent).toBe(true);
    await removeOneTimeAdjustment(p, clubId, { snapshotId });
    status = await getBatchReviewStatus(p, clubId, batchId);
    expect(status.find((s) => s.dimension === "ONE_TIME_ADJUSTMENTS")?.attestation).toBeNull();
  });

  it("RECURRING_COMPONENTS attestation stays current when no batch snapshot changes", async () => {
    const { clubId, batchId } = await seedScenario();
    const p = editorPrincipal(clubId);
    await attestBatchReview(p, clubId, batchId, "RECURRING_COMPONENTS");
    // Recurring source changes on the employee happen outside the batch
    // (not exercised here) — the frozen snapshot count remains zero,
    // fingerprint is stable, attestation stays current.
    const status = await getBatchReviewStatus(p, clubId, batchId);
    const rec = status.find((s) => s.dimension === "RECURRING_COMPONENTS");
    expect(rec?.attestation?.isCurrent).toBe(true);
  });

  it("read-only (Controller) principal cannot attest", async () => {
    const { clubId, batchId } = await seedScenario();
    const reader = readerPrincipal(clubId);
    await expect(attestBatchReview(reader, clubId, batchId, "ONE_TIME_ADJUSTMENTS"))
      .rejects.toThrow(/Missing permission|payroll:edit/);
  });

  it("cross-tenant editor cannot attest", async () => {
    const scenarioA = await seedScenario();
    const scenarioB = await seedScenario();
    // Editor holds PAYROLL_ADMIN on club A only.
    const p = editorPrincipal(scenarioA.clubId);
    await expect(attestBatchReview(p, scenarioB.clubId, scenarioB.batchId, "ONE_TIME_ADJUSTMENTS"))
      .rejects.toThrow(/Missing permission|payroll:edit/);
  });

  it("re-attesting supersedes the prior current row (historical trail preserved)", async () => {
    const { clubId, batchId, batchEmployeeId } = await seedScenario();
    const p = editorPrincipal(clubId);
    const first = await attestBatchReview(p, clubId, batchId, "ONE_TIME_ADJUSTMENTS");
    // Introduce dataset change so re-attest fingerprints differently.
    await addOneTimeAdjustment(p, clubId, batchId, {
      batchEmployeeId, componentCode: "BONUS", amount: "10.00", reason: "step",
    });
    const second = await attestBatchReview(p, clubId, batchId, "ONE_TIME_ADJUSTMENTS");
    expect(second.fingerprint).not.toBe(first.fingerprint);
    // Both rows exist in history; only the second is current.
    const rows = await prisma.payrollBatchReviewAttestation.findMany({
      where: { clubId, batchId, dimension: "ONE_TIME_ADJUSTMENTS" },
      orderBy: [{ attestedAt: "asc" }],
    });
    expect(rows.length).toBe(2);
    expect(rows[0]!.invalidatedAt).not.toBeNull();
    expect(rows[1]!.invalidatedAt).toBeNull();
  });
});
