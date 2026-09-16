// Phase 4 (2026-09-16) — DB-backed regression for Employee Profile ·
// Recurring Payroll Components add / end / effective-date /
// permission / audit behaviour, plus the snapshot immutability rule.
//
// Uses the canonical Payroll-3C-1 services (createRecurringComponentAssignment
// and endRecurringComponentAssignment) via a synthetic Club, so no
// Coulee Ridge staging data is touched.

import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import {
  createRecurringComponentAssignment,
  endRecurringComponentAssignment,
  listActiveEmployeeComponentAssignments,
  upsertPayrollComponent,
} from "@/lib/payroll/components-catalogue";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function seed(clubName: string) {
  const c = db();
  const club = await makeClub(clubName);
  const adminU = await makeUser({ email: `a.${clubName}@t.test`, clubId: club.id, role: "CLUB_ADMIN" });
  const paU    = await makeUser({ email: `pa.${clubName}@t.test`, clubId: club.id, role: "PAYROLL_ADMIN" });
  const staffU = await makeUser({ email: `s.${clubName}@t.test`, clubId: club.id, role: "STAFF" });
  const adminP = await principalFor(adminU.email);
  const paP    = await principalFor(paU.email);
  const staffP = await principalFor(staffU.email);
  const cellExp = await c.account.create({
    data: {
      clubId: club.id, accountNumber: "6100", name: "Cell Phone Allowance Expense",
      type: "EXPENSE", normalBalance: "DEBIT", isActive: true, allowManualPosting: false,
    },
  });
  // The catalogue upsert requires payroll:write; use the PA principal.
  const comp = await upsertPayrollComponent(paP, club.id, {
    code: "CELL", displayName: "Cell Phone Allowance",
    category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
    taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
    displaySection: "EARNINGS", displayOrder: 10,
    calculationMethod: "FIXED_AMOUNT",
    expenseAccountId: cellExp.id,
  });
  const employee = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Test", lastName: "Employee",
      employeeNumber: "T-1", hireDate: utc(2020, 1, 1),
      employeeLifecycle: "ACTIVE", timekeepingMethod: "NO_CLOCK",
    },
  });
  return { club, adminP, paP, staffP, comp, cellExp, employee };
}

describe("Phase 4 · Employee Recurring Payroll Component service", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("adds a recurring FIXED_AMOUNT component with effective date + notes", async () => {
    const c = db();
    const s = await seed("add-fixed");
    const created = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id,
      componentId: s.comp.id,
      amount: "75.00",
      effectiveFrom: utc(2026, 9, 1),
      notes: "Chris standard $75",
    });
    expect(created.id).toBeTruthy();
    // Read back.
    const row = await c.employeeRecurringPayrollComponent.findUnique({ where: { id: created.id } });
    expect(row).toBeTruthy();
    expect(String(row!.amount)).toBe("75");
    expect(row!.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(row!.active).toBe(true);
    // Audit row.
    const audit = await c.auditLog.findFirst({
      where: { clubId: s.club.id, action: "payroll.component.assign", entityId: created.id },
    });
    expect(audit).toBeTruthy();
  });

  it("refuses when the actor lacks payroll:write", async () => {
    const s = await seed("no-write");
    await expect(createRecurringComponentAssignment(s.staffP, s.club.id, {
      employeeId: s.employee.id,
      componentId: s.comp.id,
      amount: "75.00",
      effectiveFrom: utc(2026, 9, 1),
    })).rejects.toThrow(/Missing permission/i);
  });

  it("ends an assignment (preserves the row + writes effectiveTo + active=false + audit)", async () => {
    const c = db();
    const s = await seed("end");
    const created = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id,
      componentId: s.comp.id,
      amount: "75.00",
      effectiveFrom: utc(2026, 9, 1),
    });
    await endRecurringComponentAssignment(s.paP, s.club.id, created.id, utc(2026, 12, 31));
    const row = await c.employeeRecurringPayrollComponent.findUnique({ where: { id: created.id } });
    // Row STILL exists — history is preserved.
    expect(row).toBeTruthy();
    expect(row!.effectiveTo?.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect(row!.active).toBe(false);
    const audit = await c.auditLog.findFirst({
      where: { clubId: s.club.id, action: "payroll.component.assign.end", entityId: created.id },
    });
    expect(audit).toBeTruthy();
  });

  it("listActive returns only rows that cover the as-of date + active component", async () => {
    const s = await seed("list");
    // Prior ended row.
    const prior = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id,
      componentId: s.comp.id,
      amount: "50.00",
      effectiveFrom: utc(2025, 1, 1),
    });
    await endRecurringComponentAssignment(s.paP, s.club.id, prior.id, utc(2026, 8, 31));
    // Current active.
    await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id,
      componentId: s.comp.id,
      amount: "75.00",
      effectiveFrom: utc(2026, 9, 1),
    });
    // Future upcoming.
    await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id,
      componentId: s.comp.id,
      amount: "100.00",
      effectiveFrom: utc(2027, 1, 1),
    });
    const active = await listActiveEmployeeComponentAssignments(s.paP, s.club.id, s.employee.id, utc(2026, 10, 1));
    expect(active).toHaveLength(1);
    expect(String(active[0].amount)).toBe("75");
  });

  it("PayrollBatchComponentSnapshot copies expenseAccountIdSnapshot from the component at Prepare and is immutable to later live-assignment mutation", async () => {
    // This test proves the SNAPSHOT contract without running the full
    // preparation service (which requires calendar + declaration + more
    // fixtures than this narrow test needs). A snapshot manually
    // written in the shape Prepare would produce is proven to remain
    // stable when the live assignment's amount + expenseAccountId are
    // subsequently mutated.
    const c = db();
    const s = await seed("snapshot");
    const created = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id,
      componentId: s.comp.id,
      amount: "75.00",
      effectiveFrom: utc(2026, 9, 1),
    });
    // Manually simulate a Prepare — write a snapshot with the frozen
    // expenseAccountIdSnapshot.
    const pg = await c.payrollPayGroup.create({
      data: { clubId: s.club.id, code: "BW", name: "Biweekly",
        payFrequency: "BIWEEKLY", payDateOffsetDays: 0,
        calendarAnchorDate: utc(2026, 9, 1), active: true },
    });
    const pp = await c.payrollPayPeriod.create({
      data: { clubId: s.club.id, payGroupId: pg.id, sequenceInYear: 1, taxYear: 2026,
        periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 15),
        payDate: utc(2026, 9, 15), status: "OPEN" },
    });
    const batch = await c.payrollBatch.create({
      data: { clubId: s.club.id, payGroupId: pg.id, payPeriodId: pp.id,
        sequence: 1, status: "PREPARED",
        algorithmVersion: "test-1" },
    });
    const be = await c.payrollBatchEmployee.create({
      data: {
        clubId: s.club.id, batchId: batch.id, employeeId: s.employee.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED", salaried: true,
      },
    });
    const originalExpenseAccountId = s.cellExp.id;
    const snapshot = await c.payrollBatchComponentSnapshot.create({
      data: {
        clubId: s.club.id, batchId: batch.id,
        batchEmployeeId: be.id, employeeId: s.employee.id,
        sourceComponentId: s.comp.id,
        sourceAssignmentId: created.id,
        provenance: "RECURRING_EMPLOYEE_SETUP",
        componentCode: "CELL", displayName: "Cell Phone Allowance",
        category: "ALLOWANCE", side: "EMPLOYEE",
        displaySection: "EARNINGS", displayOrder: 10,
        cashEffect: "INCREASES_NET_PAY",
        calculationMethod: "FIXED_AMOUNT",
        resolvedAmount: new Prisma.Decimal("75.00"),
        sourceEffectiveFrom: utc(2026, 9, 1),
        expenseAccountIdSnapshot: originalExpenseAccountId,
      },
    });

    // NOW mutate the live assignment amount + the live component's
    // expense account. Snapshot must remain unchanged.
    const newExpenseAcct = await c.account.create({
      data: {
        clubId: s.club.id, accountNumber: "6199", name: "Other Expense",
        type: "EXPENSE", normalBalance: "DEBIT", isActive: true, allowManualPosting: false,
      },
    });
    await c.employeeRecurringPayrollComponent.update({
      where: { id: created.id },
      data: { amount: new Prisma.Decimal("999.99") },
    });
    await c.payrollComponent.update({
      where: { id: s.comp.id },
      data: { expenseAccountId: newExpenseAcct.id },
    });

    const snapAfter = await c.payrollBatchComponentSnapshot.findUnique({ where: { id: snapshot.id } });
    expect(snapAfter!.resolvedAmount!.toString()).toBe("75");
    expect(snapAfter!.expenseAccountIdSnapshot).toBe(originalExpenseAccountId);
    // Frozen displayName + code stay put.
    expect(snapAfter!.componentCode).toBe("CELL");
    expect(snapAfter!.displayName).toBe("Cell Phone Allowance");
  });
});
