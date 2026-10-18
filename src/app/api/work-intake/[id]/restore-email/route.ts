// WI-SYNC-1e (2026-10-18) — POST /api/work-intake/[id]/restore-email
//
// User-facing restore action.  Moves the WI's source email from
// wherever it currently lives (Deleted Items / Archive / etc.)
// back to Inbox, triggering the delta sync's isRestore branch on
// the next tick (which clears softDeletedAt + flips WI back to
// its pre-suppression status via handleEmailEvidenceRestored).
//
// Different from /api/admin/mailbox/debug/move-to-inbox:
//   - This endpoint is user-authenticated (ordinary founder role).
//   - It's scoped to a specific WorkIntakeItem (not raw emailId).
//   - Tenant-guards via the WI's clubId.
//   - Suitable for Mission Control card button exposure.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { getMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated";
import { getFreshDelegatedAccessToken } from "@/lib/mailbox/connect";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json({ error: "mailbox_integration_disabled" }, { status: 404 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clubId: (principal as any).activeClubId ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    role: (principal as any).role ?? "",
  });
  if (!clubId) {
    return NextResponse.json({ error: "no_active_club" }, { status: 400 });
  }
  const link = await prisma.emailWorkIntakeOrigin.findFirst({
    where: { workIntakeItemId: params.id, role: "PRIMARY" },
    include: {
      workIntakeItem: { select: { id: true, clubId: true } },
      emailMessage: {
        select: {
          id: true, clubId: true, graphMessageId: true, immutableId: true,
          mailboxConnectionId: true, softDeletedAt: true,
        },
      },
    },
  });
  if (!link) {
    return NextResponse.json({ error: "no_primary_email_origin" }, { status: 409 });
  }
  if (link.workIntakeItem.clubId !== clubId) {
    return NextResponse.json({ error: "cross_tenant" }, { status: 403 });
  }
  if (!link.emailMessage.softDeletedAt) {
    return NextResponse.json({ error: "email_not_soft_deleted" }, { status: 409 });
  }
  const mailbox = await prisma.mailboxConnection.findUnique({
    where: { id: link.emailMessage.mailboxConnectionId },
    select: { id: true, clubId: true, userId: true, status: true },
  });
  if (!mailbox || mailbox.clubId !== clubId) {
    return NextResponse.json({ error: "cross_tenant_mailbox" }, { status: 403 });
  }
  if (mailbox.status !== "CONNECTED") {
    return NextResponse.json({ error: "mailbox_not_connected" }, { status: 422 });
  }
  const { accessToken } = await getFreshDelegatedAccessToken({
    mailboxConnectionId: mailbox.id,
    callerClubId: clubId,
    callerUserId: principal.id,
  });
  const graphId = link.emailMessage.immutableId || link.emailMessage.graphMessageId;
  try {
    const result = await getMicrosoftDelegatedProvider().moveMessage({
      accessToken,
      graphMessageId: graphId,
      destinationId: "inbox",
    });
    await audit(principal, {
      action: "work-intake.restore-email",
      entityType: "WorkIntakeItem",
      entityId: params.id,
      clubId,
      meta: {
        emailMessageId: link.emailMessage.id,
        fromGraphId: graphId,
        toGraphId: result.resultingGraphMessageId,
        destinationFolderId: result.destinationFolderId,
      },
    });
    return NextResponse.json({
      ok: true,
      emailMessageId: link.emailMessage.id,
      destinationFolderId: result.destinationFolderId,
    }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "graph_error", detail: msg },
      { status: 502 },
    );
  }
}
