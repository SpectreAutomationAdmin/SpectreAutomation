// HR-2B.3.1 (2026-08-18) §4 — EmployeePosition canonical service tests.
//
// Covers the founder brief §4.1 loader-correctness case AND §4.2
// empty-catalogue case:
//   • listEmployeePositions returns only same-Club active positions.
//   • cross-Club positions never leak into the caller's list.
//   • inactive positions filtered by default; opt-in via includeInactive.
//   • createEmployeePosition creates a same-Club row and it appears in
//     the next list.
//   • createEmployeePosition auto-derives a canonical code when the
//     operator supplied only a name.
//   • duplicate code within the same Club is refused (schema
//     @unique @@ ([clubId, code])).
//   • AUDITOR_READ_ONLY without hr:employee:write cannot create.
//   • cross-Club admin cannot create against a foreign Club.
//   • Employee row can then persist a positionId that points at the
//     new row.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createEmployeePosition,
  listEmployeePositions,
} from "@/lib/hr/employee-positions";
import { createEmployee } from "@/lib/hr/employees";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";

async function mkDept(clubId: string, name = "General") {
  const dept = await prisma.department.create({
    data: { clubId, name, code: name.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_" + Math.random().toString(36).slice(2, 6).toUpperCase(), isActive: true },
  });
  return dept.id;
}


describe("HR-2B.3.1 §4 · EmployeePosition service", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("listEmployeePositions returns only same-Club active positions", async () => {
    const fx = await makeAdminHrFixture("Positions-Same");
    const dept = await mkDept(fx.club.id);
    const foreignDept = await mkDept(fx.foreignClub.id);
    await createEmployeePosition(fx.clubAdmin, fx.club.id, { name: "Head Server", departmentId: dept });
    await createEmployeePosition(fx.clubAdmin, fx.club.id, { name: "Server Assistant", departmentId: dept });
    // A row in the foreign club — MUST NOT appear in the list.
    await createEmployeePosition(fx.foreignClubAdmin, fx.foreignClub.id, {
      name: "Foreign Server",
      departmentId: foreignDept,
    });

    const rows = await listEmployeePositions(fx.clubAdmin, fx.club.id);
    const names = rows.map((r) => r.name);
    expect(names).toContain("Head Server");
    expect(names).toContain("Server Assistant");
    expect(names).not.toContain("Foreign Server");
    expect(rows.every((r) => r.isActive)).toBe(true);
  });

  it("inactive positions filtered by default; visible with includeInactive:true", async () => {
    const fx = await makeAdminHrFixture("Positions-Inactive");
    const dept = await mkDept(fx.club.id);
    const active = await createEmployeePosition(fx.clubAdmin, fx.club.id, { name: "Active One", departmentId: dept });
    const inactive = await createEmployeePosition(fx.clubAdmin, fx.club.id, { name: "Retired One", departmentId: dept });
    await prisma.employeePosition.update({
      where: { id: inactive.id },
      data: { isActive: false },
    });

    const active_only = await listEmployeePositions(fx.clubAdmin, fx.club.id);
    expect(active_only.map((r) => r.id)).toContain(active.id);
    expect(active_only.map((r) => r.id)).not.toContain(inactive.id);

    const all = await listEmployeePositions(fx.clubAdmin, fx.club.id, {
      includeInactive: true,
    });
    expect(all.map((r) => r.id)).toContain(inactive.id);
  });

  it("createEmployeePosition auto-derives a code from the name", async () => {
    const fx = await makeAdminHrFixture("Positions-CodeDerive");
    const dept = await mkDept(fx.club.id);
    const created = await createEmployeePosition(fx.clubAdmin, fx.club.id, {
      name: "Head Bartender",
      departmentId: dept,
    });
    expect(created.name).toBe("Head Bartender");
    expect(created.code).toBe("HEAD_BARTENDER");
  });

  it("creating a second position with a colliding derived code auto-suffixes", async () => {
    const fx = await makeAdminHrFixture("Positions-Collide");
    const dept = await mkDept(fx.club.id);
    const first = await createEmployeePosition(fx.clubAdmin, fx.club.id, { name: "Server", departmentId: dept });
    const second = await createEmployeePosition(fx.clubAdmin, fx.club.id, { name: "Server", departmentId: dept });
    expect(first.code).toBe("SERVER");
    expect(second.code).not.toBe("SERVER");
    expect(second.code.startsWith("SERVER")).toBe(true);
  });

  it("AUDITOR_READ_ONLY without hr:employee:write cannot create", async () => {
    const fx = await makeAdminHrFixture("Positions-Auditor");
    const dept = await mkDept(fx.club.id);
    await expect(
      createEmployeePosition(fx.auditor, fx.club.id, { name: "Barista", departmentId: dept }),
    ).rejects.toThrow();
    const rows = await listEmployeePositions(fx.clubAdmin, fx.club.id);
    expect(rows.length).toBe(0);
  });

  it("cross-Club admin cannot create against a foreign Club", async () => {
    const fx = await makeAdminHrFixture("Positions-CrossClub");
    const dept = await mkDept(fx.club.id);
    // foreignClubAdmin is a CLUB_ADMIN at foreignClub — has
    // hr:employee:write at THEIR club, but not against fx.club.id.
    await expect(
      createEmployeePosition(fx.foreignClubAdmin, fx.club.id, { name: "X", departmentId: dept }),
    ).rejects.toThrow();
    const rows = await listEmployeePositions(fx.clubAdmin, fx.club.id);
    expect(rows.length).toBe(0);
  });

  it("empty catalogue: fresh Club returns an empty list (the configuration state)", async () => {
    const fx = await makeAdminHrFixture("Positions-Empty");
    const rows = await listEmployeePositions(fx.clubAdmin, fx.club.id);
    expect(rows).toEqual([]);
  });

  it("newly-created position immediately appears in the next Add-Employee load and can be persisted on an Employee", async () => {
    const fx = await makeAdminHrFixture("Positions-EndToEnd");
    const dept = await mkDept(fx.club.id);
    // Before: no positions.
    let rows = await listEmployeePositions(fx.clubAdmin, fx.club.id);
    expect(rows).toEqual([]);
    
    const created = await createEmployeePosition(fx.clubAdmin, fx.club.id, {
      name: "Membership Coordinator",
      defaultPayRate: 24.5,
      departmentId: dept,
    });

    rows = await listEmployeePositions(fx.clubAdmin, fx.club.id);
    expect(rows.map((r) => r.id)).toContain(created.id);

    // The Add-Employee flow can now persist the new positionId on
    // the Employee row — this is the same call the API route makes.
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Testy",
      lastName: "Hire",
      positionId: created.id,
    });
    expect(emp.positionId).toBe(created.id);
  });
});
