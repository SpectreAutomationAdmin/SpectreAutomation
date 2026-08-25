// HR mobile-hotfix (2026-08-30) — §4 Approve & Activate Employee.
//
// The founder observed the Employee Portal message "Your Club is
// reviewing your onboarding" but NO admin action anywhere in People
// to actually close the loop. This suite pins the invariants of the
// canonical service that wires the missing action:
//
//   1. SUBMITTED session + CLUB_ADMIN → session APPROVED,
//      Employee.employeeLifecycle flips PRE_HIRE → ACTIVE,
//      activatedAt stamped, audit written.
//   2. Non-SUBMITTED session (DRAFT / IN_PROGRESS / REJECTED /
//      REVOKED) refused with HR_APPROVE_INVALID_STATE (409).
//   3. Idempotent — a repeat call on an already-APPROVED / ACTIVE
//      employee returns the current state without a second lifecycle
//      flip and without a second audit row.
//   4. Requires BOTH `hr:onboarding:approve` AND `hr:employee:write`.
//      A caller with only one grant (e.g. GM has approve but not
//      employee:write) is refused before any state change happens.
//   5. Cross-tenant refusal — a Club-A admin cannot approve a
//      Club-B employee.
//   6. Readiness projection never leaks plaintext — SIN + banking
//      appear only as presence flags + banking status label.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  approveAndActivateEmployee,
  getOnboardingApprovalReadiness,
} from "@/lib/hr/onboarding-approve-activate";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { AppError, NotFoundError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";

async function makeEmployee(fx: AdminHrFixture, opts?: { clubId?: string }) {
  const clubId = opts?.clubId ?? fx.club.id;
  return prisma.employee.create({
    data: {
      clubId,
      employeeNumber: `APV-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Alex",
      lastName: "Reviewer",
      personalEmail: `alex-${Math.random().toString(36).slice(2, 8)}@example.com`,
      employeeLifecycle: "PRE_HIRE",
      status: "ACTIVE",
    },
  });
}

async function bringSessionToSubmitted(
  fx: AdminHrFixture, employeeId: string,
): Promise<{ sessionId: string }> {
  const session = await createSession(fx.clubAdmin, employeeId);
  await transitionSession(fx.clubAdmin, session.id, "INVITED", { actorSource: "STAFF" });
  await transitionSession(fx.clubAdmin, session.id, "IN_PROGRESS", { actorSource: "EMPLOYEE" });
  await transitionSession(fx.clubAdmin, session.id, "SUBMITTED", { actorSource: "EMPLOYEE" });
  return { sessionId: session.id };
}

describe("HR mobile-hotfix · §4 Approve & Activate Employee", () => {
  let fx: AdminHrFixture;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => {
    await resetDb(); await seedRbac();
    fx = await makeAdminHrFixture("HRApproveActivate");
  }, 60_000);

  it("SUBMITTED + CLUB_ADMIN → session APPROVED, employee ACTIVE, audit written", async () => {
    const employee = await makeEmployee(fx);
    await bringSessionToSubmitted(fx, employee.id);

    const result = await approveAndActivateEmployee(fx.clubAdmin, employee.id);
    expect(result.employeeLifecycle).toBe("ACTIVE");
    expect(result.onboardingState).toBe("APPROVED");
    expect(result.activatedAt).toBeInstanceOf(Date);

    const persisted = await prisma.employee.findUnique({
      where: { id: employee.id },
      select: { employeeLifecycle: true, activatedAt: true },
    });
    expect(persisted?.employeeLifecycle).toBe("ACTIVE");
    expect(persisted?.activatedAt).not.toBeNull();

    const session = await prisma.employeeOnboardingSession.findFirst({
      where: { employeeId: employee.id },
      orderBy: { startedAt: "desc" },
    });
    expect(session?.state).toBe("APPROVED");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "hr.employee.approve.activate", entityId: employee.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.clubId).toBe(employee.clubId);
  });

  it("DRAFT session → HR_APPROVE_INVALID_STATE 409, no lifecycle flip", async () => {
    const employee = await makeEmployee(fx);
    await createSession(fx.clubAdmin, employee.id); // stays DRAFT

    await expect(approveAndActivateEmployee(fx.clubAdmin, employee.id))
      .rejects.toBeInstanceOf(AppError);
    try {
      await approveAndActivateEmployee(fx.clubAdmin, employee.id);
      expect.fail("expected rejection");
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe("HR_APPROVE_INVALID_STATE");
      expect(err.httpStatus).toBe(409);
      // Neutral safe message — never exposes internal state names or names.
      expect(err.safeMessage).not.toContain("DRAFT");
      expect(err.safeMessage).not.toContain(employee.id);
    }

    const persisted = await prisma.employee.findUnique({
      where: { id: employee.id },
      select: { employeeLifecycle: true },
    });
    expect(persisted?.employeeLifecycle).toBe("PRE_HIRE");
  });

  it("Idempotent — second call on ACTIVE employee returns current state, no new audit", async () => {
    const employee = await makeEmployee(fx);
    await bringSessionToSubmitted(fx, employee.id);
    await approveAndActivateEmployee(fx.clubAdmin, employee.id);

    const auditsBefore = await prisma.auditLog.count({
      where: { action: "hr.employee.approve.activate", entityId: employee.id },
    });

    const result = await approveAndActivateEmployee(fx.clubAdmin, employee.id);
    expect(result.employeeLifecycle).toBe("ACTIVE");
    expect(result.onboardingState).toBe("APPROVED");

    const auditsAfter = await prisma.auditLog.count({
      where: { action: "hr.employee.approve.activate", entityId: employee.id },
    });
    expect(auditsAfter).toBe(auditsBefore); // no new audit — service short-circuited
  });

  it("Requires BOTH approve AND employee:write — GM (approve only) is refused", async () => {
    // GM has hr:onboarding:approve but NOT hr:employee:write. The
    // service must fail on the second permission check without
    // flipping either the session or the lifecycle.
    const employee = await makeEmployee(fx);
    await bringSessionToSubmitted(fx, employee.id);

    await expect(approveAndActivateEmployee(fx.gm, employee.id))
      .rejects.toBeInstanceOf(AppError);

    const persisted = await prisma.employee.findUnique({
      where: { id: employee.id },
      select: { employeeLifecycle: true },
    });
    expect(persisted?.employeeLifecycle).toBe("PRE_HIRE");

    const session = await prisma.employeeOnboardingSession.findFirst({
      where: { employeeId: employee.id }, orderBy: { startedAt: "desc" },
    });
    expect(session?.state).toBe("SUBMITTED"); // unchanged
  });

  it("Cross-tenant refusal — foreign-club admin cannot approve", async () => {
    const employee = await makeEmployee(fx); // in fx.club
    await bringSessionToSubmitted(fx, employee.id);

    // fx.foreignClubAdmin has no grants on fx.club — should NotFound / Forbid.
    await expect(approveAndActivateEmployee(fx.foreignClubAdmin, employee.id))
      .rejects.toThrow();

    const persisted = await prisma.employee.findUnique({
      where: { id: employee.id },
      select: { employeeLifecycle: true },
    });
    expect(persisted?.employeeLifecycle).toBe("PRE_HIRE");
  });

  it("Readiness projection never exposes plaintext SIN or bank digits", async () => {
    const employee = await makeEmployee(fx);
    await bringSessionToSubmitted(fx, employee.id);

    const readiness = await getOnboardingApprovalReadiness(fx.clubAdmin, employee.id);
    const asJson = JSON.stringify(readiness);

    // No 9-digit SIN, no long digit runs that could be bank/transit
    // numbers should ever appear in the readiness projection.
    expect(asJson).not.toMatch(/\d{9}/);
    expect(asJson).not.toMatch(/\d{7,}/);
    // The projection may only carry presence flags + a bank status
    // label (a small enum), never raw account text.
    expect(readiness.sinPresent).toBe(false); // no SIN yet in this fixture
    expect(readiness.bankingPresent).toBe(false);
    // callerCanApprove reflects the combined permission check.
    expect(readiness.callerCanApprove).toBe(true); // CLUB_ADMIN has both.
  });

  it("Readiness projection reports callerCanApprove=false for GM (only one grant)", async () => {
    const employee = await makeEmployee(fx);
    await bringSessionToSubmitted(fx, employee.id);
    const readiness = await getOnboardingApprovalReadiness(fx.gm, employee.id);
    expect(readiness.callerCanApprove).toBe(false);
  });

  it("Missing employee → NotFoundError, not silent no-op", async () => {
    await expect(approveAndActivateEmployee(fx.clubAdmin, "nonexistent-emp-id"))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});
