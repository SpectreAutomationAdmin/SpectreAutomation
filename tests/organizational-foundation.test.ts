// Organizational Foundation (2026-09-13) — canonical Position domain tests.
//
// Covers §36 minimum test list:
//   1. provisionDefaultOrganization creates canonical starter Positions.
//   2. provisioning is idempotent.
//   3. aliases don't create semantic duplicates.
//   5. Position hierarchy is created.
//   6. cycle refused.
//   7. cross-club parent refused.
//   8. UserClubProfile occupies Position without Employee.
//  12. explicit person-level manager override wins.
//  13. position default manager works.
//  14. ambiguity does not choose arbitrarily.
//  17. Position does not grant SecurityRole.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import {
  provisionDefaultOrganization,
  setPositionReportsTo,
  STARTER_POSITIONS,
} from "@/lib/organizational/provisioning";
import { resolveEmployeeManager, listManagerOptions } from "@/lib/organizational/manager-resolver";
import { hasPermission } from "@/lib/rbac";

async function seedClubWithDepts(name: string) {
  const c = db();
  const club = await makeClub(name);
  for (const [code, deptName] of [
    ["ADMIN", "Administration"],
    ["GOLF", "Golf Operations"],
    ["FAB", "Food & Beverage"],
    ["CULINARY", "Culinary"],
    ["GROUNDS", "Grounds"],
    ["MEMBER", "Membership"],
    ["FACILITY", "Facilities"],
  ] as const) {
    await c.department.create({
      data: { clubId: club.id, code, name: deptName, isActive: true, sortOrder: 0 },
    });
  }
  return club;
}

describe("Organizational Foundation · provisionDefaultOrganization", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("creates the full starter Position catalogue on a fresh Club", async () => {
    const club = await seedClubWithDepts("Alpha");
    const r = await provisionDefaultOrganization(club.id);
    expect(r.positionsCreated).toBe(STARTER_POSITIONS.length);
    expect(r.positionsUpdated).toBe(0);
    expect(r.positionsSkipped).toBe(0);
    const count = await db().organizationalPosition.count({ where: { clubId: club.id } });
    expect(count).toBe(STARTER_POSITIONS.length);
  });

  it("is idempotent — a second run creates nothing new", async () => {
    const club = await seedClubWithDepts("Beta");
    await provisionDefaultOrganization(club.id);
    const r2 = await provisionDefaultOrganization(club.id);
    expect(r2.positionsCreated).toBe(0);
    expect(r2.positionsSkipped + r2.positionsUpdated).toBe(STARTER_POSITIONS.length);
    const count = await db().organizationalPosition.count({ where: { clubId: club.id } });
    expect(count).toBe(STARTER_POSITIONS.length);
  });

  it("wires the default hierarchy: Controller → General Manager, Clubhouse Manager → General Manager", async () => {
    const club = await seedClubWithDepts("Gamma");
    await provisionDefaultOrganization(club.id);
    const gm = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "GENERAL_MANAGER" },
    });
    const controller = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CONTROLLER" },
    });
    const clubhouseMgr = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CLUBHOUSE_MANAGER" },
    });
    expect(gm.reportsToPositionId).toBeNull();
    expect(controller.reportsToPositionId).toBe(gm.id);
    expect(clubhouseMgr.reportsToPositionId).toBe(gm.id);
  });

  it("recognises legacy alias 'Head Chef' as the Executive Chef starter (no semantic duplicate)", async () => {
    const club = await seedClubWithDepts("Delta");
    // Pre-seed a legacy row with the alias label + null code.
    await db().organizationalPosition.create({
      data: {
        clubId: club.id, name: "Head Chef",
        departmentId: (await db().department.findFirstOrThrow({
          where: { clubId: club.id, code: "CULINARY" },
        })).id,
        isActive: true, sortOrder: 100,
      },
    });
    const r = await provisionDefaultOrganization(club.id);
    // The alias matched — the starter Executive Chef entry was reused
    // and its code populated on the legacy row.
    const rows = await db().organizationalPosition.findMany({
      where: { clubId: club.id, name: { in: ["Head Chef", "Executive Chef / Head Chef"] } },
    });
    // Exactly one canonical row with the Executive Chef code.
    expect(rows.filter((r) => r.code === "EXECUTIVE_CHEF").length).toBe(1);
    // The updated row was counted as an update, not a create.
    expect(r.positionsUpdated).toBeGreaterThanOrEqual(1);
  });
});

describe("Organizational Foundation · Position hierarchy edit", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("cycle detection refuses a report-to that would make the position a descendant of itself", async () => {
    const club = await seedClubWithDepts("Cycle");
    await provisionDefaultOrganization(club.id);
    const gm = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "GENERAL_MANAGER" },
    });
    const controller = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CONTROLLER" },
    });
    // Try to make GM report to Controller — Controller already reports
    // to GM, so this would create a cycle.
    await expect(setPositionReportsTo(club.id, gm.id, controller.id))
      .rejects.toThrow(/cycle/i);
  });

  it("refuses cross-club parent", async () => {
    const clubA = await seedClubWithDepts("Cross-A");
    const clubB = await seedClubWithDepts("Cross-B");
    await provisionDefaultOrganization(clubA.id);
    await provisionDefaultOrganization(clubB.id);
    const controllerA = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: clubA.id, code: "CONTROLLER" },
    });
    const gmB = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: clubB.id, code: "GENERAL_MANAGER" },
    });
    await expect(setPositionReportsTo(clubA.id, controllerA.id, gmB.id))
      .rejects.toThrow(/Club/);
  });

  it("refuses self-report", async () => {
    const club = await seedClubWithDepts("Self");
    await provisionDefaultOrganization(club.id);
    const gm = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "GENERAL_MANAGER" },
    });
    await expect(setPositionReportsTo(club.id, gm.id, gm.id))
      .rejects.toThrow(/itself/i);
  });
});

describe("Organizational Foundation · Position occupancy", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("UserClubProfile can occupy a Position without an Employee record", async () => {
    const club = await seedClubWithDepts("Occupy");
    await provisionDefaultOrganization(club.id);
    const controller = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CONTROLLER" },
    });
    const user = await makeUser({ email: "chris.occ@t.test", role: "CLUB_ADMIN", clubId: club.id });
    const profile = await db().userClubProfile.create({
      data: {
        clubId: club.id, userId: user.id,
        positionId: controller.id,
        departmentId: controller.departmentId,
        displayTitle: "Controller",
      },
    });
    expect(profile.positionId).toBe(controller.id);
    expect(profile.employeeId).toBeNull();
    // The Club has 0 Employees but the org structure is functional.
    const empCount = await db().employee.count({ where: { clubId: club.id } });
    expect(empCount).toBe(0);
  });
});

describe("Organizational Foundation · manager resolver", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("recommends the org-User occupant of the parent Position when Add Employee cascades from Clubhouse Manager", async () => {
    const club = await seedClubWithDepts("Recommend");
    await provisionDefaultOrganization(club.id);
    // Coulee-style override: Clubhouse Manager → Controller.
    const controller = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CONTROLLER" },
    });
    const clubhouseMgr = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CLUBHOUSE_MANAGER" },
    });
    await setPositionReportsTo(club.id, clubhouseMgr.id, controller.id);

    // A single org User occupies Controller (no Employee).
    const chris = await makeUser({ email: "chris.rec@t.test", role: "CLUB_ADMIN", clubId: club.id });
    await db().userClubProfile.create({
      data: {
        clubId: club.id, userId: chris.id,
        positionId: controller.id,
      },
    });
    const bundle = await listManagerOptions(club.id, { positionId: clubhouseMgr.id });
    expect(bundle.recommended).not.toBeNull();
    expect(bundle.recommended?.kind).toBe("profile");
    expect(bundle.recommended?.displayName).toBe(chris.name);
    expect(bundle.recommended?.positionName).toBe("Controller / CFO");
  });

  it("explicit person-level manager override wins over position-hierarchy resolution", async () => {
    const club = await seedClubWithDepts("Override");
    await provisionDefaultOrganization(club.id);
    const controller = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CONTROLLER" },
    });
    const clubhouseMgr = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CLUBHOUSE_MANAGER" },
    });
    await setPositionReportsTo(club.id, clubhouseMgr.id, controller.id);

    // Two org Users occupy Controller — ambiguous by hierarchy.
    const chris = await makeUser({ email: "chris.o@t.test", role: "CLUB_ADMIN", clubId: club.id });
    const alex = await makeUser({ email: "alex.o@t.test", role: "CLUB_ADMIN", clubId: club.id });
    const chrisProfile = await db().userClubProfile.create({
      data: { clubId: club.id, userId: chris.id, positionId: controller.id },
    });
    await db().userClubProfile.create({
      data: { clubId: club.id, userId: alex.id, positionId: controller.id },
    });

    // An employee with an explicit override to chrisProfile.
    const emp = await db().employee.create({
      data: {
        clubId: club.id, employeeNumber: "E-001",
        firstName: "Sam", lastName: "Employee",
        orgPositionId: clubhouseMgr.id,
        managerProfileId: chrisProfile.id,
      },
    });
    const r = await resolveEmployeeManager(emp.id);
    expect(r.reason).toBe("override");
    expect(r.manager?.kind).toBe("profile");
    expect(r.manager?.id).toBe(chrisProfile.id);
  });

  it("ambiguity: multiple occupants of parent Position → resolver returns null with candidates", async () => {
    const club = await seedClubWithDepts("Ambig");
    await provisionDefaultOrganization(club.id);
    const controller = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CONTROLLER" },
    });
    const clubhouseMgr = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CLUBHOUSE_MANAGER" },
    });
    await setPositionReportsTo(club.id, clubhouseMgr.id, controller.id);

    const chris = await makeUser({ email: "chris.a@t.test", role: "CLUB_ADMIN", clubId: club.id });
    const alex = await makeUser({ email: "alex.a@t.test", role: "CLUB_ADMIN", clubId: club.id });
    await db().userClubProfile.create({
      data: { clubId: club.id, userId: chris.id, positionId: controller.id },
    });
    await db().userClubProfile.create({
      data: { clubId: club.id, userId: alex.id, positionId: controller.id },
    });

    const emp = await db().employee.create({
      data: {
        clubId: club.id, employeeNumber: "E-002",
        firstName: "Bee", lastName: "Employee",
        orgPositionId: clubhouseMgr.id,
      },
    });
    const r = await resolveEmployeeManager(emp.id);
    expect(r.reason).toBe("ambiguous");
    expect(r.manager).toBeNull();
    expect(r.candidates?.length).toBe(2);
  });
});

describe("Organizational Foundation · Position ≠ SecurityRole", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("assigning the Controller Position does NOT grant payroll:approve or payroll:post", async () => {
    const club = await seedClubWithDepts("Sec");
    await provisionDefaultOrganization(club.id);
    const controllerPos = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CONTROLLER" },
    });
    // A STAFF-role user (no CONTROLLER SecurityRole).
    const staffUser = await makeUser({ email: "staff.sec@t.test", role: "STAFF", clubId: club.id });
    await db().userClubProfile.create({
      data: {
        clubId: club.id, userId: staffUser.id,
        positionId: controllerPos.id,
        displayTitle: "Controller",
      },
    });
    const p = await principalFor("staff.sec@t.test");
    expect(hasPermission(p, club.id, "payroll:approve")).toBe(false);
    expect(hasPermission(p, club.id, "payroll:post")).toBe(false);
    expect(hasPermission(p, club.id, "payroll:return")).toBe(false);
  });

  it("adding the CONTROLLER SecurityRole DOES grant payroll:approve + payroll:post", async () => {
    const club = await seedClubWithDepts("SecOn");
    await provisionDefaultOrganization(club.id);
    const controllerPos = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CONTROLLER" },
    });
    const staffUser = await makeUser({ email: "sec.on@t.test", role: "STAFF", clubId: club.id });
    await db().userClubProfile.create({
      data: {
        clubId: club.id, userId: staffUser.id,
        positionId: controllerPos.id,
      },
    });
    // Add the SecurityRole separately (Position was already there).
    await db().userClubRole.create({
      data: { userId: staffUser.id, clubId: club.id, roleKey: "CONTROLLER" },
    });
    const p = await principalFor("sec.on@t.test");
    expect(hasPermission(p, club.id, "payroll:approve")).toBe(true);
    expect(hasPermission(p, club.id, "payroll:post")).toBe(true);
  });
});
