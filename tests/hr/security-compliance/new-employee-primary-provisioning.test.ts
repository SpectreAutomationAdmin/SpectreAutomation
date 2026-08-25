// HR mobile-hotfix (2026-08-30) — new-employee canonical PRIMARY
// role provisioning + portal display resolver fallback for
// pre-hire employees.
//
// Founder reported that a freshly-onboarded employee (Lise
// Montsion, Executive Chef) rendered "No role assigned yet" in
// the portal even though the admin form had a department +
// position selected. Root causes:
//   1. If any field was missing (e.g. positionId submitted blank),
//      `provisionInitialAssignmentIfMissing` silently returned
//      { provisioned: false, reason: "no_legacy_data" }.
//   2. If the PRIMARY assignment WAS created, its effectiveFrom
//      matched expectedStartDate (in the future). The portal
//      resolver `getCurrentPrimaryRoleDisplay` refused to return
//      it because effectiveFrom was > now.
//
// Fixes:
//   * `createEmployee` passes `{ alwaysCreate: true }` — PRIMARY
//     row lands even with sparse fields.
//   * `getCurrentPrimaryRoleDisplay` falls back to the SOONEST
//     UPCOMING PRIMARY for display purposes (payroll continues
//     to use its own effective-at-pay-period reader).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createEmployee } from "@/lib/hr/employees";
import {
  provisionInitialAssignmentIfMissing,
  getCurrentPrimaryRoleDisplay,
} from "@/lib/hr/employment-assignments";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";

describe("HR mobile-hotfix · new-employee canonical PRIMARY provisioning", () => {
  let fx: AdminHrFixture;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HRMHFProv");
  }, 60_000);

  it("createEmployee always provisions a PRIMARY assignment (even with sparse fields)", async () => {
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Lise", lastName: "Provisioning-Test",
      // Intentionally sparse: no department, no position, no employmentType.
      employeeLifecycle: "PRE_HIRE",
      expectedStartDate: new Date("2027-01-15"),
    });
    const primary = await prisma.employeeEmploymentAssignment.findFirst({
      where: { employeeId: emp.id, role: "PRIMARY" },
    });
    expect(primary, "PRIMARY must exist after createEmployee even with sparse fields").not.toBeNull();
    // Sensible defaults when fields are absent.
    expect(primary!.employmentType).toBe("FULL_TIME");
    expect(primary!.effectiveFrom.toISOString().slice(0, 10)).toBe("2027-01-15");
  });

  it("createEmployee with department + position provisions a PRIMARY carrying those references", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "FNB-CULINARY", name: "Culinary" },
    });
    const pos = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "EXEC-CHEF", name: "Executive Chef", departmentId: dept.id },
    });
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Lise", lastName: "Montsion-Test",
      departmentId: dept.id, positionId: pos.id, employmentType: "FULL_TIME",
      expectedStartDate: new Date("2027-01-15"),
    });
    const primary = await prisma.employeeEmploymentAssignment.findFirst({
      where: { employeeId: emp.id, role: "PRIMARY" },
    });
    expect(primary).not.toBeNull();
    expect(primary!.departmentId).toBe(dept.id);
    expect(primary!.positionId).toBe(pos.id);
  });

  it("provisionInitialAssignmentIfMissing({alwaysCreate:true}) creates a PRIMARY when legacy fields are all null", async () => {
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: `SPARSE-${Date.now().toString().slice(-6)}`,
        firstName: "Sparse", lastName: "Employee",
        employeeLifecycle: "PRE_HIRE",
        // No department, position, employmentType.
      },
    });
    // Default behaviour (alwaysCreate omitted) → no_legacy_data.
    const dryResult = await provisionInitialAssignmentIfMissing(fx.club.id, emp.id);
    expect(dryResult.provisioned).toBe(false);
    expect(dryResult.reason).toBe("no_legacy_data");
    // alwaysCreate:true → provisions with defaults.
    const eagerResult = await provisionInitialAssignmentIfMissing(
      fx.club.id, emp.id, null, { alwaysCreate: true },
    );
    expect(eagerResult.provisioned).toBe(true);
    expect(eagerResult.reason).toBe("provisioned");
    const primary = await prisma.employeeEmploymentAssignment.findFirst({
      where: { employeeId: emp.id, role: "PRIMARY" },
    });
    expect(primary).not.toBeNull();
    expect(primary!.employmentType).toBe("FULL_TIME");
  });

  it("provisionInitialAssignmentIfMissing is idempotent — second call is a no-op", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "IDEMPO", name: "Test" },
    });
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Idempo", lastName: "Test", departmentId: dept.id, employmentType: "FULL_TIME",
    });
    const second = await provisionInitialAssignmentIfMissing(
      fx.club.id, emp.id, null, { alwaysCreate: true },
    );
    expect(second.provisioned).toBe(false);
    expect(second.reason).toBe("already_has_assignment");
    const count = await prisma.employeeEmploymentAssignment.count({
      where: { employeeId: emp.id, role: "PRIMARY" },
    });
    expect(count).toBe(1);
  });

  it("§29 — Portal display resolver returns the SOONEST UPCOMING PRIMARY when none is currently effective", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "FNB", name: "Food & Beverage" },
    });
    const pos = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "EXEC-CHEF-2", name: "Executive Chef", departmentId: dept.id },
    });
    // Employee with expectedStartDate 30 days in the future.
    const start = new Date();
    start.setDate(start.getDate() + 30);
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Lise", lastName: "Future-Start",
      departmentId: dept.id, positionId: pos.id, employmentType: "FULL_TIME",
      expectedStartDate: start,
    });
    // Assignment.effectiveFrom is the expected start (30 days out).
    const primary = await prisma.employeeEmploymentAssignment.findFirst({
      where: { employeeId: emp.id, role: "PRIMARY" },
    });
    expect(primary!.effectiveFrom.getTime()).toBeGreaterThan(Date.now());
    // Portal display resolver returns the UPCOMING PRIMARY.
    const display = await getCurrentPrimaryRoleDisplay(emp.id);
    expect(display.assignmentId).toBe(primary!.id);
    expect(display.positionName).toBe("Executive Chef");
    expect(display.departmentName).toBe("Food & Beverage");
  });

  it("§29 — Portal display resolver still returns the CURRENT PRIMARY when one is effective", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "ADM", name: "Administration" },
    });
    const pos = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "CTRL", name: "Controller", departmentId: dept.id },
    });
    // Employee hired 30 days ago — PRIMARY is currently effective.
    const hired = new Date();
    hired.setDate(hired.getDate() - 30);
    const emp = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Chris", lastName: "Current",
      departmentId: dept.id, positionId: pos.id, employmentType: "FULL_TIME",
      hireDate: hired,
    });
    const display = await getCurrentPrimaryRoleDisplay(emp.id);
    expect(display.positionName).toBe("Controller");
    expect(display.departmentName).toBe("Administration");
  });
});
