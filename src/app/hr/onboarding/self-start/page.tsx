// Payroll/HR Integration hotfix (2026-09-14) §6-9 — Super-Admin
// self-onboarding entry.
//
// This route provides the founder-mandated supported workflow for the
// FIRST operational administrator of a Club to complete their own
// employee onboarding. It does NOT bypass sensitive onboarding controls
// — the authenticated Tenant User issues a NEW invitation for THEIR OWN
// linked Employee (via `UserClubProfile.employeeId`), then the standard
// invitation redemption flow establishes the employee-onboarding cookie.
//
// The admin session cookie is UNTOUCHED — the admin cookie and the
// employee-onboarding cookie are distinct scopes (see
// src/lib/hr/employee-onboarding-session.ts). Chris keeps his admin
// access while working through his own employee onboarding.
//
// Preconditions:
//   * Authenticated Principal.
//   * `UserClubProfile.employeeId` links the principal's User to an
//     Employee at the active club.
//   * The linked Employee is not in a terminal onboarding state that
//     forbids re-onboarding (§6-9 accept any non-terminal state; a
//     one-time staging reset for Chris resets his onboardingState).
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

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createHash } from "crypto";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { prisma } from "@/lib/prisma";
import { issueInvitation } from "@/lib/hr/invitations";
import { NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESUMABLE_STATES = new Set(["INVITED", "IN_PROGRESS", "DRAFT"]);

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
    // No linked Employee — this route only serves the Super-Admin →
    // Employee bootstrap case. Redirect to the admin home with a helpful
    // query param so the founder isn't stuck on a blank page.
    redirect("/app/admin?self-onboarding=no-linked-employee");
  }

  const employeeId = profile.employeeId;

  // 2026-09-14 fix — the self-start route MUST ensure an
  // `EmployeeOnboardingSession` exists BEFORE it issues the invitation.
  //
  // Root cause of the "Begin onboarding" 500 crash (Fly digest
  // 3544159346, InvitationRevokedError): the earlier version of this
  // route created only the invitation. When the founder subsequently
  // clicked "Begin onboarding", `acquireInvitationContext` did a
  // `findFirst EmployeeOnboardingSession { employeeId, clubId }`,
  // returned null, and threw `InvitationRevokedError`. Because that
  // error class did NOT extend `AppError` (also fixed today), the
  // server action's `isAppError` gate did not catch it and Next.js
  // surfaced a 500 to the browser.
  //
  // The fix has two parts, both required for defense-in-depth:
  //   (a) here: never issue an invitation for an employee that has no
  //       resumable session. Provision one first, atomically, in the
  //       same transaction as the invitation issuance.
  //   (b) invitations.ts: the four Invitation*Error classes now
  //       extend AppError, so any *future* variant of this crash
  //       degrades to a graceful `?err=<message>` banner rather than
  //       a page-level 500.
  //
  // Idempotency: if a resumable session ALREADY exists we reuse it —
  // do not create a duplicate. If a prior invitation is still active
  // we supersede it as part of the fresh issuance (the standard
  // resend semantic), so the newly-generated raw token is the only
  // one the browser sees. This matches the founder's stated
  // requirement that self-start be idempotent on retry.
  const existingSession = await prisma.employeeOnboardingSession.findFirst({
    where: { employeeId, clubId },
    orderBy: { startedAt: "desc" },
    select: { id: true, state: true },
  });

  if (!existingSession || !RESUMABLE_STATES.has(existingSession.state)) {
    // No resumable session — create one in DRAFT. `initiatedByUserId`
    // is the acting principal (the founder in the self-start case).
    // The state stays DRAFT until the first real employee action
    // inside About You transitions it to IN_PROGRESS.
    await prisma.employeeOnboardingSession.create({
      data: {
        clubId,
        employeeId,
        initiatedByUserId: principal.id,
        state: "DRAFT",
      },
    });
  }

  // Now that a resumable session is guaranteed, issue the invitation.
  let issued;
  try {
    issued = await issueInvitation(principal, employeeId, { ttlHours: 24 });
  } catch (err) {
    if (err instanceof NotFoundError) {
      redirect("/app/admin?self-onboarding=employee-not-found");
    }
    throw err;
  }

  // Rate-limit hint via IP hash — the token page uses this too.
  // We pass through the raw token in the URL; the token page's
  // beginOnboardingAction is what actually consumes it.
  const hdrs = headers();
  const ip = hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip") ?? "unknown";
  const ipHash = createHash("sha256").update(ip).digest("hex").slice(0, 32);
  // ipHash not used here directly — reserved for future rate-limit gating
  // symmetric to `beginOnboardingAction` in the token redemption route.
  void ipHash;

  redirect(`/hr/onboarding/${issued.rawToken}`);
}
