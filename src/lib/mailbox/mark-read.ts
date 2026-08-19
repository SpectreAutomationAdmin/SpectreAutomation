// Phase 4R rev-13 (2026-08-16) — Outlook mark-as-read worker.
//
// One canonical Outlook mark-read worker consumed by the Work
// Intake action `mark_read` when the founder first meaningfully
// interacts with an email-backed unread work item.
//
// REV-13 ARCHITECTURAL CHANGE — no permanent latch:
//   * Rev-10 modelled ONE mutation row per (mailbox, message),
//     enforced by `@@unique([mailboxConnectionId, emailMessageId])`,
//     and short-circuited any second invocation on
//     `mutation.status === "SUCCEEDED"`. That created a permanent
//     LIFETIME latch: after the very first successful Spectre-side
//     mark-read, no subsequent click could ever mark the same
//     message read again in Outlook.
//   * Rev-13 retires the (mailbox, message) unique constraint.
//     Each read-generation is a separate row. Active-intent
//     deduplication happens at the ENQUEUE site
//     (src/lib/work-intake/actions.ts), which checks for a row
//     with status IN ('PENDING','RUNNING','RETRYABLE') before
//     creating a new one. Historical SUCCEEDED / FAILED_TERMINAL /
//     SUPERSEDED / NOT_REQUIRED rows remain as immutable audit
//     history and do NOT block new intents.
//
// The enqueue site creates the OutlookMarkReadMutation row (with
// status=PENDING) and passes its `id` to the worker via the job
// payload. The worker loads the row by id, executes Graph, and
// updates the same row through its lifecycle. There is no
// upsert — each row belongs to exactly one generation.
//
// The handler:
//   1. Loads the EmailMessage + the specific mutation row keyed by
//      `markReadMutationId`.
//   2. Short-circuits NOT_REQUIRED if the message is already
//      isRead=true in the local mirror (a delta sync already
//      caught the change or a concurrent generation succeeded).
//   3. SUPERSEDED guard (this generation only): if a mailbox sync
//      has ingested a fresh isRead=false AFTER this specific
//      mutation was queued AND this is a retry, treat as
//      superseded — Outlook contradicted the queued intent.
//   4. Scope allowlist + per-user grantedScopes gate.
//   5. Obtains a fresh delegated bearer token, calls
//      Graph PATCH /me/messages/{id} { "isRead": true }.
//   6. Updates the local EmailMessage.isRead = true so the loader
//      reflects read immediately without waiting for the next
//      delta sync.
//   7. Retryable errors throw so the queue backs off + retries
//      against the SAME mutation row; terminal errors close the
//      row and the queue marks the job failed.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { APPROVED_DELEGATED_SCOPES } from "@/lib/integrations/microsoft-graph-delegated";

export type MarkReadOutcome =
  | { status: "SUCCEEDED"; markReadMutationId: string }
  | { status: "NOT_REQUIRED"; reason: string; markReadMutationId?: string }
  | { status: "PENDING_SCOPE"; missingScopes: string[]; markReadMutationId?: string }
  | { status: "RETRYABLE"; error: string; markReadMutationId?: string }
  | { status: "FAILED_TERMINAL"; error: string; markReadMutationId?: string };

export interface MailboxMarkReadPayload {
  workIntakeItemId: string;
  emailMessageId: string;
  graphMessageId: string;
  mailboxConnectionId: string;
  triggeredByUserId?: string;
  // Rev-13: the enqueue site creates the mutation row and passes
  // its ID here. Older enqueued jobs (pre-rev-13) may not carry
  // this field; when absent, the worker creates a fresh row so
  // the transition is backward-compatible during a rolling deploy.
  markReadMutationId?: string;
}

const REQUIRED_SCOPES = ["Mail.ReadWrite"];

export async function runMailboxMarkRead(
  payload: MailboxMarkReadPayload,
): Promise<MarkReadOutcome> {
  // 1. Load email + confirm it still exists.
  const email = await prisma.emailMessage.findUnique({
    where: { id: payload.emailMessageId },
    select: {
      id: true,
      clubId: true,
      graphMessageId: true,
      mailboxConnectionId: true,
      isRead: true,
      softDeletedAt: true,
      lastSyncedAt: true,
      updatedAt: true,
    },
  });
  if (!email) {
    logger.warn("mailbox.mark-read.email-missing", { emailMessageId: payload.emailMessageId });
    return { status: "FAILED_TERMINAL", error: "EmailMessage not found" };
  }
  if (email.softDeletedAt) {
    return { status: "NOT_REQUIRED", reason: "email_soft_deleted", markReadMutationId: payload.markReadMutationId };
  }

  // 2. Resolve / create the mutation row for THIS generation.
  //    Enqueue-site creation is the normal path. During rollout
  //    (worker running rev-13 with an in-flight pre-rev-13 job),
  //    the payload may not carry markReadMutationId — in which
  //    case we create a fresh row here.
  let mutationRow = payload.markReadMutationId
    ? await prisma.outlookMarkReadMutation.findUnique({
        where: { id: payload.markReadMutationId },
        select: {
          id: true, status: true, attemptCount: true,
          createdAt: true, errorCode: true,
        },
      })
    : null;

  if (!mutationRow) {
    mutationRow = await prisma.outlookMarkReadMutation.create({
      data: {
        clubId: email.clubId,
        workIntakeItemId: payload.workIntakeItemId,
        emailMessageId: email.id,
        graphMessageId: email.graphMessageId,
        mailboxConnectionId: email.mailboxConnectionId,
        triggeredByUserId: payload.triggeredByUserId ?? null,
        generationCursor: email.updatedAt.toISOString(),
        status: "RUNNING",
        attemptCount: 1,
        lastAttemptAt: new Date(),
      },
      select: {
        id: true, status: true, attemptCount: true,
        createdAt: true, errorCode: true,
      },
    });
  } else {
    // Bump attemptCount for observability / retry accounting.
    await prisma.outlookMarkReadMutation.update({
      where: { id: mutationRow.id },
      data: {
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        status: "RUNNING",
      },
    });
  }

  // 3. Short-circuit if the local mirror already says READ. A
  //    concurrent Spectre generation or a delta sync flipped it;
  //    this generation is a no-op.
  if (email.isRead) {
    await closeMutation(mutationRow.id, { status: "NOT_REQUIRED", errorCode: "already_read_in_local_mirror" });
    return { status: "NOT_REQUIRED", reason: "already_read_in_local_mirror", markReadMutationId: mutationRow.id };
  }

  // 4. SUPERSEDED guard (this generation only) — if we've retried
  //    at least once AND a mailbox sync has ingested a fresh
  //    isRead=false AFTER we queued THIS mutation, Outlook has
  //    actively contradicted the queued intent. Skip and record.
  //    On the FIRST attempt this guard cannot trip (attemptCount
  //    was just incremented from its initial value).
  if (
    mutationRow.attemptCount >= 2 &&
    email.lastSyncedAt &&
    email.lastSyncedAt > mutationRow.createdAt
  ) {
    logger.info("mailbox.mark-read.superseded-by-outlook", {
      workIntakeItemIdTail: payload.workIntakeItemId.slice(-6),
      emailMessageIdTail: email.id.slice(-6),
      lastSyncedAt: email.lastSyncedAt.toISOString(),
      mutationCreatedAt: mutationRow.createdAt.toISOString(),
    });
    await closeMutation(mutationRow.id, {
      status: "SUPERSEDED",
      errorCode: "superseded_by_outlook_unread",
    });
    return { status: "NOT_REQUIRED", reason: "superseded_by_outlook_unread", markReadMutationId: mutationRow.id };
  }

  // 5. Scope allowlist check — Mail.ReadWrite must be in the
  //    approved scope set (compile-time guard).
  const missingScopes = REQUIRED_SCOPES.filter(
    (s) => !(APPROVED_DELEGATED_SCOPES as readonly string[]).includes(s),
  );
  if (missingScopes.length > 0) {
    logger.info("mailbox.mark-read.pending-scope-allowlist", {
      workIntakeItemIdTail: payload.workIntakeItemId.slice(-6),
      missingScopes,
    });
    await closeMutation(mutationRow.id, { status: "PENDING_SCOPE", errorCode: "scope_not_allowlisted" });
    return { status: "PENDING_SCOPE", missingScopes, markReadMutationId: mutationRow.id };
  }

  // 6. Runtime consent gate — MailboxConnection.grantedScopes.
  const conn = await prisma.mailboxConnection.findUnique({
    where: { id: email.mailboxConnectionId },
    select: { grantedScopes: true, status: true, userId: true },
  });
  if (!conn || conn.status !== "CONNECTED") {
    await markRetryable(mutationRow.id, "connection_not_ready");
    return { status: "RETRYABLE", error: "mailbox_connection_not_connected", markReadMutationId: mutationRow.id };
  }
  const grantedScopes = (conn.grantedScopes ?? "").split(/\s+/).filter(Boolean);
  if (!grantedScopes.map((s) => s.toLowerCase()).includes("mail.readwrite")) {
    await markRetryable(mutationRow.id, "user_consent_missing");
    return { status: "PENDING_SCOPE", missingScopes: ["Mail.ReadWrite"], markReadMutationId: mutationRow.id };
  }

  // 7. Perform the Graph PATCH via the provider.
  const { getFreshDelegatedAccessToken } = await import("./connect");
  const { getMicrosoftDelegatedProvider } = await import(
    "@/lib/integrations/microsoft-graph-delegated"
  );
  const provider = getMicrosoftDelegatedProvider();
  try {
    const tok = await getFreshDelegatedAccessToken({
      mailboxConnectionId: email.mailboxConnectionId,
      callerClubId: email.clubId,
      callerUserId: conn.userId,
    });
    await provider.markMessageRead({
      accessToken: tok.accessToken,
      graphMessageId: email.graphMessageId,
    });
    // 8. Update local mirror so the loader reflects read
    //    immediately (do not wait for next delta sync). Wrapped
    //    with the mutation write in a single transaction so both
    //    complete-or-neither in the presence of a crash.
    await prisma.$transaction([
      prisma.emailMessage.update({
        where: { id: email.id },
        data: { isRead: true },
      }),
      prisma.outlookMarkReadMutation.update({
        where: { id: mutationRow.id },
        data: {
          status: "SUCCEEDED",
          completedAt: new Date(),
          errorCode: null,
        },
      }),
    ]);
    logger.info("mailbox.mark-read.succeeded", {
      workIntakeItemIdTail: payload.workIntakeItemId.slice(-6),
      emailMessageIdTail: email.id.slice(-6),
      markReadMutationIdTail: mutationRow.id.slice(-6),
    });
    return { status: "SUCCEEDED", markReadMutationId: mutationRow.id };
  } catch (e) {
    const err = e as Error & { code?: string; status?: number };
    // Terminal error classes: 404 message-not-found, 410 gone.
    const isTerminal =
      err.status === 404 ||
      err.status === 410 ||
      err.code === "MESSAGE_NOT_FOUND";
    if (isTerminal) {
      await closeMutation(mutationRow.id, {
        status: "FAILED_TERMINAL",
        errorCode: err.code ?? `http_${err.status ?? "unknown"}`,
      });
      return { status: "FAILED_TERMINAL", error: err.message ?? "terminal_failure", markReadMutationId: mutationRow.id };
    }
    await markRetryable(mutationRow.id, err.code ?? `http_${err.status ?? "unknown"}`);
    // Throw so the queue applies exponential backoff + retries.
    throw err;
  }
}

async function closeMutation(
  id: string,
  args: { status: string; errorCode?: string | null },
): Promise<void> {
  await prisma.outlookMarkReadMutation.update({
    where: { id },
    data: {
      status: args.status,
      completedAt: new Date(),
      errorCode: args.errorCode ?? null,
    },
  });
}

async function markRetryable(id: string, errorCode: string): Promise<void> {
  await prisma.outlookMarkReadMutation.update({
    where: { id },
    data: {
      status: "RETRYABLE",
      errorCode,
    },
  });
}
