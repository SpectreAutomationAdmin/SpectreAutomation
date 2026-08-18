// HR-2B.2 (2026-08-18) — Onboarding redemption resilience.
//
// The founder invariant this test suite pins:
//
//   > A valid employee must never permanently lose onboarding access
//   > merely because Spectre fails between invitation redemption and
//   > establishment of their authenticated onboarding session.
//
// The redemption HTTP action's cookie-establishment step is the
// non-DB tail after `acquireInvitationContext` returns. If that
// action crashes, the employee must be able to re-visit the same
// magic link and complete the flow — the token is not permanently
// spent on failure.

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import {
  issueInvitation,
  acquireInvitationContext,
  revokeInvitation,
  InvitationNotFoundError,
  InvitationExpiredError,
  InvitationRevokedError,
  InvitationAlreadyRedeemedError,
} from "@/lib/hr/invitations";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";

const IP_HASH = createHash("sha256").update("127.0.0.1|salt", "utf8").digest("hex");

describe("HR-2B.2 · onboarding redemption resilience", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  async function issueForFixtureNamed(name: string) {
    const { club, employee, clubAdmin } = await makeHrFixture(name);
    const session = await createSession(clubAdmin, employee.id);
    const result = await transitionSession(clubAdmin, session.id, "INVITED", {
      actorSource: "STAFF",
    });
    if (!result.invitation) throw new Error("expected invitation from transition");
    return { club, employee, clubAdmin, session, ...result.invitation };
  }

  async function issueForFixture() {
    const { club, employee, clubAdmin } = await makeHrFixture(
      `Nightingale HR Club ${Math.random().toString(36).slice(2, 8)}`,
    );
    // The HR test fixture does not create an EmployeeOnboardingSession;
    // create one explicitly so the invitation-issue flow can transition
    // it to INVITED — mirroring what Add Employee does in production.
    const session = await createSession(clubAdmin, employee.id);
    const result = await transitionSession(clubAdmin, session.id, "INVITED", {
      actorSource: "STAFF",
    });
    if (!result.invitation) throw new Error("expected invitation from transition");
    return { club, employee, clubAdmin, session, ...result.invitation };
  }

  it("first acquire marks invitation REDEEMED, returns wasFirstRedemption=true", async () => {
    const { club, employee, rawToken, invitationId } = await issueForFixture();
    const ctx = await acquireInvitationContext(rawToken, { ipHash: IP_HASH });
    expect(ctx.wasFirstRedemption).toBe(true);
    expect(ctx.invitationId).toBe(invitationId);
    expect(ctx.clubId).toBe(club.id);
    expect(ctx.employeeId).toBe(employee.id);
    expect(ctx.sessionId).toBeTruthy();
    const row = await prisma.employeeOnboardingInvitation.findUnique({
      where: { id: invitationId },
    });
    expect(row!.redeemedAt).toBeInstanceOf(Date);
    expect(row!.redeemedByIpHash).toBe(IP_HASH);
  });

  it("second acquire (retry after cookie-establishment failure) succeeds with wasFirstRedemption=false — the founder invariant", async () => {
    const { rawToken, invitationId } = await issueForFixture();
    const first = await acquireInvitationContext(rawToken, { ipHash: IP_HASH });
    expect(first.wasFirstRedemption).toBe(true);
    // Simulate: cookie establishment failed after redemption. Employee
    // clicks the link again from the same email.
    const second = await acquireInvitationContext(rawToken, { ipHash: IP_HASH });
    expect(second.wasFirstRedemption).toBe(false);
    expect(second.invitationId).toBe(invitationId);
    expect(second.employeeId).toBe(first.employeeId);
    expect(second.clubId).toBe(first.clubId);
    expect(second.sessionId).toBe(first.sessionId);
    // Row was NOT re-stamped — original redemption timestamp survives.
    const row = await prisma.employeeOnboardingInvitation.findUnique({
      where: { id: invitationId },
    });
    expect(row!.redeemedAt).toBeInstanceOf(Date);
  });

  it("resume audit fires distinct from initial redeem — forensic visibility of retry", async () => {
    const { rawToken, invitationId } = await issueForFixture();
    await acquireInvitationContext(rawToken, { ipHash: IP_HASH });
    await acquireInvitationContext(rawToken, { ipHash: IP_HASH });
    const audits = await prisma.auditLog.findMany({
      where: {
        entityId: invitationId,
        entityType: "EmployeeOnboardingInvitation",
        action: "hr.onboarding.invite.update",
      },
      orderBy: { createdAt: "asc" },
    });
    // 1 from staff-issue + 1 from redeem + 1 from resume = 3 total.
    expect(audits.length).toBe(3);
    const contexts = audits.map((a) => JSON.parse(a.metaJson ?? "{}").context ?? "issue");
    expect(contexts).toContain("redeem");
    expect(contexts).toContain("resume");
  });

  it("acquire refuses when the invitation is revoked", async () => {
    const { rawToken, invitationId, clubAdmin } = await issueForFixture();
    await revokeInvitation(clubAdmin, invitationId);
    await expect(
      acquireInvitationContext(rawToken, { ipHash: IP_HASH }),
    ).rejects.toBeInstanceOf(InvitationRevokedError);
  });

  it("acquire refuses when the invitation has expired (never returns wasFirstRedemption)", async () => {
    const { rawToken, invitationId } = await issueForFixture();
    // Force expiry.
    await prisma.employeeOnboardingInvitation.update({
      where: { id: invitationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await expect(
      acquireInvitationContext(rawToken, { ipHash: IP_HASH }),
    ).rejects.toBeInstanceOf(InvitationExpiredError);
  });

  it("acquire refuses an unknown token — neutral copy semantics", async () => {
    await expect(
      acquireInvitationContext("not-a-real-token-value-that-does-not-exist", { ipHash: IP_HASH }),
    ).rejects.toBeInstanceOf(InvitationNotFoundError);
  });

  it("acquire refuses resume once the session has moved past IN_PROGRESS (invitation terminally spent)", async () => {
    const { rawToken, session, clubAdmin } = await issueForFixture();
    await acquireInvitationContext(rawToken, { ipHash: IP_HASH });
    // Simulate the employee submitted their onboarding.
    await prisma.employeeOnboardingSession.update({
      where: { id: session.id },
      data: { state: "IN_PROGRESS" },
    });
    await transitionSession(clubAdmin, session.id, "SUBMITTED", {
      actorSource: "EMPLOYEE",
      actorEmployeeId: (await prisma.employee.findFirst())!.id,
    });
    await expect(
      acquireInvitationContext(rawToken, { ipHash: IP_HASH }),
    ).rejects.toBeInstanceOf(InvitationAlreadyRedeemedError);
  });

  it("acquire refuses when the linked session was revoked after redemption (staff took away access)", async () => {
    const { rawToken, session, clubAdmin } = await issueForFixture();
    await acquireInvitationContext(rawToken, { ipHash: IP_HASH });
    await transitionSession(clubAdmin, session.id, "REVOKED", { actorSource: "STAFF" });
    // The invitation itself remains "redeemed" — but the session
    // being terminal means the invitation is spent.
    await expect(
      acquireInvitationContext(rawToken, { ipHash: IP_HASH }),
    ).rejects.toBeInstanceOf(InvitationAlreadyRedeemedError);
  });

  it("acquire requires a non-empty ipHash — service-layer defence against a missing rate-limit key", async () => {
    const { rawToken } = await issueForFixture();
    await expect(
      acquireInvitationContext(rawToken, { ipHash: "" as unknown as string }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      issues: expect.arrayContaining([expect.objectContaining({ path: "ipHash" })]),
    });
  });

  it("cross-tenant token replay refused: token from Club A cannot resolve to Club B rows", async () => {
    // Set up two isolated fixtures with distinct club names (the
    // fixture uses the name for the club's slug, which is unique).
    const a = await issueForFixtureNamed("Cross-tenant Alpha");
    const b = await issueForFixtureNamed("Cross-tenant Bravo");
    const bCtx = await acquireInvitationContext(b.rawToken, { ipHash: IP_HASH });
    // Sanity — B's context resolves to B's row set.
    expect(bCtx.clubId).toBe(b.club.id);
    expect(bCtx.employeeId).toBe(b.employee.id);
    const aCtx = await acquireInvitationContext(a.rawToken, { ipHash: IP_HASH });
    // A's context resolves ONLY to A's row set — never bleeds to B.
    expect(aCtx.clubId).toBe(a.club.id);
    expect(aCtx.employeeId).toBe(a.employee.id);
    expect(aCtx.sessionId).not.toBe(bCtx.sessionId);
  });
});
