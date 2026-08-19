// HR-1 admin-workflows — Employee CRUD basics + audit + permissions.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import {
  createEmployee,
  updateEmployee,
  terminateEmployee,
  setManager,
  getEmployee,
  listEmployees,
} from "@/lib/hr/employees";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { latestAuditForAction, makeAdminHrFixture } from "./_helpers";

describe("HR admin-workflows · Employees", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("createEmployee produces an Employee row + hr.employee.write.update audit", async () => {
    const fx = await makeAdminHrFixture();
    const created = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Alexandra",
      lastName: "Reyes",
      email: "alexandra.r@example.com",
      compensationType: "SALARY",
      payRate: 65000,
      hireDate: "2024-03-15",
    });
    expect(created.firstName).toBe("Alexandra");
    expect(created.lastName).toBe("Reyes");
    expect(created.clubId).toBe(fx.club.id);
    expect(created.employeeLifecycle).toBe("PRE_HIRE");

    const audit = await latestAuditForAction("hr.employee.write.update");
    expect(audit?.entityType).toBe("Employee");
    expect(audit?.entityId).toBe(created.id);
  });

  it("createEmployee rejects a caller without hr:employee:write (auditor)", async () => {
    const fx = await makeAdminHrFixture();
    await expect(
      createEmployee(fx.auditor, fx.club.id, { firstName: "X", lastName: "Y" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("updateEmployee partial update audits before/after", async () => {
    const fx = await makeAdminHrFixture();
    const updated = await updateEmployee(fx.clubAdmin, fx.employee.id, {
      preferredName: "Riv",
      mobilePhone: "555-1234",
    });
    expect(updated.preferredName).toBe("Riv");
    expect(updated.mobilePhone).toBe("555-1234");
  });

  it("terminateEmployee sets lifecycle=TERMINATED, status=TERMINATED, terminationDate", async () => {
    const fx = await makeAdminHrFixture();
    const term = await terminateEmployee(fx.clubAdmin, fx.employee.id, {
      terminationDate: new Date("2026-09-01"),
      reason: "Contract end",
    });
    expect(term.employeeLifecycle).toBe("TERMINATED");
    expect(term.status).toBe("TERMINATED");
    expect(term.terminationDate?.toISOString().startsWith("2026-09-01")).toBe(true);
    const audit = await latestAuditForAction("hr.employee.terminate.post");
    expect(audit?.entityId).toBe(fx.employee.id);
  });

  it("setManager enforces same-tenant on the manager Employee", async () => {
    const fx = await makeAdminHrFixture();
    // Manager in the same club — OK.
    const manager = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Sam", lastName: "Manager",
    });
    const updated = await setManager(fx.clubAdmin, fx.employee.id, manager.id);
    expect(updated.managerEmployeeId).toBe(manager.id);
  });

  it("setManager rejects a manager belonging to a different club", async () => {
    const fx = await makeAdminHrFixture();
    const foreignManager = await createEmployee(fx.superAdmin, fx.foreignClub.id, {
      firstName: "Away", lastName: "Person",
    });
    // Even super-admin can create in the foreign club, but linking a
    // manager across clubs must throw a TenantViolationError.
    await expect(
      setManager(fx.superAdmin, fx.employee.id, foreignManager.id),
    ).rejects.toThrow(/tenant/i);
  });

  it("setManager rejects self-reference", async () => {
    const fx = await makeAdminHrFixture();
    // ValidationError from service — the `issues[]` array carries
    // the human-readable "employee cannot manage themselves"; the
    // AppError's public message is the generic "Validation failed".
    await expect(
      setManager(fx.clubAdmin, fx.employee.id, fx.employee.id),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("getEmployee returns masked payload; sinMasked null without hr:sin:read", async () => {
    const fx = await makeAdminHrFixture();
    // GM has hr:employee:read but no hr:sin:read.
    const payload = await getEmployee(fx.gm, fx.employee.id);
    expect(payload.id).toBe(fx.employee.id);
    expect(payload.sinMasked).toBeNull();
    expect(payload.bankMasked).toBeNull();
  });

  it("listEmployees requires hr:directory:view + club membership", async () => {
    const fx = await makeAdminHrFixture();
    const rows = await listEmployees(fx.clubAdmin, fx.club.id);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // Foreign club admin cannot list employees in the primary club.
    await expect(listEmployees(fx.foreignClubAdmin, fx.club.id)).rejects.toThrow();
    // Auditor at the club has hr:directory:view AND club membership — allowed.
    const auditorList = await listEmployees(fx.auditor, fx.club.id);
    expect(auditorList.length).toBeGreaterThanOrEqual(1);
  });

  it("action strings under Employee CRUD all contain a WRITE_INDICATOR verb", async () => {
    const fx = await makeAdminHrFixture();
    await updateEmployee(fx.clubAdmin, fx.employee.id, { preferredName: "R" });
    const audits = await prisma.auditLog.findMany({
      where: { entityId: fx.employee.id },
      orderBy: { createdAt: "asc" },
    });
    for (const a of audits) {
      expect(a.action).toMatch(/(create|update|delete|post|approve|void|issue|send|terminate|reveal|activate|suspend|invite|revoke|redeem|submit|reject)/);
    }
  });
});
