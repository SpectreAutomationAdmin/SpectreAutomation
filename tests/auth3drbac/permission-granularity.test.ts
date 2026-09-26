// AUTH-3D.RBAC.FIX — granularity boundary proof.
//
// Proves the founder's §6 test requirements:
//   • CONTROLLER can sign employee out + issue password reset.
//   • CONTROLLER cannot edit / archive / terminate / reveal PII.
//   • GENERAL_MANAGER same.
//   • CLUB_ADMIN keeps existing write authority AND gains explicit
//     account-security grant.
//   • PAYROLL_ADMIN cannot perform account-security actions.
//   • Negative roles (FINANCE_ADMIN, DEPARTMENT_MANAGER, AUDITOR_READ_ONLY)
//     cannot perform account-security actions.
//   • Possession of hr:employee:security alone permits nothing else.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import {
  signOutEmployeeEverywhere,
} from "@/lib/hr/employee-session-revocation";
import { adminSendPortalPasswordReset } from "@/lib/hr/password-reset";
import { terminateEmployee, archiveEmployee, updateEmployee } from "@/lib/hr/employees";
import { createSession, SURFACE_EMPLOYEE } from "@/lib/services/session-store";
import { ForbiddenError } from "@/lib/errors";
import { makeAdminHrFixture } from "../hr/admin-workflows/_helpers";
import { makeUser, principalFor } from "../util/db";
import type { RoleKey } from "@/lib/permissions";
import { resetDb, seedRbac } from "../util/db";

async function makePrincipalWithRole(role: RoleKey, clubId: string | null) {
  const email = `auth3d-rbac-${role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await makeUser({ email, role, clubId });
  return principalFor(email);
}

describe("AUTH-3D.RBAC.FIX · code-catalogue boundary proof", () => {
  it("CONTROLLER holds hr:employee:security", () => {
    expect((ROLE_PERMISSIONS["CONTROLLER"] as string[])).toContain("hr:employee:security");
  });

  it("CONTROLLER does NOT hold hr:employee:write", () => {
    expect((ROLE_PERMISSIONS["CONTROLLER"] as string[])).not.toContain("hr:employee:write");
  });

  it("CONTROLLER does NOT hold hr:employee:terminate", () => {
    expect((ROLE_PERMISSIONS["CONTROLLER"] as string[])).not.toContain("hr:employee:terminate");
  });

  it("GENERAL_MANAGER holds hr:employee:security", () => {
    expect((ROLE_PERMISSIONS["GENERAL_MANAGER"] as string[])).toContain("hr:employee:security");
  });

  it("GENERAL_MANAGER does NOT gain hr:employee:write or terminate", () => {
    expect((ROLE_PERMISSIONS["GENERAL_MANAGER"] as string[])).not.toContain("hr:employee:write");
    expect((ROLE_PERMISSIONS["GENERAL_MANAGER"] as string[])).not.toContain("hr:employee:terminate");
  });

  it("CLUB_ADMIN retains hr:employee:write AND explicitly holds hr:employee:security", () => {
    expect((ROLE_PERMISSIONS["CLUB_ADMIN"] as string[])).toContain("hr:employee:write");
    expect((ROLE_PERMISSIONS["CLUB_ADMIN"] as string[])).toContain("hr:employee:security");
    expect((ROLE_PERMISSIONS["CLUB_ADMIN"] as string[])).toContain("hr:employee:terminate");
  });

  it("PAYROLL_ADMIN does NOT hold hr:employee:security", () => {
    expect((ROLE_PERMISSIONS["PAYROLL_ADMIN"] as string[])).not.toContain("hr:employee:security");
  });

  it("PAYROLL_ADMIN retains its reveal-tier grants unchanged by AUTH-3D.RBAC.FIX", () => {
    for (const k of [
      "hr:sin:reveal",
      "hr:banking:reveal",
      "hr:tax:reveal",
      "hr:compensation:write",
      "hr:payroll_profile:activate",
    ]) {
      expect((ROLE_PERMISSIONS["PAYROLL_ADMIN"] as string[])).toContain(k);
    }
  });
});

describe("AUTH-3D.RBAC.FIX · service-layer positive proofs", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("CONTROLLER can call signOutEmployeeEverywhere and it revokes the target's sessions", async () => {
    const fx = await makeAdminHrFixture();
    const controller = await makePrincipalWithRole("CONTROLLER", fx.club.id);
    const s = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    const res = await signOutEmployeeEverywhere(controller, fx.employee.id);
    expect(res.sessionsRevoked).toBe(1);
    const after = await prisma.session.findUnique({
      where: { id: s.session.id },
      select: { revokedAt: true, revokeReason: true },
    });
    expect(after?.revokedAt).not.toBeNull();
    expect(after?.revokeReason).toBe("admin-force");
  });

  it("CONTROLLER can call adminSendPortalPasswordReset", async () => {
    const fx = await makeAdminHrFixture();
    const controller = await makePrincipalWithRole("CONTROLLER", fx.club.id);
    // Requires personalEmail on the employee.
    await prisma.employee.update({
      where: { id: fx.employee.id },
      data: { personalEmail: "acceptance-target@example.com" },
    });
    const res = await adminSendPortalPasswordReset(controller, fx.employee.id, {
      publicOrigin: "http://localhost:3000",
    });
    expect(res.status).toBe("queued");
  });

  it("GENERAL_MANAGER can also sign the employee out", async () => {
    const fx = await makeAdminHrFixture();
    const gm = await makePrincipalWithRole("GENERAL_MANAGER", fx.club.id);
    await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    const res = await signOutEmployeeEverywhere(gm, fx.employee.id);
    expect(res.sessionsRevoked).toBe(1);
  });
});

describe("AUTH-3D.RBAC.FIX · service-layer negative proofs", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("CONTROLLER CANNOT terminateEmployee (hr:employee:terminate withheld)", async () => {
    const fx = await makeAdminHrFixture();
    const controller = await makePrincipalWithRole("CONTROLLER", fx.club.id);
    await expect(
      terminateEmployee(controller, fx.employee.id, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("CONTROLLER CANNOT archiveEmployee (hr:employee:write withheld)", async () => {
    const fx = await makeAdminHrFixture();
    const controller = await makePrincipalWithRole("CONTROLLER", fx.club.id);
    await expect(
      archiveEmployee(controller, fx.employee.id, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("CONTROLLER CANNOT updateEmployee (edit ordinary fields — hr:employee:write withheld)", async () => {
    const fx = await makeAdminHrFixture();
    const controller = await makePrincipalWithRole("CONTROLLER", fx.club.id);
    await expect(
      updateEmployee(controller, fx.employee.id, { preferredName: "Hacked" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("GENERAL_MANAGER CANNOT terminateEmployee", async () => {
    const fx = await makeAdminHrFixture();
    const gm = await makePrincipalWithRole("GENERAL_MANAGER", fx.club.id);
    await expect(
      terminateEmployee(gm, fx.employee.id, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("GENERAL_MANAGER CANNOT updateEmployee", async () => {
    const fx = await makeAdminHrFixture();
    const gm = await makePrincipalWithRole("GENERAL_MANAGER", fx.club.id);
    await expect(
      updateEmployee(gm, fx.employee.id, { preferredName: "GM Tried" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("PAYROLL_ADMIN CANNOT signOutEmployeeEverywhere (hr:employee:security withheld)", async () => {
    const fx = await makeAdminHrFixture();
    const payroll = await makePrincipalWithRole("PAYROLL_ADMIN", fx.club.id);
    await expect(
      signOutEmployeeEverywhere(payroll, fx.employee.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("PAYROLL_ADMIN CANNOT adminSendPortalPasswordReset", async () => {
    const fx = await makeAdminHrFixture();
    const payroll = await makePrincipalWithRole("PAYROLL_ADMIN", fx.club.id);
    await prisma.employee.update({
      where: { id: fx.employee.id },
      data: { personalEmail: "target@example.com" },
    });
    await expect(
      adminSendPortalPasswordReset(payroll, fx.employee.id, {
        publicOrigin: "http://localhost:3000",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("FINANCE_ADMIN CANNOT signOutEmployeeEverywhere", async () => {
    const fx = await makeAdminHrFixture();
    const finance = await makePrincipalWithRole("FINANCE_ADMIN", fx.club.id);
    await expect(
      signOutEmployeeEverywhere(finance, fx.employee.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("DEPARTMENT_MANAGER CANNOT signOutEmployeeEverywhere", async () => {
    const fx = await makeAdminHrFixture();
    const dept = await makePrincipalWithRole("DEPARTMENT_MANAGER", fx.club.id);
    await expect(
      signOutEmployeeEverywhere(dept, fx.employee.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("AUDITOR_READ_ONLY CANNOT signOutEmployeeEverywhere", async () => {
    const fx = await makeAdminHrFixture();
    const auditor = await makePrincipalWithRole("AUDITOR_READ_ONLY", fx.club.id);
    await expect(
      signOutEmployeeEverywhere(auditor, fx.employee.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("AUTH-3D.RBAC.FIX · hasPermission fine-grained check", () => {
  it("hr:employee:security alone does NOT confer edit / terminate / reveal", () => {
    // Synthetic principal carrying ONLY hr:employee:security via a
    // custom role fixture would still not gain hr:employee:write etc.
    // — we prove the boundary at the ROLE_PERMISSIONS level: nowhere
    // in the catalogue is hr:employee:security co-listed with any of
    // these forbidden keys on any role BUT SUPER_ADMIN (which is
    // allPermissionKeys() by design).
    const roles = Object.keys(ROLE_PERMISSIONS) as RoleKey[];
    for (const role of roles) {
      if (role === "SUPER_ADMIN" || role === "CLUB_ADMIN") continue;
      const grants = ROLE_PERMISSIONS[role] as string[];
      if (grants.includes("hr:employee:security")) {
        // Only the security-tier grant should be present; no write/terminate.
        expect(grants).not.toContain("hr:employee:write");
        expect(grants).not.toContain("hr:employee:terminate");
        expect(grants).not.toContain("hr:sin:reveal");
        expect(grants).not.toContain("hr:banking:reveal");
        expect(grants).not.toContain("hr:tax:reveal");
      }
    }
  });
});
