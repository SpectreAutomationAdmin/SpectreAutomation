// Payroll-3C-1 (2026-09-07) — Payroll Component catalogue + recurring
// employee-assignment tests.
//
// This slice does NOT touch the calculator, review DTO, or GL adapter.
// The tests here therefore prove:
//   • Catalogue writes are validated + tenant-scoped.
//   • Category / side / cash / statutory-base flags are stored as
//     independent invariants (§3, §4 of the 3C brief).
//   • Recurring assignments are effective-dated + tenant-scoped.
//   • Existing salaried Payroll workflow is not disturbed (regression
//     covered by tests/payroll/salary-periodization.test.ts +
//     tests/payroll/calculation-execute.test.ts).

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  upsertPayrollComponent,
  listPayrollComponents,
  createRecurringComponentAssignment,
  endRecurringComponentAssignment,
  listActiveEmployeeComponentAssignments,
} from "@/lib/payroll/components-catalogue";
import { NotFoundError, ValidationError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function seedClubWithAdmin(name: string) {
  const club = await makeClub(name);
  const admin = await makeUser({ email: `admin.${club.id}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  return { club, admin, adminP };
}

async function seedEmployee(clubId: string, tag: string) {
  return db().employee.create({
    data: {
      clubId, firstName: `${tag}First`, lastName: `${tag}Last`,
      email: `${tag}.${clubId}@t.test`, hireDate: utc(2020, 1, 1),
      status: "ACTIVE", employeeNumber: `E-${tag}`,
      employeeLifecycle: "ACTIVE", compensationType: "SALARY", homeProvince: "AB",
    },
  });
}

// -------------------------------------------------------------------
// Catalogue: category × side × cash × statutory-base combinations
// -------------------------------------------------------------------
describe("PayrollComponent catalogue — semantic distinctions", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("stores cash allowance with the correct four independent flags", async () => {
    const s = await seedClubWithAdmin("Cat A");
    const r = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "CELL_PHONE_ALLOWANCE", displayName: "Cell Phone Allowance",
      category: "ALLOWANCE", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY", taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
    });
    expect(r.createdOrUpdated).toBe("created");
    const row = await db().payrollComponent.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.cashEffect).toBe("INCREASES_NET_PAY");
    expect(row.taxableEffect).toBe("ADD");
    expect(row.cppPensionableEffect).toBe("ADD");
    // Non-insurable — proves the four flags are independent.
    expect(row.eiInsurableEffect).toBe("NONE");
  });

  it("stores a non-cash TAXABLE_BENEFIT that participates in tax base but NOT in cash", async () => {
    const s = await seedClubWithAdmin("Cat B");
    const r = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "LIFE_INSURANCE_TAXABLE", displayName: "Employer Life Insurance",
      category: "TAXABLE_BENEFIT", side: "EMPLOYER",
      cashEffect: "NO_NET_PAY_EFFECT", taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "BENEFITS",
    });
    const row = await db().payrollComponent.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.cashEffect).toBe("NO_NET_PAY_EFFECT");
    expect(row.taxableEffect).toBe("ADD");
    // Employer side + non-cash = never reduces employee net.
    expect(row.side).toBe("EMPLOYER");
  });

  it("stores an EMPLOYER_CONTRIBUTION that is informational-only (no statutory-base impact)", async () => {
    const s = await seedClubWithAdmin("Cat C");
    const r = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "RRSP_ER", displayName: "Employer RRSP",
      category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER",
      cashEffect: "NO_NET_PAY_EFFECT", taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      displaySection: "BENEFITS",
    });
    const row = await db().payrollComponent.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.taxableEffect).toBe("NONE");
    expect(row.cppPensionableEffect).toBe("NONE");
    expect(row.eiInsurableEffect).toBe("NONE");
  });

  it("refuses REGULAR_EARNING with cashEffect != INCREASES_NET_PAY (structural invariant)", async () => {
    const s = await seedClubWithAdmin("Cat D");
    await expect(upsertPayrollComponent(s.adminP, s.club.id, {
      code: "REG_NONCASH", displayName: "Regular (broken)",
      category: "REGULAR_EARNING", side: "EMPLOYEE",
      cashEffect: "NO_NET_PAY_EFFECT", taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
      calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses EMPLOYEE_DEDUCTION with side=EMPLOYER", async () => {
    const s = await seedClubWithAdmin("Cat E");
    await expect(upsertPayrollComponent(s.adminP, s.club.id, {
      code: "BAD_LTD", displayName: "LTD (broken)",
      category: "EMPLOYEE_DEDUCTION", side: "EMPLOYER",
      cashEffect: "NO_NET_PAY_EFFECT", taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "DEDUCTIONS",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses malformed codes (must be UPPER_SNAKE_CASE)", async () => {
    const s = await seedClubWithAdmin("Cat F");
    for (const bad of ["", "lowercase", "spaces here", "9LEAD_DIGIT", "TOO-LONG-" + "X".repeat(80)]) {
      await expect(upsertPayrollComponent(s.adminP, s.club.id, {
        code: bad, displayName: "x",
        category: "ALLOWANCE", side: "EMPLOYEE",
        cashEffect: "INCREASES_NET_PAY", taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
        calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
      })).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

// -------------------------------------------------------------------
// Tenant isolation
// -------------------------------------------------------------------
describe("PayrollComponent catalogue — tenant isolation", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("(clubId, code) is unique per tenant — same code allowed in another club", async () => {
    const a = await seedClubWithAdmin("Iso A");
    const b = await seedClubWithAdmin("Iso B");
    for (const s of [a, b]) {
      const r = await upsertPayrollComponent(s.adminP, s.club.id, {
        code: "CELL_PHONE_ALLOWANCE", displayName: "Cell Phone Allowance",
        category: "ALLOWANCE", side: "EMPLOYEE",
        cashEffect: "INCREASES_NET_PAY", taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
        calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
      });
      expect(r.createdOrUpdated).toBe("created");
    }
    const inA = await listPayrollComponents(a.adminP, a.club.id);
    const inB = await listPayrollComponents(b.adminP, b.club.id);
    expect(inA.length).toBe(1);
    expect(inB.length).toBe(1);
    expect(inA[0].id).not.toBe(inB[0].id);
  });

  it("assigning a component from another club to an employee in this club is refused", async () => {
    const a = await seedClubWithAdmin("Iso C");
    const b = await seedClubWithAdmin("Iso D");
    const empA = await seedEmployee(a.club.id, "A");
    const compB = await upsertPayrollComponent(b.adminP, b.club.id, {
      code: "BAD_XREF", displayName: "Cross-tenant",
      category: "ALLOWANCE", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY", taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
      calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
    });
    await expect(createRecurringComponentAssignment(a.adminP, a.club.id, {
      employeeId: empA.id, componentId: compB.id,
      amount: "10.00", effectiveFrom: utc(2026, 1, 1),
    })).rejects.toBeInstanceOf(ValidationError);
  });
});

// -------------------------------------------------------------------
// Recurring assignments — validation + effective dating
// -------------------------------------------------------------------
describe("EmployeeRecurringPayrollComponent — validation + effective dating", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("FIXED_AMOUNT requires amount, forbids percentBps", async () => {
    const s = await seedClubWithAdmin("Rec A");
    const emp = await seedEmployee(s.club.id, "R1");
    const comp = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "CELL_PHONE", displayName: "Cell", category: "ALLOWANCE", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY", taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
    });
    await expect(createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: emp.id, componentId: comp.id,
      effectiveFrom: utc(2026, 1, 1),
    })).rejects.toBeInstanceOf(ValidationError);
    await expect(createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: emp.id, componentId: comp.id,
      amount: "37.50", percentBps: 500, effectiveFrom: utc(2026, 1, 1),
    })).rejects.toBeInstanceOf(ValidationError);
    const ok = await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: emp.id, componentId: comp.id,
      amount: "37.50", effectiveFrom: utc(2026, 1, 1),
    });
    expect(ok.id).toBeTruthy();
  });

  it("PERCENT_OF_ELIGIBLE_EARNINGS requires percentBps, forbids fixed amount", async () => {
    const s = await seedClubWithAdmin("Rec B");
    const emp = await seedEmployee(s.club.id, "R2");
    const comp = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "RRSP_EE", displayName: "RRSP EE", category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
      cashEffect: "DECREASES_NET_PAY", taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      displaySection: "DEDUCTIONS",
    });
    await expect(createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: emp.id, componentId: comp.id,
      amount: "100", effectiveFrom: utc(2026, 1, 1),
    })).rejects.toBeInstanceOf(ValidationError);
    await expect(createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: emp.id, componentId: comp.id,
      percentBps: 20_001, effectiveFrom: utc(2026, 1, 1),   // > 100%
    })).rejects.toBeInstanceOf(ValidationError);
    const ok = await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: emp.id, componentId: comp.id,
      percentBps: 500, effectiveFrom: utc(2026, 1, 1),
    });
    expect(ok.id).toBeTruthy();
  });

  it("effective-date window governs which assignment is 'active' at a given asOf", async () => {
    const s = await seedClubWithAdmin("Rec C");
    const emp = await seedEmployee(s.club.id, "R3");
    const comp = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "CELL_PHONE", displayName: "Cell", category: "ALLOWANCE", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY", taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
    });
    // First assignment ends 2026-06-01; second starts 2026-06-01.
    const first = await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: emp.id, componentId: comp.id,
      amount: "25.00", effectiveFrom: utc(2026, 1, 1), effectiveTo: utc(2026, 6, 1),
    });
    const second = await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: emp.id, componentId: comp.id,
      amount: "37.50", effectiveFrom: utc(2026, 6, 1),
    });
    // Query at Feb 2026 → only the first is active.
    const asFeb = await listActiveEmployeeComponentAssignments(s.adminP, s.club.id, emp.id, utc(2026, 2, 15));
    expect(asFeb.map((r) => r.id)).toEqual([first.id]);
    // Query at Sep 2026 → only the second is active.
    const asSep = await listActiveEmployeeComponentAssignments(s.adminP, s.club.id, emp.id, utc(2026, 9, 15));
    expect(asSep.map((r) => r.id)).toEqual([second.id]);
  });

  it("endRecurringComponentAssignment sets effectiveTo + deactivates the row", async () => {
    const s = await seedClubWithAdmin("Rec D");
    const emp = await seedEmployee(s.club.id, "R4");
    const comp = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "CELL_PHONE", displayName: "Cell", category: "ALLOWANCE", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY", taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
    });
    const a = await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: emp.id, componentId: comp.id,
      amount: "37.50", effectiveFrom: utc(2026, 1, 1),
    });
    await endRecurringComponentAssignment(s.adminP, s.club.id, a.id, utc(2026, 9, 1));
    const row = await db().employeeRecurringPayrollComponent.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.active).toBe(false);
    expect(row.effectiveTo?.toISOString()).toBe(utc(2026, 9, 1).toISOString());
  });

  it("endRecurringComponentAssignment refuses effectiveTo ≤ effectiveFrom", async () => {
    const s = await seedClubWithAdmin("Rec E");
    const emp = await seedEmployee(s.club.id, "R5");
    const comp = await upsertPayrollComponent(s.adminP, s.club.id, {
      code: "CELL_PHONE", displayName: "Cell", category: "ALLOWANCE", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY", taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
    });
    const a = await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: emp.id, componentId: comp.id,
      amount: "37.50", effectiveFrom: utc(2026, 6, 1),
    });
    await expect(endRecurringComponentAssignment(s.adminP, s.club.id, a.id, utc(2026, 5, 1)))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it("cross-tenant getPayrollComponent read is refused", async () => {
    const a = await seedClubWithAdmin("Rec F");
    const b = await seedClubWithAdmin("Rec G");
    const compA = await upsertPayrollComponent(a.adminP, a.club.id, {
      code: "CELL_PHONE", displayName: "Cell", category: "ALLOWANCE", side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY", taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT", displaySection: "EARNINGS",
    });
    const { getPayrollComponent } = await import("@/lib/payroll/components-catalogue");
    // Admin of club B may not read component owned by club A —
    // whether that's expressed as tenant-isolation or not-found, the
    // component must not be returned.
    await expect(getPayrollComponent(b.adminP, b.club.id, compA.id))
      .rejects.toBeTruthy();
  });
});
