// HR-2A (2026-08-16) — POST /api/people/employees/[id]/invitation.
//
// Issues an onboarding invitation for a pre-hire employee by driving
// the canonical session `-> INVITED` transition (which invokes
// `issueInvitation` internally). The raw magic-link token is
// deliberately NEVER returned in the HTTP response body — HR-2A
// does not ship the employee-facing redemption page yet, so the
// raw token has nowhere legitimate to go. HR-2B replaces the dev-
// stderr log with a real email delivery pipeline.
//
// Discipline:
//   • Guarded by `hr:onboarding:invite` inside the canonical
//     `transitionSession` service (via `requirePermForTransition`).
//   • Refuses if the employee has no in-flight DRAFT session, or
//     if the session is not in a state that allows `-> INVITED`.
//   • Response body carries only `invitationId` + `expiresAt`.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isAppError } from "@/lib/errors";
import { transitionSession } from "@/lib/hr/onboarding-sessions";

const DEFAULT_INVITATION_TTL_HOURS = 168; // 7 days

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  // Find the current in-flight (non-terminal) session for this
  // employee. HR-2A always issues invitations against the DRAFT
  // session created at Add-Employee time.
  const session = await prisma.employeeOnboardingSession.findFirst({
    where: {
      employeeId: params.id,
      state: { notIn: ["REVOKED", "APPROVED"] },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, clubId: true, state: true },
  });
  if (!session) {
    return NextResponse.json(
      { error: "No in-flight onboarding session for this employee." },
      { status: 409 },
    );
  }

  try {
    const result = await transitionSession(principal, session.id, "INVITED", {
      ttlHours: DEFAULT_INVITATION_TTL_HOURS,
      actorSource: "STAFF",
    });
    if (!result.invitation) {
      // Guard rail — transitionSession(...) always returns an
      // invitation on the INVITED branch. If this ever fires, the
      // service contract changed and we refuse to silently succeed.
      return NextResponse.json(
        { error: "Invitation service did not return a token." },
        { status: 500 },
      );
    }

    // HR-2A.1 (2026-08-17) — TWO-LAYER FAIL-SECURE GATE for the
    // raw-token stderr log. HR-2B replaces this entirely with real
    // Club-branded email delivery. Until then, the token is only
    // logged when BOTH conditions hold:
    //   1. NODE_ENV is exactly "development" or "test"
    //      (production and staging both run NODE_ENV=production;
    //      an unset NODE_ENV also fails this check — fail-secure).
    //   2. SPECTRE_LOG_INVITATION_TOKENS === "1"
    //      (explicit local opt-in — a developer must consciously
    //      enable this in their .env.local; never set on any
    //      shared host).
    // The raw token MUST NOT be returned to the browser — the
    // employee-facing redemption page is not shipped yet and there
    // is nowhere legitimate for a browser-side token to go.
    const nodeEnv = process.env.NODE_ENV;
    const invitationTokenLoggingOptIn = process.env.SPECTRE_LOG_INVITATION_TOKENS === "1";
    const rawTokenLoggingEnabled =
      (nodeEnv === "development" || nodeEnv === "test") && invitationTokenLoggingOptIn;
    if (rawTokenLoggingEnabled) {
      // eslint-disable-next-line no-console -- dev-only, gated, replaced by HR-2B email delivery
      console.error(
        `[hr-invitation] token=${result.invitation.rawToken} employee=${params.id} expiresAt=${result.invitation.expiresAt.toISOString()} — HR-2B will replace this with real email delivery`,
      );
    }

    return NextResponse.json(
      {
        invitationId: result.invitation.invitationId,
        expiresAt: result.invitation.expiresAt.toISOString(),
        sessionState: result.session.state,
      },
      { status: 201 },
    );
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
