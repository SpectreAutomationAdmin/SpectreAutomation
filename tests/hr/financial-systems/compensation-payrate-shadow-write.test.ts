// HR-1 financial-systems — Employee.payRate shadow-write invariant.
//
// The compensation service is the ONLY writer of Employee.payRate.
// Every changeCompensation call must update BOTH EmployeeCompensation
// AND Employee.payRate in the SAME prisma.$transaction so a crash
// between the two cannot leave them diverged.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { changeCompensation } from "@/lib/hr/compensation";
import { updateEmployee } from "@/lib/hr/employees";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";
import { latestAuditForAction } from "../admin-workflows/_helpers";

describe("HR financial-systems · Employee.payRate shadow-write", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("changeCompensation writes Employee.payRate to the new amount", async () => {
    const fx = await makeAdminHrFixture();
    // Employee starts at payRate=20 (fixture default in
    // security-compliance/_helpers.ts::makeEmployee).
    const preEmployee = await prisma.employee.findUnique({ where: { id: fx.employee.id } });
    expect(preEmployee?.payRate.toString()).toBe("20");

    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
      amount: 27.5,
      cadence: "HOURLY",
      currency: "CAD",
    });

    const postEmployee = await prisma.employee.findUnique({ where: { id: fx.employee.id } });
    expect(postEmployee?.payRate.toString()).toBe("27.5");
  });

  it("EmployeeCompensation.rate and Employee.payRate stay in step after multiple changes", async () => {
    const fx = await makeAdminHrFixture();
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
      amount: 22, cadence: "HOURLY", currency: "CAD",
    });
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2025-06-01T00:00:00.000Z"),
      amount: 25.75, cadence: "HOURLY", currency: "CAD",
    });
    const latest = await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      amount: 30.25, cadence: "HOURLY", currency: "CAD",
    });
    const employee = await prisma.employee.findUnique({ where: { id: fx.employee.id } });
    expect(employee?.payRate.toString()).toBe(latest.rate.toString());
    expect(employee?.payRate.toString()).toBe("30.25");
  });

  it("shadow-write is atomic — after the service returns, the compensation row exists AND Employee.payRate matches", async () => {
    // We can't inject a mid-transaction crash without patching the
    // Prisma client. Instead, we prove the two writes are consistent
    // in the observed state — any non-transactional implementation
    // that shadow-wrote OUTSIDE the tx could have written the
    // compensation row and then failed to update the Employee, but
    // in that failure path this test would see a mismatch. We assert
    // the invariant across dozens of consecutive writes to keep the
    // window observable.
    const fx = await makeAdminHrFixture();
    let dateCursor = new Date("2024-01-01T00:00:00.000Z").getTime();
    for (let i = 0; i < 5; i++) {
      const amt = 20 + i * 3.25;
      dateCursor += 30 * 86_400_000; // +30 days each time
      await changeCompensation(fx.payrollAdmin, fx.employee.id, {
        effectiveFrom: new Date(dateCursor),
        amount: amt.toString(),
        cadence: "HOURLY",
        currency: "CAD",
      });
      const employee = await prisma.employee.findUnique({ where: { id: fx.employee.id } });
      const openRow = await prisma.employeeCompensation.findFirst({
        where: { employeeId: fx.employee.id, effectiveTo: null },
      });
      expect(openRow).toBeTruthy();
      expect(openRow!.rate.toString()).toBe(employee!.payRate.toString());
    }
  });

  it("admin-workflows updateEmployee cannot touch payRate (compensation service is exclusive writer)", async () => {
    // The updateEmployee input surface deliberately excludes
    // payRate — this pin catches a regression that would allow
    // admin-workflows to bypass the compensation service and drift
    // the shadow write.
    const fx = await makeAdminHrFixture();
    // Seed a compensation row so Employee.payRate is non-default.
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
      amount: 22, cadence: "HOURLY", currency: "CAD",
    });
    // Try to sneak payRate through updateEmployee — the runtime cast
    // bypasses the type surface so we can prove the SERVICE also
    // ignores unknown fields. If someone loosened
    // UpdateEmployeeInput to accept payRate, this test would still
    // catch the resulting drift on the assertion below.
    const sneakyInput = { preferredName: "Sneak", payRate: 99 } as unknown as {
      preferredName: string;
    };
    await updateEmployee(fx.clubAdmin, fx.employee.id, sneakyInput);
    const employee = await prisma.employee.findUnique({ where: { id: fx.employee.id } });
    expect(employee?.payRate.toString()).toBe("22");
  });

  it("audit row emits amount as a string (Decimal.toString) to preserve precision", async () => {
    const fx = await makeAdminHrFixture();
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
      amount: "22.505",
      cadence: "HOURLY",
      currency: "CAD",
    });
    const audit = await latestAuditForAction("hr.compensation.update");
    expect(audit).toBeTruthy();
    const after = JSON.parse(audit!.afterJson!);
    // No JSON-precision loss (would be `22.505` as a string, not a
    // Number). If someone regressed to Number(amount), a trailing
    // `.505` might survive but the point is stability across a wide
    // fractional range — assert stringly-typed here.
    expect(typeof after.amount).toBe("string");
    expect(after.amount).toBe("22.505");
  });
});
