// Slice B closeout (2026-09-18) — mandatory lifecycle proofs:
//   * void / discard resets APPLIED → SCHEDULED atomically
//   * POSTED source is never reset (defence-in-depth on top of the
//     outer void guard which already refuses POSTED batches)
//   * replacement Prepare consumes the reset SCHEDULED row exactly once
//   * invalid component at Prepare time — fail-closed (usage flipped
//     to RECURRING, component deactivated, or side/cashEffect changed)
//   * frozen snapshot survives live edits after Prepare
//   * scheduled bonus renders as its own line on PayStatementV2

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import {
  scheduleOneTimeEarning,
} from "@/lib/payroll/scheduled-one-time-earning";
import { snapshotEmployeeComponentsForBatch } from "@/lib/payroll/components-snapshot";
import { voidPayrollBatch, discardPreparedPayrollBatch } from "@/lib/payroll/batch-preparation";
import { buildPayStatement } from "@/lib/payroll/pay-statement";
import { Prisma } from "@prisma/client";

async function seedTestEmployee(clubId: string, payGroupId: string) {
  const id = `test-emp-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.employee.create({
    data: {
      id, clubId,
      employeeNumber: id.slice(-8),
      firstName: "Test", lastName: id.slice(-6),
      employeeLifecycle: "ACTIVE",
      hireDate: new Date("2020-01-01"),
      activatedAt: new Date("2020-01-01"),
    },
  });
  await prisma.payrollPayGroupMember.create({
    data: {
      clubId, employeeId: id, payGroupId,
      effectiveFrom: new Date("2020-01-01"),
    },
  });
  return id;
}

async function seedFixture(clubName: string) {
  const club = await makeClub(clubName);
  await makeUser({ email: `pa.${club.id}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const pa = await principalFor(`pa.${club.id}@t.test`);
  const pg = await prisma.payrollPayGroup.create({
    data: {
      clubId: club.id, code: "SM", name: "SM",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 0, active: true,
    },
  });
  const pp = await prisma.payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: pg.id, sequenceInYear: 18, taxYear: 2026,
      periodStart: new Date("2026-09-16T00:00:00.000Z"),
      periodEnd:   new Date("2026-10-01T00:00:00.000Z"),
      payDate:     new Date("2026-09-30T00:00:00.000Z"),
      status: "OPEN",
    },
  });
  const empId = await seedTestEmployee(club.id, pg.id);
  const bonus = await prisma.payrollComponent.create({
    data: {
      clubId: club.id, code: "PERF_BONUS", displayName: "Performance Bonus",
      category: "ADDITIONAL_EARNING", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY", calculationMethod: "FIXED_AMOUNT",
      displaySection: "EARNINGS", usage: "ONE_TIME", active: true,
    },
  });
  return { club, pa, pg, pp, empId, bonus };
}

async function seedBatchAndEmployee(clubId: string, payGroupId: string, payPeriodId: string, employeeId: string, status = "DRAFT", sequence?: number) {
  const seq = sequence ?? (await prisma.payrollBatch.count({ where: { clubId, payGroupId, payPeriodId } })) + 1;
  const batch = await prisma.payrollBatch.create({
    data: {
      clubId, payGroupId, payPeriodId, sequence: seq, status,
    },
  });
  const be = await prisma.payrollBatchEmployee.create({
    data: {
      clubId, batchId: batch.id, employeeId,
      jurisdictionCountry: "CA", jurisdictionProvince: "AB",
      employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED",
      salaried: true,
      grossPay: new Prisma.Decimal("4583.33"),
      earningsTaxable: new Prisma.Decimal("4583.33"),
      earningsPensionable: new Prisma.Decimal("4583.33"),
      earningsInsurable: new Prisma.Decimal("4583.33"),
      deductionCppEeBase: new Prisma.Decimal("0"),
      deductionCppEeFirstAdd: new Prisma.Decimal("0"),
      deductionCppEeCombined: new Prisma.Decimal("0"),
      deductionCpp2Ee: new Prisma.Decimal("0"),
      deductionEiEe: new Prisma.Decimal("0"),
      deductionFederalTax: new Prisma.Decimal("0"),
      deductionProvincialTax: new Prisma.Decimal("0"),
      totalEmployeeDeductions: new Prisma.Decimal("0"),
      netPay: new Prisma.Decimal("4583.33"),
      employerCppBase: new Prisma.Decimal("0"),
      employerCppFirstAdd: new Prisma.Decimal("0"),
      employerCppCombined: new Prisma.Decimal("0"),
      employerCpp2: new Prisma.Decimal("0"),
      employerEi: new Prisma.Decimal("0"),
    },
  });
  return { batch, be };
}

describe("Slice B closeout — void / discard resets APPLIED → SCHEDULED", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("A + B. discardPreparedPayrollBatch atomically resets APPLIED → SCHEDULED and clears applied linkage", async () => {
    const { club, pa, pg, pp, empId, bonus } = await seedFixture("Void A");
    const scheduled = await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: bonus.id,
      amount: "1500", reason: "Perf",
    });
    // Simulate Prepare by creating a batch + snapshot via the snapshotter.
    const { batch, be } = await seedBatchAndEmployee(club.id, pg.id, pp.id, empId, "PREPARED");
    await snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id, employeeId: empId,
      payPeriodId: pp.id, periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    });
    const applied = await prisma.payrollScheduledOneTimeEarning.findUnique({ where: { id: scheduled.id } });
    expect(applied?.status).toBe("APPLIED");
    expect(applied?.appliedToBatchId).toBe(batch.id);

    // Discard the batch via the REAL canonical service.
    await discardPreparedPayrollBatch(pa, club.id, batch.id, "changed mind");
    const reset = await prisma.payrollScheduledOneTimeEarning.findUnique({ where: { id: scheduled.id } });
    expect(reset?.status).toBe("SCHEDULED");
    expect(reset?.appliedAt).toBeNull();
    expect(reset?.appliedToBatchId).toBeNull();
    expect(reset?.appliedSnapshotId).toBeNull();
  });

  it("A + B. voidPayrollBatch also resets APPLIED → SCHEDULED", async () => {
    const { club, pa, pg, pp, empId, bonus } = await seedFixture("Void B");
    const scheduled = await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: bonus.id,
      amount: "500", reason: "spot",
    });
    const { batch, be } = await seedBatchAndEmployee(club.id, pg.id, pp.id, empId, "DRAFT");
    await snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id, employeeId: empId,
      payPeriodId: pp.id, periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    });

    await voidPayrollBatch(pa, club.id, batch.id, "cancel");
    const reset = await prisma.payrollScheduledOneTimeEarning.findUnique({ where: { id: scheduled.id } });
    expect(reset?.status).toBe("SCHEDULED");
    expect(reset?.appliedToBatchId).toBeNull();
  });

  it("C. Replacement Prepare consumes the reset row exactly once", async () => {
    const { club, pa, pg, pp, empId, bonus } = await seedFixture("Void Replay");
    const scheduled = await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: bonus.id,
      amount: "1500", reason: "Perf",
    });
    const first = await seedBatchAndEmployee(club.id, pg.id, pp.id, empId, "DRAFT");
    await snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: first.batch.id, batchEmployeeId: first.be.id, employeeId: empId,
      payPeriodId: pp.id, periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    });
    await voidPayrollBatch(pa, club.id, first.batch.id, "cancel");

    // Fresh batch #2 for the same period.
    const second = await seedBatchAndEmployee(club.id, pg.id, pp.id, empId, "DRAFT");
    await snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: second.batch.id, batchEmployeeId: second.be.id, employeeId: empId,
      payPeriodId: pp.id, periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    });

    // Exactly ONE snapshot on the new batch. Original voided batch's
    // snapshot may still exist (immutable audit) but is no longer
    // authoritative for the SCHEDULED source.
    const applied = await prisma.payrollScheduledOneTimeEarning.findUnique({ where: { id: scheduled.id } });
    expect(applied?.status).toBe("APPLIED");
    expect(applied?.appliedToBatchId).toBe(second.batch.id);
    const snapsSecond = await prisma.payrollBatchComponentSnapshot.count({
      where: { batchId: second.batch.id, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    });
    expect(snapsSecond).toBe(1);
    // The voided batch's snapshot is still in the DB (audit-preserved).
    const snapsFirst = await prisma.payrollBatchComponentSnapshot.count({
      where: { batchId: first.batch.id, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    });
    expect(snapsFirst).toBe(1);
  });

  it("D. POSTED batch's applied scheduled earning is never reset (outer guard refuses void of POSTED)", async () => {
    const { club, pa, pg, pp, empId, bonus } = await seedFixture("Void Posted");
    const scheduled = await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: bonus.id,
      amount: "1500", reason: "Perf",
    });
    const { batch, be } = await seedBatchAndEmployee(club.id, pg.id, pp.id, empId, "POSTED");
    await snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id, employeeId: empId,
      payPeriodId: pp.id, periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    });
    // Both void + discard MUST refuse for POSTED.
    await expect(voidPayrollBatch(pa, club.id, batch.id, "try")).rejects.toThrow();
    await expect(discardPreparedPayrollBatch(pa, club.id, batch.id, "try")).rejects.toThrow();
    // Source scheduled row remains APPLIED.
    const still = await prisma.payrollScheduledOneTimeEarning.findUnique({ where: { id: scheduled.id } });
    expect(still?.status).toBe("APPLIED");
    expect(still?.appliedToBatchId).toBe(batch.id);
  });
});

describe("Slice B closeout — invalid component at Prepare-time (fail-closed)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Q. component deactivated between schedule and Prepare → snapshotter throws with actionable message", async () => {
    const { club, pa, pg, pp, empId, bonus } = await seedFixture("Invalid Q");
    await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: bonus.id,
      amount: "1500", reason: "Perf",
    });
    // Deactivate the component after scheduling.
    await prisma.payrollComponent.update({ where: { id: bonus.id }, data: { active: false } });
    const { batch, be } = await seedBatchAndEmployee(club.id, pg.id, pp.id, empId);
    await expect(snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id, employeeId: empId,
      payPeriodId: pp.id, periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    })).rejects.toThrow(/inactive component/i);
  });

  it("R. component usage flipped from ONE_TIME to RECURRING before Prepare → snapshotter throws", async () => {
    const { club, pa, pg, pp, empId, bonus } = await seedFixture("Invalid R");
    await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: bonus.id,
      amount: "1500", reason: "Perf",
    });
    await prisma.payrollComponent.update({ where: { id: bonus.id }, data: { usage: "RECURRING" } });
    const { batch, be } = await seedBatchAndEmployee(club.id, pg.id, pp.id, empId);
    await expect(snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id, employeeId: empId,
      payPeriodId: pp.id, periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    })).rejects.toThrow(/usage is now RECURRING/i);
  });

  it("component side/cashEffect changed to invalid → snapshotter throws", async () => {
    const { club, pa, pg, pp, empId, bonus } = await seedFixture("Invalid side");
    await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: bonus.id,
      amount: "1500", reason: "Perf",
    });
    await prisma.payrollComponent.update({
      where: { id: bonus.id }, data: { side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT" },
    });
    const { batch, be } = await seedBatchAndEmployee(club.id, pg.id, pp.id, empId);
    await expect(snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id, employeeId: empId,
      payPeriodId: pp.id, periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    })).rejects.toThrow(/no longer a valid employee cash earning/i);
  });
});

describe("Slice B closeout — PayStatement line rendering (§F/G)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("F + G. scheduled bonus frozen into snapshot renders as its own OTHER_EARNINGS line on PayStatementV2", async () => {
    const { club, pa, pg, pp, empId, bonus } = await seedFixture("PayStatement Line");
    await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: bonus.id,
      amount: "1500", reason: "Perf bonus",
    });
    const { batch, be } = await seedBatchAndEmployee(club.id, pg.id, pp.id, empId);
    await snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id, employeeId: empId,
      payPeriodId: pp.id, periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    });
    // Build the real PayStatementV2 DTO via the real service.
    const stmt = await buildPayStatement(pa, club.id, be.id);
    const allLines = stmt.sections.flatMap((s) => s.lines);
    const bonusLine = allLines.find((l) => l.label === "Performance Bonus");
    expect(bonusLine, `expected a Performance Bonus line; got: ${allLines.map((l) => l.label).join(", ")}`).toBeDefined();
    expect(bonusLine!.current).toBe("1500.00");
    // Slice-B provenance stamps isOneTime on the frozen snapshot.
    expect(bonusLine!.isOneTime).toBe(true);
  });

  it("X. frozen snapshot's amount is unchanged after a live edit of the source scheduled earning is refused", async () => {
    // Editing an APPLIED row throws ConflictError (Slice B basic test).
    // This test additionally verifies that the frozen snapshot amount
    // survives a direct DB-level mutation attempt via a live PayrollComponent
    // rename (which SHOULD NOT touch the batch, per Phase 4 immutability).
    const { club, pa, pg, pp, empId, bonus } = await seedFixture("Frozen mutation");
    await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: bonus.id,
      amount: "1500", reason: "Perf",
    });
    const { batch, be } = await seedBatchAndEmployee(club.id, pg.id, pp.id, empId);
    await snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id, employeeId: empId,
      payPeriodId: pp.id, periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    });
    // Mutate the live component (rename + change expense account is a
    // future-proofing test — for now we just rename since expenseAccountId
    // is null in this fixture).
    await prisma.payrollComponent.update({
      where: { id: bonus.id }, data: { displayName: "RENAMED" },
    });
    const snap = await prisma.payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: batch.id, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    });
    // Snapshot display name still the original.
    expect(snap.displayName).toBe("Performance Bonus");
    expect(snap.resolvedAmount?.toString()).toBe("1500");
  });
});
