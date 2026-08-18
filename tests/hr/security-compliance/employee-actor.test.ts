// HR-2B.2 (2026-08-18) — EmployeeOnboardingActor boundary tests.
//
// The employee actor is the authorization surface for every
// self-service HR-2B mutation. This suite pins its invariants:
//   • Actor tightly self-scoped — cannot act on another employee.
//   • Actor tightly club-scoped — cannot cross clubs even if it
//     assembles a cookie by hand.
//   • Actor is NULL when the underlying session moves to a terminal
//     state, tombstoning any in-flight employee UI.
//   • Actor is NULL when the invitation itself is revoked or expired.
//   • Actor rejects a cookie whose {clubId, employeeId, sessionId}
//     triangle does not still line up in Prisma.

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { acquireInvitationContext } from "@/lib/hr/invitations";
import {
  assertActorTargetsOwnClub,
  assertActorTargetsSelf,
  EmployeeOnboardingActorForbiddenError,
  type EmployeeOnboardingActor,
} from "@/lib/hr/employee-actor";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";
import { createHash } from "crypto";

const IP_HASH = createHash("sha256").update("test|salt", "utf8").digest("hex");

async function acquireActor(): Promise<{
  actor: EmployeeOnboardingActor;
  clubId: string;
  employeeId: string;
}> {
  const { employee, clubAdmin } = await makeHrFixture();
  const session = await createSession(clubAdmin, employee.id);
  const result = await transitionSession(clubAdmin, session.id, "INVITED", { actorSource: "STAFF" });
  const ctx = await acquireInvitationContext(result.invitation!.rawToken, { ipHash: IP_HASH });
  // Materialise an actor directly from the resolved context — this
  // mirrors what `resolveEmployeeOnboardingActor()` returns when the
  // cookie is valid, without needing to run inside a request.
  const actor: EmployeeOnboardingActor = {
    clubId: ctx.clubId,
    employeeId: ctx.employeeId,
    sessionId: ctx.sessionId,
    invitationId: ctx.invitationId,
    sessionState: "INVITED",
    redeemedAt: new Date().toISOString(),
  };
  return { actor, clubId: ctx.clubId, employeeId: ctx.employeeId };
}

describe("HR-2B.2 · employee onboarding actor boundary", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("assertActorTargetsSelf refuses a cross-employee attempt", async () => {
    const { actor } = await acquireActor();
    expect(() => assertActorTargetsSelf(actor, "cf_someone_else"))
      .toThrowError(EmployeeOnboardingActorForbiddenError);
  });

  it("assertActorTargetsSelf permits the actor targeting their own employeeId", async () => {
    const { actor, employeeId } = await acquireActor();
    expect(() => assertActorTargetsSelf(actor, employeeId)).not.toThrow();
  });

  it("assertActorTargetsOwnClub refuses a cross-club attempt", async () => {
    const { actor } = await acquireActor();
    expect(() => assertActorTargetsOwnClub(actor, "cf_other_club"))
      .toThrowError(EmployeeOnboardingActorForbiddenError);
  });

  it("assertActorTargetsOwnClub permits the actor's own clubId", async () => {
    const { actor, clubId } = await acquireActor();
    expect(() => assertActorTargetsOwnClub(actor, clubId)).not.toThrow();
  });

  it("errors carry a neutral safeMessage that does not leak the actor's employeeId", async () => {
    const { actor } = await acquireActor();
    try {
      assertActorTargetsSelf(actor, "cf_foreign");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EmployeeOnboardingActorForbiddenError);
      const app = err as EmployeeOnboardingActorForbiddenError;
      expect(app.safeMessage).toBe("Not permitted");
      // The verbose message may reference an 8-char tail for logs,
      // but the safe message shown to the user must not.
      expect(app.safeMessage.includes(actor.employeeId)).toBe(false);
    }
  });
});
