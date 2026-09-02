// TA-1B closeout — Invitation resend + revoke endpoints.
//
// Resend rotates the token, sends a new email, and reports delivery
// status. The activation URL is only surfaced when
// SPECTRE_ALLOW_ACTIVATION_URL=true AND the caller is SUPER_ADMIN AND
// ?includeActivationUrl=true is set — see the parent route.ts header.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isSuperAdmin } from "@/lib/rbac";
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from "@/lib/errors";
import { resendAdminInvitation, revokeAdminInvitation } from "@/lib/tenant-admin/invitations";
import { resolvePublicHost } from "@/lib/tenant-admin/invitation-email";

const UNAUTHORIZED = NextResponse.json({ error: "Not authorised" }, { status: 403 });

function handleErr(err: unknown) {
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
  }
  if (err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
  if (err instanceof ConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  // eslint-disable-next-line no-console
  console.error("[tenant-users invitation API]", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; invitationId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return UNAUTHORIZED;
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== "resend") {
      return NextResponse.json({ error: 'Body must specify action: "resend"' }, { status: 400 });
    }
    const url = new URL(req.url);
    const result = await resendAdminInvitation(principal, params.invitationId);
    const gateOn = process.env.SPECTRE_ALLOW_ACTIVATION_URL === "true";
    const requested = url.searchParams.get("includeActivationUrl") === "true";
    const allowActivationUrl = gateOn && requested && isSuperAdmin(principal);

    const body_: Record<string, unknown> = {
      invitation: {
        id: result.invitation.id,
        email: result.invitation.email,
        status: result.invitation.status,
        expiresAt: result.invitation.expiresAt,
        sentAt: result.invitation.sentAt,
      },
      delivery: {
        status: result.delivery.status,
        externalSendConfirmed: result.delivery.externalSendConfirmed,
        operatorAlert: result.delivery.operatorAlert,
        provider: result.delivery.provider,
        failureReason: result.delivery.failureReason,
      },
    };
    if (allowActivationUrl) {
      let publicHost: string | null = null;
      try { publicHost = resolvePublicHost(); } catch { publicHost = null; }
      body_.activationUrl = publicHost ? `${publicHost.replace(/\/$/, "")}/invite/${result.rawToken}` : null;
      body_.rawTokenReturnedOnce = true;
    }
    return NextResponse.json(body_);
  } catch (err) {
    return handleErr(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; invitationId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return UNAUTHORIZED;
  try {
    await revokeAdminInvitation(principal, params.invitationId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleErr(err);
  }
}
