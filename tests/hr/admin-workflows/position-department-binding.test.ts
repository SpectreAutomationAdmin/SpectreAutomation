// HR-2B.3.6 (2026-08-19) — Position depends on Department.
//
// Founder invariants:
//   * createEmployeePosition without departmentId → ValidationError.
//   * createEmployeePosition with a department from a DIFFERENT club
//     → ValidationError.
//   * listEmployeePositions({departmentId}) filters correctly.
//   * A position bound to Department A does NOT surface in Department B's list.
//   * Cross-club positions never leak (existing invariant reinforced).

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/lib/errors";
import {
  createEmployeePosition,
  listEmployeePositions,
} from "@/lib/hr/employee-positions";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "./_helpers";

async function mkDept(clubId: string, name: string) {
  return prisma.department.create({
    data: {
      clubId,
      name,
      code: name.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_" + Math.random().toString(36).slice(2, 6).toUpperCase(),
      isActive: true,
    },
  });
}

describe("HR-2B.3.6 · Position depends on Department", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("createEmployeePosition without departmentId → ValidationError with issue on `departmentId`", async () => {
    const fx = await makeAdminHrFixture("Pos-NoDept");
    let caught: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await createEmployeePosition(fx.clubAdmin, fx.club.id, { name: "Server" } as any);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const issues = (caught as ValidationError).issues;
    expect(issues.some((i) => i.path === "departmentId")).toBe(true);
  });

  it("createEmployeePosition with a department from a DIFFERENT club → ValidationError with issue on `departmentId`", async () => {
    const fx = await makeAdminHrFixture("Pos-XClubDept");
    const foreignDept = await mkDept(fx.foreignClub.id, "Foreign Dept");
    let caught: unknown;
    try {
      await createEmployeePosition(fx.clubAdmin, fx.club.id, {
        name: "Cross Position",
        departmentId: foreignDept.id,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const issues = (caught as ValidationError).issues;
    expect(issues.some((i) => i.path === "departmentId")).toBe(true);
    expect(issues.find((i) => i.path === "departmentId")?.message).toMatch(/not a valid department/);
  });

  it("listEmployeePositions({departmentId}) filters to same-department positions only", async () => {
    const fx = await makeAdminHrFixture("Pos-Filter");
    const admin = await mkDept(fx.club.id, "Administration");
    const kitchen = await mkDept(fx.club.id, "Kitchen");
    await createEmployeePosition(fx.clubAdmin, fx.club.id, {
      name: "Administrative Assistant",
      departmentId: admin.id,
    });
    await createEmployeePosition(fx.clubAdmin, fx.club.id, {
      name: "General Manager",
      departmentId: admin.id,
    });
    await createEmployeePosition(fx.clubAdmin, fx.club.id, {
      name: "Line Cook",
      departmentId: kitchen.id,
    });

    const adminList = await listEmployeePositions(fx.clubAdmin, fx.club.id, {
      departmentId: admin.id,
    });
    const kitchenList = await listEmployeePositions(fx.clubAdmin, fx.club.id, {
      departmentId: kitchen.id,
    });
    expect(adminList.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Administrative Assistant", "General Manager"]),
    );
    expect(adminList.map((p) => p.name)).not.toContain("Line Cook");
    expect(kitchenList.map((p) => p.name)).toEqual(["Line Cook"]);
  });

  it("Line Cook (Kitchen) is NOT an option for Administration", async () => {
    const fx = await makeAdminHrFixture("Pos-LineCook");
    const admin = await mkDept(fx.club.id, "Administration");
    const kitchen = await mkDept(fx.club.id, "Kitchen");
    await createEmployeePosition(fx.clubAdmin, fx.club.id, {
      name: "Line Cook",
      departmentId: kitchen.id,
    });
    const list = await listEmployeePositions(fx.clubAdmin, fx.club.id, {
      departmentId: admin.id,
    });
    expect(list).toEqual([]);
  });

  it("cross-club positions never surface — even when the caller passes the foreign departmentId", async () => {
    const fx = await makeAdminHrFixture("Pos-XClubList");
    const homeDept = await mkDept(fx.club.id, "Home");
    const foreignDept = await mkDept(fx.foreignClub.id, "Foreign");
    await createEmployeePosition(fx.foreignClubAdmin, fx.foreignClub.id, {
      name: "Foreign-only Position",
      departmentId: foreignDept.id,
    });
    // Caller on the home club — even if they know the foreign dept id,
    // the outer clubId filter refuses to return foreign rows.
    const list = await listEmployeePositions(fx.clubAdmin, fx.club.id, {
      departmentId: foreignDept.id,
    });
    expect(list).toEqual([]);
    // And with the correct home dept filter, still no foreign leakage.
    const homeList = await listEmployeePositions(fx.clubAdmin, fx.club.id, {
      departmentId: homeDept.id,
    });
    expect(homeList.map((p) => p.name)).not.toContain("Foreign-only Position");
  });

  it("inactive positions are excluded by default even when in the requested department", async () => {
    const fx = await makeAdminHrFixture("Pos-Inactive");
    const dept = await mkDept(fx.club.id, "General");
    const active = await createEmployeePosition(fx.clubAdmin, fx.club.id, {
      name: "Active Role",
      departmentId: dept.id,
    });
    const inactive = await createEmployeePosition(fx.clubAdmin, fx.club.id, {
      name: "Retired Role",
      departmentId: dept.id,
    });
    await prisma.employeePosition.update({
      where: { id: inactive.id },
      data: { isActive: false },
    });

    const list = await listEmployeePositions(fx.clubAdmin, fx.club.id, {
      departmentId: dept.id,
    });
    expect(list.map((p) => p.id)).toContain(active.id);
    expect(list.map((p) => p.id)).not.toContain(inactive.id);
  });
});
