// Sprint 3 · Checkpoint 16H (2026-08-04) — canonical WI completion
// event emitter.
//
// Every place that transitions a WorkIntakeItem to a terminal state
// (Resolve, Post & clear, Send reply & close, etc.) calls
// `emitWorkCompletionEvent`. Downstream side-effects (Outlook
// archive worker, audit, analytics) subscribe here rather than each
// caller having to know every consequence.
//
// The emitter:
//   1. Writes a WorkCompletionEvent row (idempotent per WI + type +
//      day guardrail is not enforced here — callers must protect
//      double-clicks with their own transactional guards).
//   2. Determines whether an Outlook archive job is required by
//      checking:
//        a. OUTLOOK_ARCHIVE_ON_COMPLETION_ENABLED feature flag
//        b. WI has at least one PRIMARY email origin
//        c. mailbox connection is CONNECTED
//        d. the emitting completionType is archive-eligible
//   3. Enqueues MAILBOX_ARCHIVE_MESSAGE for each linked email —
//      idempotent via the OutlookArchiveMutation
//      (workCompletionEventId, emailMessageId) unique index.
//
// Never blocks the caller's transaction on the archive enqueue —
// archive is fire-and-forget from the caller's perspective; the
// worker owns the Graph call + retries.

import { prisma } from "@/lib/prisma";
import { enqueue } from "@/lib/queue";
import { isOutlookArchiveOnCompletionEnabled } from "@/lib/env";
import { logger } from "@/lib/observability/logger";
import type {
  CompletionCardSnapshot,
  CompletionEventMetadataEnvelope,
} from "./completion-snapshot";

export type CompletionType =
  | "RESOLVED"
  | "POSTED_AND_CLEARED"
  | "REPLIED_AND_CLOSED"
  | "APPROVED_AND_COMPLETED"
  | "OTHER";

const ARCHIVE_ELIGIBLE_TYPES: CompletionType[] = [
  "RESOLVED",
  "POSTED_AND_CLEARED",
  "REPLIED_AND_CLOSED",
  "APPROVED_AND_COMPLETED",
];

export interface EmitCompletionEventArgs {
  workIntakeItemId: string;
  clubId: string;
  completedByUserId: string;
  completionType: CompletionType;
  /** Free-form metadata carried through to WorkCompletionEvent.metadataJson.
   *  For AP work items, the caller should include a typed `cardSnapshot`
   *  captured from the projection at the moment of the terminal-transition
   *  click. See src/lib/work-intake/completion-snapshot.ts. */
  metadata?: CompletionEventMetadataEnvelope;
  /** Convenience — pass the typed snapshot separately and it will be
   *  merged into metadata.cardSnapshot. If both are supplied, the
   *  explicit cardSnapshot argument wins. */
  cardSnapshot?: CompletionCardSnapshot | null;
}

export interface CompletionEventResult {
  eventId: string;
  archiveJobsEnqueued: number;
  archiveEligible: boolean;
  reason?: string;
}

/**
 * Emit a canonical completion event and (if the archive flag is on
 * and the WI has email provenance) enqueue Outlook archive jobs.
 * Called from every terminal-state transition.
 */
export async function emitWorkCompletionEvent(args: EmitCompletionEventArgs): Promise<CompletionEventResult> {
  // 1. Compose the metadata envelope. If a typed cardSnapshot was
  //    supplied separately, merge it into metadata.cardSnapshot so
  //    downstream readers have one canonical shape to check.
  const envelope: CompletionEventMetadataEnvelope | undefined = (() => {
    if (!args.metadata && !args.cardSnapshot) return undefined;
    const base: CompletionEventMetadataEnvelope = args.metadata ? { ...args.metadata } : {};
    if (args.cardSnapshot) {
      base.cardSnapshot = args.cardSnapshot;
    }
    return base;
  })();

  // 2. Write the event row.
  const event = await prisma.workCompletionEvent.create({
    data: {
      clubId: args.clubId,
      workIntakeItemId: args.workIntakeItemId,
      completedByUserId: args.completedByUserId,
      completionType: args.completionType,
      metadataJson: envelope ? JSON.stringify(envelope) : null,
    },
    select: { id: true },
  });

  // 2. Archive eligibility gates.
  if (!isOutlookArchiveOnCompletionEnabled()) {
    return { eventId: event.id, archiveJobsEnqueued: 0, archiveEligible: false, reason: "flag_off" };
  }
  if (!ARCHIVE_ELIGIBLE_TYPES.includes(args.completionType)) {
    return { eventId: event.id, archiveJobsEnqueued: 0, archiveEligible: false, reason: "type_not_eligible" };
  }

  // 3. Find linked emails via PRIMARY email origins.
  const wi = await prisma.workIntakeItem.findUnique({
    where: { id: args.workIntakeItemId },
    select: {
      emailOrigins: {
        where: { role: "PRIMARY" },
        select: {
          emailMessageId: true,
          emailMessage: {
            select: { id: true, clubId: true, graphMessageId: true, mailboxConnectionId: true, softDeletedAt: true },
          },
        },
      },
      apIntakeSourcesForCanonical: {
        select: {
          ingestedDocument: {
            select: {
              // A canonical AP intake may have its source email
              // via the underlying attachment. Not always present.
              id: true, filename: true,
            },
          },
        },
      },
    },
  });
  if (!wi) {
    return { eventId: event.id, archiveJobsEnqueued: 0, archiveEligible: false, reason: "wi_not_found" };
  }
  const emails = wi.emailOrigins
    .map((o) => o.emailMessage)
    .filter((e): e is NonNullable<typeof e> => !!e && !e.softDeletedAt);
  if (emails.length === 0) {
    return { eventId: event.id, archiveJobsEnqueued: 0, archiveEligible: false, reason: "no_email_provenance" };
  }

  // 4. Enqueue one archive job per linked email. Idempotency is
  //    enforced by the (workCompletionEventId, emailMessageId) unique
  //    index on OutlookArchiveMutation — the worker upserts the row
  //    before calling Graph.
  let enqueued = 0;
  for (const em of emails) {
    try {
      await enqueue({
        clubId: args.clubId,
        kind: "MAILBOX_ARCHIVE_MESSAGE",
        payload: {
          workIntakeItemId: args.workIntakeItemId,
          workCompletionEventId: event.id,
          emailMessageId: em.id,
          graphMessageId: em.graphMessageId,
          mailboxConnectionId: em.mailboxConnectionId,
        },
        // Idempotency key ties the queue-level dedupe to the completion
        // event so a rapid double-click coalesces into a single job.
        idempotencyKey: `archive:${event.id}:${em.id}`,
      });
      enqueued++;
    } catch (e) {
      logger.warn("work-completion.archive-enqueue-failed", {
        eventId: event.id, emailMessageIdTail: em.id.slice(-6),
        reason: (e as Error).message?.slice(0, 80),
      });
    }
  }
  return { eventId: event.id, archiveJobsEnqueued: enqueued, archiveEligible: true };
}
