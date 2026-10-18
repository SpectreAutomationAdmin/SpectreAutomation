// WI-SYNC-1e-close §1 (2026-10-18) — Spectre→Outlook Archive.
//
// POST /api/work-intake/[id]/archive-email
// Moves the WI's primary email to Outlook's Archive folder via
// Graph POST /me/messages/{id}/move and records a SUCCEEDED
// OutlookArchiveMutation row.  The delta sync's @removed branch
// recognizes the mutation and skips re-suppressing the WI (loop
// prevention has existed since Phase 4R Checkpoint 16H).
//
// Different from the AP completion flow: completion-driven archive
// still runs via MAILBOX_ARCHIVE_MESSAGE queue job; this user-
// facing endpoint is a direct synchronous Graph PATCH that mirrors
// the Delete endpoint's shape.  Suitable for a card button.

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

const ARCHIVE_DESTINATION = "archive";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
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
    where: { workIntakeItemId: params.id, role: "PRIMARY" },
    include: {
      workIntakeItem: { select: { id: true, clubId: true, status: true } },
      emailMessage: {
        select: {
          id: true, clubId: true, graphMessageId: true, immutableId: true,
          mailboxConnectionId: true, softDeletedAt: true,
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
  // Pre-persist a RUNNING mutation row for audit continuity.
  const mutation = await prisma.outlookArchiveMutation.create({
    data: {
      clubId,
      workIntakeId: link.workIntakeItem.id,
      emailMessageId: link.emailMessage.id,
      originalExternalMessageId: graphId,
      mailboxConnectionId: mailbox.id,
      status: "RUNNING",
      attemptCount: 1,
      lastAttemptAt: new Date(),
    },
  });
  try {
    const result = await getMicrosoftDelegatedProvider().moveMessage({
      accessToken,
      graphMessageId: graphId,
      destinationId: ARCHIVE_DESTINATION,
    });
    const resultingId = result.resultingGraphMessageId ?? graphId;
    // Flip softDeletedAt (archive moves the message OUT of Inbox,
    // which the delta scope would otherwise observe as removal).
    // handleEmailEvidenceDeleted's `ourArchive` guard will then
    // write an EVIDENCE_ARCHIVED activity (not EVIDENCE_DELETED).
    await prisma.$transaction([
      prisma.outlookArchiveMutation.update({
        where: { id: mutation.id },
        data: {
          status: "SUCCEEDED",
          resultingExternalMessageId: resultingId,
          destinationFolderId: result.destinationFolderId ?? ARCHIVE_DESTINATION,
          completedAt: new Date(),
        },
      }),
      prisma.emailMessage.update({
        where: { id: link.emailMessage.id },
        data: {
          softDeletedAt: new Date(),
          lastSyncedAt: new Date(),
          ...(resultingId !== graphId ? { graphMessageId: resultingId } : {}),
        },
      }),
    ]);
    await audit(principal, {
      action: "mailbox.message.archive",
      entityType: "WorkIntakeItem",
      entityId: params.id,
      clubId,
      meta: { mutationId: mutation.id, emailMessageId: link.emailMessage.id },
    });
    return NextResponse.json({
      ok: true,
      mutationId: mutation.id,
      resultingGraphMessageId: resultingId,
    }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.outlookArchiveMutation.update({
      where: { id: mutation.id },
      data: {
        status: "FAILED_TERMINAL",
        errorCode: msg.slice(0, 500),
        lastAttemptAt: new Date(),
      },
    });
    return NextResponse.json({ error: "graph_error", detail: msg }, { status: 502 });
  }
}
