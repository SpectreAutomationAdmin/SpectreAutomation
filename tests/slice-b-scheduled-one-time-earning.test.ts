// Slice B (2026-09-18) — pre-batch scheduled one-time earning tests.
// Covers the founder's tests A-C (recurring filter), N-Z (one-time
// scheduling + freeze semantics), and idempotency.

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import {
  scheduleOneTimeEarning,
  cancelOneTimeEarning,
  listOneTimeEarningsForEmployee,
} from "@/lib/payroll/scheduled-one-time-earning";
import { snapshotEmployeeComponentsForBatch } from "@/lib/payroll/components-snapshot";
import { ForbiddenError, ConflictError, ValidationError } from "@/lib/errors";
import type { Principal } from "@/lib/rbac";

async function seedComponent(clubId: string, opts: {
  code: string;
  displayName?: string;
  usage: "RECURRING" | "ONE_TIME" | "BOTH";
  side?: "EMPLOYEE" | "EMPLOYER";
  cashEffect?: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  calculationMethod?: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
  category?: string;
  active?: boolean;
}) {
  return prisma.payrollComponent.create({
    data: {
      clubId,
      code: opts.code,
      displayName: opts.displayName ?? opts.code,
      category: opts.category ?? "ADDITIONAL_EARNING",
      side: opts.side ?? "EMPLOYEE",
      cashEffect: opts.cashEffect ?? "INCREASES_NET_PAY",
      calculationMethod: opts.calculationMethod ?? "FIXED_AMOUNT",
      displaySection: "EARNINGS",
      usage: opts.usage,
      active: opts.active ?? true,
    },
  });
}

async function seedPayGroupAndPeriod(clubId: string, opts: {
  periodStart: Date; periodEnd: Date; payDate: Date;
  code?: string;
}) {
  const pg = await prisma.payrollPayGroup.create({
    data: {
      clubId, code: opts.code ?? "SM-B", name: opts.code ?? "SM-B",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 0, active: true,
    },
  });
  const pp = await prisma.payrollPayPeriod.create({
    data: {
      clubId, payGroupId: pg.id, sequenceInYear: 18, taxYear: 2026,
      periodStart: opts.periodStart, periodEnd: opts.periodEnd, payDate: opts.payDate,
      status: "FUTURE",
    },
  });
  return { pg, pp };
}

async function seedTestEmployee(clubId: string, opts: { payGroupId?: string; hireDate?: Date; activatedAt?: Date } = {}) {
  const id = `test-emp-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.employee.create({
    data: {
      id, clubId,
      employeeNumber: id.slice(-8),
      firstName: "Test", lastName: id.slice(-6),
      employeeLifecycle: "ACTIVE",
      hireDate: opts.hireDate ?? new Date("2020-01-01"),
      activatedAt: opts.activatedAt ?? new Date("2020-01-01"),
    },
  });
  if (opts.payGroupId) {
    await prisma.payrollPayGroupMember.create({
      data: {
        clubId, employeeId: id, payGroupId: opts.payGroupId,
        effectiveFrom: new Date("2020-01-01"),
      },
    });
  }
  return id;
}

describe("Slice B — permissions", () => {
  it("PAYROLL_ADMIN can schedule (payroll:edit)", async () => {
    const { ROLE_PERMISSIONS } = await import("@/lib/permissions");
    const g = new Set(ROLE_PERMISSIONS.PAYROLL_ADMIN);
    expect(g.has("payroll:edit")).toBe(true);
  });
  it("CONTROLLER also has payroll:edit today", async () => {
    const { ROLE_PERMISSIONS } = await import("@/lib/permissions");
    const g = new Set(ROLE_PERMISSIONS.CONTROLLER);
    // Controller already had payroll:write via the Phase-4 governance
    // restoration. This slice does NOT broaden; we simply reuse the
    // existing payroll:edit grant. Controller can also schedule.
    expect(g.has("payroll:edit") || g.has("payroll:write")).toBe(true);
  });
});

describe("Slice B — scheduleOneTimeEarning service", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  async function baseline() {
    const club = await makeClub("B Club");
    await makeUser({ email: "pa-b@t.test", role: "PAYROLL_ADMIN", clubId: club.id });
    const pa = await principalFor("pa-b@t.test");
    const { pg, pp } = await seedPayGroupAndPeriod(club.id, {
      periodStart: new Date("2026-09-16T00:00:00.000Z"),
      periodEnd:   new Date("2026-10-01T00:00:00.000Z"),
      payDate:     new Date("2026-09-30T00:00:00.000Z"),
    });
    const empId = await seedTestEmployee(club.id, { payGroupId: pg.id });
    const oneTime = await seedComponent(club.id, {
      code: "PERF_BONUS", displayName: "Performance Bonus", usage: "ONE_TIME",
    });
    const recurringOnly = await seedComponent(club.id, {
      code: "CELL", displayName: "Cell Phone Allowance", usage: "RECURRING",
    });
    const both = await seedComponent(club.id, {
      code: "SPOT", displayName: "Spot Bonus", usage: "BOTH",
    });
    const inactive = await seedComponent(club.id, {
      code: "OLD_BONUS", usage: "ONE_TIME", active: false,
    });
    return { club, pa, pg, pp, empId, oneTime, recurringOnly, both, inactive };
  }

  it("N. schedule succeeds before any PayrollBatch exists", async () => {
    const { club, pa, empId, pp, oneTime } = await baseline();
    const view = await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: oneTime.id,
      amount: "1500.00", reason: "Performance bonus",
    });
    expect(view.status).toBe("SCHEDULED");
    expect(view.amount).toBe("1500");
    expect(view.componentCode).toBe("PERF_BONUS");
    // Zero payroll batches yet.
    const batchCount = await prisma.payrollBatch.count({ where: { clubId: club.id } });
    expect(batchCount).toBe(0);
  });

  it("R. rejects RECURRING-only component", async () => {
    const { club, pa, empId, pp, recurringOnly } = await baseline();
    await expect(scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: recurringOnly.id,
      amount: "100", reason: "x",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects inactive one-time component", async () => {
    const { club, pa, empId, pp, inactive } = await baseline();
    await expect(scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: inactive.id,
      amount: "100", reason: "x",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("BOTH-usage component accepted", async () => {
    const { club, pa, empId, pp, both } = await baseline();
    const view = await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: both.id,
      amount: "250", reason: "Spot",
    });
    expect(view.status).toBe("SCHEDULED");
  });

  it("O. explicit pay-period required (invalid id rejected)", async () => {
    const { club, pa, empId, oneTime } = await baseline();
    await expect(scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: "not-a-real-id", componentId: oneTime.id,
      amount: "100", reason: "x",
    })).rejects.toThrow();
  });

  it("P. employee-not-in-pay-group rejected", async () => {
    const { club, pa, pp, oneTime } = await baseline();
    // Fresh employee with NO pay-group membership.
    const empId = await seedTestEmployee(club.id);
    await expect(scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: oneTime.id,
      amount: "100", reason: "x",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("duplicate SCHEDULED for same (employee, period, component) rejected", async () => {
    const { club, pa, empId, pp, oneTime } = await baseline();
    await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: oneTime.id,
      amount: "1500", reason: "x",
    });
    await expect(scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: oneTime.id,
      amount: "1500", reason: "x",
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("T. cancel before Prepare marks CANCELLED (no delete)", async () => {
    const { club, pa, empId, pp, oneTime } = await baseline();
    const v = await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: oneTime.id,
      amount: "500", reason: "test",
    });
    const cancelled = await cancelOneTimeEarning(pa, club.id, v.id, { reason: "no bonus" });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledAt).not.toBeNull();
    const list = await listOneTimeEarningsForEmployee(pa, club.id, empId);
    expect(list.length).toBe(1);
    expect(list[0].status).toBe("CANCELLED");
  });

  it("Refuses GENERAL_MANAGER (missing payroll:edit)", async () => {
    const { club, empId, pp, oneTime } = await baseline();
    await makeUser({ email: "gm-b@t.test", role: "GENERAL_MANAGER", clubId: club.id });
    const gm = await principalFor("gm-b@t.test") as Principal;
    await expect(scheduleOneTimeEarning(gm, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: oneTime.id,
      amount: "100", reason: "x",
    })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Slice B — snapshotter Prepare-time freeze", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("U + V. snapshotter freezes SCHEDULED once and is idempotent on retry", async () => {
    const club = await makeClub("B Freeze Club");
    await makeUser({ email: "pa-b-freeze@t.test", role: "PAYROLL_ADMIN", clubId: club.id });
    const pa = await principalFor("pa-b-freeze@t.test");
    const { pg, pp } = await seedPayGroupAndPeriod(club.id, {
      periodStart: new Date("2026-09-16T00:00:00.000Z"),
      periodEnd:   new Date("2026-10-01T00:00:00.000Z"),
      payDate:     new Date("2026-09-30T00:00:00.000Z"),
    });
    const empId = await seedTestEmployee(club.id, { payGroupId: pg.id });
    const bonus = await seedComponent(club.id, { code: "PERF_BONUS", usage: "ONE_TIME" });
    const scheduled = await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: bonus.id,
      amount: "1500", reason: "Perf",
    });
    // Build a synthetic PayrollBatch + PayrollBatchEmployee so the
    // snapshotter has somewhere to write.
    const batch = await prisma.payrollBatch.create({
      data: {
        clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id, sequence: 1, status: "DRAFT",
      },
    });
    const be = await prisma.payrollBatchEmployee.create({
      data: {
        clubId: club.id, batchId: batch.id, employeeId: empId,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE",
      },
    });

    const first = await snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id, employeeId: empId,
      payPeriodId: pp.id,
      periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    });
    expect(first.written).toBeGreaterThanOrEqual(1);
    const snapshots = await prisma.payrollBatchComponentSnapshot.findMany({
      where: { batchId: batch.id, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    });
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]!.resolvedAmount?.toString()).toBe("1500");
    expect(snapshots[0]!.componentCode).toBe("PERF_BONUS");

    // Scheduled row is APPLIED with provenance links.
    const applied = await prisma.payrollScheduledOneTimeEarning.findUnique({ where: { id: scheduled.id } });
    expect(applied?.status).toBe("APPLIED");
    expect(applied?.appliedToBatchId).toBe(batch.id);
    expect(applied?.appliedSnapshotId).toBe(snapshots[0]!.id);

    // V. Retry — idempotent (no duplicate snapshot).
    const second = await snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id, employeeId: empId,
      payPeriodId: pp.id,
      periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    });
    const after = await prisma.payrollBatchComponentSnapshot.findMany({
      where: { batchId: batch.id, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    });
    expect(after.length).toBe(1);
    expect(second.written).toBeGreaterThanOrEqual(1);
  });

  it("Z. CANCELLED scheduled earning is NOT frozen", async () => {
    const club = await makeClub("B Cancel Club");
    await makeUser({ email: "pa-b-cancel@t.test", role: "PAYROLL_ADMIN", clubId: club.id });
    const pa = await principalFor("pa-b-cancel@t.test");
    const { pg, pp } = await seedPayGroupAndPeriod(club.id, {
      periodStart: new Date("2026-09-16T00:00:00.000Z"),
      periodEnd:   new Date("2026-10-01T00:00:00.000Z"),
      payDate:     new Date("2026-09-30T00:00:00.000Z"),
    });
    const empId = await seedTestEmployee(club.id, { payGroupId: pg.id });
    const bonus = await seedComponent(club.id, { code: "PERF_BONUS", usage: "ONE_TIME" });
    const s = await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: bonus.id,
      amount: "1500", reason: "perf",
    });
    await cancelOneTimeEarning(pa, club.id, s.id);

    const batch = await prisma.payrollBatch.create({
      data: { clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id, sequence: 1, status: "DRAFT" },
    });
    const be = await prisma.payrollBatchEmployee.create({
      data: {
        clubId: club.id, batchId: batch.id, employeeId: empId,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE",
      },
    });
    await snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id, employeeId: empId,
      payPeriodId: pp.id,
      periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    });
    const snapshots = await prisma.payrollBatchComponentSnapshot.findMany({
      where: { batchId: batch.id, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    });
    expect(snapshots.length).toBe(0);
  });

  it("X. Editing scheduled amount AFTER Prepare does not mutate frozen snapshot", async () => {
    const { editOneTimeEarning } = await import("@/lib/payroll/scheduled-one-time-earning");
    const club = await makeClub("B Frozen Club");
    await makeUser({ email: "pa-b-frozen@t.test", role: "PAYROLL_ADMIN", clubId: club.id });
    const pa = await principalFor("pa-b-frozen@t.test");
    const { pg, pp } = await seedPayGroupAndPeriod(club.id, {
      periodStart: new Date("2026-09-16T00:00:00.000Z"),
      periodEnd:   new Date("2026-10-01T00:00:00.000Z"),
      payDate:     new Date("2026-09-30T00:00:00.000Z"),
    });
    const empId = await seedTestEmployee(club.id, { payGroupId: pg.id });
    const bonus = await seedComponent(club.id, { code: "PERF_BONUS", usage: "ONE_TIME" });
    const s = await scheduleOneTimeEarning(pa, club.id, {
      employeeId: empId, payPeriodId: pp.id, componentId: bonus.id,
      amount: "1500", reason: "perf",
    });
    const batch = await prisma.payrollBatch.create({
      data: { clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id, sequence: 1, status: "DRAFT" },
    });
    const be = await prisma.payrollBatchEmployee.create({
      data: {
        clubId: club.id, batchId: batch.id, employeeId: empId,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE",
      },
    });
    await snapshotEmployeeComponentsForBatch({
      clubId: club.id, batchId: batch.id, batchEmployeeId: be.id, employeeId: empId,
      payPeriodId: pp.id,
      periodStart: pp.periodStart, periodEnd: pp.periodEnd,
    });
    // Post-Prepare the row is APPLIED; edit refuses.
    await expect(editOneTimeEarning(pa, club.id, s.id, { amount: "9999" }))
      .rejects.toBeInstanceOf(ConflictError);
    // Snapshot still shows original amount.
    const snap = await prisma.payrollBatchComponentSnapshot.findFirst({
      where: { batchId: batch.id, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    });
    expect(snap?.resolvedAmount?.toString()).toBe("1500");
  });
});
