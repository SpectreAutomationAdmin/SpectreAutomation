// FPP-4A (2026-09-20) — correctUnusedRecurringComponentAssignment.
//
// Narrow correction path for a recurring assignment that has NEVER been
// consumed by a PayrollBatchComponentSnapshot. Allows in-place edits
// of amount/percentBps/effectiveFrom/notes. Server-side enforced —
// UI hiding is a UX aid, not a security control.
//
// Once a snapshot exists for the assignment, correction refuses closed
// and the canonical Change path must be used instead.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import {
  createRecurringComponentAssignment,
  correctUnusedRecurringComponentAssignment,
  changeRecurringComponentAssignment,
} from "@/lib/payroll/components-catalogue";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function seedComponent(clubId: string, code: string, opts: Partial<{
  displayName: string; side: "EMPLOYEE" | "EMPLOYER";
  cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  category: string;
  calculationMethod: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
  active: boolean;
}> = {}) {
  return db().payrollComponent.create({
    data: {
      clubId, code,
      displayName: opts.displayName ?? code,
      category: opts.category ?? "EMPLOYEE_DEDUCTION",
      side: opts.side ?? "EMPLOYEE",
      cashEffect: opts.cashEffect ?? "DECREASES_NET_PAY",
      calculationMethod: opts.calculationMethod ?? "FIXED_AMOUNT",
      displaySection: "DEDUCTIONS",
      usage: "BOTH",
      active: opts.active ?? true,
    },
  });
}

async function scenario() {
  const club = await makeClub("FPP-4A Club");
  const admin = await makeUser({ email: "adminA@fpp4a.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa = await makeUser({ email: "paA@fpp4a.test", role: "PAYROLL_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id,
  });
  const emp = await db().employee.create({
    data: {
      clubId: club.id, firstName: "Correct", lastName: "Me",
      email: "c@fpp4a.test", hireDate: d(2026, 2, 1), status: "ACTIVE",
      employeeNumber: "E-FPP4A",
    },
  });
  return { club, adminP, paP, emp };
}

/**
 * Attach a snapshot to a recurring assignment so the "consumed" guard
 * fires. Uses the minimal required set of BatchComponentSnapshot fields
 * for the schema — a synthetic batch + batchEmployee pair.
 */
async function consumeAssignment(clubId: string, employeeId: string, assignmentId: string, componentId: string) {
  // Minimal batch + batchEmployee scaffolding just to give the snapshot
  // a legitimate parent, no calculation required.
  const pg = await db().payrollPayGroup.create({
    data: {
      clubId, code: "SYN-4A", name: "Syn 4A", payFrequency: "SEMI_MONTHLY",
      periodBoundaryStrategy: "LAGGED_SEMI_MONTHLY", active: true,
    },
  });
  const period = await db().payrollPayPeriod.create({
    data: {
      clubId, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 1,
      periodStart: d(2026, 1, 1), periodEnd: d(2026, 1, 15), payDate: d(2026, 1, 15),
    },
  });
  const batch = await db().payrollBatch.create({
    data: {
      clubId, payPeriodId: period.id, payGroupId: pg.id, status: "DRAFT",
    },
  });
  const bemp = await db().payrollBatchEmployee.create({
    data: {
      batchId: batch.id, employeeId, clubId,
      jurisdictionCountry: "CA", employeeLifecycleAtPrep: "ACTIVE",
    },
  });
  await db().payrollBatchComponentSnapshot.create({
    data: {
      clubId, batchId: batch.id, batchEmployeeId: bemp.id, employeeId,
      sourceComponentId: componentId, sourceAssignmentId: assignmentId,
      componentCode: "SYN", displayName: "Synthetic",
      category: "EMPLOYEE_DEDUCTION",
      side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY",
      displaySection: "DEDUCTIONS",
      calculationMethod: "FIXED_AMOUNT",
      resolvedAmount: "1.00",
      sourceEffectiveFrom: d(2026, 1, 1),
      provenance: "RECURRING_EMPLOYEE_SETUP",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    },
  });
}

describe("FPP-4A — correct an unused recurring assignment in place", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("moves effectiveFrom BACKWARD on an unused assignment (LTD Sep20 → Aug24)", async () => {
    const s = await scenario();
    const ltd = await seedComponent(s.club.id, "LTD", { displayName: "LTD" });
    const created = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.emp.id, componentId: ltd.id, amount: "28.11",
      effectiveFrom: d(2026, 9, 20),
    } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]);

    const r = await correctUnusedRecurringComponentAssignment(s.paP, s.club.id, created.id, {
      effectiveFrom: d(2026, 8, 24),
    });
    expect(r.id).toBe(created.id);

    const row = await db().employeeRecurringPayrollComponent.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.effectiveFrom.toISOString()).toBe(d(2026, 8, 24).toISOString());
    expect(row.effectiveTo).toBeNull();
    expect(row.amount?.toString()).toBe("28.11");
    expect(row.active).toBe(true);
  });

  it("also permits amount + notes changes in one call", async () => {
    const s = await scenario();
    const cell = await seedComponent(s.club.id, "CELL_A", { displayName: "Cell", category: "ALLOWANCE", cashEffect: "INCREASES_NET_PAY" });
    const created = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.emp.id, componentId: cell.id, amount: "30",
      effectiveFrom: d(2026, 2, 2),
    } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]);

    await correctUnusedRecurringComponentAssignment(s.paP, s.club.id, created.id, {
      amount: "37.50",
      notes: "Corrected from prior draft",
    });
    const row = await db().employeeRecurringPayrollComponent.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.amount?.toString()).toBe("37.5");
    expect(row.notes).toBe("Corrected from prior draft");
  });

  it("refuses correction once the assignment has a batch snapshot (consumed)", async () => {
    const s = await scenario();
    const cell = await seedComponent(s.club.id, "CELL_B", { displayName: "Cell B", category: "ALLOWANCE", cashEffect: "INCREASES_NET_PAY" });
    const created = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.emp.id, componentId: cell.id, amount: "30",
      effectiveFrom: d(2026, 2, 2),
    } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]);

    await consumeAssignment(s.club.id, s.emp.id, created.id, cell.id);

    await expect(
      correctUnusedRecurringComponentAssignment(s.paP, s.club.id, created.id, {
        effectiveFrom: d(2026, 8, 24),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses correction on an assignment that has been ended (effectiveTo != null)", async () => {
    const s = await scenario();
    const cell = await seedComponent(s.club.id, "CELL_C", { displayName: "Cell C", category: "ALLOWANCE", cashEffect: "INCREASES_NET_PAY" });
    const created = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.emp.id, componentId: cell.id, amount: "30",
      effectiveFrom: d(2026, 2, 2),
    } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]);

    await db().employeeRecurringPayrollComponent.update({
      where: { id: created.id },
      data: { effectiveTo: d(2026, 6, 1), active: false },
    });

    await expect(
      correctUnusedRecurringComponentAssignment(s.paP, s.club.id, created.id, {
        effectiveFrom: d(2026, 8, 24),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses correction when the new interval would overlap another active assignment", async () => {
    const s = await scenario();
    const cell = await seedComponent(s.club.id, "CELL_D", { displayName: "Cell D", category: "ALLOWANCE", cashEffect: "INCREASES_NET_PAY" });
    const older = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.emp.id, componentId: cell.id, amount: "30",
      effectiveFrom: d(2026, 2, 2),
    } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]);
    // End the first one at Jun 1 so it doesn't overlap with the future one at Sep 20.
    await db().employeeRecurringPayrollComponent.update({
      where: { id: older.id }, data: { effectiveTo: d(2026, 6, 1), active: false },
    });
    const future = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.emp.id, componentId: cell.id, amount: "37.50",
      effectiveFrom: d(2026, 9, 20),
    } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]);

    // Try to correct future BACK to Jan 1 — would overlap the ended Feb-Jun row.
    await expect(
      correctUnusedRecurringComponentAssignment(s.paP, s.club.id, future.id, {
        effectiveFrom: d(2026, 1, 1),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("Change flow remains available for consumed assignments (canonical path unchanged)", async () => {
    const s = await scenario();
    const cell = await seedComponent(s.club.id, "CELL_E", { displayName: "Cell E", category: "ALLOWANCE", cashEffect: "INCREASES_NET_PAY" });
    const created = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.emp.id, componentId: cell.id, amount: "30",
      effectiveFrom: d(2026, 2, 2),
    } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]);
    await consumeAssignment(s.club.id, s.emp.id, created.id, cell.id);

    const r = await changeRecurringComponentAssignment(s.paP, s.club.id, created.id, {
      amount: "37.50",
      effectiveFrom: d(2026, 10, 1),
    } as unknown as Parameters<typeof changeRecurringComponentAssignment>[3]);
    expect(r.successorId).toBeTruthy();
  });
});
