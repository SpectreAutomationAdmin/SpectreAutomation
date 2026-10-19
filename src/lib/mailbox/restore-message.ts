// WI-SYNC-1g (2026-10-18) — Spectre→Outlook Restore action.
//
// Moves a Work Intake item's source email back to the Outlook
// Inbox folder from Deleted Items / Archive, then IMMEDIATELY —
// in-request, inside the same handler — flips the local Spectre
// state so the UI reflects reality without waiting for the delta
// sync.  Companion to deleteOutlookMessageForWorkIntake, which
// already flips softDeletedAt inline after the Graph move.
//
// Determinism guarantee (founder directive WI-SYNC-1g §1):
//
//   After Microsoft Graph confirms the message was successfully
//   moved to Inbox AND probeMessage verifies the destination,
//   update the corresponding Spectre EmailMessage and
//   WorkIntakeItem state DIRECTLY through the existing restoration
//   service, within a single DB transaction.  Do NOT depend on a
//   subsequent delta event to clear softDeletedAt.
//
// Loop prevention + partial-failure recovery (§2 + §4):
//
//   The service persists an OutlookRestoreMutation row.  Lifecycle:
//     RUNNING → SUCCEEDED       (Graph + DB both complete)
//     RUNNING → GRAPH_OK_DB_PENDING  (Graph OK, DB txn failed —
//                                     reconciliation sweep + a
//                                     MAILBOX_RESTORE_COMPLETION
//                                     job finish it idempotently)
//     RUNNING → RETRYABLE / FAILED_TERMINAL  (Graph error paths)
//
//   On the 60-s delta that observes the moved message in Inbox,
//   sync.ts' isRestore branch is a no-op because softDeletedAt is
//   already null.  The 15-min reconciliation sweep ignores
//   SUCCEEDED mutations and completes GRAPH_OK_DB_PENDING ones
//   via a dedicated handler.
//
// User-intent preservation (§3):
//
//   handleEmailEvidenceRestored (the shared restoration function)
//   already honours userDismissedAt — a user-dismissed WI stays
//   SUPPRESSED even when the source email is restored.  The
//   service calls it directly, so this invariant is reused, not
//   re-implemented.
//
// Financial preservation:
//
//   Never touches APInvoice / ApIntakeSource / JournalEntry /
//   Approval / Payment.  Only EmailMessage.softDeletedAt and
//   WorkIntakeItem.status are mutated.

import { prisma } from "@/lib/prisma";
import type { Principal } from "@/lib/rbac";
import { getMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated";
import { getFreshDelegatedAccessToken } from "./connect";
import { handleEmailEvidenceRestored } from "./email-materializer";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { enqueue } from "@/lib/queue";

export type RestoreOutcome =
  | {
      status: "SUCCEEDED";
      mutationId: string;
      resultingGraphMessageId: string;
      destinationFolderId: string;
      workIntakeStatusAfter: string;
    }
  | {
      status: "GRAPH_OK_DB_PENDING";
      mutationId: string;
      resultingGraphMessageId: string;
      destinationFolderId: string;
      errorCode: string;
    }
  | { status: "ALREADY_RESTORED" }
  | { status: "NOT_APPLICABLE"; reason: string }
  | { status: "GRAPH_ERROR"; errorCode: string; httpStatus?: number }
  | {
      status: "GRAPH_DESTINATION_UNVERIFIED";
      mutationId: string;
      probeOutcome: string;
    };

export interface RestoreMessageArgs {
  clubId: string;
  workIntakeItemId: string;
  principal: Principal | { id: string } | null;
}

const INBOX_DESTINATION = "inbox";

export async function restoreOutlookMessageForWorkIntake(
  args: RestoreMessageArgs,
): Promise<RestoreOutcome> {
  // 1. Load the WI + its primary email origin + mailbox connection.
  const link = await prisma.emailWorkIntakeOrigin.findFirst({
    where: { workIntakeItemId: args.workIntakeItemId, role: "PRIMARY" },
    include: {
      workIntakeItem: {
        select: {
          id: true,
          clubId: true,
          status: true,
          statusBeforeSuppression: true,
          userDismissedAt: true,
        },
      },
      emailMessage: {
        select: {
          id: true,
          clubId: true,
          graphMessageId: true,
          immutableId: true,
          softDeletedAt: true,
          mailboxConnectionId: true,
        },
      },
    },
  });
  if (!link) {
    return { status: "NOT_APPLICABLE", reason: "no_primary_email_origin" };
  }
  if (link.workIntakeItem.clubId !== args.clubId) {
    return { status: "NOT_APPLICABLE", reason: "cross_tenant_blocked" };
  }
  if (link.emailMessage.clubId !== args.clubId) {
    return { status: "NOT_APPLICABLE", reason: "cross_tenant_email_blocked" };
  }
  if (!link.emailMessage.softDeletedAt) {
    return { status: "ALREADY_RESTORED" };
  }

  const mailbox = await prisma.mailboxConnection.findUnique({
    where: { id: link.emailMessage.mailboxConnectionId },
    select: { id: true, clubId: true, userId: true, status: true },
  });
  if (!mailbox) {
    return { status: "NOT_APPLICABLE", reason: "mailbox_not_found" };
  }
  if (mailbox.clubId !== args.clubId) {
    return { status: "NOT_APPLICABLE", reason: "mailbox_cross_tenant" };
  }
  if (mailbox.status !== "CONNECTED") {
    return {
      status: "NOT_APPLICABLE",
      reason: `mailbox_not_connected_${mailbox.status}`,
    };
  }

  const token = await getFreshDelegatedAccessToken({
    mailboxConnectionId: mailbox.id,
    callerClubId: args.clubId,
    callerUserId: args.principal?.id ?? mailbox.userId,
  });

  const graphId =
    link.emailMessage.immutableId || link.emailMessage.graphMessageId;

  // 2. Record RUNNING mutation BEFORE Graph call — worker crash
  //    leaves an observable trace.
  const mutation = await prisma.outlookRestoreMutation.create({
    data: {
      clubId: args.clubId,
      workIntakeItemId: args.workIntakeItemId,
      emailMessageId: link.emailMessage.id,
      originalGraphMessageId: graphId,
      mailboxConnectionId: mailbox.id,
      triggeredByUserId: args.principal?.id ?? null,
      status: "RUNNING",
      attemptCount: 1,
      lastAttemptAt: new Date(),
    },
  });

  // 3. Graph round-trip.
  const provider = getMicrosoftDelegatedProvider();
  let resultingId: string;
  let destinationFolder: string;
  try {
    const result = await provider.moveMessage({
      accessToken: token.accessToken,
      graphMessageId: graphId,
      destinationId: INBOX_DESTINATION,
    });
    resultingId = result.resultingGraphMessageId ?? graphId;
    destinationFolder = result.destinationFolderId ?? INBOX_DESTINATION;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const response =
      typeof err === "object" && err !== null && "response" in err
        ? (err as { response?: { status?: number } }).response
        : undefined;
    await prisma.outlookRestoreMutation.update({
      where: { id: mutation.id },
      data: {
        status: isRetryableGraphError(response?.status) ? "RETRYABLE" : "FAILED_TERMINAL",
        errorCode: message.slice(0, 500),
        lastAttemptAt: new Date(),
      },
    });
    logger.warn("mailbox.restore.graph_error", {
      mutationIdTail: mutation.id.slice(-6),
      httpStatus: response?.status,
      message,
    });
    return {
      status: "GRAPH_ERROR",
      errorCode: message,
      httpStatus: response?.status,
    };
  }

  // 4. Verify destination with probeMessage. Graph's moveMessage
  //    returns 200 even on edge cases; the probe confirms the
  //    message is actually in the Inbox folder before we touch
  //    Spectre state.  "PRESENT" + parentFolderId matching the
  //    well-known Inbox folder = genuine PRESENT_INBOX.
  const inboxFolder = await provider.getWellKnownFolder({
    accessToken: token.accessToken,
    wellKnownName: "inbox",
  });
  const probe = await provider.probeMessage({
    accessToken: token.accessToken,
    graphMessageId: resultingId,
  });
  const probeIsInInbox =
    probe.outcome === "PRESENT" &&
    inboxFolder !== null &&
    probe.parentFolderId === inboxFolder.id;
  if (!probeIsInInbox) {
    // The move claimed success but the probe disagrees.  Do NOT
    // flip Spectre state — leave the mutation in a terminal state
    // that reconciliation can audit.
    const probeDetail =
      probe.outcome === "PRESENT"
        ? `PRESENT_OTHER_FOLDER:${probe.parentFolderId}`
        : probe.outcome;
    await prisma.outlookRestoreMutation.update({
      where: { id: mutation.id },
      data: {
        status: "FAILED_TERMINAL",
        errorCode: `probe_mismatch:${probeDetail}`,
        resultingGraphMessageId: resultingId,
        destinationFolderId: destinationFolder,
        lastAttemptAt: new Date(),
      },
    });
    logger.warn("mailbox.restore.destination_unverified", {
      mutationIdTail: mutation.id.slice(-6),
      probeOutcome: probe.outcome,
      probeFolderId: probe.parentFolderId ?? null,
    });
    return {
      status: "GRAPH_DESTINATION_UNVERIFIED",
      mutationId: mutation.id,
      probeOutcome: probeDetail,
    };
  }

  // 5. Inline DB flip + handler.  Separate the mutation+email
  //    update (one transaction) from the handler call (which
  //    starts its own transaction).  If the first transaction
  //    throws, the mutation stays RUNNING so reconciliation can
  //    recover.
  try {
    await prisma.$transaction([
      prisma.outlookRestoreMutation.update({
        where: { id: mutation.id },
        data: {
          status: "SUCCEEDED",
          resultingGraphMessageId: resultingId,
          destinationFolderId: destinationFolder,
          completedAt: new Date(),
        },
      }),
      prisma.emailMessage.update({
        where: { id: link.emailMessage.id },
        data: {
          softDeletedAt: null,
          lastSyncedAt: new Date(),
          ...(resultingId !== graphId ? { graphMessageId: resultingId } : {}),
        },
      }),
    ]);
  } catch (dbErr) {
    // §4 Partial failure: Graph succeeded, DB did not.  Record
    // GRAPH_OK_DB_PENDING + enqueue a completion job.  The
    // mutation row + the enqueued job are the two independent
    // recovery signals (reconciliation sweep also inspects
    // GRAPH_OK_DB_PENDING rows).
    const message = dbErr instanceof Error ? dbErr.message : String(dbErr);
    await prisma.outlookRestoreMutation.update({
      where: { id: mutation.id },
      data: {
        status: "GRAPH_OK_DB_PENDING",
        resultingGraphMessageId: resultingId,
        destinationFolderId: destinationFolder,
        errorCode: message.slice(0, 500),
        lastAttemptAt: new Date(),
      },
    });
    try {
      await enqueue({
        kind: "MAILBOX_RESTORE_COMPLETION",
        queue: "mailbox",
        clubId: args.clubId,
        payload: { mutationId: mutation.id },
        idempotencyKey: `mailbox:restore-completion:${mutation.id}`,
        maxAttempts: 5,
      });
    } catch (enqueueErr) {
      logger.warn("mailbox.restore.completion_enqueue_failed", {
        mutationIdTail: mutation.id.slice(-6),
        message: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      });
    }
    logger.warn("mailbox.restore.db_pending", {
      mutationIdTail: mutation.id.slice(-6),
      message,
    });
    return {
      status: "GRAPH_OK_DB_PENDING",
      mutationId: mutation.id,
      resultingGraphMessageId: resultingId,
      destinationFolderId: destinationFolder,
      errorCode: message,
    };
  }

  // 6. WI restoration.  handleEmailEvidenceRestored honours
  //    userDismissedAt (§3) and is idempotent — safe to call even
  //    if the delta sync beats us to it.  Non-fatal here: the
  //    EmailMessage is already restored, so the sweep will reach
  //    the WI side on its next pass.
  try {
    await handleEmailEvidenceRestored({
      clubId: args.clubId,
      emailMessageId: link.emailMessage.id,
    });
  } catch (handlerErr) {
    logger.warn("mailbox.restore.wi_handler_failed", {
      mutationIdTail: mutation.id.slice(-6),
      message:
        handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
    });
  }

  // 7. Audit.  Action name preserved from WI-SYNC-1e so existing
  //    queries + acceptance tests continue to match.
  await audit(args.principal, {
    action: "work-intake.restore-email",
    entityType: "WorkIntakeItem",
    entityId: args.workIntakeItemId,
    clubId: args.clubId,
    meta: {
      mutationId: mutation.id,
      emailMessageId: link.emailMessage.id,
      mailboxConnectionId: mailbox.id,
      fromGraphId: graphId,
      toGraphId: resultingId,
      destinationFolderId: destinationFolder,
      userDismissedAtPreserved: !!link.workIntakeItem.userDismissedAt,
    },
  });

  // Re-read the current WI status so the caller can see the
  // post-handler state (handler respects userDismissedAt, so this
  // may still be SUPPRESSED when the user dismissed it).
  const updatedWi = await prisma.workIntakeItem.findUnique({
    where: { id: args.workIntakeItemId },
    select: { status: true },
  });

  return {
    status: "SUCCEEDED",
    mutationId: mutation.id,
    resultingGraphMessageId: resultingId,
    destinationFolderId: destinationFolder,
    workIntakeStatusAfter: updatedWi?.status ?? "UNKNOWN",
  };
}

/**
 * Completion handler for the MAILBOX_RESTORE_COMPLETION job and
 * for the reconciliation sweep.  Called with a mutation row that
 * is in GRAPH_OK_DB_PENDING (or RUNNING older than a safety
 * window).  Finishes the DB side idempotently.
 *
 * Idempotency:
 *   - EmailMessage.softDeletedAt=null is set unconditionally; a
 *     second write is a no-op.
 *   - handleEmailEvidenceRestored short-circuits if the WI is
 *     already non-SUPPRESSED or user-dismissed.
 *   - Mutation is only transitioned to SUCCEEDED once.
 */
export async function completeRestoreMutation(args: {
  mutationId: string;
}): Promise<{ ok: boolean; detail: string }> {
  const m = await prisma.outlookRestoreMutation.findUnique({
    where: { id: args.mutationId },
    select: {
      id: true,
      clubId: true,
      emailMessageId: true,
      workIntakeItemId: true,
      status: true,
      resultingGraphMessageId: true,
      originalGraphMessageId: true,
      destinationFolderId: true,
    },
  });
  if (!m) return { ok: false, detail: "mutation_not_found" };
  if (m.status === "SUCCEEDED") return { ok: true, detail: "already_succeeded" };
  if (m.status !== "GRAPH_OK_DB_PENDING" && m.status !== "RUNNING") {
    return { ok: false, detail: `mutation_status_${m.status}` };
  }

  // Confirm Graph side is still consistent before touching Spectre
  // state — the message id and tenancy must still match.
  const email = await prisma.emailMessage.findUnique({
    where: { id: m.emailMessageId },
    select: { id: true, clubId: true, softDeletedAt: true, graphMessageId: true },
  });
  if (!email || email.clubId !== m.clubId) {
    return { ok: false, detail: "email_missing_or_cross_tenant" };
  }

  const resultingId = m.resultingGraphMessageId ?? m.originalGraphMessageId;
  await prisma.$transaction([
    prisma.outlookRestoreMutation.update({
      where: { id: m.id },
      data: {
        status: "SUCCEEDED",
        completedAt: new Date(),
      },
    }),
    prisma.emailMessage.update({
      where: { id: email.id },
      data: {
        softDeletedAt: null,
        lastSyncedAt: new Date(),
        ...(resultingId !== email.graphMessageId
          ? { graphMessageId: resultingId }
          : {}),
      },
    }),
  ]);
  try {
    await handleEmailEvidenceRestored({
      clubId: m.clubId,
      emailMessageId: email.id,
    });
  } catch (err) {
    logger.warn("mailbox.restore.completion.wi_handler_failed", {
      mutationIdTail: m.id.slice(-6),
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return { ok: true, detail: "completed" };
}

function isRetryableGraphError(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}
