// HR-2B.5 §11-15, §43 — Initial compensation on Add Employee.
//
// The admin Add-Employee form now collects cadence + rate. On submit,
// the /api/people/employees route wires those into `changeCompensation()`
// (the canonical EmployeeCompensation writer) with effectiveFrom set to
// the expected start date. The pay-rate shadow-write into legacy
// Employee.payRate is exercised by the compensation service's own tests;
// here we verify the composition-level guarantees.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createEmployee } from "@/lib/hr/employees";
import { changeCompensation, getCurrentCompensation } from "@/lib/hr/compensation";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "./_helpers";

describe("HR-2B.5 · Initial compensation on Add Employee", () => {
  let fx: AdminHrFixture;

  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("CompFix");
  });

  it("CLUB_ADMIN can create hourly compensation effective on expected start date", async () => {
    const employee = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Chris", lastName: "Hourly", personalEmail: `hourly-${Date.now()}@example.com`,
      expectedStartDate: new Date("2026-09-08"),
    });
    await changeCompensation(fx.clubAdmin, employee.id, {
      effectiveFrom: new Date("2026-09-08"),
      amount: "22.50",
      cadence: "HOURLY",
    });
    const current = await getCurrentCompensation(fx.clubAdmin, employee.id);
    expect(current?.cadence).toBe("HOURLY");
    expect(current?.rate.toString()).toBe("22.5");
    expect(current?.effectiveFrom.toISOString()).toBe(new Date("2026-09-08").toISOString());
  });

  it("CLUB_ADMIN can create salary compensation using annual amount", async () => {
    const employee = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Chris", lastName: "Salary", personalEmail: `salary-${Date.now()}@example.com`,
      expectedStartDate: new Date("2026-09-08"),
    });
    await changeCompensation(fx.clubAdmin, employee.id, {
      effectiveFrom: new Date("2026-09-08"),
      amount: "72000",
      cadence: "SALARY",
    });
    const current = await getCurrentCompensation(fx.clubAdmin, employee.id);
    expect(current?.cadence).toBe("SALARY");
    expect(current?.rate.toString()).toBe("72000");
  });

  it("legacy shadow-write keeps Employee.payRate in step (single writer invariant)", async () => {
    const employee = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Chris", lastName: "Shadow", personalEmail: `shadow-${Date.now()}@example.com`,
      expectedStartDate: new Date("2026-09-08"),
    });
    await changeCompensation(fx.clubAdmin, employee.id, {
      effectiveFrom: new Date("2026-09-08"),
      amount: "24.00",
      cadence: "HOURLY",
    });
    const row = await prisma.employee.findUnique({ where: { id: employee.id } });
    expect(row?.payRate.toString()).toBe("24");
  });

  it("AUDITOR_READ_ONLY cannot write compensation (hr:compensation:write refused)", async () => {
    const employee = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Chris", lastName: "AuditorRefused", personalEmail: `ar-${Date.now()}@example.com`,
      expectedStartDate: new Date("2026-09-08"),
    });
    await expect(
      changeCompensation(fx.auditor, employee.id, {
        effectiveFrom: new Date("2026-09-08"),
        amount: "22.50",
        cadence: "HOURLY",
      }),
    ).rejects.toThrow(/permission/i);
  });

  it("cross-club compensation write is refused", async () => {
    // Employee lives in fx.club; an admin from fx.foreignClub tries to write.
    const employee = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Chris", lastName: "CrossClub", personalEmail: `cc-${Date.now()}@example.com`,
      expectedStartDate: new Date("2026-09-08"),
    });
    await expect(
      changeCompensation(fx.foreignClubAdmin, employee.id, {
        effectiveFrom: new Date("2026-09-08"),
        amount: "22.50",
        cadence: "HOURLY",
      }),
    ).rejects.toThrow(/tenant|access|not found|denied/i);
  });

  it("effective-dated history: second row closes the first at the second's start", async () => {
    const employee = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Chris", lastName: "History", personalEmail: `hist-${Date.now()}@example.com`,
      expectedStartDate: new Date("2026-09-08"),
    });
    await changeCompensation(fx.clubAdmin, employee.id, {
      effectiveFrom: new Date("2026-09-08"),
      amount: "22.00",
      cadence: "HOURLY",
    });
    await changeCompensation(fx.clubAdmin, employee.id, {
      effectiveFrom: new Date("2027-01-01"),
      amount: "24.00",
      cadence: "HOURLY",
    });
    const rows = await prisma.employeeCompensation.findMany({
      where: { employeeId: employee.id },
      orderBy: { effectiveFrom: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.effectiveTo?.toISOString()).toBe(rows[1]!.effectiveFrom.toISOString());
    expect(rows[1]!.effectiveTo).toBeNull();
    // Legacy shadow reflects the current row.
    const emp = await prisma.employee.findUnique({ where: { id: employee.id } });
    expect(emp?.payRate.toString()).toBe("24");
  });
});
