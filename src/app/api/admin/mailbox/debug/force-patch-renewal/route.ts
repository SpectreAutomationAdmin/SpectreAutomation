// WI-SYNC-1e-close §2 (2026-10-18) — staging-only operator tool
// that exercises an actual Graph PATCH /subscriptions/{id} against
// the current ACTIVE subscription for the caller's active club.
//
// Returns the old expiration, the Graph response, and the newly
// persisted subscription state so the acceptance report can
// demonstrate a REAL renewal (as opposed to a delete+recreate).
//
// Gated by SPECTRE_ALLOW_STAGING_DEBUG — identical pattern to
// move-to-inbox so production can never hit this.

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

export async function POST(_req: NextRequest) {
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
  const sub = await prisma.graphSubscription.findFirst({
    where: { clubId, lifecycleState: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });
  if (!sub) {
    return NextResponse.json({ error: "no_active_subscription" }, { status: 404 });
  }
  const mailbox = await prisma.mailboxConnection.findUnique({
    where: { id: sub.mailboxConnectionId },
    select: { id: true, userId: true, clubId: true, status: true },
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
  // Target: now + 2d 20h (within Graph's 3-day inbox cap).
  const now = new Date();
  const target = new Date(now.getTime() + (2 * 24 + 20) * 60 * 60 * 1000).toISOString();
  const oldExpiration = sub.expirationDateTime.toISOString();
  try {
    const result = await getMicrosoftDelegatedProvider().renewSubscription({
      accessToken,
      microsoftSubscriptionId: sub.microsoftSubscriptionId,
      expirationDateTime: target,
    });
    const updated = await prisma.graphSubscription.update({
      where: { id: sub.id },
      data: {
        expirationDateTime: new Date(result.expirationDateTime),
        lastRenewalAt: now,
        renewalFailureCount: 0,
        lastRenewalError: null,
      },
    });
    await audit(principal, {
      action: "mailbox.subscription.patch-renew",
      entityType: "GraphSubscription",
      entityId: sub.id,
      clubId,
      meta: {
        microsoftSubscriptionId: sub.microsoftSubscriptionId,
        oldExpiration,
        newExpiration: result.expirationDateTime,
      },
    });
    return NextResponse.json({
      ok: true,
      microsoftSubscriptionId: sub.microsoftSubscriptionId,
      oldExpiration,
      newExpirationFromGraph: result.expirationDateTime,
      newExpirationPersisted: updated.expirationDateTime.toISOString(),
      lifecycleState: updated.lifecycleState,
      renewalFailureCount: updated.renewalFailureCount,
      lastRenewalAt: updated.lastRenewalAt?.toISOString() ?? null,
    }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      error: "graph_renew_failed",
      detail: msg,
      oldExpiration,
    }, { status: 502 });
  }
}
