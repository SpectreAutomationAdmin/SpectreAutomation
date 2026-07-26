// Sprint 2 B4 (2026-07-19) — POST /api/integrations/microsoft/sync
//
// Manual "Sync now" endpoint. Enqueues MAILBOX_INITIAL_SYNC for the
// given mailboxConnectionId, gated by feature flag + tenant + owner.
// Repeated clicks are safe — the queue's idempotencyKey collapses
// concurrent enqueues into a single job.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { MAILBOX_ERROR_CODE } from "@/lib/mailbox/errors";
import { isTerminalStatus } from "@/lib/mailbox/status";

export async function POST(req: NextRequest) {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.UNAUTHENTICATED }, { status: 401 });
  }
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });

  const body: Record<string, unknown> = await req
    .text()
    .then((t) => (t ? (JSON.parse(t) as Record<string, unknown>) : ({} as Record<string, unknown>)))
    .catch(() => ({} as Record<string, unknown>));
  const rawId = body["mailboxConnectionId"];
  const mailboxConnectionId = typeof rawId === "string" ? rawId : "";
  if (!mailboxConnectionId) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.CONNECTION_NOT_FOUND }, { status: 400 });
  }

  const conn = await prisma.mailboxConnection.findUnique({
    where: { id: mailboxConnectionId },
    include: { accesses: true },
  });
  if (!conn) return NextResponse.json({ error: MAILBOX_ERROR_CODE.CONNECTION_NOT_FOUND }, { status: 404 });
  if (conn.clubId !== clubId) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.PERMISSION_DENIED }, { status: 403 });
  }
  const isOwner = conn.accesses.some(
    (a) => a.userId === principal.id && a.revokedAt == null && (a.role === "OWNER" || a.role === "MANAGER"),
  );
  if (!isOwner) return NextResponse.json({ error: MAILBOX_ERROR_CODE.PERMISSION_DENIED }, { status: 403 });
  if (isTerminalStatus(conn.status)) {
    return NextResponse.json({ error: "cannot_sync_terminal_status", status: conn.status }, { status: 409 });
  }

  const { enqueue } = await import("@/lib/queue");
  const job = await enqueue({
    kind: "MAILBOX_INITIAL_SYNC",
    payload: { mailboxConnectionId },
    clubId,
    idempotencyKey: `mailbox:sync-now:${mailboxConnectionId}`,
    correlationId: `mailbox:${mailboxConnectionId}`,
    createdByUserId: principal.id,
  });
  return NextResponse.json({ jobId: (job as { id?: string })?.id ?? null, status: "enqueued" }, { status: 202 });
}
