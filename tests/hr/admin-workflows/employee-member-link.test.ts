// HR-1 admin-workflows — Employee <-> Member link/unlink with the
// same-tenant invariant that rejects EVEN FOR SUPER-ADMIN.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ConflictError, TenantViolationError } from "@/lib/errors";
import {
  createEmployee,
  linkEmployeeToMember,
  unlinkEmployeeFromMember,
} from "@/lib/hr/employees";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, makeMemberFor, latestAuditForAction } from "./_helpers";

describe("HR admin-workflows · Employee<->Member link", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("linkEmployeeToMember succeeds when Member.clubId == Employee.clubId", async () => {
    const fx = await makeAdminHrFixture();
    const member = await makeMemberFor(fx.club.id, { firstName: "Riv", lastName: "Sensitive" });
    const updated = await linkEmployeeToMember(fx.clubAdmin, fx.employee.id, member.id);
    expect(updated.memberId).toBe(member.id);
    const audit = await latestAuditForAction("hr.employee.member.update");
    expect(audit?.entityId).toBe(fx.employee.id);
  });

  it("linkEmployeeToMember REJECTS cross-club link EVEN FOR SUPER-ADMIN", async () => {
    const fx = await makeAdminHrFixture();
    const foreignMember = await makeMemberFor(fx.foreignClub.id, { firstName: "Away", lastName: "Person" });
    // The super-admin passes the RBAC check (they have every
    // permission) but the same-tenant invariant on the Employee/Member
    // pair still fires. Cross-club links are refused.
    await expect(
      linkEmployeeToMember(fx.superAdmin, fx.employee.id, foreignMember.id),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("linkEmployeeToMember refuses to overwrite an existing link unless replace=true", async () => {
    const fx = await makeAdminHrFixture();
    const m1 = await makeMemberFor(fx.club.id, { firstName: "A", lastName: "One" });
    const m2 = await makeMemberFor(fx.club.id, { firstName: "B", lastName: "Two" });
    await linkEmployeeToMember(fx.clubAdmin, fx.employee.id, m1.id);
    await expect(
      linkEmployeeToMember(fx.clubAdmin, fx.employee.id, m2.id),
    ).rejects.toBeInstanceOf(ConflictError);
    const replaced = await linkEmployeeToMember(fx.clubAdmin, fx.employee.id, m2.id, { replace: true });
    expect(replaced.memberId).toBe(m2.id);
  });

  it("linkEmployeeToMember refuses when the target Member is already linked to another Employee", async () => {
    const fx = await makeAdminHrFixture();
    const member = await makeMemberFor(fx.club.id);
    await linkEmployeeToMember(fx.clubAdmin, fx.employee.id, member.id);
    const otherEmployee = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Second", lastName: "Employee",
    });
    await expect(
      linkEmployeeToMember(fx.clubAdmin, otherEmployee.id, member.id),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("unlinkEmployeeFromMember clears memberId + audits", async () => {
    const fx = await makeAdminHrFixture();
    const member = await makeMemberFor(fx.club.id);
    await linkEmployeeToMember(fx.clubAdmin, fx.employee.id, member.id);
    const unlinked = await unlinkEmployeeFromMember(fx.clubAdmin, fx.employee.id);
    expect(unlinked.memberId).toBeNull();
    const audit = await latestAuditForAction("hr.employee.member.delete");
    expect(audit?.entityId).toBe(fx.employee.id);
  });

  it("Employee C fixture pattern — CHILD-OF-Member Employee has memberId === null", async () => {
    // Simulates Employee C (Carmen Sato): a family relationship
    // exists out-of-band with a Member, but the Employee row's
    // memberId MUST NOT be populated. This test locks the invariant
    // for the seed fixture too.
    const fx = await makeAdminHrFixture();
    // Create the parent Member.
    await makeMemberFor(fx.club.id, { firstName: "Yuki", lastName: "Sato" });
    // Create Employee C.
    const carmen = await createEmployee(fx.clubAdmin, fx.club.id, {
      firstName: "Carmen", lastName: "Sato", hireDate: "2025-06-01",
    });
    const row = await prisma.employee.findUnique({ where: { id: carmen.id } });
    expect(row?.memberId).toBeNull();
  });
});
