// HR-1 (2026-08-16) — EmployeeOnboardingSession service.
//
// State machine:
//   DRAFT -> INVITED -> IN_PROGRESS -> SUBMITTED -> APPROVED
//                                                -> REJECTED
//   ANY -> REVOKED
//
// Every transition writes an EmployeeOnboardingStateTransition row
// carrying fromState / toState / actorSource / actor id.
//
// Transition to INVITED CALLS `invitations.issueInvitation` — this is
// the ONE authoritative site the session lifecycle invokes the
// invitation service, so we do NOT duplicate invitation audit
// action strings here.
//
// Writes require `hr:onboarding:invite` / `hr:onboarding:approve` /
// `hr:onboarding:revoke` per the transition table below, all with
// sensitive-action guard on the session action string
// `hr.onboarding.state.update`.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, isSuperAdmin, requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";
import { issueInvitation } from "./invitations";

const SESSION_ENTITY = "EmployeeOnboardingSession";
const TRANSITION_ENTITY = "EmployeeOnboardingStateTransition";

export type OnboardingState =
  | "DRAFT"
  | "INVITED"
  | "IN_PROGRESS"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED"
  | "REVOKED";

export type ActorSource = "STAFF" | "EMPLOYEE" | "SYSTEM";

// Machine — allowed transitions.
const VALID_TRANSITIONS: Record<OnboardingState, OnboardingState[]> = {
  DRAFT: ["INVITED", "REVOKED"],
  INVITED: ["IN_PROGRESS", "REVOKED"],
  IN_PROGRESS: ["SUBMITTED", "REVOKED"],
  SUBMITTED: ["APPROVED", "REJECTED", "REVOKED"],
  APPROVED: ["REVOKED"], // once approved, only revoke is possible
  REJECTED: ["INVITED", "REVOKED"], // re-invite after rejection
  REVOKED: [], // terminal
};

// Which permission gates which transition.
function requirePermForTransition(
  principal: Principal,
  clubId: string,
  to: OnboardingState,
) {
  switch (to) {
    case "INVITED":
      requirePermission(principal, clubId, "hr:onboarding:invite");
      return;
    case "APPROVED":
    case "REJECTED":
      requirePermission(principal, clubId, "hr:onboarding:approve");
      return;
    case "REVOKED":
      requirePermission(principal, clubId, "hr:onboarding:revoke");
      return;
    default:
      // IN_PROGRESS / SUBMITTED — advanced by the employee themselves
      // from the redemption flow. When a staff principal drives this
      // transition (rare, e.g. an admin correcting state), require
      // the invite grant.
      requirePermission(principal, clubId, "hr:onboarding:invite");
  }
}

export class InvalidOnboardingTransitionError extends AppError {
  readonly fromState: OnboardingState;
  readonly toState: OnboardingState;
  constructor(fromState: OnboardingState, toState: OnboardingState) {
    super(
      "HR_INVALID_ONBOARDING_TRANSITION",
      `Invalid onboarding transition ${fromState} -> ${toState}`,
      409,
      "Invalid state transition",
    );
    this.fromState = fromState;
    this.toState = toState;
  }
}

async function loadEmployee(principal: Principal, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  return employee;
}

async function loadSession(principal: Principal, sessionId: string) {
  const session = await prisma.employeeOnboardingSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new NotFoundError(SESSION_ENTITY, sessionId);
  assertTenantOwned(session, principal);
  return session;
}

// ---------------------------------------------------------------------------
// Create (staff-initiated).
// ---------------------------------------------------------------------------
/**
 * Create a new DRAFT onboarding session for `employeeId`. Every
 * employee may have at most one non-terminal (non-REVOKED / non-
 * APPROVED) session at a time.
 */
export async function createSession(
  principal: Principal,
  employeeId: string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:onboarding:invite");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.onboarding.session.create",
    SESSION_ENTITY,
    employeeId,
  );

  // Refuse if there's an in-flight session for this employee.
  const inflight = await prisma.employeeOnboardingSession.findFirst({
    where: {
      employeeId,
      state: { notIn: ["REVOKED", "APPROVED"] },
    },
  });
  if (inflight) {
    throw new ValidationError([{
      path: "employeeId",
      message: `Employee already has an in-flight onboarding session (id=${inflight.id}, state=${inflight.state})`,
    }]);
  }

  const created = await prisma.employeeOnboardingSession.create({
    data: {
      clubId: employee.clubId,
      employeeId,
      initiatedByUserId: principal.id,
      state: "DRAFT",
    },
  });

  // Sync the Employee.onboardingState pointer.
  await prisma.employee.update({
    where: { id: employeeId },
    data: { onboardingState: "DRAFT" },
  });

  await audit(principal, {
    action: "hr.onboarding.session.create",
    entityType: SESSION_ENTITY,
    entityId: created.id,
    clubId: employee.clubId,
    after: {
      id: created.id,
      state: created.state,
      initiatedByUserId: created.initiatedByUserId,
    },
  });

  return created;
}

// ---------------------------------------------------------------------------
// Transition (staff-driven or system-driven).
// ---------------------------------------------------------------------------
export interface TransitionOpts {
  actorSource?: ActorSource;
  actorEmployeeId?: string | null;
  reason?: string | null;
  /** Only relevant for `-> INVITED`. TTL for the issued invitation. */
  ttlHours?: number;
  /** Only relevant for `-> REJECTED`. */
  rejectionReason?: string | null;
}

/**
 * Transition a session to a new state. Refuses invalid transitions
 * via `InvalidOnboardingTransitionError`. Writes an
 * EmployeeOnboardingStateTransition row.
 *
 * The `-> INVITED` branch calls `invitations.issueInvitation()` and
 * returns the raw magic-link token in the result (once — never
 * stored on the session).
 */
export async function transitionSession(
  principal: Principal,
  sessionId: string,
  toState: OnboardingState,
  opts: TransitionOpts = {},
): Promise<{
  session: {
    id: string;
    state: OnboardingState;
    submittedAt: Date | null;
    approvedAt: Date | null;
    rejectedAt: Date | null;
    completedAt: Date | null;
  };
  transitionId: string;
  invitation?: { invitationId: string; rawToken: string; expiresAt: Date };
}> {
  const session = await loadSession(principal, sessionId);
  requirePermForTransition(principal, session.clubId, toState);
  await assertSensitiveActionAllowed(
    principal,
    session.clubId,
    "hr.onboarding.state.update",
    SESSION_ENTITY,
    sessionId,
  );

  const fromState = session.state as OnboardingState;
  const allowed = VALID_TRANSITIONS[fromState] ?? [];
  if (!allowed.includes(toState)) {
    throw new InvalidOnboardingTransitionError(fromState, toState);
  }

  const now = new Date();
  const data: Record<string, unknown> = { state: toState };
  if (toState === "SUBMITTED") data.submittedAt = now;
  if (toState === "APPROVED") {
    data.approvedAt = now;
    data.approvedByUserId = principal.id;
    data.completedAt = now;
  }
  if (toState === "REJECTED") {
    data.rejectedAt = now;
    data.rejectionReason = opts.rejectionReason ?? null;
  }

  // Issue an invitation as part of the INVITED transition.
  let invitationResult: { invitationId: string; rawToken: string; expiresAt: Date } | undefined;
  if (toState === "INVITED") {
    invitationResult = await issueInvitation(principal, session.employeeId, {
      ttlHours: opts.ttlHours,
    });
  }

  const updated = await prisma.employeeOnboardingSession.update({
    where: { id: sessionId },
    data,
  });

  // Sync Employee.onboardingState pointer.
  await prisma.employee.update({
    where: { id: session.employeeId },
    data: { onboardingState: toState },
  });

  const actorSource: ActorSource = opts.actorSource ?? "STAFF";
  const transition = await prisma.employeeOnboardingStateTransition.create({
    data: {
      clubId: session.clubId,
      employeeId: session.employeeId,
      sessionId,
      fromState,
      toState,
      actorSource,
      actorUserId: actorSource === "STAFF" ? principal.id : null,
      actorEmployeeId: opts.actorEmployeeId ?? null,
      reason: opts.reason ?? null,
      at: now,
    },
  });

  await audit(principal, {
    action: "hr.onboarding.state.update",
    entityType: TRANSITION_ENTITY,
    entityId: transition.id,
    clubId: session.clubId,
    before: { state: fromState },
    after: {
      state: toState,
      sessionId,
      transitionId: transition.id,
      invitationIdTail: invitationResult?.invitationId.slice(-8) ?? null,
    },
  });

  return {
    session: {
      id: updated.id,
      state: updated.state as OnboardingState,
      submittedAt: updated.submittedAt,
      approvedAt: updated.approvedAt,
      rejectedAt: updated.rejectedAt,
      completedAt: updated.completedAt,
    },
    transitionId: transition.id,
    invitation: invitationResult,
  };
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------
export async function getSession(
  principal: Principal,
  sessionId: string,
) {
  const session = await loadSession(principal, sessionId);
  requirePermission(principal, session.clubId, "hr:onboarding:read");
  return session;
}

export async function listSessions(
  principal: Principal,
  employeeId: string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:onboarding:read");
  return prisma.employeeOnboardingSession.findMany({
    where: { employeeId },
    orderBy: { startedAt: "desc" },
  });
}

export async function listTransitions(
  principal: Principal,
  sessionId: string,
) {
  const session = await loadSession(principal, sessionId);
  requirePermission(principal, session.clubId, "hr:onboarding:read");
  return prisma.employeeOnboardingStateTransition.findMany({
    where: { sessionId },
    orderBy: { at: "asc" },
  });
}

// Escape hatch — an admin can hard-check read of any session even
// without a session id (paged directory view).
export async function listOpenSessionsForClub(
  principal: Principal,
  clubId: string,
) {
  requirePermission(principal, clubId, "hr:onboarding:read");
  if (!isSuperAdmin(principal) && !hasPermission(principal, clubId, "hr:onboarding:read")) {
    throw new ForbiddenError("Missing permission: hr:onboarding:read");
  }
  return prisma.employeeOnboardingSession.findMany({
    where: { clubId, state: { notIn: ["REVOKED", "APPROVED"] } },
    orderBy: { startedAt: "desc" },
  });
}
