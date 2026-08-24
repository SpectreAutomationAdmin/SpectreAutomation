// HR-2C Employment Corrections (2026-08-24) — Founder correction slice.
//
// Pins §17 and §21:
//   - Backfill is idempotent AND actually fills in.
//   - Legacy employee viewed through updateEmployee gets provisioned
//     just-in-time.
//   - Overview derives from canonical PRIMARY when it exists.
//   - New employees always end up with a canonical PRIMARY from day one.
//   - Cross-Club position creation refused.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  provisionInitialAssignmentIfMissing,
  listAssignments,
  getActiveAssignmentsAt,
} from "@/lib/hr/employment-assignments";
import { createEmployee, updateEmployee } from "@/lib/hr/employees";
import { createEmployeePosition } from "@/lib/hr/employee-positions";
import { ValidationError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";

describe("HR-2C Employment Corrections · backfill + provisioning + Overview parity", () => {
  let fx: AdminHrFixture;

  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HR2CCorr");
  });

  it("legacy employee with populated dept+position+type but zero assignments → backfill provisions a PRIMARY", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "ADMIN", name: "Administration", sortOrder: 1 },
    });
    const pos = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "CLBHSE_MGR", name: "Clubhouse Manager", departmentId: dept.id },
    });
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.club.id,
        employeeNumber: "E-00001",
        firstName: "Chris", lastName: "Turcato",
        personalEmail: `chris-${Date.now()}@x.test`,
        departmentId: dept.id,
        positionId: pos.id,
        employmentType: "FULL_TIME",
        hireDate: new Date("2026-01-15"),
      },
    });
    expect(await listAssignments(fx.clubAdmin, emp.id)).toHaveLength(0);

    const result = await provisionInitialAssignmentIfMissing(fx.club.id, emp.id);
    expect(result.provisioned).toBe(true);
    expect(result.reason).toBe("provisioned");

    const assignments = await listAssignments(fx.clubAdmin, emp.id);
    expect(assignments).toHaveLength(1);
    const primary = assignments[0]!;
    expect(primary.role).toBe("PRIMARY");
    expect(primary.departmentId).toBe(dept.id);
    expect(primary.positionId).toBe(pos.id);
    expect(primary.employmentType).toBe("FULL_TIME");
    expect(primary.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-01-15");
    expect(primary.isCurrent).toBe(true);
  });

  it("backfill is idempotent — second call is a no-op", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "ADMIN", name: "Administration", sortOrder: 1 },
    });
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: "E-01",
        firstName: "A", lastName: "B",
        personalEmail: `a-${Date.now()}@x.test`,
        departmentId: dept.id, employmentType: "FULL_TIME",
      },
    });
    const first = await provisionInitialAssignmentIfMissing(fx.club.id, emp.id);
    expect(first.provisioned).toBe(true);
    const second = await provisionInitialAssignmentIfMissing(fx.club.id, emp.id);
    expect(second.provisioned).toBe(false);
    expect(second.reason).toBe("already_has_assignment");
    const rows = await listAssignments(fx.clubAdmin, emp.id);
    expect(rows).toHaveLength(1);
  });

  it("employee with no legacy dept/position/type at all → skipped (no fabrication)", async () => {
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: "E-02",
        firstName: "A", lastName: "B",
        personalEmail: `a-${Date.now()}@x.test`,
      },
    });
    const result = await provisionInitialAssignmentIfMissing(fx.club.id, emp.id);
    expect(result.provisioned).toBe(false);
    expect(result.reason).toBe("no_legacy_data");
    expect(await listAssignments(fx.clubAdmin, emp.id)).toHaveLength(0);
  });

  it("cross-Club provisioning refused (wrong clubId → no rows created)", async () => {
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.foreignClub.id, employeeNumber: "F-01",
        firstName: "F", lastName: "E",
        personalEmail: `f-${Date.now()}@x.test`,
        employmentType: "FULL_TIME",
      },
    });
    // Attempt to provision using the WRONG clubId.
    const result = await provisionInitialAssignmentIfMissing(fx.club.id, emp.id);
    expect(result.provisioned).toBe(false);
    // No rows created anywhere.
    const anywhere = await prisma.employeeEmploymentAssignment.findMany({
      where: { employeeId: emp.id },
    });
    expect(anywhere).toHaveLength(0);
  });

  it("createEmployee routes through provisioning — new employee has PRIMARY from day one", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "GOLF", name: "Golf", sortOrder: 1 },
    });
    const pos = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "STARTER", name: "Starter", departmentId: dept.id },
    });
    const created = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "New", lastName: "Hire",
      personalEmail: `new-${Date.now()}@x.test`,
      departmentId: dept.id, positionId: pos.id,
      employmentType: "PART_TIME",
    });
    const rows = await listAssignments(fx.clubAdmin, created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("PRIMARY");
    expect(rows[0]!.departmentId).toBe(dept.id);
    expect(rows[0]!.positionId).toBe(pos.id);
    expect(rows[0]!.employmentType).toBe("PART_TIME");
  });

  it("updateEmployee just-in-time backfills a legacy employee before running the edit", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "ADMIN", name: "Administration", sortOrder: 1 },
    });
    const legacy = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: "LEG-01",
        firstName: "L", lastName: "E",
        personalEmail: `l-${Date.now()}@x.test`,
        departmentId: dept.id, employmentType: "FULL_TIME",
      },
    });
    expect(await listAssignments(fx.clubAdmin, legacy.id)).toHaveLength(0);
    // Edit any field — provisioning fires before the mutation.
    await updateEmployee(fx.clubAdmin, legacy.id, { mobilePhone: "555-0100" });
    const rows = await listAssignments(fx.clubAdmin, legacy.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("PRIMARY");
  });

  it("Overview canonical parity — after backfill, PRIMARY assignment reports the same Position/Department the legacy fields carried", async () => {
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
        departmentId: dept.id,
        positionId: pos.id,
        employmentType: "FULL_TIME",
      },
    });
    await provisionInitialAssignmentIfMissing(fx.club.id, emp.id);
    const active = await getActiveAssignmentsAt(emp.id);
    expect(active).toHaveLength(1);
    const primary = active[0]!;
    // Canonical read matches legacy for backwards compatibility.
    expect(primary.departmentId).toBe(dept.id);
    expect(primary.positionId).toBe(pos.id);
    expect(primary.employmentType).toBe("FULL_TIME");
  });

  it("createEmployeePosition refuses a cross-Club department", async () => {
    const foreignDept = await prisma.department.create({
      data: { clubId: fx.foreignClub.id, code: "FGN", name: "Foreign", sortOrder: 1 },
    });
    await expect(
      createEmployeePosition(fx.clubAdmin, fx.club.id, {
        name: "New Position", departmentId: foreignDept.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("inline position creation followed by an assignment referencing it works end-to-end", async () => {
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "FB", name: "Food & Beverage", sortOrder: 1 },
    });
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: "E-11",
        firstName: "T", lastName: "E",
        personalEmail: `t-${Date.now()}@x.test`,
      },
    });
    // Admin creates a Position inline in the F&B department.
    const created = await createEmployeePosition(fx.clubAdmin, fx.club.id, {
      name: "Sommelier", departmentId: dept.id,
    });
    expect(created.id).toBeTruthy();
    expect(created.departmentId).toBe(dept.id);
    // The new position is immediately usable in an assignment.
    const { addAssignment } = await import("@/lib/hr/employment-assignments");
    const asg = await addAssignment(fx.clubAdmin, emp.id, {
      role: "ADDITIONAL", departmentId: dept.id, positionId: created.id,
      employmentType: "PART_TIME", effectiveFrom: "2026-10-01",
    });
    expect(asg.id).toBeTruthy();
    const rows = await listAssignments(fx.clubAdmin, emp.id);
    expect(rows.some((r) => r.positionId === created.id)).toBe(true);
  });
});
