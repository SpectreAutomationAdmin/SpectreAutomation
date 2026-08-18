// HR-2B.3.1 (2026-08-18) §5 — POST /api/people/employees/[id]/invitation/resend.
//
// Admin action that supersedes the current invitation and issues a
// fresh one, THEN sends it through the SAME delegated Microsoft
// outbound path the initial invitation uses. No parallel mail stack.
//
// Response mirrors the initial-invitation route:
//   {
//     invitationId, expiresAt, sessionState,
//     supersededInvitationId,
//     email: { status, provider, externalSendConfirmed,
//              failureReason, operatorAlert, senderIdentity }
//   }
//
// HTTP status uses the same DELIVERED=201 / DEV_LOGGED|NOT_ATTEMPTED=202 /
// FAILED=502 vocabulary so the admin UI can render the four outcome
// banners with the existing InvitationOutcome component.
//
// The raw magic-link token NEVER leaves this handler; it lives only
// inside the outbound email URL and inside `reissueInvitation`'s
// return value.
//
// Discipline:
//   • Guarded by `hr:onboarding:invite` inside `reissueInvitation`
//     (composed with sensitive-action guard).
//   • Refuses for terminal sessions (`ConflictError` → 409).
//   • Refuses cross-tenant via `assertTenantOwned` inside the
//     canonical `loadEmployee` in `reissueInvitation`.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isAppError } from "@/lib/errors";
import { reissueInvitation } from "@/lib/hr/invitations";
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

  try {
    const result = await reissueInvitation(principal, params.id, {
      ttlHours: DEFAULT_INVITATION_TTL_HOURS,
    });

    // Resolve the outbound target the SAME way the initial-invitation
    // route does — canonical Employee.personalEmail, fallback work
    // email. Body-supplied recipients are structurally impossible
    // here (this handler reads no body).
    const employee = await prisma.employee.findUnique({
      where: { id: params.id },
      select: { clubId: true, personalEmail: true, email: true },
    });
    const toEmail = employee?.personalEmail ?? employee?.email ?? null;

    let delivery: Awaited<ReturnType<typeof sendInvitationEmail>> | null = null;
    if (!toEmail) {
      await persistInvitationDelivery(result.invitationId, {
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
        await persistInvitationDelivery(result.invitationId, {
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
          clubId: employee!.clubId,
          invitationId: result.invitationId,
          employeeId: params.id,
          toEmail,
          rawToken: result.rawToken,
          expiresAt: result.expiresAt,
          publicHost,
          callerUserId: principal.id,
        });
      }
    }

    const httpStatus =
      delivery.status === "DELIVERED" ? 201 :
      delivery.status === "DEV_LOGGED" ? 202 :
      delivery.status === "NOT_ATTEMPTED" ? 202 :
      // FAILED — invitation persisted but delivery failed.
      502;

    return NextResponse.json(
      {
        invitationId: result.invitationId,
        expiresAt: result.expiresAt.toISOString(),
        sessionState: result.sessionState,
        supersededInvitationId: result.supersededInvitationId,
        email: {
          status: delivery.status,
          provider: delivery.provider,
          externalSendConfirmed: delivery.externalSendConfirmed,
          failureReason: delivery.failureReason,
          operatorAlert: delivery.operatorAlert,
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
