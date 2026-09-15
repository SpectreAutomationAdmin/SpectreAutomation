// v399 Slice-1 follow-up (2026-09-15) — self-start lifecycle regression.
//
// Root cause of Chris's Submit failure ("Cannot transition session
// from DRAFT to SUBMITTED via employee actor"):
//
//   v399's self-start route created an EmployeeOnboardingSession in
//   DRAFT and called `issueInvitation` directly, bypassing the
//   canonical `transitionSession(→INVITED)` state-machine primitive.
//   Chris completed every section against a DRAFT session, and Submit
//   refused because the legal employee-actor path is
//   INVITED → IN_PROGRESS → SUBMITTED.
//
// This suite proves that the primitives self-start now uses:
//
//   createSession                       (DRAFT)
//   transitionSession(→INVITED, STAFF)  (DRAFT → INVITED + invitation)
//   acquireInvitationContext(rawToken)  (redemption, session left in INVITED)
//   transitionSelfSessionToInProgress   (INVITED → IN_PROGRESS)
//   ...employee completes required data...
//   transitionSelfSessionToSubmitted    (IN_PROGRESS → SUBMITTED)
//   transitionSession(→APPROVED, STAFF) (SUBMITTED → APPROVED)
//
// compose end-to-end without a state-transition error, that repeated
// self-start doesn't create duplicate sessions, that repeated
// redemption of the same token is safe, and that a missing session
// row throws a gracefully-typed AppError (never a bare Error).

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import {
  acquireInvitationContext,
  reissueInvitation,
  InvitationRevokedError,
} from "@/lib/hr/invitations";
import {
  transitionSelfSessionToInProgress,
  transitionSelfSessionToSubmitted,
} from "@/lib/hr/employee-self-service";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { isAppError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "./_helpers";

const IP_HASH = createHash("sha256").update("127.0.0.1|salt", "utf8").digest("hex");

function actorFor(clubId: string, employeeId: string, sessionId: string, invitationId: string, sessionState: EmployeeOnboardingActor["sessionState"] = "INVITED"): EmployeeOnboardingActor {
  return {
    clubId,
    employeeId,
    sessionId,
    invitationId,
    sessionState,
    redeemedAt: new Date().toISOString(),
  };
}

async function seedRequiredCompletionArtifacts(clubId: string, employeeId: string, sessionId: string) {
  // The Submit readiness gate at transitionSelfSessionToSubmitted §28
  // requires:
  //   - EmployeeOnboardingAcknowledgement.kind = "final_submission_attestation"
  //   - EmployeePortalCredential set
  // Seed both so the readiness check passes and we can prove the
  // state transition works end-to-end.
  await prisma.employeeOnboardingAcknowledgement.create({
    data: {
      clubId,
      employeeId,
      sessionId,
      kind: "final_submission_attestation",
      acknowledgedAt: new Date(),
    },
  });
  await prisma.employeePortalCredential.create({
    data: {
      clubId,
      employeeId,
      passwordHash: "$2a$12$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      passwordUpdatedAt: new Date(),
    },
  });
}

describe("Self-start onboarding — canonical lifecycle (v399 follow-up)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  // Primary regression: prove the canonical sequence self-start now uses
  // composes DRAFT → INVITED → IN_PROGRESS → SUBMITTED without a
  // state-transition error at any step.
  it("canonical sequence composes end-to-end and Submit succeeds", async () => {
    const fx = await makeAdminHrFixture();

    // Step 1 — self-start creates the session (DRAFT).
    const created = await createSession(fx.clubAdmin, fx.employee.id);
    expect(created.state).toBe("DRAFT");

    // Step 2 — self-start transitions DRAFT → INVITED (issues invitation).
    const invitedResult = await transitionSession(fx.clubAdmin, created.id, "INVITED", {
      ttlHours: 24,
      actorSource: "STAFF",
    });
    expect(invitedResult.session.state).toBe("INVITED");
    expect(invitedResult.invitation).toBeDefined();
    const rawToken = invitedResult.invitation!.rawToken;
    expect(rawToken.length).toBeGreaterThanOrEqual(40);

    // Step 3 — employee redeems the invitation.
    const ctx = await acquireInvitationContext(rawToken, { ipHash: IP_HASH });
    expect(ctx.clubId).toBe(fx.employee.clubId);
    expect(ctx.employeeId).toBe(fx.employee.id);
    expect(ctx.sessionId).toBe(created.id);
    expect(ctx.wasFirstRedemption).toBe(true);

    // Step 4 — first employee action transitions INVITED → IN_PROGRESS.
    const actor = actorFor(ctx.clubId, ctx.employeeId, ctx.sessionId, ctx.invitationId);
    const ip = await transitionSelfSessionToInProgress(actor);
    expect(ip.state).toBe("IN_PROGRESS");

    // Step 5 — employee finishes the required artifacts + Submit succeeds.
    await seedRequiredCompletionArtifacts(ctx.clubId, ctx.employeeId, ctx.sessionId);
    const submitted = await transitionSelfSessionToSubmitted({ ...actor, sessionState: "IN_PROGRESS" });
    expect(submitted.state).toBe("SUBMITTED");
    const submittedRow = await prisma.employeeOnboardingSession.findUniqueOrThrow({ where: { id: created.id } });
    expect(submittedRow.submittedAt).toBeTruthy();

    // Step 6 — admin approves.
    const approved = await transitionSession(fx.clubAdmin, created.id, "APPROVED");
    expect(approved.session.state).toBe("APPROVED");
    expect(approved.session.approvedAt).toBeTruthy();
    expect(approved.session.completedAt).toBeTruthy();

    // Verify Employee.onboardingState pointer follows the session.
    const emp = await prisma.employee.findUnique({ where: { id: fx.employee.id } });
    expect(emp?.onboardingState).toBe("APPROVED");

    // Verify audit trail of transitions was written.
    const transitions = await prisma.employeeOnboardingStateTransition.findMany({
      where: { sessionId: created.id },
      orderBy: { at: "asc" },
    });
    const chain = transitions.map(t => `${t.fromState}->${t.toState}`);
    expect(chain).toEqual(["DRAFT->INVITED", "INVITED->IN_PROGRESS", "IN_PROGRESS->SUBMITTED", "SUBMITTED->APPROVED"]);
  });

  // Idempotency: repeated self-start does NOT create conflicting
  // sessions. When a session is already in INVITED or IN_PROGRESS,
  // self-start uses reissueInvitation which supersedes the prior
  // invitation and issues a fresh one WITHOUT touching session state.
  it("repeated self-start against INVITED session reuses session + supersedes prior invitation", async () => {
    const fx = await makeAdminHrFixture();
    const created = await createSession(fx.clubAdmin, fx.employee.id);
    const first = await transitionSession(fx.clubAdmin, created.id, "INVITED", {
      ttlHours: 24,
      actorSource: "STAFF",
    });
    const firstToken = first.invitation!.rawToken;

    // Second self-start on the same INVITED session → reissue path.
    const reissued = await reissueInvitation(fx.clubAdmin, fx.employee.id, { ttlHours: 24 });
    expect(reissued.rawToken).not.toBe(firstToken);
    expect(reissued.sessionState).toBe("INVITED");
    expect(reissued.supersededInvitationId).toBeTruthy();

    // Session state unchanged; still exactly ONE session.
    const sessions = await prisma.employeeOnboardingSession.findMany({
      where: { employeeId: fx.employee.id },
    });
    expect(sessions.length).toBe(1);
    expect(sessions[0].state).toBe("INVITED");
  });

  // Cross-transition safety: attempting the DRAFT → SUBMITTED shortcut
  // via the employee-actor Submit primitive still refuses. This is the
  // exact code path that caught Chris's failure and MUST stay strict.
  it("transitionSelfSessionToSubmitted refuses to submit a DRAFT session", async () => {
    const fx = await makeAdminHrFixture();
    const created = await createSession(fx.clubAdmin, fx.employee.id);
    // Do NOT transition to INVITED. Session stays DRAFT.
    // Seed just enough for the readiness gate not to short-circuit first.
    await seedRequiredCompletionArtifacts(fx.employee.clubId, fx.employee.id, created.id);
    const actor = actorFor(fx.employee.clubId, fx.employee.id, created.id, "fake-invitation-id", "DRAFT" as never);
    await expect(
      transitionSelfSessionToSubmitted(actor),
    ).rejects.toSatisfy((err: unknown) =>
      err instanceof Error && /Cannot transition session from DRAFT to SUBMITTED via employee actor/.test(err.message),
    );
  });

  // Repeated redemption of the same token is idempotent within the
  // resumable states (INVITED / IN_PROGRESS) — the employee can retry
  // if the cookie write between redemption and About You fails.
  it("repeated redemption of the same token is safe", async () => {
    const fx = await makeAdminHrFixture();
    const created = await createSession(fx.clubAdmin, fx.employee.id);
    const invitedResult = await transitionSession(fx.clubAdmin, created.id, "INVITED", {
      ttlHours: 24,
      actorSource: "STAFF",
    });
    const rawToken = invitedResult.invitation!.rawToken;

    const first = await acquireInvitationContext(rawToken, { ipHash: IP_HASH });
    expect(first.wasFirstRedemption).toBe(true);
    const second = await acquireInvitationContext(rawToken, { ipHash: IP_HASH });
    expect(second.wasFirstRedemption).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.invitationId).toBe(first.invitationId);
  });

  // Missing session with a live invitation still throws a typed
  // AppError (not a bare Error). This is the safety net that prevents
  // any future variant of the v399 crash from turning into a 500.
  it("missing session → InvitationRevokedError which IS an AppError", async () => {
    const fx = await makeAdminHrFixture();
    const created = await createSession(fx.clubAdmin, fx.employee.id);
    const invitedResult = await transitionSession(fx.clubAdmin, created.id, "INVITED", {
      ttlHours: 24,
      actorSource: "STAFF",
    });
    const rawToken = invitedResult.invitation!.rawToken;

    // Simulate the pre-v399 defect: delete the session but leave the
    // invitation. Redemption path must throw an AppError, not a bare
    // Error, so the /hr/onboarding/[token] server action can render
    // a graceful ?err= banner rather than a page-level 500.
    await prisma.employeeOnboardingSession.delete({ where: { id: created.id } });

    await expect(
      acquireInvitationContext(rawToken, { ipHash: IP_HASH }),
    ).rejects.toSatisfy((err: unknown) =>
      err instanceof InvitationRevokedError && isAppError(err),
    );
  });
});
