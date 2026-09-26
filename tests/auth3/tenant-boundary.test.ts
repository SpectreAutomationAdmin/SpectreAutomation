// AUTH-3B — Tenant-isolation hard gate for the new sign-out services.
//
// Property under test: an administrator of Tenant A cannot enumerate,
// mutate, or revoke Sessions of any identity that belongs exclusively
// to Tenant B. Every cross-tenant attempt must fail closed with a
// NotFoundError so the response body cannot be used to distinguish
// "unknown target" from "known target in a tenant the caller can't see".

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { signOutEmployeeEverywhere } from "@/lib/hr/employee-session-revocation";
import { signOutUserEverywhere } from "@/lib/tenant-admin/user-session-revocation";
import {
  createSession,
  SURFACE_ADMIN,
  SURFACE_EMPLOYEE,
} from "@/lib/services/session-store";
import { makeAdminHrFixture } from "../hr/admin-workflows/_helpers";
import { makeEmployee } from "../hr/security-compliance/_helpers";
import { NotFoundError, TenantViolationError } from "@/lib/errors";
import { resetDb, seedRbac } from "../util/db";

describe("AUTH-3B · Tenant-isolation hard gate", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Tenant A admin cannot revoke Tenant B employee — throws tenant-boundary error and revokes nothing", async () => {
    const fx = await makeAdminHrFixture();
    const foreignEmployee = await makeEmployee(fx.foreignClub.id, {
      firstName: "Foreign",
      lastName: "Employee",
    });
    const foreignSession = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: foreignEmployee.id,
      clubId: fx.foreignClub.id,
    });

    // clubAdmin belongs to fx.club (not foreignClub).
    // Should reject at assertTenantOwned with a tenant-boundary error.
    await expect(
      signOutEmployeeEverywhere(fx.clubAdmin, foreignEmployee.id),
    ).rejects.toBeInstanceOf(TenantViolationError);

    // Foreign session must be untouched.
    const stillActive = await prisma.session.findUnique({
      where: { id: foreignSession.session.id },
      select: { revokedAt: true },
    });
    expect(stillActive?.revokedAt).toBeNull();
  });

  it("Forged nonexistent employeeId fails closed with NotFoundError, does not enumerate", async () => {
    const fx = await makeAdminHrFixture();
    await expect(
      signOutEmployeeEverywhere(fx.clubAdmin, "cmxx-forged-employee-id"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Tenant A admin cannot sign out Tenant B admin user — same 404 shape as unknown user", async () => {
    const fx = await makeAdminHrFixture();
    // foreignClubAdmin is a User with UserClubRole ONLY at foreignClub.
    const foreignSession = await createSession({
      surface: SURFACE_ADMIN,
      userId: fx.foreignClubAdmin.id,
      clubId: fx.foreignClub.id,
    });

    // clubAdmin has settings:write only at fx.club → not at foreignClub.
    // signOutUserEverywhere loads target's clubRoles and checks
    // hasPermission at each shared tenant. clubAdmin shares no tenant
    // with foreignClubAdmin → NotFoundError (same shape as unknown user).
    await expect(
      signOutUserEverywhere(fx.clubAdmin, fx.foreignClubAdmin.id),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Foreign admin session must be untouched.
    const stillActive = await prisma.session.findUnique({
      where: { id: foreignSession.session.id },
      select: { revokedAt: true },
    });
    expect(stillActive?.revokedAt).toBeNull();
  });

  it("Forged nonexistent userId fails closed with NotFoundError", async () => {
    const fx = await makeAdminHrFixture();
    await expect(
      signOutUserEverywhere(fx.clubAdmin, "cmxx-forged-user-id"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("SUPER_ADMIN can sign out cross-tenant admin user (SUPER_ADMIN is the escape hatch)", async () => {
    const fx = await makeAdminHrFixture();
    const foreignSession = await createSession({
      surface: SURFACE_ADMIN,
      userId: fx.foreignClubAdmin.id,
      clubId: fx.foreignClub.id,
    });

    const res = await signOutUserEverywhere(fx.superAdmin, fx.foreignClubAdmin.id);
    expect(res.sessionsRevoked).toBe(1);

    const after = await prisma.session.findUnique({
      where: { id: foreignSession.session.id },
      select: { revokedAt: true },
    });
    expect(after?.revokedAt).not.toBeNull();
  });

  it("SUPER_ADMIN can sign out cross-tenant employee", async () => {
    const fx = await makeAdminHrFixture();
    const foreignEmployee = await makeEmployee(fx.foreignClub.id, {
      firstName: "Foreign",
      lastName: "Employee",
    });
    const foreignSession = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: foreignEmployee.id,
      clubId: fx.foreignClub.id,
    });
    const res = await signOutEmployeeEverywhere(fx.superAdmin, foreignEmployee.id);
    expect(res.sessionsRevoked).toBe(1);

    const after = await prisma.session.findUnique({
      where: { id: foreignSession.session.id },
      select: { revokedAt: true },
    });
    expect(after?.revokedAt).not.toBeNull();
  });
});
