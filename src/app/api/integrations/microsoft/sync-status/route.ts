// Sprint 2 B4.1 (2026-07-19) — GET /api/integrations/microsoft/sync-status
//
// Polling endpoint for Connected Accounts. Returns the most recent
// MailboxSyncRun summary + current connection state so the client can
// present live progress without WebSockets. Feature-flag + tenant +
// owner-gated. Never returns tokens, subjects, or bodies.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { MAILBOX_ERROR_CODE } from "@/lib/mailbox/errors";
import { isTerminalStatus } from "@/lib/mailbox/status";

// Sprint 2 Step 11 / Checkpoint 11 (2026-07-20) — same static-bake
// hazard as /callback. Force runtime execution so the flag flip is
// observed on every request and never captured at build time.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.UNAUTHENTICATED }, { status: 401 });
  }
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  const url = new URL(req.url);
  const mailboxConnectionId = url.searchParams.get("mailboxConnectionId") ?? "";
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

  const latestRun = await prisma.mailboxSyncRun.findFirst({
    where: { mailboxConnectionId },
    orderBy: { queuedAt: "desc" },
  });

  return NextResponse.json({
    connection: {
      status: conn.status,
      lastSuccessfulSyncAt: conn.lastSuccessfulSyncAt?.toISOString() ?? null,
      lastAttemptedSyncAt: conn.lastAttemptedSyncAt?.toISOString() ?? null,
      isTerminal: isTerminalStatus(conn.status),
    },
    latestRun: latestRun && {
      id: latestRun.id,
      status: latestRun.status,
      triggerKind: latestRun.triggerKind,
      queuedAt: latestRun.queuedAt.toISOString(),
      startedAt: latestRun.startedAt?.toISOString() ?? null,
      completedAt: latestRun.completedAt?.toISOString() ?? null,
      messagesExamined: latestRun.messagesExamined,
      messagesImported: latestRun.messagesImported,
      messagesUpdated: latestRun.messagesUpdated,
      intakeCreatedActionable: latestRun.intakeCreatedActionable,
      intakeCreatedInformational: latestRun.intakeCreatedInformational,
      messagesSuppressed: latestRun.messagesSuppressed,
      messagesFailed: latestRun.messagesFailed,
      failureCategory: latestRun.failureCategory,
    },
  });
}
