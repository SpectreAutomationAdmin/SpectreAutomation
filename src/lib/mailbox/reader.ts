// Sprint 2 B3 (2026-07-19) — Read-side utilities for the Connected
// Accounts page.
//
// This is the single loader for "what mailbox does THIS user own in
// THIS club?". Tenant + personal-mailbox privacy is enforced here so
// no component talks directly to Prisma for mailbox rows.
//
// Per §3 + §9 of the B3 directive: a Club Admin viewing this page as
// themselves sees only THEIR own connection. The route MUST NOT
// expose another user's mailbox.

import { prisma } from "@/lib/prisma";

export interface UserMailboxSnapshot {
  connection: {
    id: string;
    connectedEmail: string;
    status: string;
    mailboxType: string;
    createdAt: Date;
    disconnectedAt: Date | null;
    lastSuccessfulSyncAt: Date | null;
    lastAttemptedSyncAt: Date | null;
    lastSyncError: string | null;
    // Non-sensitive tenant display hint. The full GUID is NOT
    // exposed to the client. This is the last 8 characters only so
    // the user can distinguish two Microsoft tenants at a glance
    // without leaking directory metadata.
    tenantDisplayHint: string;
  } | null;
  /** Recent user-visible activity — connect, reconnect, disconnect only.
   *  Token refresh events are excluded per §15. */
  recentActivity: Array<{
    action: string;
    createdAt: Date;
  }>;
}

const USER_VISIBLE_MAILBOX_ACTIONS = new Set<string>([
  "mailbox.connect.completed",
  "mailbox.connect.reconnected",
  "mailbox.disconnected",
  "mailbox.reauth.required",
]);

export async function loadUserMailboxSnapshot(args: {
  userId: string;
  clubId: string;
}): Promise<UserMailboxSnapshot> {
  const connection = await prisma.mailboxConnection.findFirst({
    where: {
      userId: args.userId,
      clubId: args.clubId,
      mailboxType: "PERSONAL",
    },
    orderBy: { createdAt: "desc" },
  });
  if (!connection) return { connection: null, recentActivity: [] };

  const audit = await prisma.auditLog.findMany({
    where: {
      clubId: args.clubId,
      entityType: "MailboxConnection",
      entityId: connection.id,
      action: { in: Array.from(USER_VISIBLE_MAILBOX_ACTIONS) },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const tenantDisplayHint = connection.microsoftTenantId
    .replace(/-/g, "")
    .slice(-8);

  return {
    connection: {
      id: connection.id,
      connectedEmail: connection.connectedEmail,
      status: connection.status,
      mailboxType: connection.mailboxType,
      createdAt: connection.createdAt,
      disconnectedAt: connection.disconnectedAt,
      lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
      lastAttemptedSyncAt: connection.lastAttemptedSyncAt,
      lastSyncError: connection.lastSyncError,
      tenantDisplayHint,
    },
    recentActivity: audit.map((a) => ({ action: a.action, createdAt: a.createdAt })),
  };
}
