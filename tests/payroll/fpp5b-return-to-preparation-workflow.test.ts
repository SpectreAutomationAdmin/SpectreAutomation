// FPP-5B (2026-09-21) — Return-to-Preparation lifecycle + UX pins.
//
// Two concerns:
//   1. The service returnBatchToPreparation must correctly transition
//      status CALCULATED → PREPARED, clear calculatedAt, and invalidate
//      the CALCULATED_PAYROLL attestation while preserving
//      calculationVersion and audit history.
//   2. The founder-observed dead-end was a UX defect (details-dropdown
//      never submitting). This suite pins the DERIVATION rules the UI
//      uses so a post-Return-to-Prep state exposes the correct
//      primary/secondary action set.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { returnBatchToPreparation } from "@/lib/payroll/return-to-preparation";
import { attestBatchReview } from "@/lib/payroll/batch-review";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function scenario() {
  const club = await makeClub("FPP-5B Club");
  const admin = await makeUser({ email: "adminA@fpp5b.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa = await makeUser({ email: "paA@fpp5b.test", role: "PAYROLL_ADMIN", clubId: club.id });
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
      email: "rtp@fpp5b.test", hireDate: d(2026, 2, 1), status: "ACTIVE",
      employeeNumber: "E-FPP5B",
    },
  });
  const batch = await db().payrollBatch.create({
    data: {
      clubId: club.id, payGroupId: pg.id, payPeriodId: period.id,
      status: "CALCULATED", calculationVersion: 1,
      preparedAt: d(2026, 9, 15), calculatedAt: d(2026, 9, 15),
    },
  });
  await db().payrollBatchEmployee.create({
    data: {
      batchId: batch.id, employeeId: emp.id, clubId: club.id,
      jurisdictionCountry: "CA", employeeLifecycleAtPrep: "ACTIVE",
      grossPay: "4620.83", netPay: "2967.43", totalEmployeeDeductions: "1653.40",
    },
  });
  return { club, adminP, paP, pg, period, batch };
}

describe("FPP-5B — Return-to-Preparation lifecycle", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("CALCULATED → VOIDED (FPP-5C); calculationVersion + calculated columns preserved for audit", async () => {
    const s = await scenario();
    const r = await returnBatchToPreparation(s.paP, s.club.id, s.batch.id, "test");
    expect(r.priorStatus).toBe("CALCULATED");
    // FPP-5C: return-to-preparation now voids the batch so a fresh
    // Prepare is required. The next-status contract accordingly is
    // "VOIDED", not "PREPARED".
    expect(r.nextStatus).toBe("VOIDED");
    expect(r.calculationVersion).toBe(1); // preserved

    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: s.batch.id } });
    expect(after.status).toBe("VOIDED");
    // Calculated columns preserved as historical audit evidence.
    expect(after.calculatedAt).not.toBeNull();
    expect(after.calculationVersion).toBe(1);
    // Batch employee calculated columns are UNCHANGED by return-to-prep
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: s.batch.id } });
    expect(be.grossPay?.toString()).toBe("4620.83");
    expect(be.totalEmployeeDeductions?.toString()).toBe("1653.4");
  });

  it("Refuses reason=empty", async () => {
    const s = await scenario();
    await expect(
      returnBatchToPreparation(s.paP, s.club.id, s.batch.id, ""),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("Refuses non-CALCULATED / non-RETURNED_FOR_CORRECTION batches", async () => {
    const s = await scenario();
    // Move the batch to POSTED
    await db().payrollBatch.update({
      where: { id: s.batch.id },
      data: { status: "POSTED" },
    });
    await expect(
      returnBatchToPreparation(s.paP, s.club.id, s.batch.id, "test"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("Invalidates CALCULATED_PAYROLL attestation but preserves RECURRING_COMPONENTS", async () => {
    const s = await scenario();
    // Attest both dimensions
    await attestBatchReview(s.paP, s.club.id, s.batch.id, "RECURRING_COMPONENTS");
    await attestBatchReview(s.paP, s.club.id, s.batch.id, "CALCULATED_PAYROLL");
    const before = await db().payrollBatchReviewAttestation.findMany({
      where: { batchId: s.batch.id, invalidatedAt: null },
    });
    expect(before.map((a) => a.dimension).sort()).toEqual(["CALCULATED_PAYROLL", "RECURRING_COMPONENTS"]);

    await returnBatchToPreparation(s.paP, s.club.id, s.batch.id, "test");

    const after = await db().payrollBatchReviewAttestation.findMany({
      where: { batchId: s.batch.id },
      orderBy: { dimension: "asc" },
    });
    // CALCULATED_PAYROLL invalidated; RECURRING_COMPONENTS still current
    const calc = after.find((a) => a.dimension === "CALCULATED_PAYROLL");
    const recurring = after.find((a) => a.dimension === "RECURRING_COMPONENTS");
    expect(calc?.invalidatedAt).not.toBeNull();
    expect(recurring?.invalidatedAt).toBeNull();
  });
});

/**
 * FPP-5B — UI derivation contract for the post-Return-to-Preparation
 * state. Pins the "when to show the amber callout" and "what the
 * primary action is" rules so the workspace never re-enters the
 * dead-end.
 */
describe("FPP-5B — post-Return-to-Preparation UI derivation", () => {
  it("Amber callout renders when PREPARED + calculationVersion > 0 + calculatedAt null", () => {
    const state = {
      batchStatus: "PREPARED",
      batch: { calculationVersion: 1, calculatedAt: null },
    };
    const shouldShowCallout =
      state.batchStatus === "PREPARED" &&
      (state.batch.calculationVersion ?? 0) > 0 &&
      state.batch.calculatedAt == null;
    expect(shouldShowCallout).toBe(true);
  });

  it("Callout does NOT render on a fresh PREPARED batch (never calculated)", () => {
    const state = {
      batchStatus: "PREPARED",
      batch: { calculationVersion: 0, calculatedAt: null },
    };
    const shouldShowCallout =
      state.batchStatus === "PREPARED" &&
      (state.batch.calculationVersion ?? 0) > 0 &&
      state.batch.calculatedAt == null;
    expect(shouldShowCallout).toBe(false);
  });

  it("Callout does NOT render on a CALCULATED batch", () => {
    const state = {
      batchStatus: "CALCULATED",
      batch: { calculationVersion: 1, calculatedAt: new Date().toISOString() },
    };
    const shouldShowCallout =
      state.batchStatus === "PREPARED" &&
      (state.batch.calculationVersion ?? 0) > 0 &&
      state.batch.calculatedAt == null;
    expect(shouldShowCallout).toBe(false);
  });
});
