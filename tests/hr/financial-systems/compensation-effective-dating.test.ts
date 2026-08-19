// HR-1 financial-systems — EmployeeCompensation half-open effective
// dating.
//
// Load-bearing behaviour: `getCompensationAt(t)` at exact boundary
// instants — half-open semantics say the boundary belongs to the NEW
// row. NO `-1ms` arithmetic anywhere in the service.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  changeCompensation,
  getCompensationAt,
  getCurrentCompensation,
  listCompensationHistory,
} from "@/lib/hr/compensation";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";

describe("HR financial-systems · EmployeeCompensation half-open dating", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("changeCompensation inserts the first period as [effectiveFrom, null)", async () => {
    const fx = await makeAdminHrFixture();
    const row = await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
      amount: 22,
      cadence: "HOURLY",
      currency: "CAD",
    });
    expect(row.effectiveFrom.toISOString().startsWith("2024-01-01")).toBe(true);
    expect(row.effectiveTo).toBeNull();
    expect(row.rate.toString()).toBe("22");
  });

  it("opening a second period closes the first at exactly the new effectiveFrom (no -1ms)", async () => {
    const fx = await makeAdminHrFixture();
    const t0 = new Date("2024-01-01T00:00:00.000Z");
    const t1 = new Date("2025-06-01T00:00:00.000Z");

    const first = await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: t0, amount: 22, cadence: "HOURLY", currency: "CAD",
    });
    const second = await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: t1, amount: 25, cadence: "HOURLY", currency: "CAD",
    });

    const all = await listCompensationHistory(fx.payrollAdmin, fx.employee.id);
    expect(all).toHaveLength(2);
    const rowA = all.find((r) => r.id === first.id)!;
    const rowB = all.find((r) => r.id === second.id)!;
    // Half-open: prior period's effectiveTo == new period's effectiveFrom.
    // NEVER "1 ms before" — exactly equal.
    expect(rowA.effectiveTo?.getTime()).toBe(t1.getTime());
    expect(rowB.effectiveTo).toBeNull();
  });

  it("getCompensationAt(t) — t exactly at second.effectiveFrom resolves to second (half-open boundary)", async () => {
    const fx = await makeAdminHrFixture();
    const t0 = new Date("2024-01-01T00:00:00.000Z");
    const t1 = new Date("2025-06-01T00:00:00.000Z");
    const first = await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: t0, amount: 22, cadence: "HOURLY", currency: "CAD",
    });
    const second = await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: t1, amount: 25, cadence: "HOURLY", currency: "CAD",
    });

    // t = t0 (exact boundary of first) — resolves to first.
    const atT0 = await getCompensationAt(fx.payrollAdmin, fx.employee.id, t0);
    expect(atT0?.id).toBe(first.id);

    // t = t1 (exact boundary between first and second) — resolves to
    // second. If a bug used `-1ms` this test would return first.
    const atT1 = await getCompensationAt(fx.payrollAdmin, fx.employee.id, t1);
    expect(atT1?.id).toBe(second.id);

    // Just before the boundary — resolves to first.
    const justBefore = new Date(t1.getTime() - 1);
    const atJustBefore = await getCompensationAt(fx.payrollAdmin, fx.employee.id, justBefore);
    expect(atJustBefore?.id).toBe(first.id);

    // "Now" — resolves to second (the currently-open row).
    const atNow = await getCompensationAt(fx.payrollAdmin, fx.employee.id, new Date());
    expect(atNow?.id).toBe(second.id);
  });

  it("getCompensationAt returns null when the employee has no row active at t", async () => {
    const fx = await makeAdminHrFixture();
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
      amount: 22, cadence: "HOURLY", currency: "CAD",
    });
    const before = await getCompensationAt(fx.payrollAdmin, fx.employee.id, new Date("2023-01-01"));
    expect(before).toBeNull();
  });

  it("getCurrentCompensation returns the single open row", async () => {
    const fx = await makeAdminHrFixture();
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
      amount: 22, cadence: "HOURLY", currency: "CAD",
    });
    const second = await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2025-06-01T00:00:00.000Z"),
      amount: 25, cadence: "HOURLY", currency: "CAD",
    });

    const current = await getCurrentCompensation(fx.payrollAdmin, fx.employee.id);
    expect(current?.id).toBe(second.id);
    expect(current?.effectiveTo).toBeNull();
  });

  it("listCompensationHistory returns rows oldest-first", async () => {
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
    const rows = await listCompensationHistory(fx.payrollAdmin, fx.employee.id);
    expect(rows.map((r) => r.effectiveFrom.getTime())).toEqual([
      t0.getTime(), t1.getTime(), t2.getTime(),
    ]);
  });
});
