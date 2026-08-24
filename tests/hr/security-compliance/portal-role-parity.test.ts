// HR-2C Portal Parity (2026-08-24) — Founder-surfaced regression.
//
// Admin changes an employee's Primary Role from Clubhouse Manager to
// Controller. The Employee Portal hero was still showing Clubhouse
// Manager because it read the legacy `Employee.position` join, which
// the assignment write path deliberately never updates.
//
// This suite pins the canonical resolver `getCurrentPrimaryRoleDisplay`
// so the following is guaranteed forever:
//   * changing the primary assignment IMMEDIATELY changes what any
//     surface reading through the resolver displays — no session
//     refresh, no cache invalidation, no logout;
//   * historical assignments never leak into "current";
//   * future-dated assignments do not surface early;
//   * Department changes propagate identically.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  addAssignment,
  getCurrentPrimaryRoleDisplay,
  provisionInitialAssignmentIfMissing,
} from "@/lib/hr/employment-assignments";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";

describe("HR-2C Portal Parity · getCurrentPrimaryRoleDisplay", () => {
  let fx: AdminHrFixture;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HR2CPortalParity");
  }, 60_000);

  it("no PRIMARY assignment → returns nulls (no legacy fallback in the resolver itself)", async () => {
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: "E-01",
        firstName: "A", lastName: "B",
        personalEmail: `a-${Date.now()}@x.test`,
        departmentId: null, positionId: null,
      },
    });
    const view = await getCurrentPrimaryRoleDisplay(emp.id);
    expect(view.positionName).toBeNull();
    expect(view.departmentName).toBeNull();
    expect(view.employmentType).toBeNull();
    expect(view.assignmentId).toBeNull();
  });

  it("legacy employee with populated legacy fields (no assignment) → resolver returns null; provisioning fills it", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "ADMIN", name: "Administration", sortOrder: 1 },
    });
    const pos = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "CLBHSE_MGR", name: "Clubhouse Manager", departmentId: dept.id },
    });
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: "E-Chris",
        firstName: "Chris", lastName: "Turcato",
        personalEmail: `chris-${Date.now()}@x.test`,
        departmentId: dept.id, positionId: pos.id,
        employmentType: "FULL_TIME", hireDate: new Date("2026-01-01"),
      },
    });
    // Before provisioning — resolver returns nulls (no fallback).
    let view = await getCurrentPrimaryRoleDisplay(emp.id);
    expect(view.positionName).toBeNull();
    // After provisioning — resolver reflects the canonical assignment.
    await provisionInitialAssignmentIfMissing(fx.club.id, emp.id);
    view = await getCurrentPrimaryRoleDisplay(emp.id);
    expect(view.positionName).toBe("Clubhouse Manager");
    expect(view.departmentName).toBe("Administration");
    expect(view.employmentType).toBe("FULL_TIME");
    expect(view.assignmentId).not.toBeNull();
  });

  it("Primary role change (Clubhouse Manager → Controller) — resolver returns Controller IMMEDIATELY", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "ADMIN", name: "Administration", sortOrder: 1 },
    });
    const clubhouseMgr = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "CLBHSE_MGR", name: "Clubhouse Manager", departmentId: dept.id },
    });
    const controller = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "CTRL", name: "Controller", departmentId: dept.id },
    });
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: "E-Chris",
        firstName: "Chris", lastName: "Turcato",
        personalEmail: `chris-${Date.now()}@x.test`,
        // Legacy field still Clubhouse Manager — the point is that
        // portal reads must NOT come from here.
        departmentId: dept.id, positionId: clubhouseMgr.id,
        employmentType: "FULL_TIME",
      },
    });
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "PRIMARY", departmentId: dept.id, positionId: clubhouseMgr.id,
      employmentType: "FULL_TIME", effectiveFrom: "2026-01-01",
    });
    // Baseline — resolver returns the initial primary.
    let view = await getCurrentPrimaryRoleDisplay(emp.id);
    expect(view.positionName).toBe("Clubhouse Manager");

    // Admin changes primary role to Controller.
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "PRIMARY", departmentId: dept.id, positionId: controller.id,
      employmentType: "FULL_TIME", effectiveFrom: "2026-07-01",
    });
    // Resolver returns Controller immediately — no session refresh
    // required. Employee.positionId is deliberately still
    // clubhouseMgr.id, proving the resolver is not reading it.
    view = await getCurrentPrimaryRoleDisplay(emp.id);
    expect(view.positionName).toBe("Controller");
    const stillLegacy = await prisma.employee.findUnique({
      where: { id: emp.id }, select: { positionId: true },
    });
    expect(stillLegacy!.positionId).toBe(clubhouseMgr.id); // stale on purpose
  });

  it("Department change (Administration → Finance) propagates through the resolver", async () => {
    const admin = await prisma.department.create({
      data: { clubId: fx.club.id, code: "ADMIN", name: "Administration", sortOrder: 1 },
    });
    const finance = await prisma.department.create({
      data: { clubId: fx.club.id, code: "FINANCE", name: "Finance", sortOrder: 2 },
    });
    const controllerAdmin = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "CTRL_A", name: "Controller (Admin)", departmentId: admin.id },
    });
    const controllerFinance = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "CTRL_F", name: "Controller (Finance)", departmentId: finance.id },
    });
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: "E-01",
        firstName: "X", lastName: "Y",
        personalEmail: `x-${Date.now()}@x.test`,
        departmentId: admin.id, positionId: controllerAdmin.id, employmentType: "FULL_TIME",
      },
    });
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "PRIMARY", departmentId: admin.id, positionId: controllerAdmin.id,
      employmentType: "FULL_TIME", effectiveFrom: "2026-01-01",
    });
    expect((await getCurrentPrimaryRoleDisplay(emp.id)).departmentName).toBe("Administration");
    // Department change requires a Position that lives in the new
    // Department (canonical service enforces this — see
    // assertPositionInClub). Reassign to the Finance Controller role.
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "PRIMARY", departmentId: finance.id, positionId: controllerFinance.id,
      employmentType: "FULL_TIME", effectiveFrom: "2026-04-01",
    });
    expect((await getCurrentPrimaryRoleDisplay(emp.id)).departmentName).toBe("Finance");
  });

  it("future-dated assignment does not surface before its effectiveFrom (respects effective dates)", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "ADMIN", name: "Administration", sortOrder: 1 },
    });
    const controller = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "CTRL", name: "Controller", departmentId: dept.id },
    });
    const gm = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "GM", name: "General Manager", departmentId: dept.id },
    });
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: "E-01",
        firstName: "X", lastName: "Y",
        personalEmail: `x-${Date.now()}@x.test`,
      },
    });
    // Current: Controller effective Jan 2026.
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "PRIMARY", departmentId: dept.id, positionId: controller.id,
      employmentType: "FULL_TIME", effectiveFrom: "2026-01-01",
    });
    // Future: General Manager effective Jan 2027.
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "PRIMARY", departmentId: dept.id, positionId: gm.id,
      employmentType: "FULL_TIME", effectiveFrom: "2027-01-01",
    });
    // At Dec 31, 2026 the resolver returns Controller (the future GM
    // has not started yet even though it exists as a row).
    const dec2026 = await getCurrentPrimaryRoleDisplay(emp.id, new Date("2026-12-31T12:00:00Z"));
    expect(dec2026.positionName).toBe("Controller");
    // At Jan 2, 2027 the resolver returns General Manager.
    const jan2027 = await getCurrentPrimaryRoleDisplay(emp.id, new Date("2027-01-02T12:00:00Z"));
    expect(jan2027.positionName).toBe("General Manager");
  });

  it("ADDITIONAL assignments never surface as the primary hero subtitle", async () => {
    const admin = await prisma.department.create({
      data: { clubId: fx.club.id, code: "ADMIN", name: "Administration", sortOrder: 1 },
    });
    const fb = await prisma.department.create({
      data: { clubId: fx.club.id, code: "FB", name: "Food & Beverage", sortOrder: 2 },
    });
    const controller = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "CTRL", name: "Controller", departmentId: admin.id },
    });
    const bartender = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "BAR", name: "Bartender", departmentId: fb.id },
    });
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: "E-01",
        firstName: "X", lastName: "Y",
        personalEmail: `x-${Date.now()}@x.test`,
      },
    });
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "PRIMARY", departmentId: admin.id, positionId: controller.id,
      employmentType: "FULL_TIME", effectiveFrom: "2026-01-01",
    });
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "ADDITIONAL", departmentId: fb.id, positionId: bartender.id,
      employmentType: "PART_TIME", effectiveFrom: "2026-06-01",
    });
    // Hero must show Controller (PRIMARY), NOT Bartender.
    const view = await getCurrentPrimaryRoleDisplay(emp.id);
    expect(view.positionName).toBe("Controller");
    expect(view.departmentName).toBe("Administration");
  });

  it("Portal Home + Portal Profile source-contract: neither reads legacy Employee.position for display; both consume the canonical resolver / assignment list", () => {
    const home = require("node:fs").readFileSync(
      require("node:path").resolve(process.cwd(), "src/app/employee/(authed)/page.tsx"),
      "utf8",
    );
    const profile = require("node:fs").readFileSync(
      require("node:path").resolve(process.cwd(), "src/app/employee/(authed)/profile/page.tsx"),
      "utf8",
    );
    // Home imports and uses the canonical resolver for the hero.
    expect(home).toMatch(/getCurrentPrimaryRoleDisplay/);
    expect(home).toMatch(/positionName=\{primaryRole\.positionName\}/);
    // Home no longer joins Employee.position for the hero.
    const homeCode = home.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(homeCode).not.toMatch(/position:\s*\{\s*select:\s*\{\s*name:\s*true\s*\}/);
    expect(homeCode).not.toMatch(/employee\.position\?\./);
    // Portal Profile no longer joins Employee.position / Employee.department.
    const profCode = profile.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(profCode).not.toMatch(/position:\s*\{\s*select:\s*\{\s*name:\s*true\s*\}/);
    expect(profCode).not.toMatch(/employee\.position\?\./);
    // Portal Profile uses assignment-driven roles list.
    expect(profile).toMatch(/getActiveAssignmentsAt/);
  });

  it("Session/cookie carries no mutable employment metadata (identity + tenant only)", () => {
    const session = require("node:fs").readFileSync(
      require("node:path").resolve(process.cwd(), "src/lib/employee-portal-session.ts"),
      "utf8",
    );
    // Interface field list is the source of truth.
    for (const forbidden of ["positionId", "departmentId", "employmentType", "managerEmployeeId", "position", "department"]) {
      expect(session).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
    // Only identity + tenant fields are on the principal.
    expect(session).toMatch(/employeeId:\s*string/);
    expect(session).toMatch(/clubId:\s*string/);
  });
});
