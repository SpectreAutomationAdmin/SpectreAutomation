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
import {
  persistInvitationDelivery,
  sendInvitationEmail,
} from "@/lib/hr/invitation-email";

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

    // HR-2B.1 (2026-08-18) — Real branded email delivery via the
    // canonical selectEmailAdapter(clubId) stack.
    // HR-2B.3 tail (2026-08-20) — inspect the send result + persist
    // the delivery status on the invitation row + surface distinct
    // response codes so the admin UI no longer masquerades a
    // console-only DEV_LOGGED as SENT.
    //
    // The raw magic-link token is embedded ONLY in the outbound email
    // body's URL and is NEVER returned to the browser, logged to
    // stderr, or persisted after this call.
    const employee = await prisma.employee.findUnique({
      where: { id: params.id },
      select: { personalEmail: true, email: true },
    });
    const toEmail = employee?.personalEmail ?? employee?.email ?? null;

    let delivery: Awaited<ReturnType<typeof sendInvitationEmail>> | null = null;
    if (!toEmail) {
      // Mark NOT_ATTEMPTED so the invitation row records the operator's
      // recoverable state (add a personal email → resend).
      await persistInvitationDelivery(result.invitation.invitationId, {
        status: "NOT_ATTEMPTED",
        provider: null,
        providerMessageId: null,
        failureReason: "no recipient email on file",
        externalSendConfirmed: false,
      });
      delivery = {
        status: "NOT_ATTEMPTED",
        provider: null,
        providerMessageId: null,
        failureReason: "no recipient email on file",
        externalSendConfirmed: false,
        operatorAlert: true,
      };
    } else {
      const publicHost = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
      if (!publicHost) {
        // Same treatment — invitation persisted but delivery not
        // attempted because we cannot construct a redemption URL.
        await persistInvitationDelivery(result.invitation.invitationId, {
          status: "NOT_ATTEMPTED",
          provider: null,
          providerMessageId: null,
          failureReason: "APP_URL not configured",
          externalSendConfirmed: false,
        });
        delivery = {
          status: "NOT_ATTEMPTED",
          provider: null,
          providerMessageId: null,
          failureReason: "APP_URL not configured",
          externalSendConfirmed: false,
          operatorAlert: true,
        };
      } else {
        delivery = await sendInvitationEmail({
          clubId: session.clubId,
          invitationId: result.invitation.invitationId,
          employeeId: params.id,
          toEmail,
          rawToken: result.invitation.rawToken,
          expiresAt: result.invitation.expiresAt,
          publicHost,
          // HR-2B.3 tail — thread the acting user id through to the
          // delegated adapter's token-refresh audit trail. The
          // delegated sender is the Club's designated Work Intake
          // mailbox, NOT this principal — but the audit event for
          // token refresh records who triggered the send.
          callerUserId: principal.id,
        });
      }
    }

    // HR-2A.1 dev opt-in stderr log — retained ONLY when both
    // NODE_ENV ∈ {"development","test"} AND SPECTRE_LOG_INVITATION_TOKENS=1
    // hold. Real email delivery (above) has replaced this in every
    // other environment. Kept for local-flow exercise convenience
    // when SMTP isn't configured on a developer machine.
    const nodeEnv = process.env.NODE_ENV;
    const invitationTokenLoggingOptIn = process.env.SPECTRE_LOG_INVITATION_TOKENS === "1";
    if ((nodeEnv === "development" || nodeEnv === "test") && invitationTokenLoggingOptIn) {
      // eslint-disable-next-line no-console -- dev-only, gated
      console.error(
        `[hr-invitation] token=${result.invitation.rawToken} employee=${params.id} expiresAt=${result.invitation.expiresAt.toISOString()}`,
      );
    }

    // Distinct HTTP outcomes — invitation is always persisted (201);
    // the `email` block tells the UI whether external delivery
    // actually happened. Never expose the raw token.
    const httpStatus =
      delivery.status === "DELIVERED" ? 201 :
      delivery.status === "DEV_LOGGED" ? 202 :
      delivery.status === "NOT_ATTEMPTED" ? 202 :
      // FAILED: invitation persisted but delivery unambiguously
      // failed. 502 tells the admin UI to surface the recoverable
      // "invitation created, email failed" state.
      502;

    return NextResponse.json(
      {
        invitationId: result.invitation.invitationId,
        expiresAt: result.invitation.expiresAt.toISOString(),
        sessionState: result.session.state,
        email: {
          status: delivery.status,
          provider: delivery.provider,
          externalSendConfirmed: delivery.externalSendConfirmed,
          failureReason: delivery.failureReason,
          operatorAlert: delivery.operatorAlert,
          // HR-2B.3 tail — when the delegated Work Intake mailbox
          // fired the send, surface the connected mailbox address the
          // recipient will see. Safe to display in the Club-side UI;
          // never carries tokens or scopes.
          senderIdentity: delivery.senderIdentity ?? null,
        },
      },
      { status: httpStatus },
    );
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
