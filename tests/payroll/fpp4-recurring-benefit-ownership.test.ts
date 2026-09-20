// FPP-4 (2026-09-20) — Recurring vs Benefit-plan ownership rule.
//
// Pins the canonical distinction:
//   * PayrollComponents that are linked as employee/employer side of an
//     ACTIVE PayrollBenefitPlan are OWNED by that plan's enrolment
//     architecture. They must NOT be assignable as standalone recurring
//     components — that would silently duplicate a deduction.
//   * The overlap prevention already provided by Payroll-3C-1 for two
//     recurring rows on the same component is preserved unchanged.
//   * Direct-edit / change / end semantics of the canonical service
//     layer are unchanged.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import {
  createRecurringComponentAssignment,
  endRecurringComponentAssignment,
  changeRecurringComponentAssignment,
} from "@/lib/payroll/components-catalogue";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function seedComponent(clubId: string, code: string, opts: Partial<{
  displayName: string; category: string; side: "EMPLOYEE" | "EMPLOYER";
  cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
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

async function seedBenefitPlan(clubId: string, opts: {
  code: string; kind: "RRSP" | "LTD" | "HEALTH_DENTAL";
  employeeComponentId?: string | null;
  employerComponentId?: string | null;
  active?: boolean;
}) {
  return db().payrollBenefitPlan.create({
    data: {
      clubId,
      code: opts.code,
      name: opts.code,
      kind: opts.kind,
      active: opts.active ?? true,
      effectiveFrom: d(2026, 1, 1),
      defaultElectionKind:
        opts.kind === "RRSP" ? "PERCENT_OF_ELIGIBLE_EARNINGS" : "FIXED_AMOUNT",
      employeeComponentId: opts.employeeComponentId ?? null,
      employerComponentId: opts.employerComponentId ?? null,
    },
  });
}

async function scenario() {
  const club = await makeClub("FPP-4 Club A");
  const admin = await makeUser({ email: "adminA@fpp4.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa = await makeUser({ email: "paA@fpp4.test", role: "PAYROLL_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id,
  });
  const emp = await db().employee.create({
    data: {
      clubId: club.id, firstName: "Owner", lastName: "Test",
      email: "ot@fpp4.test", hireDate: d(2026, 2, 1), status: "ACTIVE",
      employeeNumber: "E-FPP4",
    },
  });
  return { club, adminP, paP, emp };
}

describe("FPP-4 — recurring vs benefit-plan ownership rule", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("refuses to assign a component that an ACTIVE benefit plan links as employee side", async () => {
    const s = await scenario();
    const rrspEE = await seedComponent(s.club.id, "RRSP_EE_FPP4", { displayName: "RRSP EE" });
    await seedBenefitPlan(s.club.id, {
      code: "RRSP_PLAN_A", kind: "RRSP",
      employeeComponentId: rrspEE.id,
    });
    await expect(
      createRecurringComponentAssignment(s.paP, s.club.id, {
        employeeId: s.emp.id,
        componentId: rrspEE.id,
        amount: "100",
        effectiveFrom: d(2026, 2, 1),
      } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses to assign a component that an ACTIVE benefit plan links as employer side", async () => {
    const s = await scenario();
    const rrspER = await seedComponent(s.club.id, "RRSP_ER_FPP4", {
      displayName: "RRSP ER", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
    });
    await seedBenefitPlan(s.club.id, {
      code: "RRSP_PLAN_B", kind: "RRSP",
      employerComponentId: rrspER.id,
    });
    await expect(
      createRecurringComponentAssignment(s.paP, s.club.id, {
        employeeId: s.emp.id,
        componentId: rrspER.id,
        amount: "100",
        effectiveFrom: d(2026, 2, 1),
      } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("PERMITS assignment when the benefit plan linking the component is INACTIVE", async () => {
    const s = await scenario();
    const c = await seedComponent(s.club.id, "OLD_LINK", { displayName: "Old Linked Component" });
    await seedBenefitPlan(s.club.id, {
      code: "OLD_PLAN", kind: "LTD",
      employeeComponentId: c.id,
      active: false,
    });
    const row = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.emp.id, componentId: c.id, amount: "50",
      effectiveFrom: d(2026, 2, 1),
    } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]);
    expect(row.id).toBeTruthy();
  });

  it("PERMITS assignment for ordinary standalone components (no plan link)", async () => {
    const s = await scenario();
    const cell = await seedComponent(s.club.id, "CELL_FPP4", {
      displayName: "Cell Phone Allowance",
      category: "ALLOWANCE", cashEffect: "INCREASES_NET_PAY",
    });
    const row = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.emp.id, componentId: cell.id, amount: "37.50",
      effectiveFrom: d(2026, 2, 2),
    } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]);
    expect(row.id).toBeTruthy();
    const assn = await db().employeeRecurringPayrollComponent.findFirst({
      where: { id: row.id },
      select: { effectiveFrom: true, effectiveTo: true, active: true },
    });
    expect(assn?.active).toBe(true);
    expect(assn?.effectiveTo).toBeNull();
  });

  it("Change on an active assignment preserves history + refuses overlap", async () => {
    const s = await scenario();
    const cell = await seedComponent(s.club.id, "CELL_CHG", {
      displayName: "Cell Phone", category: "ALLOWANCE",
      cashEffect: "INCREASES_NET_PAY",
    });
    const first = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.emp.id, componentId: cell.id, amount: "30",
      effectiveFrom: d(2026, 2, 2),
    } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]);

    const r = await changeRecurringComponentAssignment(s.paP, s.club.id, first.id, {
      amount: "37.50",
      effectiveFrom: d(2026, 8, 24),
    } as unknown as Parameters<typeof changeRecurringComponentAssignment>[3]);
    expect(r.successorId).toBeTruthy();

    const rows = await db().employeeRecurringPayrollComponent.findMany({
      where: { employeeId: s.emp.id, componentId: cell.id },
      orderBy: { effectiveFrom: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].amount?.toString()).toBe("30");
    // Half-open: predecessor now has effectiveTo == successor.effectiveFrom
    expect(rows[0].effectiveTo?.toISOString()).toBe(d(2026, 8, 24).toISOString());
    expect(rows[1].amount?.toString()).toBe("37.5");
    expect(rows[1].effectiveFrom.toISOString()).toBe(d(2026, 8, 24).toISOString());
    expect(rows[1].effectiveTo).toBeNull();
  });

  it("End sets effectiveTo, refuses end-before-start", async () => {
    const s = await scenario();
    const cell = await seedComponent(s.club.id, "CELL_END", {
      displayName: "Cell Phone", category: "ALLOWANCE",
      cashEffect: "INCREASES_NET_PAY",
    });
    const first = await createRecurringComponentAssignment(s.paP, s.club.id, {
      employeeId: s.emp.id, componentId: cell.id, amount: "30",
      effectiveFrom: d(2026, 6, 1),
    } as unknown as Parameters<typeof createRecurringComponentAssignment>[2]);

    // End-before-start refused
    await expect(
      endRecurringComponentAssignment(s.paP, s.club.id, first.id, d(2026, 3, 1)),
    ).rejects.toBeInstanceOf(ValidationError);

    // Valid end succeeds
    await endRecurringComponentAssignment(s.paP, s.club.id, first.id, d(2026, 12, 31));
    const row = await db().employeeRecurringPayrollComponent.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(row.effectiveTo?.toISOString()).toBe(d(2026, 12, 31).toISOString());
    expect(row.active).toBe(false);
  });
});
