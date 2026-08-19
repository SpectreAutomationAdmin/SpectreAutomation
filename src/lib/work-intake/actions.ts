// Sprint 2 B4 (2026-07-19) — Work Intake orchestration actions.
//
// Minimum action set the founder called out in §15: mark informational,
// resolve, reopen, defer, assign-to-self. Every action:
//   • is tenant-scoped
//   • enforces personal-mailbox visibility (via the tenant guard from B1)
//   • appends a WorkIntakeActivity row
//   • preserves email evidence
//   • survives a subsequent resync (materialiser will NOT overwrite
//     orchestration state; only display / classification refreshes)
//
// Broad cross-user assignment is intentionally out of scope. B4 supports
// self-assignment only.

import { prisma } from "@/lib/prisma";
import { workIntakeReadableByPrincipal } from "@/lib/work-intake/tenant";
import type { Principal } from "@/lib/rbac";
import type { CompletionCardSnapshot } from "./completion-snapshot";

interface ActionCtx {
  principal: Principal;
  clubId: string;
  workIntakeItemId: string;
}

/**
 * Load the intake and verify the principal is authorised to see it.
 * Throws NotFound-style ForbiddenError otherwise. Used by every
 * action so authorisation is one place.
 */
async function loadAuthorisedIntake(ctx: ActionCtx) {
  const where = workIntakeReadableByPrincipal({
    userId: ctx.principal.id,
    clubId: ctx.clubId,
    isClubAdmin: false,
    isSuperAdmin: false,
  });
  const it = await prisma.workIntakeItem.findFirst({
    where: { AND: [{ id: ctx.workIntakeItemId }, where] },
  });
  if (!it) throw new WorkIntakeActionError("not_visible");
  return it;
}

export class WorkIntakeActionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Work Intake action error: ${code}`);
    this.name = "WorkIntakeActionError";
    this.code = code;
  }
}

export async function resolveIntake(
  ctx: ActionCtx,
  note?: string,
  opts?: {
    completionType?: "RESOLVED" | "REPLIED_AND_CLOSED" | "OTHER";
    /** Phase 4R Completed-State Immutability (2026-08-15) — the
     *  founder-facing card facts as rendered at the moment the user
     *  clicked the terminal-transition button. Persisted on
     *  WorkCompletionEvent.metadataJson.cardSnapshot so Completed
     *  History renders the approved historical facts, not whatever
     *  the analyser reports today. Optional: legacy callers that do
     *  not have a projection to pass (e.g. informational Resolve of
     *  a non-AP item) may omit; the reader falls back to live
     *  projection with a "legacy" source marker. */
    cardSnapshot?: CompletionCardSnapshot | null;
  },
): Promise<void> {
  const it = await loadAuthorisedIntake(ctx);
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: it.id },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolvedByUserId: ctx.principal.id,
      },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: it.id,
        actorUserId: ctx.principal.id,
        action: "RESOLVED",
        fromValue: it.status,
        toValue: "RESOLVED",
        note: note ?? null,
      },
    }),
  ]);
  // Sprint 3 · Checkpoint 16H — emit canonical completion event
  // AFTER the transaction commits, so the archive worker never
  // races the WI status write. Failure here does NOT roll back
  // the resolve (the worker owns its own retries).
  try {
    const { emitWorkCompletionEvent } = await import("./completion");
    await emitWorkCompletionEvent({
      workIntakeItemId: it.id,
      clubId: it.clubId,
      completedByUserId: ctx.principal.id,
      completionType: opts?.completionType ?? "RESOLVED",
      cardSnapshot: opts?.cardSnapshot ?? null,
    });
  } catch {
    // Never block resolve on event emission.
  }
}

export async function reopenIntake(ctx: ActionCtx): Promise<void> {
  const it = await loadAuthorisedIntake(ctx);
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: it.id },
      data: {
        status: "OPEN",
        resolvedAt: null,
        resolvedByUserId: null,
        deferredUntil: null,
      },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: it.id,
        actorUserId: ctx.principal.id,
        action: "REOPENED",
        fromValue: it.status,
        toValue: "OPEN",
      },
    }),
  ]);
}

/**
 * Sprint 3 · Checkpoint 16H completion (2026-08-05) — restore a
 * completed Work Intake back to Active.
 *
 * Asymmetric semantics (per founder §13-15):
 *   * The WI returns to the active feed with its ORIGINAL id + all
 *     provenance + all prior activity + prior completion event
 *     preserved.
 *   * Archived Outlook messages are NOT moved back to Inbox in this
 *     checkpoint.
 *   * Sent replies are NOT re-sent.
 *   * Posted AP invoices are NOT reversed.
 *
 * Records a WorkRestorationEvent capturing who + when + which
 * completion is being reversed. Idempotent — a second call while the
 * WI is already OPEN is a no-op (records no duplicate row).
 */
export async function restoreIntake(ctx: ActionCtx, reason?: string): Promise<void> {
  const it = await loadAuthorisedIntake(ctx);
  // Idempotency: nothing to do if already active. Never records a
  // "restore" event for a WI that's already Active.
  if (it.status !== "RESOLVED" && it.status !== "INFORMATIONAL" && it.status !== "SUPPRESSED") {
    return;
  }
  // Grab the most recent completion event for audit linkage.
  const priorCompletion = await prisma.workCompletionEvent.findFirst({
    where: { workIntakeItemId: it.id },
    orderBy: { completedAt: "desc" },
    select: { id: true },
  }).catch(() => null);

  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: it.id },
      data: {
        status: "OPEN",
        // NEVER clear resolvedAt / resolvedByUserId — those preserve
        // the original completion record. Restoration is a separate
        // event, not a rewrite of history.
        deferredUntil: null,
      },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: it.id,
        actorUserId: ctx.principal.id,
        action: "RESTORED",
        fromValue: it.status,
        toValue: "OPEN",
        note: reason ?? "Restored to Work Intake Feed",
      },
    }),
    prisma.workRestorationEvent.create({
      data: {
        clubId: it.clubId,
        workIntakeItemId: it.id,
        restoredByUserId: ctx.principal.id,
        priorCompletionEventId: priorCompletion?.id ?? null,
        reason: reason ?? null,
      },
    }),
  ]);
}

export async function markInformational(ctx: ActionCtx): Promise<void> {
  const it = await loadAuthorisedIntake(ctx);
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: it.id },
      data: { status: "INFORMATIONAL", judgmentRequired: false },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: it.id,
        actorUserId: ctx.principal.id,
        action: "STATUS_CHANGED",
        fromValue: it.status,
        toValue: "INFORMATIONAL",
      },
    }),
  ]);
}

export async function deferIntake(ctx: ActionCtx, until: Date): Promise<void> {
  if (!(until instanceof Date) || Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
    throw new WorkIntakeActionError("invalid_defer_time");
  }
  const it = await loadAuthorisedIntake(ctx);
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: it.id },
      data: { status: "DEFERRED", deferredUntil: until },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: it.id,
        actorUserId: ctx.principal.id,
        action: "DEFERRED",
        fromValue: it.status,
        toValue: "DEFERRED",
        note: until.toISOString(),
      },
    }),
  ]);
}

export async function assignToSelf(ctx: ActionCtx): Promise<void> {
  const it = await loadAuthorisedIntake(ctx);
  await prisma.$transaction([
    prisma.workIntakeItem.update({
      where: { id: it.id },
      data: {
        ownerUserId: ctx.principal.id,
        status: it.status === "OPEN" ? "IN_PROGRESS" : it.status,
      },
    }),
    prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: it.id,
        actorUserId: ctx.principal.id,
        action: "ASSIGNED",
        fromValue: it.ownerUserId ?? null,
        toValue: ctx.principal.id,
      },
    }),
  ]);
}

/**
 * Sprint 3 Checkpoint 15I — per-user read state.
 * Upsert a WorkIntakeItemRead row for (workIntakeItemId, userId).
 * Idempotent: repeated calls do NOT bump readAt and do NOT append
 * activity — read is a UI hint, not a domain state change. Absence
 * of a row = unread for that user; presence = read.
 *
 * Tenant guard applies via loadAuthorisedIntake — a user can only
 * mark-read intakes they can already see.
 *
 * Phase 4R rev-10 (2026-08-15) — after the local upsert, propagate
 * the read state to Outlook for every linked PRIMARY email whose
 * current local mirror still reports isRead=false. The Graph PATCH
 * is enqueued so a slow or offline mailbox cannot block the UI
 * click. Idempotency is guarded by the OutlookMarkReadMutation
 * unique constraint on (mailboxConnectionId, emailMessageId) — a
 * second click cannot enqueue a duplicate PATCH. Non-email items
 * (no linked email) skip the enqueue entirely.
 */
export async function markWorkIntakeRead(ctx: ActionCtx): Promise<void> {
  const it = await loadAuthorisedIntake(ctx);
  await prisma.workIntakeItemRead.upsert({
    where: {
      workIntakeItemId_userId: {
        workIntakeItemId: it.id,
        userId: ctx.principal.id,
      },
    },
    update: {}, // idempotent — do not bump readAt on repeat
    create: {
      workIntakeItemId: it.id,
      userId: ctx.principal.id,
    },
  });
  await enqueueOutlookMarkReadForLinkedEmails({
    workIntakeItemId: it.id,
    triggeredByUserId: ctx.principal.id,
  });
}

/**
 * Phase 4R rev-10 helper — enqueue a MAILBOX_MARK_READ job for
 * each PRIMARY-role linked email whose local mirror still reports
 * `isRead === false`. Non-email items produce zero jobs.
 *
 * We only touch PRIMARY origins (never EVIDENCE) so an unrelated
 * evidence email attached to a card is not mutated in Outlook.
 * `EMAIL_MARK_READ_ON_INTERACTION_ENABLED` gates the whole feature
 * so the write path can be flipped off in an emergency without a
 * rollback.
 */
async function enqueueOutlookMarkReadForLinkedEmails(args: {
  workIntakeItemId: string;
  triggeredByUserId: string;
}): Promise<void> {
  const { isEmailMarkReadOnInteractionEnabled } = await import("@/lib/env");
  if (!isEmailMarkReadOnInteractionEnabled()) return;

  // Find PRIMARY linked emails whose local mirror still reports unread.
  // Non-email items produce an empty list and skip the enqueue.
  const origins = await prisma.emailWorkIntakeOrigin.findMany({
    where: {
      workIntakeItemId: args.workIntakeItemId,
      role: "PRIMARY",
    },
    select: {
      emailMessageId: true,
      emailMessage: {
        select: {
          id: true,
          clubId: true,
          isRead: true,
          softDeletedAt: true,
          graphMessageId: true,
          mailboxConnectionId: true,
          updatedAt: true,
        },
      },
    },
  });
  if (origins.length === 0) return; // non-email item or evidence-only card

  const { enqueue } = await import("@/lib/queue");
  const { logger } = await import("@/lib/observability/logger");
  // Rev-13 (2026-08-16) — status values that indicate a mark-read
  // intent is CURRENTLY active. Historical statuses (SUCCEEDED,
  // FAILED_TERMINAL, NOT_REQUIRED, SUPERSEDED) do NOT block a new
  // generation — that was the rev-10 permanent-latch bug.
  const ACTIVE_STATUSES = ["PENDING", "RUNNING", "RETRYABLE"] as const;
  for (const origin of origins) {
    const email = origin.emailMessage;
    if (!email) continue;
    // Rev-13 — the stale-mirror short-circuit is preserved as an
    // optimisation (if we already know the email is read, don't
    // enqueue a PATCH that would be a no-op). The rev-12 bug was
    // NOT this check; it was the permanent SUCCEEDED latch on the
    // mutation row. After Fix A ships, the manual Feed Sync path
    // guarantees the local mirror is fresh before the founder
    // clicks the card, so this check will not lag reality.
    if (email.isRead) continue;
    if (email.softDeletedAt) continue;
    try {
      // Rev-13 active-intent dedupe (Fix B). If there is already an
      // active mutation row for THIS (mailboxConnection, email) —
      // status IN ('PENDING','RUNNING','RETRYABLE') — a duplicate
      // click during that window must NOT create a second row or a
      // second Graph PATCH. Historical rows are ignored.
      const existingActive = await prisma.outlookMarkReadMutation.findFirst({
        where: {
          mailboxConnectionId: email.mailboxConnectionId,
          emailMessageId: email.id,
          status: { in: [...ACTIVE_STATUSES] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, createdAt: true },
      });
      if (existingActive) {
        logger.info("work-intake.mark-read.active-intent-dedupe", {
          workIntakeItemIdTail: args.workIntakeItemId.slice(-6),
          emailMessageIdTail: email.id.slice(-6),
          activeMutationIdTail: existingActive.id.slice(-6),
          activeStatus: existingActive.status,
        });
        continue;
      }

      // Rev-13 (Fix B) — CREATE a new mutation row for this
      // generation. `generationCursor` records the email's
      // updatedAt at enqueue time; the worker loads the row by
      // id and closes it through its own lifecycle (SUCCEEDED /
      // FAILED_TERMINAL / SUPERSEDED / NOT_REQUIRED). Historical
      // rows for prior generations remain as immutable audit.
      const mutation = await prisma.outlookMarkReadMutation.create({
        data: {
          clubId: email.clubId,
          workIntakeItemId: args.workIntakeItemId,
          emailMessageId: email.id,
          graphMessageId: email.graphMessageId,
          mailboxConnectionId: email.mailboxConnectionId,
          triggeredByUserId: args.triggeredByUserId,
          generationCursor: email.updatedAt.toISOString(),
          status: "PENDING",
          attemptCount: 0,
        },
        select: { id: true },
      });

      await enqueue({
        kind: "MAILBOX_MARK_READ",
        clubId: email.clubId,
        payload: {
          workIntakeItemId: args.workIntakeItemId,
          emailMessageId: email.id,
          graphMessageId: email.graphMessageId,
          mailboxConnectionId: email.mailboxConnectionId,
          triggeredByUserId: args.triggeredByUserId,
          markReadMutationId: mutation.id,
        },
        // Rev-13 — idempotencyKey includes the mutation ID so each
        // generation has its own key. The queue layer's dedupe still
        // collapses truly concurrent enqueues of the same key (rare
        // if the active-intent guard above is honoured). Historical
        // COMPLETED queue rows do not block, per queue semantics.
        idempotencyKey: `mailbox-mark-read:${email.mailboxConnectionId}:${email.id}:${mutation.id}`,
      });
    } catch (e) {
      // Failure to enqueue must NOT roll back the local
      // WorkIntakeItemRead upsert — the founder still gets a
      // responsive local read. Log and continue.
      logger.warn("work-intake.mark-read.enqueue-failed", {
        workIntakeItemIdTail: args.workIntakeItemId.slice(-6),
        emailMessageIdTail: email.id.slice(-6),
        error: (e as Error).message,
      });
    }
  }
}
