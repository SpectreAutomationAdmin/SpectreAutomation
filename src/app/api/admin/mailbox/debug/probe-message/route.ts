// WI-SYNC-1h (2026-10-18) — staging-only admin tool that probes
// Microsoft Graph for one specific message's current folder.
// Mirrors the probe calls the 15-min reconciliation sweep makes,
// but scoped to a single emailMessageId so the WI-SYNC-1h final
// verification can confirm "the message is actually in Deleted
// Items in Outlook" without hand-reading tokens.
//
// Gated by SPECTRE_ALLOW_STAGING_DEBUG.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { getMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated";
import { getFreshDelegatedAccessToken } from "@/lib/mailbox/connect";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (process.env.SPECTRE_ALLOW_STAGING_DEBUG !== "1") {
    return NextResponse.json({ error: "debug_endpoint_disabled" }, { status: 404 });
  }
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

  const emailMessageId = req.nextUrl.searchParams.get("emailMessageId");
  if (!emailMessageId) {
    return NextResponse.json({ error: "missing_emailMessageId" }, { status: 400 });
  }
  const email = await prisma.emailMessage.findUnique({
    where: { id: emailMessageId },
    select: {
      id: true, clubId: true, graphMessageId: true, immutableId: true,
      softDeletedAt: true, mailboxConnectionId: true, subject: true,
    },
  });
  if (!email) return NextResponse.json({ error: "email_not_found" }, { status: 404 });
  if (email.clubId !== clubId) return NextResponse.json({ error: "cross_tenant" }, { status: 403 });
  const mailbox = await prisma.mailboxConnection.findUnique({
    where: { id: email.mailboxConnectionId },
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
  const provider = getMicrosoftDelegatedProvider();
  const graphId = email.immutableId || email.graphMessageId;

  const [probe, inboxFolder, deletedFolder, archiveFolder] = await Promise.all([
    provider.probeMessage({ accessToken, graphMessageId: graphId }),
    provider.getWellKnownFolder({ accessToken, wellKnownName: "inbox" }),
    provider.getWellKnownFolder({ accessToken, wellKnownName: "deleteditems" }),
    provider.getWellKnownFolder({ accessToken, wellKnownName: "archive" }),
  ]);

  // Classify the folder by well-known match for the human reader.
  const parent = probe.parentFolderId ?? null;
  let folderLabel = "UNKNOWN";
  if (probe.outcome === "DELETED") folderLabel = "GONE_404";
  else if (probe.outcome === "INACCESSIBLE_RETRYABLE") folderLabel = "GRAPH_RETRYABLE";
  else if (probe.outcome === "INACCESSIBLE_PERMANENT") folderLabel = "GRAPH_PERMANENT_ERROR";
  else if (probe.outcome === "PRESENT") {
    if (inboxFolder && parent === inboxFolder.id) folderLabel = "INBOX";
    else if (deletedFolder && parent === deletedFolder.id) folderLabel = "DELETED_ITEMS";
    else if (archiveFolder && parent === archiveFolder.id) folderLabel = "ARCHIVE";
    else folderLabel = "OTHER_FOLDER";
  }

  return NextResponse.json({
    ok: true,
    emailMessageId: email.id,
    subject: email.subject,
    graphMessageId: graphId,
    spectre: {
      softDeletedAt: email.softDeletedAt,
    },
    graph: {
      outcome: probe.outcome,
      parentFolderId: parent,
      folderLabel,
      isRead: probe.isRead ?? null,
      httpStatus: probe.httpStatus ?? null,
      errorCode: probe.errorCode ?? null,
    },
    wellKnownFolders: {
      inbox: inboxFolder?.id ?? null,
      deletedItems: deletedFolder?.id ?? null,
      archive: archiveFolder?.id ?? null,
    },
  }, { status: 200 });
}
