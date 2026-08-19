// HR-1 admin-workflows — onboarding session state machine.
//
//   DRAFT -> INVITED -> IN_PROGRESS -> SUBMITTED -> APPROVED
//                                                -> REJECTED
//   ANY -> REVOKED
//
// The INVITED transition calls invitations.issueInvitation and
// returns the raw token once. Every transition writes an
// EmployeeOnboardingStateTransition row.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  createSession,
  transitionSession,
  listTransitions,
  InvalidOnboardingTransitionError,
} from "@/lib/hr/onboarding-sessions";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "./_helpers";

describe("HR admin-workflows · onboarding session state machine", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("createSession -> DRAFT and updates Employee.onboardingState pointer", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    expect(session.state).toBe("DRAFT");
    const emp = await prisma.employee.findUnique({ where: { id: fx.employee.id } });
    expect(emp?.onboardingState).toBe("DRAFT");
  });

  it("valid sequence DRAFT -> INVITED -> IN_PROGRESS -> SUBMITTED -> APPROVED completes", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);

    const invited = await transitionSession(fx.clubAdmin, session.id, "INVITED");
    expect(invited.session.state).toBe("INVITED");
    expect(invited.invitation).toBeDefined();
    expect(invited.invitation!.rawToken.length).toBeGreaterThanOrEqual(40);

    const inProgress = await transitionSession(fx.clubAdmin, session.id, "IN_PROGRESS", {
      actorSource: "EMPLOYEE",
      actorEmployeeId: fx.employee.id,
    });
    expect(inProgress.session.state).toBe("IN_PROGRESS");

    const submitted = await transitionSession(fx.clubAdmin, session.id, "SUBMITTED", {
      actorSource: "EMPLOYEE",
      actorEmployeeId: fx.employee.id,
    });
    expect(submitted.session.state).toBe("SUBMITTED");
    expect(submitted.session.submittedAt).toBeTruthy();

    const approved = await transitionSession(fx.clubAdmin, session.id, "APPROVED");
    expect(approved.session.state).toBe("APPROVED");
    expect(approved.session.approvedAt).toBeTruthy();
    expect(approved.session.completedAt).toBeTruthy();

    // Employee.onboardingState pointer stayed in sync.
    const emp = await prisma.employee.findUnique({ where: { id: fx.employee.id } });
    expect(emp?.onboardingState).toBe("APPROVED");
  });

  it("invalid transition DRAFT -> APPROVED throws InvalidOnboardingTransitionError", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    await expect(
      transitionSession(fx.clubAdmin, session.id, "APPROVED"),
    ).rejects.toBeInstanceOf(InvalidOnboardingTransitionError);
  });

  it("REVOKED is reachable from any non-terminal state", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    const revoked = await transitionSession(fx.clubAdmin, session.id, "REVOKED");
    expect(revoked.session.state).toBe("REVOKED");
  });

  it("every transition writes an EmployeeOnboardingStateTransition row with the correct actorSource", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);

    await transitionSession(fx.clubAdmin, session.id, "INVITED"); // STAFF (default)
    await transitionSession(fx.clubAdmin, session.id, "IN_PROGRESS", {
      actorSource: "EMPLOYEE", actorEmployeeId: fx.employee.id,
    });
    await transitionSession(fx.clubAdmin, session.id, "SUBMITTED", {
      actorSource: "EMPLOYEE", actorEmployeeId: fx.employee.id,
    });

    const rows = await listTransitions(fx.clubAdmin, session.id);
    expect(rows.map((r) => r.toState)).toEqual(["INVITED", "IN_PROGRESS", "SUBMITTED"]);
    expect(rows[0].actorSource).toBe("STAFF");
    expect(rows[0].actorUserId).toBe(fx.clubAdmin.id);
    expect(rows[1].actorSource).toBe("EMPLOYEE");
    expect(rows[1].actorEmployeeId).toBe(fx.employee.id);
    expect(rows[1].actorUserId).toBeNull();
    expect(rows[2].actorSource).toBe("EMPLOYEE");

    // From -> To sequence.
    expect(rows[0].fromState).toBe("DRAFT");
    expect(rows[1].fromState).toBe("INVITED");
    expect(rows[2].fromState).toBe("IN_PROGRESS");
  });

  it("transition to INVITED issues an EmployeeOnboardingInvitation for the session's employee", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    const result = await transitionSession(fx.clubAdmin, session.id, "INVITED", {
      ttlHours: 48,
    });
    expect(result.invitation).toBeDefined();
    // The Invitation row exists, keyed on the SAME employeeId.
    const invitation = await prisma.employeeOnboardingInvitation.findFirst({
      where: { id: result.invitation!.invitationId },
    });
    expect(invitation).toBeTruthy();
    expect(invitation?.employeeId).toBe(fx.employee.id);
  });

  it("transition SUBMITTED -> REJECTED records rejectionReason", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    await transitionSession(fx.clubAdmin, session.id, "INVITED");
    await transitionSession(fx.clubAdmin, session.id, "IN_PROGRESS", { actorSource: "EMPLOYEE" });
    await transitionSession(fx.clubAdmin, session.id, "SUBMITTED", { actorSource: "EMPLOYEE" });
    const rejected = await transitionSession(fx.clubAdmin, session.id, "REJECTED", {
      rejectionReason: "Missing signed employment agreement",
    });
    expect(rejected.session.state).toBe("REJECTED");
    const row = await prisma.employeeOnboardingSession.findUnique({ where: { id: session.id } });
    expect(row?.rejectionReason).toBe("Missing signed employment agreement");
  });
});
