// Sprint 2 B4 (2026-07-19) — Initial mailbox synchronization service.
//
// Runs as a background job (kind MAILBOX_INITIAL_SYNC). Fetches Inbox
// messages from Microsoft Graph via the delegated provider, normalises
// and sanitises them, persists as EmailMessage evidence with
// attachment metadata, then materialises WorkIntakeItem rows through
// the email materializer. See §§3, 4, 6, 7 of the B4 directive.
//
// Idempotent: rerunning against the same mailbox produces no
// duplicate rows and no orchestration-state resets.

import { prisma } from "@/lib/prisma";
import type { RawGraphMessage } from "@/lib/integrations/microsoft-graph-delegated";
import { getMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated";
import { getFreshDelegatedAccessToken } from "./connect";
import { SYNC_SCOPE } from "./sync-scope";
import { normalizeGraphMessage, stableIdentityForEmail } from "./normalize";
import { classifyEmail } from "./classifier";
import { upsertEmailIntake } from "./email-materializer";
import {
  MAILBOX_STATUS,
  assertMailboxStatusTransition,
  isTerminalStatus,
} from "./status";
import { classifyMsalError, MAILBOX_ERROR_CODE } from "./errors";
import { auditMailboxEvent, MAILBOX_AUDIT_ACTION } from "./audit";
import { isMailboxIntegrationEnabled } from "@/lib/env";
// Sprint 2 Step 13A (2026-07-21) — controlled-sync-mode consumers.
// See src/lib/mailbox/controlled-sync.ts for design.
import {
  effectiveInitialSyncMessageCap,
  shouldSkipAttachmentMetadata,
  shouldSkipMaterialization,
  shouldRunDiagnosticOnly,
} from "./controlled-sync";
import { logger } from "@/lib/observability/logger";

export interface InitialSyncResult {
  outcome: "COMPLETED" | "PARTIAL" | "SKIPPED" | "TERMINAL" | "RETRYABLE";
  messagesExamined: number;
  messagesImported: number;
  messagesUpdated: number;
  intakeItemsCreated: number;
  messagesSkipped: number;
  // Sprint 2 Step 13A — in-memory-only field. Reflects whether the
  // handler skipped classifyEmail() + upsertEmailIntake() because
  // MAILBOX_SYNC_SKIP_MATERIALIZATION was true. Not persisted (would
  // require a schema migration and is only relevant for the caller
  // that reads the run's result JSON).
  materializationSkippedByControl?: boolean;
  // Sprint 2 Step 13A — the cap effective for this run
  // (Math.min(override, SYNC_SCOPE.messageCap)). Surfaced so callers
  // can log/report bounded behavior.
  effectiveMessageCap?: number;
  // Sprint 2 Step 13A — attachment-metadata bypass flag actually
  // observed during this run.
  attachmentMetadataSkippedByControl?: boolean;
  errorCode?: string;
  syncRunId?: string;
}

// Sprint 2 B4.1 (2026-07-19) — quarantine cap. A single message that
// throws MAX_MESSAGE_RETRIES times in a row is marked
// `ingestFailedAt` and skipped on future runs so a corrupt message
// cannot block a mailbox permanently. See §6 of B4.1 directive.
const MAX_MESSAGE_RETRIES = 3;

/**
 * Run one initial-sync pass for a mailbox connection. Idempotent.
 * Safe to call on a disconnected or reauth-required connection —
 * returns SKIPPED without side effects.
 */
export async function runInitialSyncForConnection(args: {
  mailboxConnectionId: string;
  triggerKind?: "OAUTH_CALLBACK" | "SYNC_NOW" | "RECONCILIATION";
}): Promise<InitialSyncResult> {
  const result: InitialSyncResult = {
    outcome: "COMPLETED",
    messagesExamined: 0,
    messagesImported: 0,
    messagesUpdated: 0,
    intakeItemsCreated: 0,
    messagesSkipped: 0,
  };
  let intakeInformational = 0;
  let intakeSuppressed = 0;

  if (!isMailboxIntegrationEnabled()) {
    result.outcome = "SKIPPED";
    result.errorCode = MAILBOX_ERROR_CODE.FEATURE_DISABLED;
    return result;
  }

  const conn = await prisma.mailboxConnection.findUnique({ where: { id: args.mailboxConnectionId } });
  if (!conn) {
    result.outcome = "SKIPPED";
    result.errorCode = MAILBOX_ERROR_CODE.CONNECTION_NOT_FOUND;
    return result;
  }
  if (isTerminalStatus(conn.status)) {
    result.outcome = "SKIPPED";
    result.errorCode = MAILBOX_ERROR_CODE.CONNECTION_ALREADY_DISCONNECTED;
    return result;
  }

  // Sprint 2 B4.1 — durable sync-run record. Created BEFORE the
  // first Graph call so an early worker crash still surfaces to the
  // UI as "sync queued".
  const syncRun = await prisma.mailboxSyncRun.create({
    data: {
      clubId: conn.clubId,
      mailboxConnectionId: conn.id,
      status: "RUNNING",
      triggerKind: args.triggerKind ?? "SYNC_NOW",
      startedAt: new Date(),
    },
  });
  result.syncRunId = syncRun.id;

  // Record attempt.
  await prisma.mailboxConnection.update({
    where: { id: conn.id },
    data: { lastAttemptedSyncAt: new Date() },
  });

  const cutoff = new Date(Date.now() - SYNC_SCOPE.lookbackDays * 24 * 60 * 60 * 1000);
  let pageToken: string | null | undefined = undefined;
  let deltaLink: string | null = null;
  let importedThisRun = 0;
  let updatedThisRun = 0;
  let intakeThisRun = 0;
  let skippedThisRun = 0;

  // Sprint 2 Step 13A — bounded controls. Cap enforcement moved to
  // pageSize so `messagesExamined` cannot overshoot by up to
  // (pageSize - 1) as it did before this checkpoint.
  const effectiveCap = effectiveInitialSyncMessageCap();
  const skipMaterialization = shouldSkipMaterialization();
  const skipAttachmentMetadata = shouldSkipAttachmentMetadata();
  const diagnosticOnly = shouldRunDiagnosticOnly();
  result.effectiveMessageCap = effectiveCap;
  result.materializationSkippedByControl = skipMaterialization;
  result.attachmentMetadataSkippedByControl = skipAttachmentMetadata;

  // Sprint 2 Checkpoint 13C — diagnostic-only mode. Exercise ONLY the
  // token-refresh path (getFreshDelegatedAccessToken handles KMS
  // decrypt + MSAL refresh + re-encrypt of any rotated tokens) and
  // return. No Graph mail endpoint is called, no message is
  // persisted. The safe-metadata logging inside the refreshToken
  // provider method (see microsoft-graph-delegated.ts) captures the
  // exact Microsoft response.
  if (diagnosticOnly) {
    logger.info("mailbox.sync.diagnostic_only.start", {
      mailboxConnectionId: conn.id,
      clubId: conn.clubId,
      triggerKind: args.triggerKind ?? "SYNC_NOW",
      accessTokenExpiredBeforeCall: conn.accessTokenExpiresAt < new Date(),
      minutesSinceAccessTokenExpiry: Math.round((Date.now() - conn.accessTokenExpiresAt.getTime()) / 60000),
      refreshTokenCiphertextPresent: !!conn.refreshTokenSecretRef,
    });
    try {
      const { accessToken } = await getFreshDelegatedAccessToken({
        mailboxConnectionId: conn.id,
        callerClubId: conn.clubId,
        callerUserId: conn.userId,
      });
      logger.info("mailbox.sync.diagnostic_only.refresh_ok", {
        mailboxConnectionId: conn.id,
        accessTokenLength: accessToken.length,
      });
      // Persist a successful diagnostic run — status stays PENDING_SYNC
      // (nothing was synced) but lastSuccessfulSyncAt is NOT set (the
      // refresh worked but no messages were fetched).
      result.outcome = "COMPLETED";
      await finaliseSyncRun(syncRun.id, {
        status: "COMPLETED",
        messagesExamined: 0,
        messagesImported: 0,
        messagesUpdated: 0,
        intakeCreatedActionable: 0,
        intakeCreatedInformational: 0,
        messagesSuppressed: 0,
        messagesFailed: 0,
        failureCategory: null,
      });
      return result;
    } catch (err) {
      const classification = classifyMsalError(err);
      logger.warn("mailbox.sync.diagnostic_only.refresh_failed", {
        mailboxConnectionId: conn.id,
        classification,
      });
      await prisma.mailboxConnection.update({
        where: { id: conn.id },
        data: {
          lastSyncError: classification,
          status:
            classification === "terminal"
              ? MAILBOX_STATUS.REAUTH_REQUIRED
              : conn.status,
        },
      });
      result.outcome = classification === "terminal" ? "TERMINAL" : "RETRYABLE";
      await finaliseSyncRun(syncRun.id, {
        status: classification === "terminal" ? "TERMINAL" : "DELAYED",
        messagesExamined: 0,
        messagesImported: 0,
        messagesUpdated: 0,
        intakeCreatedActionable: 0,
        intakeCreatedInformational: 0,
        messagesSuppressed: 0,
        messagesFailed: 0,
        failureCategory:
          classification === "terminal"
            ? MAILBOX_ERROR_CODE.REFRESH_TERMINAL
            : MAILBOX_ERROR_CODE.REFRESH_RETRYABLE,
      });
      return result;
    }
  }

  try {
    // Loop until cap reached OR no more pages.
    while (result.messagesExamined < effectiveCap) {
      // Re-check disconnect BEFORE each page — a user who disconnects
      // mid-run stops receiving further Graph work.
      const currentConn = await prisma.mailboxConnection.findUnique({ where: { id: conn.id } });
      if (!currentConn || isTerminalStatus(currentConn.status)) {
        result.outcome = "SKIPPED";
        return result;
      }

      const { accessToken } = await getFreshDelegatedAccessToken({
        mailboxConnectionId: conn.id,
        callerClubId: conn.clubId,
        callerUserId: conn.userId,
      });
      const provider = getMicrosoftDelegatedProvider();
      // Sprint 2 Step 13A — bound requested pageSize by remaining
      // capacity so a single page can never push messagesExamined
      // past effectiveCap. Never request 0 (avoids Graph rejecting
      // $top=0 or returning an empty page indefinitely).
      const remainingCapacity = Math.max(1, effectiveCap - result.messagesExamined);
      const requestedPageSize = Math.min(SYNC_SCOPE.pageSize, remainingCapacity);
      const page = await provider.listInboxMessages({
        accessToken,
        receivedAfter: cutoff,
        pageSize: requestedPageSize,
        pageToken,
      });
      pageToken = page.nextPageToken;
      if (page.deltaLink) deltaLink = page.deltaLink;
      result.messagesExamined += page.messages.length;

      for (const raw of page.messages) {
        // Sprint 2 Step 13A — cap on (imported + updated), NOT just
        // imported. Prevents a re-run against a mailbox with
        // existing rows from exceeding effectiveCap in the persisted
        // set (imported + updated + skipped ≤ effectiveCap after
        // examined ≤ effectiveCap upstream).
        if (importedThisRun + updatedThisRun >= effectiveCap) break;
        try {
          const outcome = await ingestOneMessage({
            clubId: conn.clubId,
            mailboxConnectionId: conn.id,
            raw,
            accessToken,
            skipAttachmentMetadata,
            skipMaterialization,
          });
          if (outcome.imported) importedThisRun += 1;
          if (outcome.updated) updatedThisRun += 1;
          if (outcome.intakeCreated) intakeThisRun += 1;
          if (outcome.intakeAction === "CREATE_INFORMATIONAL") intakeInformational += 1;
          if (outcome.intakeAction === "SUPPRESS") intakeSuppressed += 1;
        } catch (err) {
          // Sprint 2 B4.1 §6 — partial failure with quarantine.
          // Bump retryAttempts on the message; if we exceed the cap,
          // mark it ingestFailedAt so future runs skip it. The
          // delta cursor advances only when we make it out of this
          // page cleanly (see the outer while-loop). If we DON'T
          // exit cleanly, deltaLink is not written and Sync now
          // re-attempts from the same cursor.
          skippedThisRun += 1;
          if (result.outcome === "COMPLETED") result.outcome = "PARTIAL";
          try {
            const existing = await prisma.emailMessage.findFirst({
              where: {
                mailboxConnectionId: conn.id,
                graphMessageId: raw.id,
              },
            });
            const nextAttempts = (existing?.retryAttempts ?? 0) + 1;
            const quarantine = nextAttempts >= MAX_MESSAGE_RETRIES;
            if (existing) {
              await prisma.emailMessage.update({
                where: { id: existing.id },
                data: {
                  retryAttempts: nextAttempts,
                  ingestFailedAt: quarantine ? new Date() : null,
                  ingestFailReason: quarantine
                    ? sanitiseSyncFailReason(err)
                    : null,
                },
              });
            }
          } catch {
            /* meta-failure while recording retry is non-fatal */
          }
        }
      }
      if (!pageToken) break;
    }

    // Persist delta cursor + success bookkeeping. Cursor advances
    // only when the loop exited cleanly — a mid-page throw skips
    // the update and Sync-now can safely re-attempt.
    await prisma.mailboxConnection.update({
      where: { id: conn.id },
      data: {
        deltaLink: deltaLink ?? conn.deltaLink,
        lastSuccessfulSyncAt: new Date(),
        lastSyncError: null,
        status: (() => {
          if (conn.status === MAILBOX_STATUS.CONNECTED_PENDING_SYNC) {
            assertMailboxStatusTransition(conn.status, MAILBOX_STATUS.CONNECTED);
            return MAILBOX_STATUS.CONNECTED;
          }
          return conn.status;
        })(),
      },
    });
  } catch (err) {
    const classification = classifyMsalError(err);
    await prisma.mailboxConnection.update({
      where: { id: conn.id },
      data: {
        lastSyncError: classification,
        status:
          classification === "terminal"
            ? MAILBOX_STATUS.REAUTH_REQUIRED
            : conn.status === MAILBOX_STATUS.CONNECTED
              ? MAILBOX_STATUS.DELAYED
              : conn.status,
      },
    });
    if (classification === "terminal") {
      await auditMailboxEvent(MAILBOX_AUDIT_ACTION.REAUTH_REQUIRED, {
        clubId: conn.clubId,
        userId: conn.userId,
        mailboxConnectionId: conn.id,
        errorCode: MAILBOX_ERROR_CODE.REFRESH_TERMINAL,
      });
      result.outcome = "TERMINAL";
    } else {
      result.outcome = "RETRYABLE";
    }
    result.messagesImported = importedThisRun;
    result.messagesUpdated = updatedThisRun;
    result.intakeItemsCreated = intakeThisRun;
    result.messagesSkipped = skippedThisRun;
    await finaliseSyncRun(syncRun.id, {
      status: classification === "terminal" ? "TERMINAL" : "DELAYED",
      messagesExamined: result.messagesExamined,
      messagesImported: importedThisRun,
      messagesUpdated: updatedThisRun,
      intakeCreatedActionable: intakeThisRun - intakeInformational,
      intakeCreatedInformational: intakeInformational,
      messagesSuppressed: intakeSuppressed,
      messagesFailed: skippedThisRun,
      failureCategory:
        classification === "terminal"
          ? MAILBOX_ERROR_CODE.REFRESH_TERMINAL
          : MAILBOX_ERROR_CODE.REFRESH_RETRYABLE,
    });
    return result;
  }

  result.messagesImported = importedThisRun;
  result.messagesUpdated = updatedThisRun;
  result.intakeItemsCreated = intakeThisRun;
  result.messagesSkipped = skippedThisRun;
  await finaliseSyncRun(syncRun.id, {
    status: result.outcome === "PARTIAL" ? "PARTIAL" : "COMPLETED",
    messagesExamined: result.messagesExamined,
    messagesImported: importedThisRun,
    messagesUpdated: updatedThisRun,
    intakeCreatedActionable: intakeThisRun - intakeInformational,
    intakeCreatedInformational: intakeInformational,
    messagesSuppressed: intakeSuppressed,
    messagesFailed: skippedThisRun,
    failureCategory: null,
  });
  return result;
}

// Sprint 2 Checkpoint 13G — exported so runDeltaSyncForConnection
// reuses the same finalisation logic as the initial-sync path.
// Signature unchanged; callers must supply every counter (delta and
// initial paths both do). Not part of the public library surface —
// this is an intra-mailbox helper.
export async function finaliseSyncRun(
  runId: string,
  patch: {
    status: string;
    messagesExamined: number;
    messagesImported: number;
    messagesUpdated: number;
    intakeCreatedActionable: number;
    intakeCreatedInformational: number;
    messagesSuppressed: number;
    messagesFailed: number;
    failureCategory: string | null;
  },
): Promise<void> {
  await prisma.mailboxSyncRun.update({
    where: { id: runId },
    data: {
      status: patch.status,
      completedAt: new Date(),
      messagesExamined: patch.messagesExamined,
      messagesImported: patch.messagesImported,
      messagesUpdated: patch.messagesUpdated,
      intakeCreatedActionable: patch.intakeCreatedActionable,
      intakeCreatedInformational: patch.intakeCreatedInformational,
      messagesSuppressed: patch.messagesSuppressed,
      messagesFailed: patch.messagesFailed,
      failureCategory: patch.failureCategory,
    },
  });
}

function sanitiseSyncFailReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Don't leak subject lines / addresses. Extract only the leading
  // token before any colon / whitespace, capped at 40 chars.
  return msg.split(/[:\s]/)[0].slice(0, 40) || "unknown";
}

// Ingest one message: upsert EmailMessage (idempotent), upsert
// attachments (metadata only), run the materializer.
//
// Sprint 2 Step 13A — the two `skip*` args are threaded from the
// controlled-sync helpers at the outer call site so we do not
// re-read env inside the hot loop. Both default to false.
//
// Sprint 2 Checkpoint 13G — exported so runDeltaSyncForConnection
// can reuse the exact same normalization, tombstone soft-delete
// path, and classification bypass. Any change to this function
// must preserve initial-sync + delta-sync behaviour identically.
export async function ingestOneMessage(args: {
  clubId: string;
  mailboxConnectionId: string;
  raw: RawGraphMessage;
  accessToken: string;
  skipAttachmentMetadata?: boolean;
  skipMaterialization?: boolean;
}): Promise<{ imported: boolean; updated: boolean; intakeCreated: boolean; intakeAction: string }> {
  const norm = normalizeGraphMessage(args.raw);
  // Sprint 2 B4.1 §7 — stable identity. When Microsoft returned an
  // ImmutableId (which the provider requests via
  // `Prefer: IdType="ImmutableId"`), use it as the natural-key value
  // stored in `graphMessageId`. This guarantees:
  //   • the value in the unique-index column matches what we treat
  //     as the message's identity across moves / folder changes;
  //   • a user who moves a message OUTSIDE Spectre does not cause
  //     us to re-ingest as a "new" message the second the Graph id
  //     rotates.
  // For tenants that do not return ImmutableId, fall back to the
  // raw Graph id (stable within a folder — our Inbox-only scope
  // covers the common case).
  const graphId = norm.immutableId || norm.graphMessageId;

  // Soft-delete path: Graph delta responses include `removed`
  // markers — for initial (non-delta) sync we don't see this, but
  // the field is respected for parity with future C-phase code.
  if (norm.isRemoved) {
    const existing = await prisma.emailMessage.findFirst({
      where: { mailboxConnectionId: args.mailboxConnectionId, graphMessageId: graphId },
    });
    if (existing) {
      await prisma.emailMessage.update({
        where: { id: existing.id },
        data: { softDeletedAt: new Date(), lastSyncedAt: new Date() },
      });
    }
    return { imported: false, updated: false, intakeCreated: false, intakeAction: "SUPPRESS" };
  }

  // Skip quarantined messages that failed to ingest 3+ times.
  const existingCheck = await prisma.emailMessage.findFirst({
    where: { mailboxConnectionId: args.mailboxConnectionId, graphMessageId: graphId },
    select: { ingestFailedAt: true },
  });
  if (existingCheck?.ingestFailedAt) {
    return { imported: false, updated: false, intakeCreated: false, intakeAction: "SUPPRESS" };
  }

  // Upsert email row.
  const existing = await prisma.emailMessage.findUnique({
    where: {
      mailboxConnectionId_graphMessageId: {
        mailboxConnectionId: args.mailboxConnectionId,
        graphMessageId: graphId,
      },
    },
  });
  const emailData = {
    clubId: args.clubId,
    mailboxConnectionId: args.mailboxConnectionId,
    graphMessageId: graphId,
    immutableId: norm.immutableId,
    internetMessageId: norm.internetMessageId,
    conversationId: norm.conversationId,
    senderName: norm.senderName,
    senderAddress: norm.senderAddress,
    recipientsJson: JSON.stringify(norm.recipients),
    subject: norm.subject,
    receivedAt: norm.receivedAt,
    sentAt: norm.sentAt,
    preview: norm.preview,
    bodyHtmlSanitized: norm.bodyHtmlSanitized,
    bodyTextExtract: norm.bodyTextExtract,
    importance: norm.importance,
    isRead: norm.isRead,
    hasAttachments: norm.hasAttachments,
    webLink: norm.webLink,
    lastSyncedAt: new Date(),
  };
  const email = existing
    ? await prisma.emailMessage.update({
        where: { id: existing.id },
        data: emailData,
      })
    : await prisma.emailMessage.create({
        data: emailData,
      });

  // Attachment metadata.
  // Sprint 2 Step 13A — the controlled-sync attachment bypass skips
  // the /me/messages/{id}/attachments Graph call entirely AND creates
  // no EmailAttachment rows. hasAttachments (from the /messages
  // response) is still persisted on the EmailMessage row above.
  if (norm.hasAttachments && !args.skipAttachmentMetadata) {
    try {
      const provider = getMicrosoftDelegatedProvider();
      const atts = await provider.listAttachmentMetadata({ accessToken: args.accessToken, graphMessageId: graphId });
      const upsertedAttachments: Array<{ id: string; storageState: string }> = [];
      for (const a of atts) {
        const storageState =
          a.size > SYNC_SCOPE.attachmentSizeCapBytes ? "REFUSED_TOO_LARGE" : "METADATA_ONLY";
        const row = await prisma.emailAttachment.upsert({
          where: {
            emailMessageId_graphAttachmentId: {
              emailMessageId: email.id,
              graphAttachmentId: a.id,
            },
          },
          create: {
            emailMessageId: email.id,
            graphAttachmentId: a.id,
            filename: a.name,
            contentType: a.contentType,
            sizeBytes: a.size,
            isInline: a.isInline,
            storageState,
          },
          update: {
            filename: a.name,
            contentType: a.contentType,
            sizeBytes: a.size,
            isInline: a.isInline,
            storageState,
          },
          select: { id: true, storageState: true },
        });
        upsertedAttachments.push(row);
      }
      // Sprint 3 Checkpoint 15D — enqueue a bounded per-attachment
      // ingest job for every METADATA_ONLY attachment we just wrote.
      // The ingest pipeline is dedup-safe (unique clubId + sha256Hash)
      // so retries + reruns collapse to no-ops. Enqueue is best-effort:
      // if the queue write fails we log + continue, leaving the
      // attachment in METADATA_ONLY for a future sync to try again.
      if (upsertedAttachments.length > 0) {
        try {
          const { enqueue } = await import("../queue");
          for (const row of upsertedAttachments) {
            if (row.storageState !== "METADATA_ONLY") continue;
            await enqueue({
              kind: "MAILBOX_ATTACHMENT_FETCH",
              queue: "mailbox",
              clubId: args.clubId,
              payload: { emailAttachmentId: row.id },
              idempotencyKey: `mailbox:doc-ingest:${row.id}`,
              maxAttempts: 3,
            });
          }
        } catch (err) {
          // Non-fatal — sync still succeeds; ingest will retry next sync.
          logger.warn("mailbox.ingest.enqueue_failed", {
            clubId: args.clubId,
            emailIdTail: email.id.slice(-6),
            count: upsertedAttachments.length,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch {
      // Attachment fetch failure is non-fatal; leave attachment
      // metadata behind for a future retry.
    }
  }

  // Materialise intake.
  // Sprint 2 Step 13A — the controlled-sync materialization bypass
  // skips classifyEmail() AND upsertEmailIntake() entirely: no
  // WorkIntakeItem is created, no classification is recorded, no
  // downstream jobs are enqueued. The EmailMessage row above is
  // still persisted so the ingestion path is proven.
  if (args.skipMaterialization) {
    return {
      imported: !existing,
      updated: !!existing,
      intakeCreated: false,
      intakeAction: "SKIPPED_BY_CONTROL",
    };
  }
  const classification = classifyEmail(norm);
  const intakeBefore = await prisma.emailWorkIntakeOrigin.findFirst({
    where: { emailMessageId: email.id, role: "PRIMARY" },
  });
  const intake = await upsertEmailIntake({ clubId: args.clubId, email, classification });
  const intakeCreated = intake != null && !intakeBefore;

  return {
    imported: !existing,
    updated: !!existing,
    intakeCreated,
    intakeAction: classification.intakeAction,
  };
}
