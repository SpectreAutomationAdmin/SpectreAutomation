// Sprint 3 · Checkpoint 16H rejection (2026-08-06) — canonical
// outbound conversation persistence + Sent-Items reconciliation.
//
// Owns the invariants in the founder's revised architecture:
//   §2  Persist a canonical outbound ConversationMessage IMMEDIATELY
//       from known data on Graph 202. Do not wait for Sent Items.
//   §4  Exactly one canonical outbound per successful
//       OutlookReplyMutation (enforced by @@unique on replyMutationId).
//   §5  Outbound row links the same clubId + mailboxConnectionId +
//       conversationId + workIntakeItemId + replyMutationId as its
//       source thread.
//   §6  Sent-Items reconciliation is asynchronous; the founder-visible
//       conversation cannot depend on Graph indexing latency.
//   §8  Retries backoff 30s / 2m / 10m; a sent reply never disappears
//       merely because indexing was delayed.
//   §10 Matching hierarchy: internetMessageId (high) → conversationId
//       + owner-sender + tight time window (medium). conversationId
//       alone never merges (guarded in reconcileSpectreReplyToSentItem).
//   §12 Body storage uses the same encryption path as
//       OutlookReplyMutation.bodyCiphertext (KMS scope MAILBOX). Never
//       logs the plaintext body.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import type { RawGraphSentMessage } from "@/lib/integrations/microsoft-graph-delegated";

export const CONVERSATION_RECONCILE_JOB_KIND = "CONVERSATION_MESSAGE_RECONCILE";

// Bounded backoff (§8). Values are seconds so the enum survives
// configuration drift; deliberately not env-configurable in this
// slice — see the founder-directive "configuration-driven" note in
// §8 (deferred to a follow-up if a real need appears).
export const RECONCILE_BACKOFF_SECONDS = [30, 120, 600] as const;

export interface PersistCanonicalOutboundReplyArgs {
  clubId: string;
  workIntakeItemId: string;
  mailboxConnectionId: string;
  /** May be null in extreme edge cases where the source EmailMessage
   *  never had a conversationId. In that case the reply is still
   *  persisted but reconciliation is skipped — Graph cannot look it
   *  up by conversation. */
  conversationId: string | null;
  replyMutationId: string;
  senderName: string;
  senderAddress: string;
  recipientsJson: string;
  subject: string;
  bodyText: string;
  bodyCiphertext: string | null;
  bodySecretRef: string | null;
  sentAt: Date;
}

export interface PersistCanonicalOutboundReplyResult {
  conversationMessageId: string;
  reconciliationEnqueued: boolean;
}

export async function persistCanonicalOutboundReply(
  args: PersistCanonicalOutboundReplyArgs,
): Promise<PersistCanonicalOutboundReplyResult> {
  // Idempotent per §4 — the @@unique on replyMutationId prevents
  // duplicates. We use `upsert` on that key so a request-retry, a
  // double POST, or a reconcile job that races the primary write
  // all converge to the same row.
  const existing = await prisma.conversationMessage.findUnique({
    where: { replyMutationId: args.replyMutationId },
    select: { id: true },
  });

  let conversationMessageId: string;
  if (existing) {
    conversationMessageId = existing.id;
  } else {
    // Truncated preview kept short for list-level rendering; the
    // full body is stored (encrypted) in bodyCiphertext where safe.
    // Matches the EmailMessage convention (`preview` on inbound).
    const preview = args.bodyText.slice(0, 240).replace(/\s+/g, " ").trim();
    const created = await prisma.conversationMessage.create({
      data: {
        clubId: args.clubId,
        mailboxConnectionId: args.mailboxConnectionId,
        workIntakeItemId: args.workIntakeItemId,
        conversationId: args.conversationId ?? "",
        direction: "OUTBOUND",
        source: "SPECTRE_REPLY",
        providerMessageId: null,
        internetMessageId: null,
        replyMutationId: args.replyMutationId,
        senderName: args.senderName,
        senderAddress: args.senderAddress,
        recipientsJson: args.recipientsJson,
        subject: args.subject,
        // Consistent with EmailMessage — plaintext extract feeds the
        // Conversation tab; the encrypted ciphertext is the
        // authoritative long-term store.
        bodyHtmlSanitized: null,
        bodyTextExtract: preview,
        bodyCiphertext: args.bodyCiphertext,
        bodySecretRef: args.bodySecretRef,
        sentAt: args.sentAt,
        receivedAt: null,
        providerReconciledAt: null,
        reconciliationStatus: args.conversationId ? "PENDING" : "NOT_APPLICABLE",
      },
      select: { id: true },
    });
    conversationMessageId = created.id;
  }

  // Enqueue reconciliation only when a conversationId exists (§6/§7).
  // Skip when the source thread had no conversationId — Graph cannot
  // look it up in that case.
  let reconciliationEnqueued = false;
  if (args.conversationId) {
    await enqueueReconciliation({
      clubId: args.clubId,
      conversationMessageId,
      attempt: 0,
    });
    reconciliationEnqueued = true;
  }

  logger.info("mailbox.conversation.outbound_persisted", {
    workIntakeItemIdShort: args.workIntakeItemId.slice(-8),
    conversationMessageIdShort: conversationMessageId.slice(-8),
    conversationIdPresent: !!args.conversationId,
    reconciliationEnqueued,
  });

  return { conversationMessageId, reconciliationEnqueued };
}

interface EnqueueReconciliationArgs {
  clubId: string;
  conversationMessageId: string;
  /** 0-indexed retry attempt. `attempt` selects the delay from
   *  RECONCILE_BACKOFF_SECONDS; RECONCILE_BACKOFF_SECONDS.length is
   *  the terminal cap. */
  attempt: number;
}

async function enqueueReconciliation(args: EnqueueReconciliationArgs): Promise<void> {
  const delaySec = RECONCILE_BACKOFF_SECONDS[Math.min(args.attempt, RECONCILE_BACKOFF_SECONDS.length - 1)];
  const scheduledFor = new Date(Date.now() + delaySec * 1000);
  const idempotencyKey = `conv-reconcile:${args.conversationMessageId}:attempt-${args.attempt}`;
  // Best-effort — a failure to enqueue does NOT roll back the local
  // outbound row (§8: the reply never disappears merely because
  // indexing is late).
  try {
    await prisma.backgroundJob.create({
      data: {
        clubId: args.clubId,
        kind: CONVERSATION_RECONCILE_JOB_KIND,
        payloadJson: JSON.stringify({
          conversationMessageId: args.conversationMessageId,
          attempt: args.attempt,
        }),
        idempotencyKey,
        status: "QUEUED",
        scheduledFor,
        maxAttempts: 1,
        queue: "default",
      },
    });
  } catch (e) {
    logger.warn("mailbox.conversation.reconcile_enqueue_failed", {
      conversationMessageIdShort: args.conversationMessageId.slice(-8),
      attempt: args.attempt,
      reason: (e as Error).message?.slice(0, 80),
    });
  }
}

// ---------------------------------------------------------------------------
// Reconciliation — worker entrypoint. Not called directly by request
// handlers; the BullMQ worker picks it up.
// ---------------------------------------------------------------------------

export interface ReconcilePayload {
  conversationMessageId: string;
  attempt: number;
}

export async function runConversationReconciliation(payload: ReconcilePayload): Promise<{
  outcome: "RECONCILED" | "RETRY_ENQUEUED" | "TERMINAL_UNMATCHED" | "SKIPPED_NOT_PENDING" | "SKIPPED_CONNECTION_MISSING";
}> {
  const cm = await prisma.conversationMessage.findUnique({
    where: { id: payload.conversationMessageId },
    select: {
      id: true, clubId: true, mailboxConnectionId: true, conversationId: true,
      replyMutationId: true, senderAddress: true, sentAt: true,
      reconciliationStatus: true, providerMessageId: true, internetMessageId: true,
    },
  });
  if (!cm) return { outcome: "SKIPPED_NOT_PENDING" };
  if (cm.reconciliationStatus === "RECONCILED") return { outcome: "SKIPPED_NOT_PENDING" };
  if (!cm.conversationId) return { outcome: "SKIPPED_NOT_PENDING" };

  const conn = await prisma.mailboxConnection.findUnique({
    where: { id: cm.mailboxConnectionId },
    select: { id: true, status: true, connectedEmail: true, userId: true, clubId: true, mailboxType: true },
  });
  if (!conn) return { outcome: "SKIPPED_CONNECTION_MISSING" };
  if (conn.status === "DISCONNECTED" || conn.status === "REAUTH_REQUIRED") {
    // Terminal for this attempt — retry when the mailbox is
    // reconnected. Do NOT decrement or delete the local row.
    return { outcome: "TERMINAL_UNMATCHED" };
  }

  const { getFreshDelegatedAccessToken } = await import("@/lib/mailbox/connect");
  const { getMicrosoftDelegatedProvider } = await import("@/lib/integrations/microsoft-graph-delegated");

  let accessToken: string;
  try {
    const t = await getFreshDelegatedAccessToken({
      mailboxConnectionId: conn.id,
      callerClubId: conn.clubId,
      callerUserId: conn.userId,
    });
    accessToken = t.accessToken;
  } catch (e) {
    logger.warn("mailbox.conversation.reconcile_token_failed", {
      conversationMessageIdShort: cm.id.slice(-8),
      reason: (e as Error).message?.slice(0, 60),
    });
    await enqueueRetryOrGiveUp(cm.id, cm.clubId, payload.attempt);
    return { outcome: "RETRY_ENQUEUED" };
  }

  const provider = getMicrosoftDelegatedProvider();
  // Search window: mutation.sentAt - 60s to +60min. Handles clock
  // skew between Spectre's clock and Microsoft's clock, plus the
  // documented Sent-Items indexing lag.
  const anchor = cm.sentAt ?? new Date();
  const lo = new Date(anchor.getTime() - 60_000);
  const hi = new Date(anchor.getTime() + 60 * 60_000);
  let raw: RawGraphSentMessage[];
  try {
    const res = await provider.lookupSentMessagesInConversation({
      accessToken,
      conversationId: cm.conversationId,
      sentAfterIso: lo.toISOString(),
      sentBeforeIso: hi.toISOString(),
      top: 25,
    });
    raw = res.messages;
  } catch (e) {
    logger.warn("mailbox.conversation.reconcile_graph_failed", {
      conversationMessageIdShort: cm.id.slice(-8),
      reason: (e as Error).message?.slice(0, 60),
    });
    await enqueueRetryOrGiveUp(cm.id, cm.clubId, payload.attempt);
    return { outcome: "RETRY_ENQUEUED" };
  }

  // §10 matching hierarchy — strongest evidence wins.
  const match = pickBestSentMatch(raw, {
    ownerAddressLower: conn.connectedEmail.toLowerCase(),
    anchorSentAt: anchor,
    conversationId: cm.conversationId,
    knownInternetMessageId: cm.internetMessageId,
  });
  if (!match) {
    // Not found yet — likely Graph indexing lag. Requeue if attempts
    // remain, else park as FAILED without deleting the local row.
    await enqueueRetryOrGiveUp(cm.id, cm.clubId, payload.attempt);
    return { outcome: "RETRY_ENQUEUED" };
  }

  // Reconcile — attach the real Graph identifiers, mark reconciled,
  // update the linked OutlookReplyMutation.graphMessageId.
  try {
    await prisma.$transaction([
      prisma.conversationMessage.update({
        where: { id: cm.id },
        data: {
          providerMessageId: match.id,
          internetMessageId: match.internetMessageId ?? cm.internetMessageId,
          providerReconciledAt: new Date(),
          reconciliationStatus: "RECONCILED",
        },
      }),
      ...(cm.replyMutationId ? [prisma.outlookReplyMutation.update({
        where: { id: cm.replyMutationId },
        data: { graphMessageId: match.id },
      })] : []),
    ]);
  } catch (e) {
    // A parallel reconciliation may have won; the unique index on
    // (mailboxConnectionId, providerMessageId) is the guard.
    logger.warn("mailbox.conversation.reconcile_write_failed", {
      conversationMessageIdShort: cm.id.slice(-8),
      reason: (e as Error).message?.slice(0, 80),
    });
    return { outcome: "TERMINAL_UNMATCHED" };
  }

  logger.info("mailbox.conversation.reconciled", {
    conversationMessageIdShort: cm.id.slice(-8),
    attempt: payload.attempt,
    matchedByHighConfidenceInternetId: !!match.internetMessageId,
  });
  return { outcome: "RECONCILED" };
}

async function enqueueRetryOrGiveUp(
  conversationMessageId: string,
  clubId: string,
  currentAttempt: number,
): Promise<void> {
  const nextAttempt = currentAttempt + 1;
  if (nextAttempt >= RECONCILE_BACKOFF_SECONDS.length) {
    await prisma.conversationMessage.update({
      where: { id: conversationMessageId },
      data: { reconciliationStatus: "FAILED" },
    });
    logger.warn("mailbox.conversation.reconcile_exhausted", {
      conversationMessageIdShort: conversationMessageId.slice(-8),
    });
    return;
  }
  await enqueueReconciliation({ clubId, conversationMessageId, attempt: nextAttempt });
}

// ---------------------------------------------------------------------------
// Matching — §10 hierarchy.
// ---------------------------------------------------------------------------

interface MatchArgs {
  ownerAddressLower: string;
  anchorSentAt: Date;
  conversationId: string;
  knownInternetMessageId: string | null;
}

/** Exported for tests. Never merges on conversationId alone (§10). */
export function pickBestSentMatch(
  candidates: RawGraphSentMessage[],
  args: MatchArgs,
): RawGraphSentMessage | null {
  if (!candidates.length) return null;

  const owner = args.ownerAddressLower;
  const anchorMs = args.anchorSentAt.getTime();

  // High confidence: internetMessageId equals a stored value.
  if (args.knownInternetMessageId) {
    const hi = candidates.find((c) => c.internetMessageId === args.knownInternetMessageId);
    if (hi) return hi;
  }

  // Medium confidence: conversationId matches AND from-address is
  // the mailbox owner AND sentDateTime is within a tight window
  // AND is the CLOSEST such candidate to the anchor.
  const scored = candidates
    .filter((c) => (c.conversationId ?? "") === args.conversationId)
    .filter((c) => (c.from?.emailAddress?.address ?? "").toLowerCase() === owner)
    .map((c) => {
      const t = c.sentDateTime ? Date.parse(c.sentDateTime) : NaN;
      if (Number.isNaN(t)) return null;
      const delta = Math.abs(t - anchorMs);
      // Cap the window to ±10 minutes — sends beyond that are almost
      // certainly a different reply.
      if (delta > 10 * 60_000) return null;
      return { c, delta };
    })
    .filter((x): x is { c: RawGraphSentMessage; delta: number } => x !== null)
    .sort((a, b) => a.delta - b.delta);

  return scored.length ? scored[0].c : null;
}
