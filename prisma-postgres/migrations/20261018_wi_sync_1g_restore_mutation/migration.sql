-- WI-SYNC-1g (2026-10-18) — Spectre→Outlook Restore mutation.
--
-- Durable record for a Spectre-initiated restore (move-to-Inbox)
-- of an Outlook message.  Mirrors OutlookDeleteMutation (WI-SYNC-1c)
-- and OutlookArchiveMutation.
--
-- Status values:
--   PENDING                 — row created but Graph call not yet started.
--   RUNNING                 — Graph moveMessage in-flight.
--   GRAPH_OK_DB_PENDING     — Graph move succeeded + probe confirmed
--                             PRESENT_INBOX, but the DB transaction
--                             (clear softDeletedAt + WI restore) did
--                             not complete.  Reconciliation sweep +
--                             MAILBOX_RESTORE_COMPLETION job finish
--                             the DB side idempotently.
--   SUCCEEDED               — Graph + DB both complete.
--   RETRYABLE               — Graph transient error (429 / 5xx).
--   FAILED_TERMINAL         — Graph permanent error (404 / 403).

CREATE TABLE "OutlookRestoreMutation" (
    "id"                      TEXT NOT NULL,
    "clubId"                  TEXT NOT NULL,
    "workIntakeItemId"        TEXT NOT NULL,
    "emailMessageId"          TEXT NOT NULL,
    "originalGraphMessageId"  TEXT NOT NULL,
    "resultingGraphMessageId" TEXT,
    "originalFolderId"        TEXT,
    "destinationFolderId"     TEXT,
    "mailboxConnectionId"     TEXT NOT NULL,
    "triggeredByUserId"       TEXT,
    "status"                  TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount"            INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt"           TIMESTAMP(3),
    "completedAt"             TIMESTAMP(3),
    "errorCode"               TEXT,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OutlookRestoreMutation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OutlookRestoreMutation_clubId_status_idx"
  ON "OutlookRestoreMutation" ("clubId", "status");
CREATE INDEX "OutlookRestoreMutation_workIntakeItemId_idx"
  ON "OutlookRestoreMutation" ("workIntakeItemId");
CREATE INDEX "OutlookRestoreMutation_mailbox_email_status_idx"
  ON "OutlookRestoreMutation" ("mailboxConnectionId", "emailMessageId", "status");
