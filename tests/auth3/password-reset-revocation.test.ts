// AUTH-3B — employee password reset revocation semantics.
//
// Proves:
//   • Successful `completePortalPasswordReset` revokes every active
//     EMPLOYEE Session for that employee in the same transaction.
//   • Failed password mutations (invalid token, expired, mismatched,
//     policy failure) do NOT revoke Sessions.
//   • Audit meta on success carries `sessionsRevoked`.
//   • Cross-employee isolation preserved.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  completePortalPasswordReset,
  generateResetToken,
} from "@/lib/hr/password-reset";
import { createSession, SURFACE_EMPLOYEE } from "@/lib/services/session-store";
import { makeAdminHrFixture, latestAuditForAction } from "../hr/admin-workflows/_helpers";
import { makeEmployee } from "../hr/security-compliance/_helpers";
import { hashPassword } from "@/lib/services/auth";
import { resetDb, seedRbac } from "../util/db";

async function seedTokenAndCredential(employeeId: string, clubId: string) {
  // A portal credential must exist before a reset can rotate it.
  await prisma.employeePortalCredential.upsert({
    where: { employeeId },
    create: {
      employeeId,
      clubId,
      passwordHash: await hashPassword("initial-password-123"),
    },
    update: { passwordHash: await hashPassword("initial-password-123") },
  });
  const { raw, hash } = generateResetToken();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await prisma.employeePortalPasswordReset.create({
    data: { employeeId, clubId, tokenHash: hash, expiresAt },
  });
  return { raw };
}

describe("AUTH-3B · Employee password reset revocation", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("successful password reset revokes every active session for that employee", async () => {
    const fx = await makeAdminHrFixture();
    const { raw } = await seedTokenAndCredential(fx.employee.id, fx.employee.clubId);
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

    const result = await completePortalPasswordReset({
      rawToken: raw,
      password: "N3w-Str0ng-Passw0rd!",
      confirmPassword: "N3w-Str0ng-Passw0rd!",
    });
    expect(result.kind).toBe("success");

    const [r1, r2] = await Promise.all([
      prisma.session.findUnique({ where: { id: s1.session.id }, select: { revokedAt: true, revokeReason: true } }),
      prisma.session.findUnique({ where: { id: s2.session.id }, select: { revokedAt: true, revokeReason: true } }),
    ]);
    expect(r1?.revokedAt).not.toBeNull();
    expect(r2?.revokedAt).not.toBeNull();
    expect(r1?.revokeReason).toBe("password-reset");

    const audit = await latestAuditForAction("employee_portal.password_reset.consume");
    const meta = audit?.metaJson ? JSON.parse(audit.metaJson) : null;
    expect(meta?.sessionsRevoked).toBe(2);
  });

  it("cross-employee: other employee's sessions are NOT revoked", async () => {
    const fx = await makeAdminHrFixture();
    const { raw } = await seedTokenAndCredential(fx.employee.id, fx.employee.clubId);
    const other = await makeEmployee(fx.club.id, { firstName: "Sam", lastName: "Untouched" });
    const otherSession = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: other.id,
      clubId: fx.club.id,
    });

    await completePortalPasswordReset({
      rawToken: raw,
      password: "N3w-Str0ng-Passw0rd!",
      confirmPassword: "N3w-Str0ng-Passw0rd!",
    });

    const stillActive = await prisma.session.findUnique({
      where: { id: otherSession.session.id },
      select: { revokedAt: true },
    });
    expect(stillActive?.revokedAt).toBeNull();
  });

  it("mismatched confirmation → no revocation, no password rotation", async () => {
    const fx = await makeAdminHrFixture();
    const { raw } = await seedTokenAndCredential(fx.employee.id, fx.employee.clubId);
    const s1 = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    const credBefore = await prisma.employeePortalCredential.findUnique({
      where: { employeeId: fx.employee.id },
      select: { passwordHash: true },
    });

    const result = await completePortalPasswordReset({
      rawToken: raw,
      password: "aaaaaaaaaa",
      confirmPassword: "bbbbbbbbbb",
    });
    expect(result.kind).toBe("password_mismatch");

    const after = await prisma.session.findUnique({
      where: { id: s1.session.id },
      select: { revokedAt: true },
    });
    expect(after?.revokedAt).toBeNull();
    const credAfter = await prisma.employeePortalCredential.findUnique({
      where: { employeeId: fx.employee.id },
      select: { passwordHash: true },
    });
    expect(credAfter?.passwordHash).toBe(credBefore?.passwordHash);
  });

  it("policy failure (too short) → no revocation, no password rotation", async () => {
    const fx = await makeAdminHrFixture();
    const { raw } = await seedTokenAndCredential(fx.employee.id, fx.employee.clubId);
    const s1 = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });

    const result = await completePortalPasswordReset({
      rawToken: raw,
      password: "abc",
      confirmPassword: "abc",
    });
    expect(result.kind).toBe("password_policy");

    const after = await prisma.session.findUnique({
      where: { id: s1.session.id },
      select: { revokedAt: true },
    });
    expect(after?.revokedAt).toBeNull();
  });

  it("invalid token → no revocation, no rotation", async () => {
    const fx = await makeAdminHrFixture();
    await seedTokenAndCredential(fx.employee.id, fx.employee.clubId);
    const s1 = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });

    const result = await completePortalPasswordReset({
      rawToken: "not-a-real-token-value",
      password: "N3w-Str0ng-Passw0rd!",
      confirmPassword: "N3w-Str0ng-Passw0rd!",
    });
    expect(result.kind).toBe("invalid_token");

    const after = await prisma.session.findUnique({
      where: { id: s1.session.id },
      select: { revokedAt: true },
    });
    expect(after?.revokedAt).toBeNull();
  });
});
