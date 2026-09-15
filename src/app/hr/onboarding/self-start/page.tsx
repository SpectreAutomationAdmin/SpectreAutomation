// Payroll/HR Integration hotfix (2026-09-14) §6-9 — Super-Admin
// self-onboarding entry.
// v399 Slice-1 follow-up (2026-09-15) — converge with canonical
//   admin invitation state machine (see §block below).
//
// This route provides the founder-mandated supported workflow for the
// FIRST operational administrator of a Club to complete their own
// employee onboarding. It does NOT bypass sensitive onboarding controls
// — the authenticated Tenant User walks through the SAME canonical
// state machine an admin uses to invite a normal Employee.
//
// The admin session cookie is UNTOUCHED — the admin cookie and the
// employee-onboarding cookie are distinct scopes (see
// src/lib/hr/employee-onboarding-session.ts). The founder keeps their
// admin access while working through their own employee onboarding.
//
// Preconditions:
//   * Authenticated Principal.
//   * `UserClubProfile.employeeId` links the principal's User to an
//     Employee at the active club.
//   * The linked Employee's session is either not-yet-created, or in
//     a non-terminal state (DRAFT/INVITED/IN_PROGRESS). Terminal
//     states (SUBMITTED/APPROVED/REJECTED/REVOKED) route back to the
//     admin home — completing / resuming those is a different flow.
//   * The caller holds `hr:onboarding:invite` — same permission any
//     admin holds to invite others (CLUB_ADMIN grants it).
//
// Security:
//   * Employee-controlled portions of onboarding (SIN, banking, TD1,
//     acknowledgements) remain employee-controlled — the same flow a
//     regular Employee completes.
//   * SUPER_ADMIN status does NOT unlock sensitive-data reveal rules
//     inside the onboarding flow — the reveal service still gates by
//     scoped permissions + audit.

// -----------------------------------------------------------------------------
// v399 Slice-1 follow-up (2026-09-15) — canonical state-machine convergence.
//
// The v399 fix ensured a DRAFT `EmployeeOnboardingSession` existed before
// `issueInvitation`, but that was NOT the canonical flow. The canonical
// admin invitation path is:
//
//   1. `createSession(principal, employeeId)`            → session state = DRAFT
//   2. `transitionSession(principal, sessionId,          → session state = INVITED,
//         "INVITED", { ttlHours, actorSource: "STAFF" })   invitation issued atomically
//
// The employee then, via the redemption route + About You:
//
//   3. `transitionSelfSessionToInProgress(actor)`        → session state = IN_PROGRESS
//   4. `transitionSelfSessionToSubmitted(actor)`         → session state = SUBMITTED
//
// And the admin:
//
//   5. `transitionSession(principal, sessionId, "APPROVED", ...)` → APPROVED
//
// v399's self-start called `issueInvitation` directly and left the
// session in DRAFT. `markInProgress` in about-you gates on `sessionState
// === "INVITED"`, so it silently no-op'd. The employee completed every
// section against a DRAFT session, then Submit failed with:
//
//   Cannot transition session from DRAFT to SUBMITTED via employee actor
//
// This follow-up switches self-start to the canonical primitive:
//   * If no session exists: `createSession` (DRAFT), then `transitionSession`
//     (→ INVITED, issues invitation). ONE canonical two-step path — same
//     as an admin issuing the first invitation for an Employee they
//     just created.
//   * If a session exists in DRAFT: `transitionSession(→ INVITED)`.
//   * If a session exists in INVITED or IN_PROGRESS: `reissueInvitation`
//     (fresh magic link, session state unchanged — same as an admin
//     clicking "Resend").
//   * Terminal states: refuse gracefully by redirecting to admin home
//     with a query-param hint.
// -----------------------------------------------------------------------------

import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { prisma } from "@/lib/prisma";
import { reissueInvitation } from "@/lib/hr/invitations";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVITATION_TTL_HOURS = 24;

export default async function SelfStartOnboardingPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });

  // Resolve the authenticated User's linked Employee at this club.
  const profile = await prisma.userClubProfile.findFirst({
    where: { clubId, userId: principal.id },
    select: { employeeId: true },
  });
  if (!profile || !profile.employeeId) {
    redirect("/app/admin?self-onboarding=no-linked-employee");
  }

  const employeeId = profile.employeeId;

  // Look up the most recent session for this employee.
  const existingSession = await prisma.employeeOnboardingSession.findFirst({
    where: { employeeId, clubId },
    orderBy: { startedAt: "desc" },
    select: { id: true, state: true },
  });

  let rawToken: string;

  if (!existingSession) {
    // Canonical two-step: DRAFT session → INVITED transition (+invitation).
    // Same primitives POST /api/people/employees uses when an admin adds
    // an Employee, followed by POST /api/people/employees/[id]/invitation.
    const created = await createSession(principal, employeeId);
    try {
      const result = await transitionSession(principal, created.id, "INVITED", {
        ttlHours: INVITATION_TTL_HOURS,
        actorSource: "STAFF",
      });
      if (!result.invitation) {
        throw new Error("Invitation service did not return a token.");
      }
      rawToken = result.invitation.rawToken;
    } catch (err) {
      if (err instanceof NotFoundError) {
        redirect("/app/admin?self-onboarding=employee-not-found");
      }
      throw err;
    }
  } else if (existingSession.state === "DRAFT") {
    // Session exists but never transitioned. Advance it now.
    try {
      const result = await transitionSession(principal, existingSession.id, "INVITED", {
        ttlHours: INVITATION_TTL_HOURS,
        actorSource: "STAFF",
      });
      if (!result.invitation) {
        throw new Error("Invitation service did not return a token.");
      }
      rawToken = result.invitation.rawToken;
    } catch (err) {
      if (err instanceof NotFoundError) {
        redirect("/app/admin?self-onboarding=employee-not-found");
      }
      throw err;
    }
  } else if (existingSession.state === "INVITED" || existingSession.state === "IN_PROGRESS") {
    // Session is already resumable. Issue a fresh magic link via the
    // canonical resend primitive — state stays where it is (no admin
    // ever "goes back" from IN_PROGRESS to INVITED to resend a link).
    try {
      const reissued = await reissueInvitation(principal, employeeId, {
        ttlHours: INVITATION_TTL_HOURS,
      });
      rawToken = reissued.rawToken;
    } catch (err) {
      if (err instanceof NotFoundError) {
        redirect("/app/admin?self-onboarding=employee-not-found");
      }
      throw err;
    }
  } else {
    // Terminal state (SUBMITTED / APPROVED / REJECTED / REVOKED).
    // Self-start is not the flow for completing a submitted onboarding.
    redirect(
      `/app/admin?self-onboarding=terminal-state&state=${encodeURIComponent(existingSession.state)}`,
    );
  }

  redirect(`/hr/onboarding/${rawToken}`);
}
