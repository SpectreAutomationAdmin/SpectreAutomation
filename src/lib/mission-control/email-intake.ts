// Sprint 2 B4 (2026-07-19) — Mission Control email-intake loader.
//
// Reads materialised WorkIntakeItem rows (source = email) that this
// specific user is authorised to see. Personal-mailbox visibility is
// enforced via the tenant utility from B1 — a Club Admin without an
// explicit MailboxAccess row does NOT see another user's mailbox.
//
// Sprint 2 Checkpoint 14C (2026-07-23) — email items now render a
// structured operational synopsis, not the raw email body preview.
// The synopsis is composed by the deterministic
// invoice-analysis pipeline (see ../mailbox/../mission-control/
// invoice-analysis.ts) at request time. Zero AI. Zero fabrication.
// No mailbox tab. No Open detail exit.

import { prisma } from "@/lib/prisma";
import type { Principal } from "@/lib/rbac";
import { workIntakeReadableByPrincipal } from "@/lib/work-intake/tenant";
import type { WorkItem } from "./index";
import { analyseInvoiceConversation, type OperationalAnalysis } from "./invoice-analysis";

const EMAIL_ITEM_CAP = 12;

/** Load email-derived WorkIntakeItem rows for the user's feed. */
export async function loadEmailIntakeItems(args: {
  principal: Principal;
  clubId: string;
  now: Date;
}): Promise<WorkItem[]> {
  const where = workIntakeReadableByPrincipal({
    userId: args.principal.id,
    clubId: args.clubId,
    isClubAdmin: false,
    isSuperAdmin: false,
  });
  const items = await prisma.workIntakeItem.findMany({
    where: {
      ...where,
      // Only email-origin intake items — the `emailOrigins` any-clause
      // narrows to rows that have at least one email link.
      emailOrigins: { some: {} },
      // Hide suppressed noise from the feed. Post-C14C, this also
      // hides duplicate intakes that were merged into a canonical
      // conversation intake by remediateDuplicateConversationItems().
      status: { notIn: ["SUPPRESSED"] },
    },
    orderBy: [{ displayReceivedAt: "desc" }],
    take: EMAIL_ITEM_CAP,
    // Sprint 3 · Checkpoint 16G Stage B/D — workDomain fields come
    // through automatically since we're using `include` (all scalar
    // WI fields returned by default).
    include: {
      // Load ALL PRIMARY email origins (not just one) so the analysis
      // pipeline can pick the newest message in the conversation.
      emailOrigins: {
        where: { role: "PRIMARY" },
        include: {
          emailMessage: {
            select: {
              id: true, subject: true, senderAddress: true, senderName: true,
              preview: true, bodyTextExtract: true, bodyHtmlSanitized: true,
              receivedAt: true, isRead: true, importance: true,
              hasAttachments: true, conversationId: true, softDeletedAt: true,
              mailboxConnectionId: true, clubId: true, graphMessageId: true,
            },
          },
        },
      },
    },
  });

  // Compose each WorkItem in parallel — each analysis runs its own
  // vendor + AP queries. Bounded by EMAIL_ITEM_CAP (12).
  const workItems = await Promise.all(
    items.map((it) => toWorkItem(it, args.now, args.clubId)),
  );
  return workItems;
}

interface EmailOriginRow {
  emailMessage: {
    id: string;
    subject: string;
    senderAddress: string;
    senderName: string;
    preview: string;
    bodyTextExtract: string | null;
    bodyHtmlSanitized: string | null;
    receivedAt: Date;
    isRead: boolean;
    importance: string;
    hasAttachments: boolean;
    conversationId: string | null;
    softDeletedAt: Date | null;
    mailboxConnectionId: string;
    clubId: string;
    graphMessageId: string;
  };
}

interface WorkIntakeItemRow {
  id: string;
  status: string;
  judgmentRequired: boolean;
  classification: string | null;
  classificationReason: string | null;
  displaySender: string;
  displaySubject: string;
  displayPreview: string;
  displayReceivedAt: Date;
  displayHasAttachments: boolean;
  ownerUserId: string | null;
  emailOrigins: EmailOriginRow[];
  // Sprint 3 · Checkpoint 16G Stage B
  workDomain?: string | null;
  workIntent?: string | null;
  workSubtype?: string | null;
  workDomainConfidence?: number | null;
}

async function toWorkItem(
  it: WorkIntakeItemRow,
  now: Date,
  clubId: string,
): Promise<WorkItem> {
  const state: WorkItem["state"] =
    it.status === "INFORMATIONAL"
      ? "info"
      : it.judgmentRequired
        ? "judgment"
        : "comm";

  const emails = it.emailOrigins
    .map((o) => o.emailMessage)
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  const newestEmail = emails[0]!;

  const analysis: OperationalAnalysis = await analyseInvoiceConversation({
    clubId,
    newestEmail: newestEmail as unknown as Parameters<typeof analyseInvoiceConversation>[0]["newestEmail"],
    conversationEmails: emails as unknown as Parameters<typeof analyseInvoiceConversation>[0]["conversationEmails"],
    classificationLabel: it.classification,
    classificationReason: it.classificationReason,
    relTimeLabel: relTimeLocal(now, newestEmail.receivedAt),
  });

  // Map the analysis's action suggestions into the WorkItem action
  // shape. C14C removes "Open detail" — the card must never navigate
  // away from Mission Control. The tertiary AP-draft action is
  // rendered disabled when the analysis reports its disabledReason.
  const actions = analysis.actionSuggestions.map((a) => ({
    key: a.key,
    label: a.label,
    kind: a.kind,
    iconKey: a.iconKey,
    disabledReason: a.disabledReason,
    onClickAction: a.onClickAction,
  }));

  return {
    id: `wi_${it.id}`,
    state,
    idTag: `MAIL-${it.id.slice(-4).toUpperCase()}`,
    title: analysis.situationTitle,
    sender: {
      from: analysis.contextLine,
    },
    timestamp: newestEmail.receivedAt.toISOString(),
    // Sprint 3 Checkpoint 15H Remediation — canonical sort key = the
    // NEWEST message.receivedAt in the conversation (already sorted
    // above). Aligns email-derived intakes with attachment-derived
    // intakes on the reverse-chronological feed.
    sortTimestamp: newestEmail.receivedAt.toISOString(),
    timestampLabel: relTimeLocal(now, newestEmail.receivedAt),
    // Sprint 2 Checkpoint 14C — `work` is no longer used to render
    // the raw email preview. The card renders `analysis.synopsis`
    // via the new synopsisText field.
    recommendation: analysis.recommendation,
    emailMessageId: newestEmail.id,
    workIntakeItemId: it.id,
    // Sprint 3 Checkpoint 15I — isUnread is now projected by the
    // snapshot loader from WorkIntakeItemRead (per-user). The value
    // seeded here is a fallback for callers that skip that projection.
    isUnread: !newestEmail.isRead,
    isHighImportance: newestEmail.importance === "high",
    synopsisText: analysis.synopsis,
    evidence: analysis.evidence.map((e) => ({ label: e.label, value: e.value, state: e.state })),
    conversationMessageCount: emails.length,
    // Sprint 3 Checkpoint 15I — Variant D card synthesises its own
    // queue-level actions (Resolve / Snooze) from lifecycle state.
    // Domain actions (Reply, View email, etc.) now live inside the
    // expanded tabs, per founder Phase 3.4 requirement.
    actions,
    workIntakeStatus: it.status,
    // Sprint 3 · Checkpoint 16G Stage B/D — surface workDomain to
    // the renderer so it picks the correct field grid + action + tabs.
    workDomain: it.workDomain ?? undefined,
    workIntent: it.workIntent ?? undefined,
    workSubtype: it.workSubtype ?? undefined,
    workDomainConfidence: it.workDomainConfidence ?? undefined,
  };
}

function relTimeLocal(now: Date, then: Date): string {
  const diff = now.getTime() - then.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return then.toLocaleDateString();
}

/**
 * Merge AP/AR/email work items into a single feed. Ordering policy
 * (§13 of B4 directive):
 *
 *   1. Keep source-diverse — cap each source's contribution.
 *   2. Priority within the feed: judgment > approval > comm > info.
 *   3. Within each priority band, order by timestamp desc.
 *
 * Explicitly not-implemented: unified urgency score. That's a
 * follow-up refinement; the current stable ordering keeps AP/AR
 * urgency visible while admitting email evidence.
 */
export function mergeWorkItems(sources: {
  ap: WorkItem[];
  ar: WorkItem[];
  email: WorkItem[];
}): WorkItem[] {
  const AR_CAP = 20;
  const AP_CAP = 20;
  const ordered = [...sources.ar.slice(0, AR_CAP), ...sources.ap.slice(0, AP_CAP), ...sources.email];
  const priority: Record<string, number> = { judgment: 0, approval: 1, comm: 2, auto: 3, info: 4 };
  ordered.sort((a, b) => {
    const pa = priority[a.state] ?? 99;
    const pb = priority[b.state] ?? 99;
    if (pa !== pb) return pa - pb;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });
  return ordered;
}
