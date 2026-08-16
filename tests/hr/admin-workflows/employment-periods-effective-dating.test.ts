// HR-1 admin-workflows — EmploymentPeriod half-open effective dating.
//
// The load-bearing test is `getEmploymentAt(t)` at exact boundary
// instants — half-open semantics say the boundary belongs to the NEW
// period. No `-1ms` arithmetic anywhere.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  openEmploymentPeriod,
  closeCurrentEmploymentPeriod,
  getEmploymentAt,
  getEmploymentPeriodsForRange,
  listEmploymentPeriods,
} from "@/lib/hr/employment-periods";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "./_helpers";

describe("HR admin-workflows · EmploymentPeriod half-open dating", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("openEmploymentPeriod inserts the first period as [from, null)", async () => {
    const fx = await makeAdminHrFixture();
    const p = await openEmploymentPeriod(fx.clubAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01"),
      employmentType: "FULL_TIME",
      reason: "HIRE",
    });
    expect(p.effectiveFrom.toISOString().startsWith("2024-01-01")).toBe(true);
    expect(p.effectiveTo).toBeNull();
  });

  it("opening a second period closes the first at exactly the new effectiveFrom (no -1ms)", async () => {
    const fx = await makeAdminHrFixture();
    const dateA = new Date("2024-01-01T00:00:00.000Z");
    const dateB = new Date("2025-06-01T00:00:00.000Z");

    const a = await openEmploymentPeriod(fx.clubAdmin, fx.employee.id, {
      effectiveFrom: dateA, employmentType: "FULL_TIME", reason: "HIRE",
    });
    const b = await openEmploymentPeriod(fx.clubAdmin, fx.employee.id, {
      effectiveFrom: dateB, employmentType: "FULL_TIME", reason: "PROMOTION",
    });

    const all = await listEmploymentPeriods(fx.clubAdmin, fx.employee.id);
    expect(all).toHaveLength(2);
    const rowA = all.find((r) => r.id === a.id)!;
    const rowB = all.find((r) => r.id === b.id)!;
    // Half-open: prior period's effectiveTo == new period's effectiveFrom.
    // NEVER "1 ms before" — exactly equal.
    expect(rowA.effectiveTo?.getTime()).toBe(dateB.getTime());
    expect(rowB.effectiveTo).toBeNull();
  });

  it("getEmploymentAt(t) — t exactly at periodB.effectiveFrom resolves to periodB (half-open boundary rule)", async () => {
    const fx = await makeAdminHrFixture();
    const dateA = new Date("2024-01-01T00:00:00.000Z");
    const dateB = new Date("2025-06-01T00:00:00.000Z");
    const a = await openEmploymentPeriod(fx.clubAdmin, fx.employee.id, {
      effectiveFrom: dateA, employmentType: "PART_TIME", reason: "HIRE",
    });
    const b = await openEmploymentPeriod(fx.clubAdmin, fx.employee.id, {
      effectiveFrom: dateB, employmentType: "FULL_TIME", reason: "PROMOTION",
    });

    // At t = dateA (exact boundary of periodA) -> periodA.
    const atA = await getEmploymentAt(fx.clubAdmin, fx.employee.id, dateA);
    expect(atA?.id).toBe(a.id);

    // At t = dateB (exact boundary between periodA and periodB) -> periodB.
    // If a bug used `-1ms` this test would return periodA.
    const atBoundary = await getEmploymentAt(fx.clubAdmin, fx.employee.id, dateB);
    expect(atBoundary?.id).toBe(b.id);

    // Just before the boundary -> periodA.
    const justBefore = new Date(dateB.getTime() - 1);
    const atJustBefore = await getEmploymentAt(fx.clubAdmin, fx.employee.id, justBefore);
    expect(atJustBefore?.id).toBe(a.id);
  });

  it("getEmploymentAt returns null when the employee has no period active at t", async () => {
    const fx = await makeAdminHrFixture();
    await openEmploymentPeriod(fx.clubAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01"), employmentType: "FULL_TIME", reason: "HIRE",
    });
    const before = await getEmploymentAt(fx.clubAdmin, fx.employee.id, new Date("2023-01-01"));
    expect(before).toBeNull();
  });

  it("closeCurrentEmploymentPeriod sets effectiveTo strictly after effectiveFrom", async () => {
    const fx = await makeAdminHrFixture();
    await openEmploymentPeriod(fx.clubAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01"), employmentType: "FULL_TIME", reason: "HIRE",
    });
    const closed = await closeCurrentEmploymentPeriod(fx.clubAdmin, fx.employee.id, new Date("2026-08-01"));
    expect(closed.effectiveTo?.getTime()).toBe(new Date("2026-08-01").getTime());
    // After closing, no period is active at "now".
    const nowActive = await getEmploymentAt(fx.clubAdmin, fx.employee.id, new Date());
    expect(nowActive).toBeNull();
  });

  it("getEmploymentPeriodsForRange returns overlapping half-open intervals", async () => {
    const fx = await makeAdminHrFixture();
    const dateA = new Date("2024-01-01");
    const dateB = new Date("2025-06-01");
    const dateC = new Date("2026-01-01");
    await openEmploymentPeriod(fx.clubAdmin, fx.employee.id, {
      effectiveFrom: dateA, employmentType: "FULL_TIME", reason: "HIRE",
    });
    await openEmploymentPeriod(fx.clubAdmin, fx.employee.id, {
      effectiveFrom: dateB, employmentType: "FULL_TIME", reason: "PROMOTION",
    });
    await openEmploymentPeriod(fx.clubAdmin, fx.employee.id, {
      effectiveFrom: dateC, employmentType: "FULL_TIME", reason: "PROMOTION",
    });

    // Range spanning only period B: [dateB, dateC).
    const rows = await getEmploymentPeriodsForRange(fx.clubAdmin, fx.employee.id, dateB, dateC);
    // At half-open, period A (closed at dateB) has effectiveTo=dateB
    // which is NOT > dateB (from), so it does NOT overlap. period B
    // starts at dateB (< dateC), overlaps. period C starts at dateC
    // — not < to, does NOT overlap. Expected: just period B.
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("PROMOTION");
    expect(rows[0].effectiveFrom.getTime()).toBe(dateB.getTime());
  });
});
