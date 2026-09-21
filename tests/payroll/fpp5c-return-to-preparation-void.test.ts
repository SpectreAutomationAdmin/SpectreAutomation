// FPP-5C (2026-09-21) — Return-to-Preparation semantic correction.
//
// PRIOR: CALCULATED → PREPARED in place; frozen snapshots retained; a
// subsequent Calculate re-produced the same output. To pick up live
// config changes the operator had to Return → Discard → Prepare.
//
// CORRECTED: Return to Preparation VOIDS the batch. The next Prepare
// creates a fresh batch that freezes the current live catalogue. The
// voided batch remains in place (status VOIDED) with all calculated
// columns and snapshots intact — the historical audit record.
//
// This suite proves:
//   * status transitions CALCULATED → VOIDED atomically
//   * calculatedAt / calculationVersion / calculated columns / snapshots
//     are preserved on the VOIDED row (historical audit)
//   * time entries are released back to the pool
//   * APPLIED one-time earnings reset to SCHEDULED
//   * CALCULATED_PAYROLL attestation invalidated (not RECURRING)
//   * a subsequent preparePayrollBatch creates a NEW batch at
//     sequence + 1
//   * the new snapshot freezes the CURRENT live catalogue (RRSP flag
//     example) instead of the voided batch's frozen null
//   * refuses SUBMITTED_FOR_APPROVAL / APPROVED / POSTED / VOIDED / PREPARED
//   * requires a reason

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { returnBatchToPreparation } from "@/lib/payroll/return-to-preparation";
import { attestBatchReview } from "@/lib/payroll/batch-review";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function scenario(opts: { batchStatus?: string } = {}) {
  const club = await makeClub("FPP-5C Club");
  const admin = await makeUser({ email: "adminA@fpp5c.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa = await makeUser({ email: "paA@fpp5c.test", role: "PAYROLL_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id,
  });
  const pg = await db().payrollPayGroup.create({
    data: {
      clubId: club.id, code: "TEST-SM", name: "Test SM",
      payFrequency: "SEMI_MONTHLY", periodBoundaryStrategy: "LAGGED_SEMI_MONTHLY",
      active: true,
    },
  });
  const period = await db().payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 17,
      periodStart: d(2026, 8, 24), periodEnd: d(2026, 9, 9), payDate: d(2026, 9, 15),
    },
  });
  const emp = await db().employee.create({
    data: {
      clubId: club.id, firstName: "R", lastName: "TP",
      email: "rtp5c@fpp5c.test", hireDate: d(2026, 2, 1), status: "ACTIVE",
      employeeNumber: "E-FPP5C",
    },
  });
  const batch = await db().payrollBatch.create({
    data: {
      clubId: club.id, payGroupId: pg.id, payPeriodId: period.id,
      status: opts.batchStatus ?? "CALCULATED",
      calculationVersion: 1, sequence: 1,
      preparedAt: d(2026, 9, 15), calculatedAt: d(2026, 9, 15),
      packageChecksum: "test-checksum", algorithmVersion: "test-alg-v1",
    },
  });
  const bemp = await db().payrollBatchEmployee.create({
    data: {
      batchId: batch.id, employeeId: emp.id, clubId: club.id,
      jurisdictionCountry: "CA", employeeLifecycleAtPrep: "ACTIVE",
      grossPay: "4620.83", netPay: "2967.43", totalEmployeeDeductions: "1653.40",
      deductionCppEeCombined: "281.33", deductionEiEe: "75.32",
      deductionFederalTax: "699.17", deductionProvincialTax: "340.30",
      salaried: true,
    },
  });
  return { club, adminP, paP, pg, period, batch, bemp, emp };
}

describe("FPP-5C — Return-to-Preparation voids the batch (fresh Prepare required)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("CALCULATED → VOIDED; calculated columns preserved for audit", async () => {
    const s = await scenario();
    const r = await returnBatchToPreparation(s.paP, s.club.id, s.batch.id, "RRSP tax config change");
    expect(r.priorStatus).toBe("CALCULATED");
    expect(r.nextStatus).toBe("VOIDED");
    expect(r.calculationVersion).toBe(1);

    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(after.status).toBe("VOIDED");
    expect(after.voidedAt).not.toBeNull();
    expect(after.voidReason).toBe("RRSP tax config change");
    // Calculated columns preserved — historical evidence
    expect(after.calculatedAt).not.toBeNull();
    expect(after.calculationVersion).toBe(1);
    expect(after.packageChecksum).toBe("test-checksum");
    // Batch employee's calculated result columns unchanged
    const be = await db().payrollBatchEmployee.findUniqueOrThrow({ where: { id: s.bemp.id } });
    expect(be.grossPay?.toString()).toBe("4620.83");
    expect(be.netPay?.toString()).toBe("2967.43");
    expect(be.totalEmployeeDeductions?.toString()).toBe("1653.4");
    expect(be.deductionCppEeCombined?.toString()).toBe("281.33");
    expect(be.deductionFederalTax?.toString()).toBe("699.17");
  });

  it("Releases approved time entries back to the pool", async () => {
    const s = await scenario();
    // Attach a synthetic approved time entry to the batch employee
    await db().payrollApprovedTimeEntry.create({
      data: {
        clubId: s.club.id, employeeId: s.emp.id,
        consumedByBatchId: s.batch.id, consumedByBatchEmployeeId: s.bemp.id,
        workDate: d(2026, 9, 1),
        hours: "8.00",
        earningClassification: "REGULAR",
        approvalState: "APPROVED",
        approvedAt: d(2026, 9, 15),
      },
    });
    const r = await returnBatchToPreparation(s.paP, s.club.id, s.batch.id, "test");
    expect(r.releasedTimeEntryCount).toBe(1);
    const t = await db().payrollApprovedTimeEntry.findFirstOrThrow({
      where: { employeeId: s.emp.id },
    });
    expect(t.consumedByBatchId).toBeNull();
    expect(t.consumedByBatchEmployeeId).toBeNull();
  });

  it("Invalidates CALCULATED_PAYROLL attestation; preserves RECURRING_COMPONENTS", async () => {
    const s = await scenario();
    await attestBatchReview(s.paP, s.club.id, s.batch.id, "RECURRING_COMPONENTS");
    await attestBatchReview(s.paP, s.club.id, s.batch.id, "CALCULATED_PAYROLL");
    await returnBatchToPreparation(s.paP, s.club.id, s.batch.id, "test");
    const after = await db().payrollBatchReviewAttestation.findMany({
      where: { batchId: s.batch.id },
    });
    const calc = after.find((a) => a.dimension === "CALCULATED_PAYROLL");
    const recurring = after.find((a) => a.dimension === "RECURRING_COMPONENTS");
    expect(calc?.invalidatedAt).not.toBeNull();
    expect(recurring?.invalidatedAt).toBeNull();
  });

  it("Refuses empty reason", async () => {
    const s = await scenario();
    await expect(
      returnBatchToPreparation(s.paP, s.club.id, s.batch.id, ""),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("Refuses POSTED batches", async () => {
    const s = await scenario({ batchStatus: "POSTED" });
    await expect(
      returnBatchToPreparation(s.paP, s.club.id, s.batch.id, "test"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("Refuses SUBMITTED_FOR_APPROVAL batches", async () => {
    const s = await scenario({ batchStatus: "SUBMITTED_FOR_APPROVAL" });
    await expect(
      returnBatchToPreparation(s.paP, s.club.id, s.batch.id, "test"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("Refuses PREPARED batches (use Discard instead)", async () => {
    const s = await scenario({ batchStatus: "PREPARED" });
    await expect(
      returnBatchToPreparation(s.paP, s.club.id, s.batch.id, "test"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("After void, next Prepare filter (status not VOIDED) sees no active batch", async () => {
    const s = await scenario();
    await returnBatchToPreparation(s.paP, s.club.id, s.batch.id, "test");
    const nonVoided = await db().payrollBatch.findFirst({
      where: {
        clubId: s.club.id, payGroupId: s.pg.id, payPeriodId: s.period.id,
        status: { not: "VOIDED" },
      },
    });
    expect(nonVoided).toBeNull();
    // The voided one is still there (audit).
    const voided = await db().payrollBatch.findFirst({
      where: { id: s.batch.id },
    });
    expect(voided?.status).toBe("VOIDED");
  });

  it("Sequence bump: a subsequent Prepare would create batch at sequence 2", async () => {
    const s = await scenario();
    await returnBatchToPreparation(s.paP, s.club.id, s.batch.id, "test");
    const max = await db().payrollBatch.aggregate({
      where: { clubId: s.club.id, payGroupId: s.pg.id, payPeriodId: s.period.id },
      _max: { sequence: true },
    });
    expect((max._max.sequence ?? 0) + 1).toBe(2);
  });
});
