// Phase 4 follow-up (2026-09-16) — DB-backed regression proving
// overlap-prevention on Add, atomic Change (predecessor closed +
// successor created transactionally), and Prepare-time deterministic
// resolution (`resolveApplicableRecurringAssignments` throws
// ConflictError when >1 assignment applies).

import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import {
  createRecurringComponentAssignment,
  endRecurringComponentAssignment,
  changeRecurringComponentAssignment,
  resolveApplicableRecurringAssignments,
  upsertPayrollComponent,
} from "@/lib/payroll/components-catalogue";
import { ConflictError, ValidationError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function seed(name: string) {
  const c = db();
  const club = await makeClub(name);
  const paU = await makeUser({ email: `pa.${name}@t.test`, clubId: club.id, role: "PAYROLL_ADMIN" });
  const paP = await principalFor(paU.email);
  const cellExp = await c.account.create({
    data: {
      clubId: club.id, accountNumber: "6100", name: "Cell Phone Allowance Expense",
      type: "EXPENSE", normalBalance: "DEBIT", isActive: true, allowManualPosting: false,
    },
  });
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
  return { club, paP, comp, employee };
}

describe("Phase 4 follow-up · overlap-prevention on Add", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("rejects two open-ended assignments for the same (employee, component)", async () => {
    const s = await seed("ovA");
    await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "75.00", effectiveFrom: utc(2026, 9, 1),
    });
    await expect(createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "100.00", effectiveFrom: utc(2026, 9, 15),
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a same-start-date duplicate", async () => {
    const s = await seed("ovB");
    await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "75.00", effectiveFrom: utc(2026, 9, 1),
    });
    await expect(createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "80.00", effectiveFrom: utc(2026, 9, 1),
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a future assignment that overlaps an existing open-ended one", async () => {
    const s = await seed("ovC");
    await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "75.00", effectiveFrom: utc(2026, 9, 1),
    });
    await expect(createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "100.00", effectiveFrom: utc(2027, 1, 1),
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts a strictly-later assignment after the predecessor is ended (half-open [from, to) semantics)", async () => {
    const s = await seed("ovD");
    const first = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "75.00", effectiveFrom: utc(2026, 9, 1),
    });
    // Half-open: the successor's effectiveFrom = predecessor.effectiveTo
    // is legal because effectiveTo is exclusive.
    await endRecurringComponentAssignment(s.paP, s.club.id, first.id, utc(2027, 1, 1));
    const second = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "100.00", effectiveFrom: utc(2027, 1, 1),
    });
    expect(second.id).toBeTruthy();
  });
});

describe("Phase 4 follow-up · atomic Change", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("closes predecessor at successor's effectiveFrom + creates successor + audits both", async () => {
    const c = db();
    const s = await seed("chgA");
    const first = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "75.00", effectiveFrom: utc(2026, 9, 1),
    });
    const r = await changeRecurringComponentAssignment(s.paP, s.club.id, first.id, {
      amount: "100.00", effectiveFrom: utc(2027, 1, 1),
    });
    const pred = await c.employeeRecurringPayrollComponent.findUnique({ where: { id: r.predecessorId } });
    const succ = await c.employeeRecurringPayrollComponent.findUnique({ where: { id: r.successorId } });
    expect(pred!.effectiveTo?.toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(pred!.active).toBe(false);
    expect(succ!.effectiveFrom.toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(String(succ!.amount)).toBe("100");
    expect(succ!.active).toBe(true);
    // Audit row.
    const audit = await c.auditLog.findFirst({
      where: { clubId: s.club.id, action: "payroll.component.assign.change", entityId: r.successorId },
    });
    expect(audit).toBeTruthy();
    expect(audit?.beforeJson ?? audit?.afterJson).toBeTruthy();
  });

  it("refuses when effectiveFrom is not strictly after predecessor.effectiveFrom", async () => {
    const s = await seed("chgB");
    const first = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "75.00", effectiveFrom: utc(2026, 9, 1),
    });
    await expect(changeRecurringComponentAssignment(s.paP, s.club.id, first.id, {
      amount: "80.00", effectiveFrom: utc(2026, 9, 1),
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("historical POSTED snapshots remain unchanged after a Change scheduled AFTER their pay date", async () => {
    const c = db();
    const s = await seed("chgC");
    const first = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "75.00", effectiveFrom: utc(2026, 9, 1),
    });
    // Manually stamp a "posted" snapshot for a batch prior to the change.
    const pg = await c.payrollPayGroup.create({
      data: { clubId: s.club.id, code: "BW", name: "BW",
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
        sequence: 1, status: "POSTED", algorithmVersion: "test-1" },
    });
    const be = await c.payrollBatchEmployee.create({
      data: {
        clubId: s.club.id, batchId: batch.id, employeeId: s.employee.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED", salaried: true,
      },
    });
    const snap = await c.payrollBatchComponentSnapshot.create({
      data: {
        clubId: s.club.id, batchId: batch.id,
        batchEmployeeId: be.id, employeeId: s.employee.id,
        sourceComponentId: s.comp.id, sourceAssignmentId: first.id,
        provenance: "RECURRING_EMPLOYEE_SETUP",
        componentCode: "CELL", displayName: "Cell Phone Allowance",
        category: "ALLOWANCE", side: "EMPLOYEE",
        displaySection: "EARNINGS", displayOrder: 10,
        cashEffect: "INCREASES_NET_PAY",
        calculationMethod: "FIXED_AMOUNT",
        resolvedAmount: new Prisma.Decimal("75.00"),
        sourceEffectiveFrom: utc(2026, 9, 1),
      },
    });
    // Now Change AFTER the batch's pay date.
    await changeRecurringComponentAssignment(s.paP, s.club.id, first.id, {
      amount: "100.00", effectiveFrom: utc(2027, 1, 1),
    });
    const snapAfter = await c.payrollBatchComponentSnapshot.findUnique({ where: { id: snap.id } });
    expect(snapAfter!.resolvedAmount!.toString()).toBe("75");
    expect(snapAfter!.componentCode).toBe("CELL");
  });
});

describe("Phase 4 follow-up · Prepare-time deterministic resolution", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("resolves exactly one applicable assignment for a healthy (employee, component) as of a given date", async () => {
    const s = await seed("resA");
    await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "75.00", effectiveFrom: utc(2026, 9, 1),
    });
    const map = await resolveApplicableRecurringAssignments(s.club.id, s.employee.id, utc(2026, 10, 15));
    expect(map.size).toBe(1);
    const one = map.get(s.comp.id);
    expect(one).toBeTruthy();
    expect(String(one!.amount!)).toBe("75");
  });

  it("resolves nothing when no assignment covers the date", async () => {
    const s = await seed("resB");
    await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.employee.id, componentId: s.comp.id,
      amount: "75.00", effectiveFrom: utc(2027, 1, 1),
    });
    const map = await resolveApplicableRecurringAssignments(s.club.id, s.employee.id, utc(2026, 10, 15));
    expect(map.size).toBe(0);
  });

  it("throws ConflictError when >1 applicable assignments exist (legacy corrupt overlap)", async () => {
    // Simulate a data-corruption state that bypasses the write-path
    // overlap check by writing directly to the DB. Prepare must then
    // fail-closed rather than silently picking one.
    const c = db();
    const s = await seed("resC");
    await c.employeeRecurringPayrollComponent.createMany({
      data: [
        {
          clubId: s.club.id, employeeId: s.employee.id, componentId: s.comp.id,
          amount: new Prisma.Decimal("75.00"), effectiveFrom: utc(2026, 9, 1),
          effectiveTo: null, active: true,
        },
        {
          clubId: s.club.id, employeeId: s.employee.id, componentId: s.comp.id,
          amount: new Prisma.Decimal("100.00"), effectiveFrom: utc(2026, 9, 15),
          effectiveTo: null, active: true,
        },
      ],
    });
    await expect(
      resolveApplicableRecurringAssignments(s.club.id, s.employee.id, utc(2026, 10, 15)),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
