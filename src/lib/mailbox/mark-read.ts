// Phase 4R rev-10 (2026-08-15) — Outlook mark-as-read worker.
//
// One canonical Outlook mark-read worker consumed by the Work
// Intake action `mark_read` when the founder first meaningfully
// interacts with an email-backed unread work item.
//
// The handler mirrors `src/lib/mailbox/archive.ts`:
//   1. Loads the EmailMessage + MailboxConnection.
//   2. Idempotency: upsert an OutlookMarkReadMutation keyed by
//      (mailboxConnectionId, emailMessageId). A second click can
//      not enqueue a duplicate Graph PATCH.
//   3. Short-circuits NOT_REQUIRED if the message is already
//      isRead=true in the local mirror (a delta sync already
//      caught the change or Graph accepted a prior PATCH).
//   4. Obtains a fresh delegated bearer token, verifies scope
//      grantedScopes ∋ Mail.ReadWrite, calls
//      Graph PATCH /me/messages/{id} { "isRead": true }.
//   5. Updates the local EmailMessage.isRead = true so the loader
//      reflects the change immediately without waiting for the
//      next delta sync.
//   6. Retryable errors throw so the queue backs off + retries;
//      terminal errors are recorded on the mutation and the queue
//      marks the job failed. NOT_REQUIRED never retries.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { APPROVED_DELEGATED_SCOPES } from "@/lib/integrations/microsoft-graph-delegated";

export type MarkReadOutcome =
  | { status: "SUCCEEDED"; markReadMutationId: string }
  | { status: "NOT_REQUIRED"; reason: string }
  | { status: "PENDING_SCOPE"; missingScopes: string[] }
  | { status: "RETRYABLE"; error: string }
  | { status: "FAILED_TERMINAL"; error: string };

export interface MailboxMarkReadPayload {
  workIntakeItemId: string;
  emailMessageId: string;
  graphMessageId: string;
  mailboxConnectionId: string;
  triggeredByUserId?: string;
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
    },
  });
  if (!email) {
    logger.warn("mailbox.mark-read.email-missing", { emailMessageId: payload.emailMessageId });
    return { status: "FAILED_TERMINAL", error: "EmailMessage not found" };
  }
  if (email.softDeletedAt) {
    return { status: "NOT_REQUIRED", reason: "email_soft_deleted" };
  }
  // Short-circuit if a delta sync (or a prior PATCH) already flipped it.
  if (email.isRead) {
    return { status: "NOT_REQUIRED", reason: "already_read_in_local_mirror" };
  }

  // 2. Scope allowlist check — Mail.ReadWrite must be in the
  //    codebase's approved scope set. This is a static config
  //    guard; runtime consent is checked separately below.
  const missingScopes = REQUIRED_SCOPES.filter(
    (s) => !(APPROVED_DELEGATED_SCOPES as readonly string[]).includes(s),
  );
  if (missingScopes.length > 0) {
    logger.info("mailbox.mark-read.pending-scope-allowlist", {
      workIntakeItemIdTail: payload.workIntakeItemId.slice(-6),
      missingScopes,
    });
    return { status: "PENDING_SCOPE", missingScopes };
  }

  // 3. Idempotency: upsert the mutation row keyed on
  //    (mailboxConnectionId, emailMessageId). If a prior worker
  //    already SUCCEEDED, return immediately.
  const mutation = await upsertMutation({
    clubId: email.clubId,
    workIntakeItemId: payload.workIntakeItemId,
    emailMessageId: email.id,
    graphMessageId: email.graphMessageId,
    mailboxConnectionId: email.mailboxConnectionId,
    triggeredByUserId: payload.triggeredByUserId ?? null,
  });
  if (mutation.status === "SUCCEEDED") {
    return { status: "SUCCEEDED", markReadMutationId: mutation.id };
  }
  if (mutation.status === "FAILED_TERMINAL") {
    return {
      status: "FAILED_TERMINAL",
      error: mutation.errorCode ?? "prior_terminal_failure",
    };
  }

  // 4. Check MailboxConnection.grantedScopes — user-consent gate.
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

  // 5. Perform the Graph PATCH via the provider.
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
    // 6. Update local mirror so the loader reflects read
    //    immediately (do not wait for next delta sync). Wrapped
    //    with the mutation write in a single transaction so both
    //    complete-or-neither in the presence of a crash.
    await prisma.$transaction([
      prisma.emailMessage.update({
        where: { id: email.id },
        data: { isRead: true },
      }),
      prisma.outlookMarkReadMutation.update({
        where: { id: mutation.id },
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
    });
    return { status: "SUCCEEDED", markReadMutationId: mutation.id };
  } catch (e) {
    const err = e as Error & { code?: string; status?: number };
    // Terminal error classes: 404 message-not-found, 410 gone.
    // 401/403 permission may be transient if a token refresh
    // helps — leave as retryable; the queue's terminal-classify
    // will kick in on repeat.
    const isTerminal =
      err.status === 404 ||
      err.status === 410 ||
      err.code === "MESSAGE_NOT_FOUND";
    if (isTerminal) {
      await markMutation(mutation.id, {
        status: "FAILED_TERMINAL",
        errorCode: err.code ?? `http_${err.status ?? "unknown"}`,
      });
      return { status: "FAILED_TERMINAL", error: err.message ?? "terminal_failure" };
    }
    await markMutation(mutation.id, {
      status: "RETRYABLE",
      errorCode: err.code ?? `http_${err.status ?? "unknown"}`,
    });
    // Throw so the queue applies exponential backoff + retries.
    throw err;
  }
}

interface MutationRow {
  id: string;
  status: string;
  errorCode?: string | null;
}

async function upsertMutation(args: {
  clubId: string;
  workIntakeItemId: string;
  emailMessageId: string;
  graphMessageId: string;
  mailboxConnectionId: string;
  triggeredByUserId: string | null;
}): Promise<MutationRow> {
  // Unique constraint is on (mailboxConnectionId, emailMessageId).
  const existing = await prisma.outlookMarkReadMutation.findUnique({
    where: {
      mailboxConnectionId_emailMessageId: {
        mailboxConnectionId: args.mailboxConnectionId,
        emailMessageId: args.emailMessageId,
      },
    },
    select: { id: true, status: true, errorCode: true },
  });
  if (existing) {
    if (existing.status === "SUCCEEDED" || existing.status === "FAILED_TERMINAL") {
      return existing;
    }
    // Advance attemptCount + reset to RUNNING for this attempt.
    await prisma.outlookMarkReadMutation.update({
      where: { id: existing.id },
      data: {
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        status: "RUNNING",
      },
    });
    return { ...existing, status: "RUNNING" };
  }
  const created = await prisma.outlookMarkReadMutation.create({
    data: {
      clubId: args.clubId,
      workIntakeItemId: args.workIntakeItemId,
      emailMessageId: args.emailMessageId,
      graphMessageId: args.graphMessageId,
      mailboxConnectionId: args.mailboxConnectionId,
      triggeredByUserId: args.triggeredByUserId,
      status: "RUNNING",
      attemptCount: 1,
      lastAttemptAt: new Date(),
    },
    select: { id: true, status: true, errorCode: true },
  });
  return created;
}

async function markMutation(
  id: string,
  data: {
    status?: string;
    completedAt?: Date;
    errorCode?: string | null;
  },
): Promise<void> {
  await prisma.outlookMarkReadMutation.update({ where: { id }, data });
}
