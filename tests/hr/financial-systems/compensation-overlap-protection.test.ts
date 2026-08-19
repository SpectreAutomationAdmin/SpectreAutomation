// HR-1 financial-systems — EmployeeCompensation overlap protection.
//
// Invariant: at most ONE row per employee has `effectiveTo === null`.
// Enforced by close-then-insert inside a single $transaction.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { changeCompensation } from "@/lib/hr/compensation";
import { ConflictError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";
import { countOpenCompensationRows } from "./_helpers";

describe("HR financial-systems · EmployeeCompensation overlap protection", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("after sequential changeCompensation calls, only one row has effectiveTo === null", async () => {
    const fx = await makeAdminHrFixture();
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
      amount: 22, cadence: "HOURLY", currency: "CAD",
    });
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2025-06-01T00:00:00.000Z"),
      amount: 25, cadence: "HOURLY", currency: "CAD",
    });
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      amount: 28, cadence: "HOURLY", currency: "CAD",
    });
    const openCount = await countOpenCompensationRows(fx.employee.id);
    expect(openCount).toBe(1);
  });

  it("prior row's effectiveTo equals the new row's effectiveFrom (adjacent, no gap)", async () => {
    const fx = await makeAdminHrFixture();
    const t1 = new Date("2025-06-01T00:00:00.000Z");
    const first = await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
      amount: 22, cadence: "HOURLY", currency: "CAD",
    });
    const second = await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: t1,
      amount: 25, cadence: "HOURLY", currency: "CAD",
    });

    const { prisma } = await import("@/lib/prisma");
    const rowA = await prisma.employeeCompensation.findUnique({ where: { id: first.id } });
    expect(rowA?.effectiveTo?.getTime()).toBe(t1.getTime());
    expect(rowA?.effectiveTo?.getTime()).toBe(second.effectiveFrom.getTime());
  });

  it("rejects a new row whose effectiveFrom equals the currently-open row's effectiveFrom (zero-width period)", async () => {
    const fx = await makeAdminHrFixture();
    const t = new Date("2024-01-01T00:00:00.000Z");
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: t, amount: 22, cadence: "HOURLY", currency: "CAD",
    });
    await expect(
      changeCompensation(fx.payrollAdmin, fx.employee.id, {
        effectiveFrom: t, amount: 25, cadence: "HOURLY", currency: "CAD",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a new row whose effectiveFrom is BEFORE the currently-open row's start (retrospective insert)", async () => {
    const fx = await makeAdminHrFixture();
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2025-06-01T00:00:00.000Z"),
      amount: 25, cadence: "HOURLY", currency: "CAD",
    });
    await expect(
      changeCompensation(fx.payrollAdmin, fx.employee.id, {
        effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
        amount: 22, cadence: "HOURLY", currency: "CAD",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("history rows never overlap — every closed row's effectiveTo <= next row's effectiveFrom", async () => {
    const fx = await makeAdminHrFixture();
    const t0 = new Date("2024-01-01T00:00:00.000Z");
    const t1 = new Date("2025-06-01T00:00:00.000Z");
    const t2 = new Date("2026-01-01T00:00:00.000Z");
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: t0, amount: 22, cadence: "HOURLY", currency: "CAD",
    });
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: t1, amount: 25, cadence: "HOURLY", currency: "CAD",
    });
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: t2, amount: 28, cadence: "HOURLY", currency: "CAD",
    });

    const { prisma } = await import("@/lib/prisma");
    const rows = await prisma.employeeCompensation.findMany({
      where: { employeeId: fx.employee.id },
      orderBy: { effectiveFrom: "asc" },
    });
    for (let i = 0; i < rows.length - 1; i++) {
      const closedTo = rows[i].effectiveTo;
      expect(closedTo).not.toBeNull();
      expect(closedTo!.getTime()).toBeLessThanOrEqual(rows[i + 1].effectiveFrom.getTime());
    }
    expect(rows[rows.length - 1].effectiveTo).toBeNull();
  });
});
