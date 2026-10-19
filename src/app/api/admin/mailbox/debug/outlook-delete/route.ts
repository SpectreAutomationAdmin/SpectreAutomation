// WI-SYNC-1h (2026-10-18) — staging-only admin tool that simulates
// a user deleting a message in Outlook (moves it to Deleted Items
// via Graph).  Mirrors `/api/admin/mailbox/debug/move-to-inbox` but
// with destinationId=deleteditems.
//
// Why: the WI-SYNC-1h acceptance needs to reproduce the founder's
// exact scenario — "user deletes in Outlook, then clicks the
// Mission Control refresh" — in Playwright.  Without this endpoint,
// Playwright can't deterministically trigger a Graph-side delete.
//
// This endpoint deliberately does NOT touch Spectre's EmailMessage.
// softDeletedAt or WorkIntakeItem.status.  The whole point of the
// test is to observe whether the manual refresh converges Spectre
// after a Graph-side delete.  If this endpoint flipped softDeletedAt
// locally, the test would be meaningless.
//
// Gated by SPECTRE_ALLOW_STAGING_DEBUG — same pattern as the other
// debug endpoints so production can never hit this.

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

  const emailMessageId = new URL(req.url).searchParams.get("emailMessageId");
  if (!emailMessageId) {
    return NextResponse.json({ error: "missing_emailMessageId" }, { status: 400 });
  }
  const email = await prisma.emailMessage.findUnique({
    where: { id: emailMessageId },
    select: {
      id: true, clubId: true, graphMessageId: true, immutableId: true,
      mailboxConnectionId: true, softDeletedAt: true,
    },
  });
  if (!email) return NextResponse.json({ error: "email_not_found" }, { status: 404 });
  if (email.clubId !== clubId) return NextResponse.json({ error: "cross_tenant" }, { status: 403 });
  if (email.softDeletedAt) {
    return NextResponse.json({ error: "already_tombstoned" }, { status: 409 });
  }
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
  const graphId = email.immutableId || email.graphMessageId;
  try {
    const result = await getMicrosoftDelegatedProvider().moveMessage({
      accessToken,
      graphMessageId: graphId,
      destinationId: "deleteditems",
    });
    await audit(principal, {
      action: "mailbox.message.simulate-outlook-delete",
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
        note: "softDeletedAt NOT touched locally — the refresh path must detect this via probeMessage.",
      },
      { status: 200 },
    );
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "graph_error", detail }, { status: 502 });
  }
}
