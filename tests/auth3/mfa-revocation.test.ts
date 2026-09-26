// AUTH-3B — MFA state-change revocation.
//
// Amendment 1: successful MFA enable/disable revokes every active
// ADMIN Session for the affected user; failed MFA mutations preserve
// existing sessions. Enable revokes the caller's own sessions
// (including the current one, per §15 self-revocation semantics).
// Disable is admin-initiated against a target and revokes that
// target's sessions.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  startEnrollment,
  completeEnrollment,
  disableMfa,
  generateTotp,
} from "@/lib/mfa";
import { createSession, SURFACE_ADMIN } from "@/lib/services/session-store";
import { makeAdminHrFixture, latestAuditForAction } from "../hr/admin-workflows/_helpers";
import { ForbiddenError } from "@/lib/errors";
import { resetDb, seedRbac } from "../util/db";

// AUTH-3B MFA tests use the exported TOTP generator from the MFA module
// itself (no external dependency; the module owns the RFC 6238 impl).
// The `generateTotp` helper is what the module uses for `verifyTotp`
// internally on the current 30-sec window.

describe("AUTH-3B · MFA state changes revoke ADMIN sessions", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("successful MFA enrollment revokes ALL ADMIN sessions for the enrolling user (incl. current)", async () => {
    const fx = await makeAdminHrFixture();
    const s1 = await createSession({
      surface: SURFACE_ADMIN,
      userId: fx.clubAdmin.id,
      clubId: fx.club.id,
    });
    const s2 = await createSession({
      surface: SURFACE_ADMIN,
      userId: fx.clubAdmin.id,
      clubId: fx.club.id,
    });

    const { secret } = await startEnrollment(fx.clubAdmin);
    const totp = generateTotp(secret);
    const result = await completeEnrollment(fx.clubAdmin, totp);
    expect(result.recoveryCodes).toHaveLength(8);

    const [r1, r2] = await Promise.all([
      prisma.session.findUnique({ where: { id: s1.session.id }, select: { revokedAt: true, revokeReason: true } }),
      prisma.session.findUnique({ where: { id: s2.session.id }, select: { revokedAt: true, revokeReason: true } }),
    ]);
    expect(r1?.revokedAt).not.toBeNull();
    expect(r2?.revokedAt).not.toBeNull();
    expect(r1?.revokeReason).toBe("mfa-change");

    const audit = await latestAuditForAction("mfa.enroll.complete");
    const meta = audit?.metaJson ? JSON.parse(audit.metaJson) : null;
    expect(meta?.sessionsRevoked).toBe(2);
  });

  it("failed MFA enrollment (wrong code) does NOT revoke sessions", async () => {
    const fx = await makeAdminHrFixture();
    const s1 = await createSession({
      surface: SURFACE_ADMIN,
      userId: fx.clubAdmin.id,
      clubId: fx.club.id,
    });
    await startEnrollment(fx.clubAdmin);

    await expect(
      completeEnrollment(fx.clubAdmin, "000000"), // wrong TOTP
    ).rejects.toBeInstanceOf(ForbiddenError);

    const after = await prisma.session.findUnique({
      where: { id: s1.session.id },
      select: { revokedAt: true },
    });
    expect(after?.revokedAt).toBeNull();
    // User row's mfaEnabled must also remain unchanged.
    const user = await prisma.user.findUnique({
      where: { id: fx.clubAdmin.id },
      select: { mfaEnabled: true },
    });
    expect(user?.mfaEnabled).toBe(false);
  });

  it("admin disables MFA for a target user → target's ADMIN sessions are revoked", async () => {
    const fx = await makeAdminHrFixture();
    // Enroll first so there's something to disable.
    const { secret } = await startEnrollment(fx.clubAdmin);
    await completeEnrollment(fx.clubAdmin, generateTotp(secret));
    // Enroll a fresh set of sessions AFTER enrollment (the enrollment
    // revoked prior sessions).
    const s1 = await createSession({
      surface: SURFACE_ADMIN,
      userId: fx.clubAdmin.id,
      clubId: fx.club.id,
    });
    const s2 = await createSession({
      surface: SURFACE_ADMIN,
      userId: fx.clubAdmin.id,
      clubId: fx.club.id,
    });

    await disableMfa(fx.superAdmin, fx.clubAdmin.id, "auth3 test disable");

    const [r1, r2] = await Promise.all([
      prisma.session.findUnique({ where: { id: s1.session.id }, select: { revokedAt: true, revokeReason: true } }),
      prisma.session.findUnique({ where: { id: s2.session.id }, select: { revokedAt: true, revokeReason: true } }),
    ]);
    expect(r1?.revokedAt).not.toBeNull();
    expect(r2?.revokedAt).not.toBeNull();
    expect(r1?.revokeReason).toBe("mfa-change");

    const audit = await latestAuditForAction("mfa.disable");
    const meta = audit?.metaJson ? JSON.parse(audit.metaJson) : null;
    expect(meta?.sessionsRevoked).toBe(2);
  });

  it("MFA disable does NOT touch other users' sessions", async () => {
    const fx = await makeAdminHrFixture();
    const { secret } = await startEnrollment(fx.clubAdmin);
    await completeEnrollment(fx.clubAdmin, generateTotp(secret));
    const bystander = await createSession({
      surface: SURFACE_ADMIN,
      userId: fx.gm.id,
      clubId: fx.club.id,
    });

    await disableMfa(fx.superAdmin, fx.clubAdmin.id, "auth3 isolation test");

    const stillActive = await prisma.session.findUnique({
      where: { id: bystander.session.id },
      select: { revokedAt: true },
    });
    expect(stillActive?.revokedAt).toBeNull();
  });
});
