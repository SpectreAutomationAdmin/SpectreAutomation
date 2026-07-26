// Sprint 2 Checkpoint 13G (2026-07-23) — Delta mailbox synchronization service.
//
// Runs as a background job (kind MAILBOX_DELTA_SYNC). Fetches Inbox
// changes from Microsoft Graph via the delegated provider's delta
// endpoint, normalises + persists through the SHARED
// `ingestOneMessage` helper from ./sync.ts, and updates the
// connection's delta cursor when a terminal @odata.deltaLink is
// received.
//
// Design goals (per founder's C13G-Code authorization):
//   - Reuse ./sync.ts's normalization + persistence path — no
//     second email mapper.
//   - No self-scheduling. No follow-on job. No subscription. No
//     recurring poll. No heartbeat. No attachment fetch. No
//     classification unless controlled mode explicitly permits it.
//   - Bounded by the same production cap as initial sync
//     (SYNC_SCOPE.messageCap), reduced in controlled mode via
//     MAILBOX_SYNC_MAX_MESSAGES_OVERRIDE.
//   - Partial enumeration (cap reached before terminal deltaLink)
//     preserves the prior cursor rather than storing an
//     intermediate nextLink as if it were a terminal deltaLink.
//   - Tombstones (`@removed`) go through the existing soft-delete
//     path in ingestOneMessage — no new tombstone logic.
//
// Idempotent: rerunning with an unchanged mailbox produces no
// duplicate rows. Graph-message-id idempotency is enforced by
// EmailMessage's unique index (mailboxConnectionId, graphMessageId).

import { prisma } from "@/lib/prisma";
import { getMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated";
import { getFreshDelegatedAccessToken } from "./connect";
import { SYNC_SCOPE } from "./sync-scope";
import {
  MAILBOX_STATUS,
  isTerminalStatus,
} from "./status";
import { classifyMsalError, MAILBOX_ERROR_CODE } from "./errors";
import { auditMailboxEvent, MAILBOX_AUDIT_ACTION } from "./audit";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import {
  effectiveDeltaSyncMessageCap,
  shouldSkipAttachmentMetadata,
  shouldSkipMaterialization,
} from "./controlled-sync";
import { ingestOneMessage, finaliseSyncRun } from "./sync";
import { logger } from "@/lib/observability/logger";

export interface DeltaSyncResult {
  outcome: "COMPLETED" | "BOUNDED_PARTIAL" | "SKIPPED" | "TERMINAL" | "RETRYABLE";
  messagesExamined: number;
  messagesImported: number;
  messagesUpdated: number;
  messagesSoftDeleted: number;
  messagesSkipped: number;
  messagesFailed: number;
  intakeItemsCreated: number;
  /** Counters that do not have dedicated MailboxSyncRun columns are
   *  surfaced here + in structured logs (no schema migration). */
  pagesRequested: number;
  terminalCursorReceived: boolean;
  materializationSkippedByControl?: boolean;
  attachmentMetadataSkippedByControl?: boolean;
  effectiveMessageCap?: number;
  errorCode?: string;
  syncRunId?: string;
}

/**
 * Run one bounded delta pass for a mailbox connection.
 *
 * When `MailboxConnection.deltaLink` is null, this performs an
 * INITIAL delta enumeration — Graph returns pages of existing
 * messages until it emits an @odata.deltaLink on the terminal page.
 *
 * When `MailboxConnection.deltaLink` is set, this performs an
 * INCREMENTAL delta run — Graph returns only messages added,
 * changed, or removed since the cursor was minted, plus a fresh
 * @odata.deltaLink for the next hop.
 *
 * Bounded: at most `effectiveDeltaSyncMessageCap()` messages are
 * examined and at most that many rows are inserted/updated. If
 * enumeration is not complete when the cap is reached, the run
 * returns outcome=BOUNDED_PARTIAL and does NOT overwrite the
 * connection's stored cursor.
 *
 * Safe to call on a disconnected or reauth-required connection —
 * returns SKIPPED without side effects.
 */
export async function runDeltaSyncForConnection(args: {
  mailboxConnectionId: string;
  triggerKind?: "DELTA" | "RECONCILIATION" | "SYNC_NOW";
}): Promise<DeltaSyncResult> {
  const result: DeltaSyncResult = {
    outcome: "COMPLETED",
    messagesExamined: 0,
    messagesImported: 0,
    messagesUpdated: 0,
    messagesSoftDeleted: 0,
    messagesSkipped: 0,
    messagesFailed: 0,
    intakeItemsCreated: 0,
    pagesRequested: 0,
    terminalCursorReceived: false,
  };

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
  // Delta processing requires an operationally-connected mailbox.
  // Founder §"Delta handler" — "require a connected state
  // appropriate for delta processing".
  if (
    conn.status !== MAILBOX_STATUS.CONNECTED &&
    conn.status !== MAILBOX_STATUS.DELAYED &&
    conn.status !== MAILBOX_STATUS.CONNECTED_PENDING_SYNC
  ) {
    result.outcome = "SKIPPED";
    result.errorCode = MAILBOX_ERROR_CODE.CONNECTION_ALREADY_DISCONNECTED;
    return result;
  }

  // Durable sync-run record. Created BEFORE the first Graph call so
  // an early worker crash still surfaces to the UI as "delta run
  // queued". triggerKind="DELTA" so audits can distinguish delta
  // runs from initial-sync SYNC_NOW runs without a schema change.
  const syncRun = await prisma.mailboxSyncRun.create({
    data: {
      clubId: conn.clubId,
      mailboxConnectionId: conn.id,
      status: "RUNNING",
      triggerKind: args.triggerKind ?? "DELTA",
      startedAt: new Date(),
    },
  });
  result.syncRunId = syncRun.id;

  // Record attempt.
  await prisma.mailboxConnection.update({
    where: { id: conn.id },
    data: { lastAttemptedSyncAt: new Date() },
  });

  const effectiveCap = effectiveDeltaSyncMessageCap();
  const skipMaterialization = shouldSkipMaterialization();
  const skipAttachmentMetadata = shouldSkipAttachmentMetadata();
  result.effectiveMessageCap = effectiveCap;
  result.materializationSkippedByControl = skipMaterialization;
  result.attachmentMetadataSkippedByControl = skipAttachmentMetadata;

  const priorCursor = conn.deltaLink;
  // The current continuation URL for this run. Starts as the stored
  // cursor (incremental) or null (initial enumeration). Advances
  // through @odata.nextLink values as the enumeration proceeds.
  let continuationUrl: string | null = priorCursor;
  let newTerminalDeltaLink: string | null = null;
  let importedThisRun = 0;
  let updatedThisRun = 0;
  let softDeletedThisRun = 0;
  let skippedThisRun = 0;
  let failedThisRun = 0;
  let intakeThisRun = 0;

  logger.info("mailbox.delta.start", {
    mailboxConnectionId: conn.id,
    clubId: conn.clubId,
    triggerKind: args.triggerKind ?? "DELTA",
    hadPriorCursor: !!priorCursor,
    effectiveCap,
    skipMaterialization,
    skipAttachmentMetadata,
  });

  try {
    // Bounded loop. Terminates on ANY of:
    //   - cap reached (messagesExamined ≥ effectiveCap)
    //   - terminal @odata.deltaLink received (enumeration complete)
    //   - Microsoft returned no continuation URL AND no deltaLink
    //     (unexpected — treat as end and preserve prior cursor)
    while (result.messagesExamined < effectiveCap) {
      // Re-check disconnect BEFORE each page — a user who disconnects
      // mid-run stops receiving further Graph work.
      const currentConn = await prisma.mailboxConnection.findUnique({ where: { id: conn.id } });
      if (!currentConn || isTerminalStatus(currentConn.status)) {
        result.outcome = "SKIPPED";
        break;
      }

      const { accessToken } = await getFreshDelegatedAccessToken({
        mailboxConnectionId: conn.id,
        callerClubId: conn.clubId,
        callerUserId: conn.userId,
      });
      const provider = getMicrosoftDelegatedProvider();

      // Bound page size by remaining capacity so a single page can
      // never push messagesExamined past effectiveCap. Never request
      // 0 (avoids Graph rejecting $top=0 or looping empty).
      const remainingCapacity = Math.max(1, effectiveCap - result.messagesExamined);
      const requestedPageSize = Math.min(SYNC_SCOPE.pageSize, remainingCapacity);

      result.pagesRequested += 1;
      const page = await provider.listInboxMessagesDelta({
        accessToken,
        pageSize: requestedPageSize,
        continuationUrl,
      });

      result.messagesExamined += page.messages.length;

      for (const raw of page.messages) {
        // Cap on (imported + updated), not just imported, mirroring
        // the initial-sync inner-loop invariant. Prevents a run
        // against a mailbox with existing rows from exceeding
        // effectiveCap in the persisted set.
        if (importedThisRun + updatedThisRun >= effectiveCap) break;

        const wasTombstone = !!raw.removed;
        try {
          const outcome = await ingestOneMessage({
            clubId: conn.clubId,
            mailboxConnectionId: conn.id,
            raw,
            accessToken,
            skipAttachmentMetadata,
            skipMaterialization,
          });
          if (wasTombstone) softDeletedThisRun += 1;
          if (outcome.imported) importedThisRun += 1;
          if (outcome.updated) updatedThisRun += 1;
          if (outcome.intakeCreated) intakeThisRun += 1;
        } catch {
          // Per-message failure is non-fatal for the outer run; the
          // shared ingestOneMessage already records retryAttempts +
          // ingestFailedAt on the offending row via its own error
          // path — delta-sync just tallies. A partial failure DOES
          // NOT overwrite the cursor: the connection re-attempts
          // from the same cursor on the next authorized delta run.
          failedThisRun += 1;
          if (result.outcome === "COMPLETED") result.outcome = "BOUNDED_PARTIAL";
        }
      }

      // Advance / terminate. Order matters:
      //   1. If Graph returned @odata.deltaLink, enumeration is complete.
      //      Store it as the new cursor — regardless of whether it also
      //      returned a nextLink (Graph's contract says only one is
      //      present at a time, but be defensive).
      //   2. Otherwise, if @odata.nextLink is present, advance to it
      //      and loop.
      //   3. Otherwise, unexpected end — preserve prior cursor.
      if (page.deltaLink) {
        newTerminalDeltaLink = page.deltaLink;
        result.terminalCursorReceived = true;
        continuationUrl = null;
        break;
      }
      if (page.nextPageToken) {
        continuationUrl = page.nextPageToken;
        continue;
      }
      // No cursor + no next — treat as end. Cursor stays as prior.
      break;
    }

    // Determine outcome for cursor persistence. Founder §"Partial
    // enumeration rule": never overwrite deltaLink with an
    // intermediate nextLink. Cursor advances ONLY when the terminal
    // deltaLink was seen.
    const hitCapWithoutTerminal = !result.terminalCursorReceived && result.messagesExamined >= effectiveCap;
    if (result.outcome === "COMPLETED" && hitCapWithoutTerminal) {
      result.outcome = "BOUNDED_PARTIAL";
    }

    // Persist connection state.
    //
    // Founder §"Connection state and cursor persistence":
    //   - success + terminal cursor  → advance deltaLink,
    //                                  set lastSuccessfulSyncAt,
    //                                  keep status CONNECTED (or
    //                                  finish the pending-sync flip).
    //   - bounded partial            → preserve prior cursor;
    //                                  DO NOT set lastSuccessfulSyncAt
    //                                  (the run did not complete);
    //                                  keep current status.
    const isTerminalSuccess = result.outcome === "COMPLETED" && result.terminalCursorReceived;
    if (isTerminalSuccess) {
      await prisma.mailboxConnection.update({
        where: { id: conn.id },
        data: {
          deltaLink: newTerminalDeltaLink,
          lastSuccessfulSyncAt: new Date(),
          lastSyncError: null,
          // Delta sync from a PENDING_SYNC connection is unusual
          // (initial sync usually runs first) but if it happens,
          // completing a delta enumeration satisfies the PENDING
          // state — same transition semantics as initial sync.
          status:
            conn.status === MAILBOX_STATUS.CONNECTED_PENDING_SYNC
              ? MAILBOX_STATUS.CONNECTED
              : conn.status === MAILBOX_STATUS.DELAYED
                ? MAILBOX_STATUS.CONNECTED
                : conn.status,
        },
      });
    } else {
      // Bounded partial OR partial-with-failures. Preserve cursor.
      await prisma.mailboxConnection.update({
        where: { id: conn.id },
        data: {
          // Do NOT touch deltaLink here — it stays at conn.deltaLink.
          lastSyncError: null,
        },
      });
    }
  } catch (err) {
    const classification = classifyMsalError(err);
    logger.warn("mailbox.delta.error", {
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
    result.messagesSoftDeleted = softDeletedThisRun;
    result.messagesSkipped = skippedThisRun;
    result.messagesFailed = failedThisRun;
    result.intakeItemsCreated = intakeThisRun;
    await finaliseSyncRun(syncRun.id, {
      status: classification === "terminal" ? "TERMINAL" : "DELAYED",
      messagesExamined: result.messagesExamined,
      messagesImported: importedThisRun,
      messagesUpdated: updatedThisRun,
      // Soft-deletes are surfaced via the messagesSuppressed column
      // (the closest existing counter) — semantically these are
      // "message no longer present in the mailbox".
      messagesSuppressed: softDeletedThisRun,
      messagesFailed: failedThisRun,
      // Delta processing bypasses classification when
      // MAILBOX_SYNC_SKIP_MATERIALIZATION is true, so intake
      // counters are 0 in controlled mode.
      intakeCreatedActionable: intakeThisRun,
      intakeCreatedInformational: 0,
      failureCategory:
        classification === "terminal"
          ? MAILBOX_ERROR_CODE.REFRESH_TERMINAL
          : MAILBOX_ERROR_CODE.REFRESH_RETRYABLE,
    });
    return result;
  }

  result.messagesImported = importedThisRun;
  result.messagesUpdated = updatedThisRun;
  result.messagesSoftDeleted = softDeletedThisRun;
  result.messagesSkipped = skippedThisRun;
  result.messagesFailed = failedThisRun;
  result.intakeItemsCreated = intakeThisRun;
  await finaliseSyncRun(syncRun.id, {
    status:
      result.outcome === "COMPLETED"
        ? "COMPLETED"
        : result.outcome === "BOUNDED_PARTIAL"
          ? "PARTIAL"
          : "COMPLETED",
    messagesExamined: result.messagesExamined,
    messagesImported: importedThisRun,
    messagesUpdated: updatedThisRun,
    messagesSuppressed: softDeletedThisRun,
    messagesFailed: failedThisRun,
    intakeCreatedActionable: intakeThisRun,
    intakeCreatedInformational: 0,
    failureCategory: null,
  });

  logger.info("mailbox.delta.complete", {
    mailboxConnectionId: conn.id,
    outcome: result.outcome,
    messagesExamined: result.messagesExamined,
    messagesImported: importedThisRun,
    messagesUpdated: updatedThisRun,
    messagesSoftDeleted: softDeletedThisRun,
    pagesRequested: result.pagesRequested,
    terminalCursorReceived: result.terminalCursorReceived,
  });

  return result;
}
