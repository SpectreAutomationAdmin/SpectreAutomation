// HR-2A (2026-08-16) — Employee Directory server-shape test.
//
// Exercises the exact loader the /app/admin/people/employees page
// runs. Confirms:
//   • Rows are strictly tenant-scoped (only the caller's club).
//   • No sensitive fields (SIN / bank / tax) appear in the payload.
//   • The Member indicator is derived from the canonical link
//     (`Employee.memberId`) — Employee C (child-of-Member) has no
//     indicator.
//   • Terminated employees are excluded from the default query.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  createEmployee,
  linkEmployeeToMember,
  terminateEmployee,
} from "@/lib/hr/employees";
import { loadEmployeeDirectory } from "@/app/app/admin/people/employees/loader";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, makeMemberFor } from "../admin-workflows/_helpers";

describe("HR-2A · Employee Directory loader", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("returns only rows for the caller's club (tenant scope)", async () => {
    const fx = await makeAdminHrFixture();
    // Seed one row in the foreign club.
    await createEmployee(fx.superAdmin, fx.foreignClub.id, {
      firstName: "Foreign", lastName: "Person",
    });
    const rows = await loadEmployeeDirectory(fx.club.id);
    // Every returned row's employee must belong to fx.club — the
    // loader uses `where: { clubId }` so this holds structurally.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.firstName !== "Foreign")).toBe(true);
  });

  it("payload never contains SIN, banking, or tax fields", async () => {
    const fx = await makeAdminHrFixture();
    const rows = await loadEmployeeDirectory(fx.club.id);
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toMatch(/\bsin\b/i);
    expect(serialised).not.toMatch(/bankAccount|bankMasked|accountNumber/i);
    expect(serialised).not.toMatch(/taxProfile|taxMasked/i);
  });

  it("Member indicator ONLY appears when Employee.memberId is populated", async () => {
    const fx = await makeAdminHrFixture();
    // Employee A — linked to a Member.
    const linkedMember = await makeMemberFor(fx.club.id, {
      firstName: "Alexandra",
      lastName: "Reyes",
    });
    await linkEmployeeToMember(fx.clubAdmin, fx.employee.id, linkedMember.id);
    // Employee C — the "child-of-Member" fixture. Parent Member
    // exists in the club (family relationship out-of-band), but the
    // Employee's memberId is null.
    await makeMemberFor(fx.club.id, { firstName: "Yuki", lastName: "Sato" });
    const carmen = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Carmen", lastName: "Sato",
    });

    const rows = await loadEmployeeDirectory(fx.club.id);
    const linkedRow = rows.find((r) => r.id === fx.employee.id);
    expect(linkedRow?.member).not.toBeNull();
    expect(linkedRow?.member?.id).toBe(linkedMember.id);
    const carmenRow = rows.find((r) => r.id === carmen.id);
    expect(carmenRow?.member).toBeNull();
  });

  it("excludes TERMINATED employees by default", async () => {
    const fx = await makeAdminHrFixture();
    const terminated = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Gone", lastName: "Yesterday",
    });
    await terminateEmployee(fx.clubAdmin, terminated.id, {
      terminationDate: new Date(),
      reason: "test",
    });
    const rows = await loadEmployeeDirectory(fx.club.id);
    expect(rows.every((r) => r.id !== terminated.id)).toBe(true);
    expect(rows.every((r) => r.employeeLifecycle !== "TERMINATED")).toBe(true);
  });
});
