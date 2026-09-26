// AUTH-3B — Administrator "Sign out on all devices" for User + Employee.
//
// Covers:
//   • Authorized admin signs out an employee → all EMPLOYEE Sessions
//     revoked, employee status unchanged.
//   • Authorized admin signs out another admin user → all ADMIN Sessions
//     revoked.
//   • Self-revocation is always allowed regardless of settings:write.
//   • Idempotent: repeat call is a safe no-op.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  signOutEmployeeEverywhere,
  revokeEmployeeSessions,
} from "@/lib/hr/employee-session-revocation";
import {
  signOutUserEverywhere,
  canSignOutUser,
} from "@/lib/tenant-admin/user-session-revocation";
import {
  createSession,
  SURFACE_ADMIN,
  SURFACE_EMPLOYEE,
} from "@/lib/services/session-store";
import { makeAdminHrFixture, latestAuditForAction } from "../hr/admin-workflows/_helpers";
import { resetDb, seedRbac } from "../util/db";

describe("AUTH-3B · signOutEmployeeEverywhere", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("revokes every active EMPLOYEE Session, emits audit, leaves employment status untouched", async () => {
    const fx = await makeAdminHrFixture();
    const s1 = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    const s2 = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    const beforeStatus = await prisma.employee.findUnique({
      where: { id: fx.employee.id },
      select: { status: true, employeeLifecycle: true },
    });

    const res = await signOutEmployeeEverywhere(fx.clubAdmin, fx.employee.id);
    expect(res.sessionsRevoked).toBe(2);

    const [r1, r2] = await Promise.all([
      prisma.session.findUnique({ where: { id: s1.session.id }, select: { revokedAt: true, revokeReason: true, revokedBy: true } }),
      prisma.session.findUnique({ where: { id: s2.session.id }, select: { revokedAt: true, revokeReason: true } }),
    ]);
    expect(r1?.revokedAt).not.toBeNull();
    expect(r2?.revokedAt).not.toBeNull();
    expect(r1?.revokeReason).toBe("admin-force");
    expect(r1?.revokedBy).toBe(fx.clubAdmin.id);

    // Status/lifecycle NOT touched.
    const afterStatus = await prisma.employee.findUnique({
      where: { id: fx.employee.id },
      select: { status: true, employeeLifecycle: true },
    });
    expect(afterStatus?.status).toBe(beforeStatus?.status);
    expect(afterStatus?.employeeLifecycle).toBe(beforeStatus?.employeeLifecycle);

    // Audit emitted.
    const audit = await latestAuditForAction("hr.employee.sessions_revoked");
    expect(audit?.entityId).toBe(fx.employee.id);
    const meta = audit?.metaJson ? JSON.parse(audit.metaJson) : null;
    expect(meta?.sessionsRevoked).toBe(2);
    expect(meta?.reason).toBe("admin-force");
  });

  it("idempotent: second call with no active sessions returns count=0, still audits", async () => {
    const fx = await makeAdminHrFixture();
    await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    await signOutEmployeeEverywhere(fx.clubAdmin, fx.employee.id);
    const res = await signOutEmployeeEverywhere(fx.clubAdmin, fx.employee.id);
    expect(res.sessionsRevoked).toBe(0);
  });

  it("revokeEmployeeSessions (direct canonical caller) attributes null actor to system", async () => {
    const fx = await makeAdminHrFixture();
    await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    const res = await revokeEmployeeSessions({
      actor: null,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
      reason: "password-reset",
    });
    expect(res.sessionsRevoked).toBe(1);
    const audit = await latestAuditForAction("hr.employee.sessions_revoked");
    // Anonymous actor path (self-service password reset) records null userId.
    expect(audit?.userId).toBeNull();
  });
});

describe("AUTH-3B · signOutUserEverywhere", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("authorized club-admin can sign out another admin user in the same tenant", async () => {
    const fx = await makeAdminHrFixture();
    const s1 = await createSession({
      surface: SURFACE_ADMIN,
      userId: fx.gm.id,
      clubId: fx.club.id,
    });

    const res = await signOutUserEverywhere(fx.clubAdmin, fx.gm.id);
    expect(res.sessionsRevoked).toBe(1);
    expect(res.selfRevocation).toBe(false);

    const after = await prisma.session.findUnique({
      where: { id: s1.session.id },
      select: { revokedAt: true, revokeReason: true },
    });
    expect(after?.revokedAt).not.toBeNull();
    expect(after?.revokeReason).toBe("admin-force");

    const audit = await latestAuditForAction("iam.user.sessions_revoked");
    const meta = audit?.metaJson ? JSON.parse(audit.metaJson) : null;
    expect(meta?.selfRevocation).toBe(false);
    expect(meta?.reason).toBe("admin-force");
  });

  it("self-revocation is always allowed and revokes the caller's own sessions", async () => {
    const fx = await makeAdminHrFixture();
    // The auditor role has NO settings:write — self-revocation must still work.
    const s1 = await createSession({
      surface: SURFACE_ADMIN,
      userId: fx.auditor.id,
      clubId: fx.club.id,
    });

    const res = await signOutUserEverywhere(fx.auditor, fx.auditor.id);
    expect(res.sessionsRevoked).toBe(1);
    expect(res.selfRevocation).toBe(true);

    const after = await prisma.session.findUnique({
      where: { id: s1.session.id },
      select: { revokedAt: true, revokeReason: true },
    });
    expect(after?.revokedAt).not.toBeNull();
    expect(after?.revokeReason).toBe("self-force");

    const audit = await latestAuditForAction("iam.user.sessions_revoked");
    const meta = audit?.metaJson ? JSON.parse(audit.metaJson) : null;
    expect(meta?.selfRevocation).toBe(true);
    expect(meta?.reason).toBe("self-force");
  });

  it("canSignOutUser returns true for self and for authorized cross-user, false otherwise", async () => {
    const fx = await makeAdminHrFixture();
    expect(await canSignOutUser(fx.auditor, fx.auditor.id)).toBe(true); // self
    expect(await canSignOutUser(fx.clubAdmin, fx.gm.id)).toBe(true);    // authorized
    expect(await canSignOutUser(fx.auditor, fx.gm.id)).toBe(false);     // read-only auditor
    expect(await canSignOutUser(fx.superAdmin, fx.gm.id)).toBe(true);   // super
  });
});
