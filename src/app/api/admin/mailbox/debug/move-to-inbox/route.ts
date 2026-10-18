// WI-SYNC-1c (2026-10-18) — POST /api/admin/mailbox/debug/move-to-inbox
//
// Admin-only operator tool to move a specific email back to the
// Inbox folder from wherever it currently lives (Deleted Items,
// Archive, user-defined folder).  Used:
//
//   * To restore a mistakenly-deleted message so the next delta
//     sync picks it up as a RESTORE (clears softDeletedAt +
//     reactivates the linked WI via handleEmailEvidenceRestored).
//   * As the Graph-side counterpart to the WI-SYNC-1c acceptance
//     tests — the test harness needs to simulate the "user moves
//     message back to Inbox in Outlook" step without doing it by
//     hand through the Outlook UI.
//
// This endpoint does NOT touch the EmailMessage.softDeletedAt
// column or the linked WI.  Those transitions are left to the
// delta sync + handleEmailEvidenceRestored, which is the single
// source of truth for restore semantics.

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

export async function POST(req: NextRequest) {
  // WI-SYNC-1e (2026-10-18) — production safety gate.  This
  // endpoint is a staging acceptance / operator tool; it must
  // never respond on production.  SPECTRE_ALLOW_STAGING_DEBUG
  // is unset in prod secrets, set to "1" on spectre-staging.
  if (process.env.SPECTRE_ALLOW_STAGING_DEBUG !== "1") {
    return NextResponse.json({ error: "debug_endpoint_disabled" }, { status: 404 });
  }
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
  const emailMessageId = new URL(req.url).searchParams.get("emailMessageId");
  if (!emailMessageId) {
    return NextResponse.json({ error: "missing_emailMessageId" }, { status: 400 });
  }
  const email = await prisma.emailMessage.findUnique({
    where: { id: emailMessageId },
    select: {
      id: true,
      clubId: true,
      graphMessageId: true,
      immutableId: true,
      mailboxConnectionId: true,
    },
  });
  if (!email) {
    return NextResponse.json({ error: "email_not_found" }, { status: 404 });
  }
  if (email.clubId !== clubId) {
    return NextResponse.json({ error: "cross_tenant" }, { status: 403 });
  }
  const mailbox = await prisma.mailboxConnection.findUnique({
    where: { id: email.mailboxConnectionId },
    select: { id: true, clubId: true, userId: true, status: true },
  });
  if (!mailbox) {
    return NextResponse.json({ error: "mailbox_not_found" }, { status: 404 });
  }
  if (mailbox.clubId !== clubId) {
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
  try {
    const result = await provider.moveMessage({
      accessToken,
      graphMessageId: graphId,
      destinationId: "inbox",
    });
    await audit(principal, {
      action: "mailbox.message.move-to-inbox",
      entityType: "EmailMessage",
      entityId: email.id,
      clubId,
      meta: {
        mailboxConnectionId: mailbox.id,
        fromGraphId: graphId,
        toGraphId: result.resultingGraphMessageId,
        destinationFolderId: result.destinationFolderId,
      },
    });
    return NextResponse.json(
      {
        ok: true,
        emailMessageId: email.id,
        fromGraphId: graphId,
        toGraphId: result.resultingGraphMessageId,
        destinationFolderId: result.destinationFolderId,
      },
      { status: 200 },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "graph_error", detail: message },
      { status: 502 },
    );
  }
}
