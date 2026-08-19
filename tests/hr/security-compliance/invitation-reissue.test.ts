// HR-2B.3.1 (2026-08-18) §5 — Resend-invitation orchestrator tests.
//
// The founder brief §5 defines the rules:
//   • Active session (DRAFT / INVITED / IN_PROGRESS) + prior live
//     invitation → supersede + reissue.
//   • Active session (IN_PROGRESS) + prior redeemed invitation →
//     supersede + reissue (same DB column, distinct action string).
//     Session + all onboarding responses / acknowledgements /
//     corrections are UNTOUCHED.
//   • Terminal session (SUBMITTED / APPROVED / REJECTED / REVOKED) →
//     ConflictError.
//
// Cross-tenant and role-based refusal also covered.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import {
  acquireInvitationContext,
  hashToken,
  InvitationAlreadyRedeemedError,
  InvitationRevokedError,
  issueInvitation,
  reissueInvitation,
} from "@/lib/hr/invitations";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { ConflictError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";

const IP_HASH = createHash("sha256").update("127.0.0.1|salt", "utf8").digest("hex");

async function ensureInvitedSession(
  fx: Awaited<ReturnType<typeof makeAdminHrFixture>>,
): Promise<{ sessionId: string; rawToken: string; invitationId: string }> {
  const session = await createSession(fx.clubAdmin, fx.employee.id);
  const { invitation } = await transitionSession(fx.clubAdmin, session.id, "INVITED", {
    actorSource: "STAFF",
  });
  return {
    sessionId: session.id,
    rawToken: invitation!.rawToken,
    invitationId: invitation!.invitationId,
  };
}

describe("HR-2B.3.1 §5 · reissueInvitation orchestrator", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // ------------------- Fresh token + old-token invalidation -------------------
  it("issues a fresh raw token distinct from the prior one", async () => {
    const fx = await makeAdminHrFixture("Reissue-Fresh");
    const first = await ensureInvitedSession(fx);

    const reissued = await reissueInvitation(fx.clubAdmin, fx.employee.id);
    expect(reissued.rawToken).not.toBe(first.rawToken);
    expect(reissued.invitationId).not.toBe(first.invitationId);
    expect(reissued.supersededInvitationId).toBe(first.invitationId);
    expect(reissued.sessionState).toBe("INVITED");

    // The DB rows have distinct tokenHashes.
    const rows = await prisma.employeeOnboardingInvitation.findMany({
      where: { employeeId: fx.employee.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.length).toBe(2);
    expect(rows[0].tokenHash).not.toBe(rows[1].tokenHash);
    expect(rows[1].tokenHash).toBe(hashToken(reissued.rawToken));
  });

  it("old token is unusable after reissue (unredeemed path — Revoked)", async () => {
    const fx = await makeAdminHrFixture("Reissue-Unredeemed-OldDead");
    const first = await ensureInvitedSession(fx);

    await reissueInvitation(fx.clubAdmin, fx.employee.id);

    await expect(
      acquireInvitationContext(first.rawToken, { ipHash: IP_HASH }),
    ).rejects.toBeInstanceOf(InvitationRevokedError);
  });

  it("old token is unusable after reissue (already-redeemed path — Revoked, thanks to supersede)", async () => {
    const fx = await makeAdminHrFixture("Reissue-Redeemed-OldDead");
    const first = await ensureInvitedSession(fx);
    // Redeem the first invitation — session advances to IN_PROGRESS
    // via acquireInvitationContext's session-state check.
    await transitionSession(fx.clubAdmin, first.sessionId, "IN_PROGRESS", {
      actorSource: "EMPLOYEE",
    });
    const ctx = await acquireInvitationContext(first.rawToken, { ipHash: IP_HASH });
    expect(ctx.wasFirstRedemption).toBe(true);
    expect(ctx.sessionId).toBe(first.sessionId);

    // Now supersede + reissue while the session is IN_PROGRESS.
    const reissued = await reissueInvitation(fx.clubAdmin, fx.employee.id);
    expect(reissued.supersededInvitationId).toBe(first.invitationId);

    // Old token is now revoked. acquireInvitationContext checks
    // revokedAt BEFORE redeemedAt, so we get Revoked (not
    // AlreadyRedeemed).
    await expect(
      acquireInvitationContext(first.rawToken, { ipHash: IP_HASH }),
    ).rejects.toBeInstanceOf(InvitationRevokedError);
    // Sanity — the error IS the revoked one, not the redeemed one.
    await expect(
      acquireInvitationContext(first.rawToken, { ipHash: IP_HASH }),
    ).rejects.not.toBeInstanceOf(InvitationAlreadyRedeemedError);
  });

  // ------------------- Session + response preservation -------------------
  it("preserves the session row and its onboarding responses / acknowledgements / corrections", async () => {
    const fx = await makeAdminHrFixture("Reissue-Preserve");
    const first = await ensureInvitedSession(fx);
    // Advance to IN_PROGRESS + seed one of each dependent row.
    await transitionSession(fx.clubAdmin, first.sessionId, "IN_PROGRESS", {
      actorSource: "EMPLOYEE",
    });
    const ack = await prisma.employeeOnboardingAcknowledgement.create({
      data: {
        clubId: fx.club.id,
        sessionId: first.sessionId,
        employeeId: fx.employee.id,
        kind: "employment_confirmation",
        acknowledgedAt: new Date(),
      },
    });
    const correction = await prisma.employeeOnboardingCorrection.create({
      data: {
        clubId: fx.club.id,
        sessionId: first.sessionId,
        employeeId: fx.employee.id,
        field: "department",
        employeeStatedValue: "Whatever",
      },
    });

    await reissueInvitation(fx.clubAdmin, fx.employee.id);

    // Session still exists with same id.
    const session = await prisma.employeeOnboardingSession.findUnique({
      where: { id: first.sessionId },
    });
    expect(session).not.toBeNull();
    expect(session?.id).toBe(first.sessionId);

    // Dependent rows still exist.
    const ackAfter = await prisma.employeeOnboardingAcknowledgement.findUnique({
      where: { id: ack.id },
    });
    expect(ackAfter).not.toBeNull();
    const correctionAfter = await prisma.employeeOnboardingCorrection.findUnique({
      where: { id: correction.id },
    });
    expect(correctionAfter).not.toBeNull();
  });

  // ------------------- Terminal session refuses -------------------
  it("refuses to resend for a SUBMITTED (terminal) session", async () => {
    const fx = await makeAdminHrFixture("Reissue-Terminal-SUBMITTED");
    const first = await ensureInvitedSession(fx);
    await transitionSession(fx.clubAdmin, first.sessionId, "IN_PROGRESS", {
      actorSource: "EMPLOYEE",
    });
    await transitionSession(fx.clubAdmin, first.sessionId, "SUBMITTED", {
      actorSource: "EMPLOYEE",
    });

    await expect(reissueInvitation(fx.clubAdmin, fx.employee.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("refuses to resend for an APPROVED (terminal) session", async () => {
    const fx = await makeAdminHrFixture("Reissue-Terminal-APPROVED");
    const first = await ensureInvitedSession(fx);
    await transitionSession(fx.clubAdmin, first.sessionId, "IN_PROGRESS", {
      actorSource: "EMPLOYEE",
    });
    await transitionSession(fx.clubAdmin, first.sessionId, "SUBMITTED", {
      actorSource: "EMPLOYEE",
    });
    await transitionSession(fx.clubAdmin, first.sessionId, "APPROVED", {
      actorSource: "STAFF",
    });

    await expect(reissueInvitation(fx.clubAdmin, fx.employee.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  // ------------------- Cross-tenant + unauthorized -------------------
  it("cross-Club admin cannot reissue for a foreign-Club employee", async () => {
    const fx = await makeAdminHrFixture("Reissue-CrossTenant");
    await ensureInvitedSession(fx);

    // fx.foreignClubAdmin is a CLUB_ADMIN at foreignClub — has
    // hr:onboarding:invite at THEIR club, but not at fx.club.id.
    await expect(
      reissueInvitation(fx.foreignClubAdmin, fx.employee.id),
    ).rejects.toThrow();
  });

  it("AUDITOR_READ_ONLY without hr:onboarding:invite is refused", async () => {
    const fx = await makeAdminHrFixture("Reissue-Auditor");
    await ensureInvitedSession(fx);
    await expect(reissueInvitation(fx.auditor, fx.employee.id)).rejects.toThrow();
  });

  // ------------------- Raw token never in audit -------------------
  it("raw token never appears in the audit log or the invitation row", async () => {
    const fx = await makeAdminHrFixture("Reissue-NoLeak");
    await ensureInvitedSession(fx);
    const reissued = await reissueInvitation(fx.clubAdmin, fx.employee.id);

    // Audit rows for both the supersede action and the new-issue
    // action must not contain the raw token.
    const audits = await prisma.auditLog.findMany({
      where: {
        clubId: fx.club.id,
        action: {
          in: [
            "hr.onboarding.invite.supersede.void",
            "hr.onboarding.invite.update",
          ],
        },
      },
    });
    for (const row of audits) {
      const blob = `${row.beforeJson ?? ""} | ${row.afterJson ?? ""} | ${row.metaJson ?? ""}`;
      expect(blob.includes(reissued.rawToken)).toBe(false);
    }

    // The new invitation row stores only the hash.
    const invitation = await prisma.employeeOnboardingInvitation.findUnique({
      where: { id: reissued.invitationId },
    });
    expect(invitation?.tokenHash).toBe(hashToken(reissued.rawToken));
    const serialised = JSON.stringify(invitation);
    expect(serialised.includes(reissued.rawToken)).toBe(false);
  });
});
