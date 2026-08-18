// HR-2B.2 (2026-08-18) — EmployeeOnboardingActor.
//
// The invited employee is deliberately NOT a Spectre administrative
// User. They authenticate via an iron-session cookie stamped after
// invitation redemption (see `employee-onboarding-session.ts`). Every
// employee-facing self-service operation flows through this actor
// abstraction — never through the `Principal` model, and never
// through an admin RBAC permission check.
//
// The actor's authority is derived entirely from:
//
//   1. Possession of a valid `spectre_hr_onboarding` cookie whose
//      signed contents match a live EmployeeOnboardingSession row.
//   2. That session being in a resumable state (INVITED or
//      IN_PROGRESS). Any other state (SUBMITTED / APPROVED /
//      REJECTED / REVOKED) tombstones the actor — no further
//      self-service writes are permitted.
//   3. The Employee row and Club row still exist and cross-reference
//      each other correctly.
//
// The actor CANNOT:
//   • act on any employee other than themselves;
//   • cross a Club boundary;
//   • invoke any admin-only HR service (compensation, employment
//     terms, approve/reject onboarding, etc.);
//   • re-target `employeeId` from a different Club whose cookie
//     they've replayed.
//
// This module intentionally does not import from `rbac.ts` — the
// two authorization stacks are separate by design.

import type { EmployeeOnboardingState } from "./employee-onboarding-state";
import { RESUMABLE_ONBOARDING_STATES } from "./employee-onboarding-state";
import { prisma } from "../prisma";
import { getEmployeeOnboardingSession } from "./employee-onboarding-session";
import { AppError } from "../errors";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------
export interface EmployeeOnboardingActor {
  readonly clubId: string;
  readonly employeeId: string;
  readonly sessionId: string;
  readonly invitationId: string;
  /** The current session state at resolve time. Callers may branch on
   *  this for UI (e.g. "still INVITED means we haven't triggered the
   *  first-answer transition yet"), but MUST NOT trust it for
   *  authorization — the resolver has already rejected non-resumable
   *  states before returning. */
  readonly sessionState: EmployeeOnboardingState;
  /** ISO timestamp of the invitation's original redemption, propagated
   *  from the signed cookie. Provenance only — not used for auth. */
  readonly redeemedAt: string;
}

// ---------------------------------------------------------------------------
// Typed errors — distinct from admin auth errors so route handlers
// render neutral employee-facing copy without leaking whether the
// failure was "no cookie" vs "session revoked" vs "cross-tenant
// mismatch".
// ---------------------------------------------------------------------------
export class EmployeeOnboardingActorNotAuthenticatedError extends AppError {
  constructor() {
    super(
      "HR_EMPLOYEE_ONBOARDING_NOT_AUTHENTICATED",
      "Employee onboarding session is not active",
      401,
      "Your onboarding session is no longer active",
    );
  }
}

export class EmployeeOnboardingActorForbiddenError extends AppError {
  constructor(reason: string) {
    super(
      "HR_EMPLOYEE_ONBOARDING_FORBIDDEN",
      `Employee onboarding actor forbidden: ${reason}`,
      403,
      "Not permitted",
    );
  }
}

// ---------------------------------------------------------------------------
// Resolver.
// ---------------------------------------------------------------------------
/**
 * Read the employee-onboarding cookie, re-verify it against Prisma on
 * every call, and return the actor. Returns `null` when the cookie is
 * missing, malformed, or the underlying rows have moved to a terminal
 * state. NEVER throws for the missing-cookie case — call
 * `requireEmployeeOnboardingActor()` if you want the throwing variant.
 *
 * Fresh DB read on every call — a stale cookie CANNOT be used to keep
 * accessing an onboarding whose session was revoked, submitted, or
 * whose Employee/Club was hard-deleted.
 */
export async function resolveEmployeeOnboardingActor(): Promise<EmployeeOnboardingActor | null> {
  const cookie = await getEmployeeOnboardingSession();
  if (!cookie.sessionId || !cookie.employeeId || !cookie.clubId || !cookie.invitationId) {
    return null;
  }

  // Fetch session + employee + club in a single trip so the tenant
  // triangle is verified without race windows.
  const session = await prisma.employeeOnboardingSession.findFirst({
    where: {
      id: cookie.sessionId,
      employeeId: cookie.employeeId,
      clubId: cookie.clubId,
    },
    select: {
      id: true,
      state: true,
      clubId: true,
      employeeId: true,
      employee: { select: { id: true, clubId: true } },
      club: { select: { id: true } },
    },
  });
  if (!session) return null;

  // Belt-and-braces: the Employee and Club rows referenced by the
  // session must exist AND their FKs must still line up with the
  // cookie. A tenant leak via cookie transplant would have to survive
  // ALL of: session.id match, session.employeeId==cookie.employeeId,
  // session.clubId==cookie.clubId, employee.clubId==cookie.clubId,
  // club.id==cookie.clubId.
  if (!session.employee || session.employee.clubId !== cookie.clubId) return null;
  if (!session.club || session.club.id !== cookie.clubId) return null;

  // Verify the invitation row still exists (staff may have hard-
  // revoked it; that should tombstone the actor even mid-flow).
  const invitation = await prisma.employeeOnboardingInvitation.findFirst({
    where: {
      id: cookie.invitationId,
      employeeId: cookie.employeeId,
      clubId: cookie.clubId,
    },
    select: { id: true, revokedAt: true, expiresAt: true },
  });
  if (!invitation) return null;
  if (invitation.revokedAt) return null;
  if (invitation.expiresAt.getTime() < Date.now()) return null;

  // Only resumable states are valid actor sources.
  const state = session.state as EmployeeOnboardingState;
  if (!(RESUMABLE_ONBOARDING_STATES as readonly string[]).includes(state)) {
    return null;
  }

  return {
    clubId: cookie.clubId,
    employeeId: cookie.employeeId,
    sessionId: cookie.sessionId,
    invitationId: cookie.invitationId,
    sessionState: state,
    redeemedAt: cookie.redeemedAt ?? new Date().toISOString(),
  };
}

/** Throwing variant. Use in server actions / API routes that MUST
 *  have an authenticated employee to proceed. */
export async function requireEmployeeOnboardingActor(): Promise<EmployeeOnboardingActor> {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) throw new EmployeeOnboardingActorNotAuthenticatedError();
  return actor;
}

// ---------------------------------------------------------------------------
// Self-scope assertion.
// ---------------------------------------------------------------------------
/**
 * Refuse if the actor tries to act on any employeeId other than their
 * own. This is the single choke point every self-service mutation
 * MUST call before touching the DB — even though the underlying
 * function typically derives the target from actor.employeeId, an
 * explicit check documents the invariant and defends against future
 * callers that accidentally pass a targetEmployeeId through.
 */
export function assertActorTargetsSelf(
  actor: EmployeeOnboardingActor,
  targetEmployeeId: string,
): void {
  if (targetEmployeeId !== actor.employeeId) {
    throw new EmployeeOnboardingActorForbiddenError(
      `actor.employeeId=${actor.employeeId.slice(-8)} attempted to act on ${targetEmployeeId.slice(-8)}`,
    );
  }
}

/**
 * Refuse if the actor's clubId does not match the target row's clubId.
 * Cross-tenant defense-in-depth — every self-service operation should
 * call this after loading its target row.
 */
export function assertActorTargetsOwnClub(
  actor: EmployeeOnboardingActor,
  targetClubId: string,
): void {
  if (targetClubId !== actor.clubId) {
    throw new EmployeeOnboardingActorForbiddenError(
      `actor.clubId=${actor.clubId.slice(-8)} attempted to reach club=${targetClubId.slice(-8)}`,
    );
  }
}
