// Sprint 2 B2 (2026-07-19) — POST /api/integrations/microsoft/disconnect
//
// Behind MAILBOX_INTEGRATION_ENABLED per §10 of the B2 directive.
// Requires ownership or MANAGER access on the target mailbox
// connection. Idempotent: disconnecting an already-disconnected
// connection returns 200.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { disconnectMailbox } from "@/lib/mailbox/connect";
import { MailboxFlowError, MAILBOX_ERROR_CODE } from "@/lib/mailbox/errors";

export async function POST(req: NextRequest) {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.UNAUTHENTICATED }, { status: 401 });
  }
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });

  const body: Record<string, unknown> = await req.text()
    .then((t) => (t ? (JSON.parse(t) as Record<string, unknown>) : {} as Record<string, unknown>))
    .catch(() => ({} as Record<string, unknown>));
  const rawId = body["mailboxConnectionId"];
  const mailboxConnectionId = typeof rawId === "string" ? rawId : "";
  if (!mailboxConnectionId) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.CONNECTION_NOT_FOUND }, { status: 400 });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
  const userAgent = req.headers.get("user-agent") ?? undefined;

  try {
    const result = await disconnectMailbox({
      mailboxConnectionId,
      callerUserId: principal.id,
      callerClubId: clubId,
      ip,
      userAgent,
    });
    return NextResponse.json({ status: result.status }, { status: 200 });
  } catch (err) {
    if (err instanceof MailboxFlowError) {
      const httpStatus =
        err.code === MAILBOX_ERROR_CODE.CONNECTION_NOT_FOUND
          ? 404
          : err.code === MAILBOX_ERROR_CODE.PERMISSION_DENIED
            ? 403
            : 400;
      return NextResponse.json({ error: err.code }, { status: httpStatus });
    }
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.INTERNAL_ERROR }, { status: 500 });
  }
}
