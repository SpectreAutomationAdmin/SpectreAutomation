// Sprint 3 · Checkpoint 15P-7 (2026-07-28), rewritten in
// Checkpoint 16H (2026-08-04) — Outlook message archival via
// Microsoft Graph.
//
// One canonical archive worker consumed by:
//   * WorkCompletionEvent emitter (any WI resolve / post & clear /
//     send-reply-and-close);
//   * legacy AP post-and-clear path (still enqueues here).
//
// The handler:
//   1. Loads the EmailMessage + MailboxConnection.
//   2. Feature-flag gate (OUTLOOK_ARCHIVE_ON_COMPLETION_ENABLED).
//   3. Idempotency: upsert an OutlookArchiveMutation keyed by
//      (workCompletionEventId, emailMessageId). Concurrent workers
//      cannot double-move.
//   4. Obtains a fresh delegated bearer token, verifies scope
//      grantedScopes ∋ Mail.ReadWrite, calls Graph
//      POST /me/messages/{id}/move { destinationId: "archive" }.
//   5. Persists the resulting message id + folder id so delta-sync
//      reconciliation can recognise the move and NOT flip the WI
//      to SUPPRESSED nor re-materialise.
//   6. Retryable errors throw so the queue retries with backoff;
//      terminal errors are recorded on the mutation and the queue
//      marks the job failed.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { isOutlookArchiveOnCompletionEnabled } from "@/lib/env";
import { APPROVED_DELEGATED_SCOPES } from "@/lib/integrations/microsoft-graph-delegated";

export type ArchiveOutcome =
  | { status: "SUCCEEDED"; archiveMutationId: string; resultingGraphMessageId: string; destinationFolderId: string }
  | { status: "NOT_REQUIRED"; reason: string }
  | { status: "PENDING_SCOPE"; missingScopes: string[] }
  | { status: "RETRYABLE"; error: string }
  | { status: "FAILED_TERMINAL"; error: string };

export interface MailboxArchiveMessagePayload {
  workIntakeItemId: string;
  workCompletionEventId?: string;
  emailMessageId: string;
  graphMessageId: string;
  mailboxConnectionId: string;
  // Legacy 15P-7 field — still supported for AP post-and-clear path.
  apInvoiceId?: string;
}

const REQUIRED_SCOPES = ["Mail.ReadWrite"];
const ARCHIVE_DESTINATION_WELLKNOWN = "archive";

export async function runMailboxArchiveMessage(
  payload: MailboxArchiveMessagePayload,
): Promise<ArchiveOutcome> {
  // 0. Master feature-flag gate. If disabled, record NOT_REQUIRED
  //    and return — the queue does not retry NOT_REQUIRED.
  if (!isOutlookArchiveOnCompletionEnabled()) {
    logger.info("mailbox.archive.flag-off", {
      workIntakeItemIdTail: payload.workIntakeItemId.slice(-6),
    });
    return { status: "NOT_REQUIRED", reason: "flag_off" };
  }

  // 1. Load email + mailbox connection.
  const email = await prisma.emailMessage.findUnique({
    where: { id: payload.emailMessageId },
    select: {
      id: true, clubId: true, graphMessageId: true, immutableId: true,
      mailboxConnectionId: true, softDeletedAt: true,
    },
  });
  if (!email) {
    logger.warn("mailbox.archive.email-missing", { emailMessageId: payload.emailMessageId });
    return { status: "FAILED_TERMINAL", error: "EmailMessage not found" };
  }
  if (email.softDeletedAt) {
    return { status: "NOT_REQUIRED", reason: "email_soft_deleted" };
  }

  // 2. Scope allowlist check.
  const missingScopes = REQUIRED_SCOPES.filter(
    (s) => !(APPROVED_DELEGATED_SCOPES as readonly string[]).includes(s),
  );
  if (missingScopes.length > 0) {
    logger.info("mailbox.archive.pending-scope-allowlist", {
      workIntakeItemIdTail: payload.workIntakeItemId.slice(-6), missingScopes,
    });
    return { status: "PENDING_SCOPE", missingScopes };
  }

  // 3. Idempotency: upsert the mutation row keyed on the completion
  //    event + message. Concurrent workers cannot double-move.
  const mutation = await upsertMutation({
    clubId: email.clubId,
    workIntakeId: payload.workIntakeItemId,
    workCompletionEventId: payload.workCompletionEventId ?? null,
    emailMessageId: email.id,
    originalExternalMessageId: email.graphMessageId,
    mailboxConnectionId: email.mailboxConnectionId,
  });
  if (mutation.status === "SUCCEEDED") {
    return {
      status: "SUCCEEDED", archiveMutationId: mutation.id,
      resultingGraphMessageId: mutation.resultingExternalMessageId ?? email.graphMessageId,
      destinationFolderId: mutation.destinationFolderId ?? ARCHIVE_DESTINATION_WELLKNOWN,
    };
  }
  if (mutation.status === "FAILED_TERMINAL") {
    return { status: "FAILED_TERMINAL", error: mutation.errorCode ?? "prior_terminal_failure" };
  }

  // 4. Check MailboxConnection.grantedScopes — user consent gate.
  const conn = await prisma.mailboxConnection.findUnique({
    where: { id: email.mailboxConnectionId },
    select: { grantedScopes: true, status: true, userId: true },
  });
  if (!conn || conn.status !== "CONNECTED") {
    await markMutation(mutation.id, { status: "RETRYABLE", errorCode: "connection_not_ready" });
    return { status: "RETRYABLE", error: "mailbox_connection_not_connected" };
  }
  const grantedScopes = (conn.grantedScopes ?? "").split(/\s+/).filter(Boolean);
  if (!grantedScopes.map((s) => s.toLowerCase()).includes("mail.readwrite")) {
    await markMutation(mutation.id, { status: "RETRYABLE", errorCode: "user_consent_missing" });
    return { status: "PENDING_SCOPE", missingScopes: ["Mail.ReadWrite"] };
  }

  // 5. Perform the Graph move via the provider.
  const { getFreshDelegatedAccessToken } = await import("./connect");
  const { getMicrosoftDelegatedProvider } = await import("@/lib/integrations/microsoft-graph-delegated");
  const provider = getMicrosoftDelegatedProvider();
  try {
    const tok = await getFreshDelegatedAccessToken({
      mailboxConnectionId: email.mailboxConnectionId,
      callerClubId: email.clubId,
      callerUserId: conn.userId,
    });
    const result = await provider.moveMessage({
      accessToken: tok.accessToken,
      graphMessageId: email.graphMessageId,
      destinationId: ARCHIVE_DESTINATION_WELLKNOWN,
    });
    await markMutation(mutation.id, {
      status: "SUCCEEDED",
      resultingExternalMessageId: result.resultingGraphMessageId,
      destinationFolderId: result.destinationFolderId,
      completedAt: new Date(),
    });
    logger.info("mailbox.archive.succeeded", {
      workIntakeItemIdTail: payload.workIntakeItemId.slice(-6),
      emailMessageIdTail: email.id.slice(-6),
    });
    return {
      status: "SUCCEEDED",
      archiveMutationId: mutation.id,
      resultingGraphMessageId: result.resultingGraphMessageId,
      destinationFolderId: result.destinationFolderId,
    };
  } catch (e) {
    const err = e as Error & { code?: string; status?: number };
    // Terminal error classes: 404 message-not-found, 401/403 permission.
    // Everything else is retryable.
    const isTerminal =
      err.status === 404 ||
      err.status === 410 ||
      err.code === "MESSAGE_NOT_FOUND" ||
      err.code === "FOLDER_NOT_FOUND";
    if (isTerminal) {
      await markMutation(mutation.id, { status: "FAILED_TERMINAL", errorCode: err.code ?? `http_${err.status ?? "unknown"}` });
      return { status: "FAILED_TERMINAL", error: err.message ?? "terminal_failure" };
    }
    await markMutation(mutation.id, { status: "RETRYABLE", errorCode: err.code ?? `http_${err.status ?? "unknown"}` });
    // Throw so the queue backs off + retries.
    throw err;
  }
}

interface MutationRow {
  id: string;
  status: string;
  resultingExternalMessageId?: string | null;
  destinationFolderId?: string | null;
  errorCode?: string | null;
}

async function upsertMutation(args: {
  clubId: string;
  workIntakeId: string;
  workCompletionEventId: string | null;
  emailMessageId: string;
  originalExternalMessageId: string;
  mailboxConnectionId: string;
}): Promise<MutationRow> {
  // Unique constraint is on (workCompletionEventId, emailMessageId).
  // For legacy AP path where workCompletionEventId is null, fall
  // back to a per-message lookup + create pattern.
  if (args.workCompletionEventId) {
    const existing = await prisma.outlookArchiveMutation.findUnique({
      where: {
        workCompletionEventId_emailMessageId: {
          workCompletionEventId: args.workCompletionEventId,
          emailMessageId: args.emailMessageId,
        },
      },
      select: { id: true, status: true, resultingExternalMessageId: true, destinationFolderId: true, errorCode: true },
    });
    if (existing) {
      // Advance attemptCount.
      await prisma.outlookArchiveMutation.update({
        where: { id: existing.id },
        data: { attemptCount: { increment: 1 }, lastAttemptAt: new Date(), status: existing.status === "SUCCEEDED" ? "SUCCEEDED" : "RUNNING" },
      });
      return existing;
    }
  }
  const created = await prisma.outlookArchiveMutation.create({
    data: {
      clubId: args.clubId, workIntakeId: args.workIntakeId,
      workCompletionEventId: args.workCompletionEventId,
      emailMessageId: args.emailMessageId,
      originalExternalMessageId: args.originalExternalMessageId,
      mailboxConnectionId: args.mailboxConnectionId,
      status: "RUNNING", attemptCount: 1, lastAttemptAt: new Date(),
    },
    select: { id: true, status: true, resultingExternalMessageId: true, destinationFolderId: true, errorCode: true },
  });
  return created;
}

async function markMutation(id: string, data: {
  status?: string;
  resultingExternalMessageId?: string;
  destinationFolderId?: string;
  completedAt?: Date;
  errorCode?: string;
}): Promise<void> {
  await prisma.outlookArchiveMutation.update({ where: { id }, data });
}
