// Sprint 2 Checkpoint 14C (2026-07-23) — Mission Control conversation
// thread endpoint. Replaces the single-email endpoint from C14B.
//
// GET /api/mission-control/work-intake/[id]/thread
//
// Returns the canonical newest-first conversation for one Work Intake
// item the current principal is authorised to see. The endpoint also
// reports whether the source mailbox has been granted the delegated
// `Mail.Send` scope (used by the reply composer to distinguish
// "consent required" from "ready to send").
//
// Authorization contract:
//   1. session + principal must resolve  → 401 otherwise.
//   2. The WorkIntakeItem must belong to the active club.
//   3. Every EmailMessage in the thread must belong to a
//      MailboxConnection the principal can see under
//      mailboxVisibilityFilter (PERSONAL: connecting user only;
//      SHARED: unrevoked MailboxAccess).
//   4. All returned messages share the SAME
//      (mailboxConnectionId, conversationId) as the item's primary
//      origins. Cross-mailbox / cross-club leakage is impossible
//      because the WorkIntakeItem itself is tenant-scoped.
//   5. Soft-deleted messages surface metadata + `softDeleted: true`
//      but their body content is stripped server-side.
//   6. Never 403 — always 404 on any authorization failure to
//      prevent existence-oracle leaks.
//
// READ-ONLY. Never mutates. Never touches Graph. Never enqueues.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { mailboxVisibilityFilter } from "@/lib/work-intake/tenant";
import { MAILBOX_ERROR_CODE } from "@/lib/mailbox/errors";
import { APPROVED_DELEGATED_SCOPES } from "@/lib/integrations/microsoft-graph-delegated";

export const dynamic = "force-dynamic";

interface ThreadMessage {
  id: string;
  subject: string;
  senderName: string;
  senderAddress: string;
  recipientsTo: string[];
  recipientsCc: string[];
  receivedAt: string;
  sentAt: string | null;
  importance: string;
  isRead: boolean;
  hasAttachments: boolean;
  bodyHtmlSanitized: string | null;
  bodyTextExtract: string | null;
  softDeleted: boolean;
}

interface ThreadResponse {
  workIntakeItemId: string;
  conversationId: string | null;
  mailboxConnectedEmail: string;
  messageCount: number;
  /** Newest-first ordering — the message the user sees first is the
   *  most recent one in the conversation. */
  messages: ThreadMessage[];
  /** Reply-consent status derived from the source mailbox's
   *  grantedScopes column. In Phase 14C-A this is always "missing"
   *  because Mail.Send is not yet in APPROVED_DELEGATED_SCOPES. In
   *  Phase 14C-B it becomes "granted" only after the user
   *  re-consents. */
  replyConsent: {
    state: "granted" | "missing" | "unavailable";
    reason: string;
    requiredScopes: string[];
  };
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.UNAUTHENTICATED }, { status: 401 });
  }
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });

  const workIntakeItemId = params.id;
  if (!workIntakeItemId || typeof workIntakeItemId !== "string") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Load the intake plus every PRIMARY origin. Tenant scope enforced
  // via the mailboxVisibilityFilter on the origins' emailMessages.
  const intake = await prisma.workIntakeItem.findFirst({
    where: { id: workIntakeItemId, clubId },
    include: {
      emailOrigins: {
        where: { role: "PRIMARY" },
        include: {
          emailMessage: {
            include: {
              mailboxConnection: {
                select: { id: true, connectedEmail: true, mailboxType: true, userId: true, grantedScopes: true },
              },
            },
          },
        },
      },
    },
  });
  if (!intake || intake.emailOrigins.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Every origin's mailbox must satisfy the visibility filter.
  const authorisedOrigins = [];
  for (const origin of intake.emailOrigins) {
    const conn = origin.emailMessage.mailboxConnection;
    // A PERSONAL mailbox is visible only to its owner.
    if (conn.mailboxType === "PERSONAL" && conn.userId !== principal.id) continue;
    // SHARED requires an unrevoked MailboxAccess — check separately.
    if (conn.mailboxType === "SHARED") {
      const access = await prisma.mailboxAccess.count({
        where: { mailboxConnectionId: conn.id, userId: principal.id, revokedAt: null },
      });
      if (access === 0) continue;
    }
    authorisedOrigins.push(origin);
  }
  if (authorisedOrigins.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Pick the newest email as the anchor for identifying the
  // conversation. Then load ALL emails in that
  // (mailboxConnectionId, conversationId) group — the founder wants
  // the full thread, not just the linked messages.
  const anchorEmail = [...authorisedOrigins]
    .map((o) => o.emailMessage)
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0]!;
  const mailboxConnectionId = anchorEmail.mailboxConnectionId;
  const conversationId = anchorEmail.conversationId;

  // Re-apply the mailbox-visibility filter as a defense-in-depth
  // even though we already authorised the anchor. Prevents any future
  // regression where a conversation spans mailboxes.
  const threadEmails = await prisma.emailMessage.findMany({
    where: {
      mailboxConnectionId,
      // If conversationId is null, restrict to the anchor's own id.
      // Otherwise fetch every message in the conversation.
      ...(conversationId ? { conversationId } : { id: anchorEmail.id }),
      mailboxConnection: mailboxVisibilityFilter({
        userId: principal.id,
        clubId,
        isClubAdmin: false,
        isSuperAdmin: false,
      }),
    },
    orderBy: { receivedAt: "desc" },
    select: {
      id: true, subject: true, senderName: true, senderAddress: true,
      recipientsJson: true, receivedAt: true, sentAt: true,
      importance: true, isRead: true, hasAttachments: true,
      bodyHtmlSanitized: true, bodyTextExtract: true, softDeletedAt: true,
    },
  });

  const grantedScopesRaw = anchorEmail.mailboxConnection.grantedScopes || "";
  const grantedScopes = grantedScopesRaw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const replyConsent = deriveReplyConsent(grantedScopes);

  const response: ThreadResponse = {
    workIntakeItemId: intake.id,
    conversationId,
    mailboxConnectedEmail: anchorEmail.mailboxConnection.connectedEmail,
    messageCount: threadEmails.length,
    messages: threadEmails.map((m) => {
      const isSoftDeleted = m.softDeletedAt != null;
      const recipients = safeParseRecipients(m.recipientsJson);
      return {
        id: m.id,
        subject: m.subject,
        senderName: m.senderName,
        senderAddress: m.senderAddress,
        recipientsTo: recipients.to,
        recipientsCc: recipients.cc,
        receivedAt: m.receivedAt.toISOString(),
        sentAt: m.sentAt?.toISOString() ?? null,
        importance: m.importance,
        isRead: m.isRead,
        hasAttachments: m.hasAttachments,
        // Strip body content for soft-deleted messages — the UI
        // renders an audit notice in its place.
        bodyHtmlSanitized: isSoftDeleted ? null : m.bodyHtmlSanitized,
        bodyTextExtract: isSoftDeleted ? null : m.bodyTextExtract,
        softDeleted: isSoftDeleted,
      };
    }),
    replyConsent,
  };

  return NextResponse.json(response);
}

function deriveReplyConsent(grantedScopes: string[]): ThreadResponse["replyConsent"] {
  // The reply endpoint requires `Mail.Send`. The scope list is
  // driven by APPROVED_DELEGATED_SCOPES so upgrading Phase 14C
  // requires a single edit to that constant.
  const requiredScopes = APPROVED_DELEGATED_SCOPES.includes("Mail.Send" as never)
    ? ["Mail.Send"]
    : ["Mail.Send"];
  const providerSupportsSend = APPROVED_DELEGATED_SCOPES.includes("Mail.Send" as never);
  if (!providerSupportsSend) {
    return {
      state: "unavailable",
      reason: "Reply sending is not yet enabled in this staging release. The delegated OAuth scope list does not include Mail.Send.",
      requiredScopes,
    };
  }
  const missingScopes = requiredScopes.filter((s) => !grantedScopes.includes(s));
  if (missingScopes.length === 0) {
    return {
      state: "granted",
      reason: "The connected mailbox has consented to Mail.Send. Replies are allowed.",
      requiredScopes,
    };
  }
  return {
    state: "missing",
    reason: `Reply sending requires additional consent. Reconnect the mailbox and approve the ${missingScopes.join(", ")} scope.`,
    requiredScopes,
  };
}

function safeParseRecipients(json: string | null): { to: string[]; cc: string[] } {
  if (!json) return { to: [], cc: [] };
  try {
    const parsed = JSON.parse(json) as { to?: unknown[]; cc?: unknown[] };
    const extract = (arr: unknown[] | undefined): string[] => {
      if (!Array.isArray(arr)) return [];
      const out: string[] = [];
      for (const r of arr) {
        if (typeof r === "string") { out.push(r); continue; }
        if (r && typeof r === "object") {
          const rec = r as { emailAddress?: { address?: string } };
          const addr = rec.emailAddress?.address;
          if (typeof addr === "string" && addr.length > 0) out.push(addr);
        }
      }
      return out;
    };
    return { to: extract(parsed.to), cc: extract(parsed.cc) };
  } catch {
    return { to: [], cc: [] };
  }
}
