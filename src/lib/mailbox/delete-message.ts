// WI-SYNC-1c (2026-10-18) — Spectre→Outlook Delete action.
//
// Moves a Work Intake item's source email to Outlook's Deleted
// Items folder, then flips the local Spectre state in sync.  The
// user's intent is "I want this message out of my inbox AND
// Spectre's feed."  Companion to the Archive action; distinct in
// semantics (Delete goes to Deleted Items, Archive goes to
// Archive).
//
// Loop prevention: the service persists an OutlookDeleteMutation
// row with status=SUCCEEDED on the Graph round-trip.  When the
// 60-s delta sync later observes `@removed` for the same message,
// handleEmailEvidenceDeleted checks for a SUCCEEDED mutation and
// records a reconciliation activity rather than re-suppressing a
// WI that's already suppressed.
//
// Financial preservation: never touches APInvoice / ApIntakeSource
// / JournalEntry / Approval / Payment.  Spectre's accounting
// workflow is a separate module and survives any mailbox change.

import { prisma } from "@/lib/prisma";
import type { Principal } from "@/lib/rbac";
import { getMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated";
import { getFreshDelegatedAccessToken } from "./connect";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";

export type DeleteOutcome =
  | {
      status: "SUCCEEDED";
      mutationId: string;
      resultingGraphMessageId: string;
      destinationFolderId: string;
      workIntakeStatusBefore: string;
    }
  | { status: "ALREADY_DELETED" }
  | { status: "NOT_APPLICABLE"; reason: string }
  | { status: "GRAPH_ERROR"; errorCode: string; httpStatus?: number };

export interface DeleteMessageArgs {
  clubId: string;
  workIntakeItemId: string;
  principal: Principal | { id: string } | null;
}

/** The well-known destination folder name Graph accepts for the
 *  move. */
const DELETED_ITEMS_DESTINATION = "deleteditems";

export async function deleteOutlookMessageForWorkIntake(
  args: DeleteMessageArgs,
): Promise<DeleteOutcome> {
  // 1. Load the WI + its primary email origin + mailbox connection.
  //    Everything tenant-guarded by clubId.
  const link = await prisma.emailWorkIntakeOrigin.findFirst({
    where: {
      workIntakeItemId: args.workIntakeItemId,
      role: "PRIMARY",
    },
    include: {
      workIntakeItem: {
        select: {
          id: true,
          clubId: true,
          status: true,
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
  if (link.emailMessage.softDeletedAt) {
    return { status: "ALREADY_DELETED" };
  }

  // 2. Fresh delegated token (owner callerId required for the
  //    token-refresh audit).
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

  // 3. Create a PENDING mutation row BEFORE the Graph call so a
  //    worker crash leaves an observable trace.
  const mutation = await prisma.outlookDeleteMutation.create({
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

  // 4. Graph round-trip — reuse the existing moveMessage path.
  const provider = getMicrosoftDelegatedProvider();
  try {
    const result = await provider.moveMessage({
      accessToken: token.accessToken,
      graphMessageId: graphId,
      destinationId: DELETED_ITEMS_DESTINATION,
    });

    const resultingId = result.resultingGraphMessageId ?? graphId;
    const destinationFolder = result.destinationFolderId ?? DELETED_ITEMS_DESTINATION;

    // 5. On success: in a single transaction —
    //      a. mark the mutation SUCCEEDED;
    //      b. flip EmailMessage.softDeletedAt + persist the new
    //         Graph ID if it changed;
    //      c. save WI.statusBeforeSuppression (current status) +
    //         flip WI.status to SUPPRESSED;
    //      d. write EVIDENCE_DELETED activity row.
    const workIntakeStatusBefore = link.workIntakeItem.status;
    await prisma.$transaction([
      prisma.outlookDeleteMutation.update({
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
          softDeletedAt: new Date(),
          lastSyncedAt: new Date(),
          ...(resultingId !== graphId
            ? { graphMessageId: resultingId }
            : {}),
        },
      }),
      prisma.workIntakeItem.update({
        where: { id: link.workIntakeItem.id },
        data: {
          status: "SUPPRESSED",
          statusBeforeSuppression: workIntakeStatusBefore,
        },
      }),
      prisma.workIntakeActivity.create({
        data: {
          workIntakeItemId: link.workIntakeItem.id,
          action: "EVIDENCE_DELETED",
          note: "Source email deleted by Spectre user (sent to Outlook Deleted Items).",
        },
      }),
    ]);

    await audit(args.principal, {
      action: "mailbox.message.delete",
      entityType: "WorkIntakeItem",
      entityId: args.workIntakeItemId,
      clubId: args.clubId,
      meta: {
        mutationId: mutation.id,
        emailMessageId: link.emailMessage.id,
        mailboxConnectionId: mailbox.id,
        workIntakeStatusBefore,
      },
    });

    return {
      status: "SUCCEEDED",
      mutationId: mutation.id,
      resultingGraphMessageId: resultingId,
      destinationFolderId: destinationFolder,
      workIntakeStatusBefore,
    };
  } catch (err) {
    // 6. On Graph failure: record on the mutation + leave Spectre
    //    state untouched.  Caller sees an error; a retry will
    //    create a new mutation row.
    const message = err instanceof Error ? err.message : String(err);
    const response =
      typeof err === "object" && err !== null && "response" in err
        ? (err as { response?: { status?: number } }).response
        : undefined;
    await prisma.outlookDeleteMutation.update({
      where: { id: mutation.id },
      data: {
        status: isRetryableGraphError(response?.status) ? "RETRYABLE" : "FAILED_TERMINAL",
        errorCode: message.slice(0, 500),
        lastAttemptAt: new Date(),
      },
    });
    logger.warn("mailbox.delete.graph_error", {
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
}

function isRetryableGraphError(status: number | undefined): boolean {
  if (status === undefined) return true; // network / timeout
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}
