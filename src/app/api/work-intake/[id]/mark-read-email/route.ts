// WI-SYNC-1e-close §1 (2026-10-18) — Spectre→Outlook mark-as-read.
//
// POST /api/work-intake/[id]/mark-read-email
// Flips the WI's primary email to isRead=true in Outlook via Graph
// PATCH and persists the local EmailMessage.isRead mirror.
// Tenant-guarded, audited, 502 on Graph error.

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

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  return markReadImpl(params.id, true);
}

export async function markReadImpl(wiId: string, isRead: boolean) {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json({ error: "mailbox_integration_disabled" }, { status: 404 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clubId: (principal as any).activeClubId ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    role: (principal as any).role ?? "",
  });
  if (!clubId) return NextResponse.json({ error: "no_active_club" }, { status: 400 });

  const link = await prisma.emailWorkIntakeOrigin.findFirst({
    where: { workIntakeItemId: wiId, role: "PRIMARY" },
    include: {
      workIntakeItem: { select: { clubId: true } },
      emailMessage: {
        select: {
          id: true, clubId: true, graphMessageId: true, immutableId: true,
          mailboxConnectionId: true, isRead: true, softDeletedAt: true,
        },
      },
    },
  });
  if (!link) return NextResponse.json({ error: "no_primary_email_origin" }, { status: 409 });
  if (link.workIntakeItem.clubId !== clubId) {
    return NextResponse.json({ error: "cross_tenant" }, { status: 403 });
  }
  if (link.emailMessage.softDeletedAt) {
    return NextResponse.json({ error: "email_soft_deleted" }, { status: 409 });
  }
  if (link.emailMessage.isRead === isRead) {
    return NextResponse.json({ ok: true, alreadyAtTargetState: true, isRead }, { status: 200 });
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
    await getMicrosoftDelegatedProvider().markMessageRead({
      accessToken, graphMessageId: graphId, isRead,
    });
    await prisma.emailMessage.update({
      where: { id: link.emailMessage.id },
      data: { isRead, lastSyncedAt: new Date() },
    });
    await audit(principal, {
      action: isRead ? "mailbox.message.mark-read" : "mailbox.message.mark-unread",
      entityType: "EmailMessage",
      entityId: link.emailMessage.id,
      clubId,
      meta: { workIntakeItemId: wiId, mailboxConnectionId: mailbox.id },
    });
    return NextResponse.json({ ok: true, isRead }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "graph_error", detail: msg }, { status: 502 });
  }
}
