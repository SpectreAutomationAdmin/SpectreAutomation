// HR-2B.5 §28-29, §46 — Self-service IN_PROGRESS → SUBMITTED transition.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { ConflictError } from "@/lib/errors";
import {
  acknowledgeSelfFinalSubmission,
  transitionSelfSessionToSubmitted,
} from "@/lib/hr/employee-self-service";
import { establishPortalPassword } from "@/lib/hr/employee-portal-credential";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";

async function makeReadyActor(clubId: string): Promise<{ actor: EmployeeOnboardingActor; sessionId: string }> {
  const initiator = await prisma.user.create({
    data: {
      email: `init-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`,
      name: "Init",
      role: "CLUB_ADMIN",
      passwordHash: "x",
      clubId,
      status: "ACTIVE",
    },
  });
  const employee = await prisma.employee.create({
    data: {
      clubId,
      employeeNumber: `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Chris",
      lastName: "Submit",
      personalEmail: `submit-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`,
    },
  });
  const session = await prisma.employeeOnboardingSession.create({
    data: {
      clubId,
      employeeId: employee.id,
      state: "IN_PROGRESS",
      initiatedByUserId: initiator.id,
    },
  });
  const actor: EmployeeOnboardingActor = {
    invitationId: "test-invitation",
    sessionId: session.id,
    employeeId: employee.id,
    clubId,
    sessionState: "IN_PROGRESS",
    redeemedAt: new Date().toISOString(),
  };
  return { actor, sessionId: session.id };
}

describe("HR-2B.5 · Employee submit-onboarding transition", () => {
  let fx: AdminHrFixture;

  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("SubmitFix");
  });

  it("refuses SUBMIT without final_submission_attestation ack (§28 readiness)", async () => {
    const { actor } = await makeReadyActor(fx.club.id);
    // Portal credential set but no ack.
    await establishPortalPassword(actor, {
      password: "some long enough passphrase",
      confirmPassword: "some long enough passphrase",
    });
    await expect(transitionSelfSessionToSubmitted(actor)).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses SUBMIT without portal credential (§28)", async () => {
    const { actor } = await makeReadyActor(fx.club.id);
    // Ack but no credential.
    await acknowledgeSelfFinalSubmission(actor);
    await expect(transitionSelfSessionToSubmitted(actor)).rejects.toBeInstanceOf(ConflictError);
  });

  it("with attestation + credential, transitions IN_PROGRESS → SUBMITTED + writes transition row", async () => {
    const { actor, sessionId } = await makeReadyActor(fx.club.id);
    await establishPortalPassword(actor, {
      password: "some long enough passphrase",
      confirmPassword: "some long enough passphrase",
    });
    await acknowledgeSelfFinalSubmission(actor);
    await transitionSelfSessionToSubmitted(actor);

    const s = await prisma.employeeOnboardingSession.findUnique({ where: { id: sessionId } });
    expect(s?.state).toBe("SUBMITTED");
    expect(s?.submittedAt).not.toBeNull();

    const emp = await prisma.employee.findUnique({ where: { id: actor.employeeId } });
    expect(emp?.onboardingState).toBe("SUBMITTED");

    const t = await prisma.employeeOnboardingStateTransition.findFirst({
      where: { sessionId, toState: "SUBMITTED" },
    });
    expect(t?.fromState).toBe("IN_PROGRESS");
    expect(t?.actorSource).toBe("EMPLOYEE");
    expect(t?.actorEmployeeId).toBe(actor.employeeId);
    expect(t?.actorUserId).toBeNull();
  });

  it("second submit is idempotent (returns session, no additional transition row)", async () => {
    const { actor, sessionId } = await makeReadyActor(fx.club.id);
    await establishPortalPassword(actor, {
      password: "some long enough passphrase",
      confirmPassword: "some long enough passphrase",
    });
    await acknowledgeSelfFinalSubmission(actor);
    await transitionSelfSessionToSubmitted(actor);
    await transitionSelfSessionToSubmitted(actor);
    const transitions = await prisma.employeeOnboardingStateTransition.count({
      where: { sessionId, toState: "SUBMITTED" },
    });
    expect(transitions).toBe(1);
  });

  it("SUBMIT does NOT set APPROVED (§29 Club review remains separate)", async () => {
    const { actor, sessionId } = await makeReadyActor(fx.club.id);
    await establishPortalPassword(actor, {
      password: "some long enough passphrase",
      confirmPassword: "some long enough passphrase",
    });
    await acknowledgeSelfFinalSubmission(actor);
    await transitionSelfSessionToSubmitted(actor);
    const s = await prisma.employeeOnboardingSession.findUnique({ where: { id: sessionId } });
    expect(s?.state).toBe("SUBMITTED");
    expect(s?.state).not.toBe("APPROVED");
    expect(s?.approvedAt).toBeNull();
  });

  it("transition audit is written with actorSource=EMPLOYEE and no plaintext material", async () => {
    const { actor } = await makeReadyActor(fx.club.id);
    await establishPortalPassword(actor, {
      password: "some long enough passphrase",
      confirmPassword: "some long enough passphrase",
    });
    await acknowledgeSelfFinalSubmission(actor);
    await transitionSelfSessionToSubmitted(actor);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "hr.onboarding.state.update" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    const serialized = JSON.stringify(audit);
    expect(serialized).toContain("SUBMITTED");
    expect(serialized).not.toContain("some long enough passphrase");
  });
});
