// TA-1B — Invitation resend + revoke endpoints.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from "@/lib/errors";
import {
  resendAdminInvitation,
  revokeAdminInvitation,
} from "@/lib/tenant-admin/invitations";

const UNAUTHORIZED = NextResponse.json({ error: "Not authorised" }, { status: 403 });

function handleErr(err: unknown) {
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof ConflictError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
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
    const { invitation, token } = await resendAdminInvitation(principal, params.invitationId);
    const origin = new URL(req.url).origin;
    return NextResponse.json({
      invitation: {
        id: invitation.id,
        email: invitation.email,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
      },
      activationUrl: `${origin}/invite/${token}`,
      rawTokenReturnedOnce: true,
    });
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
