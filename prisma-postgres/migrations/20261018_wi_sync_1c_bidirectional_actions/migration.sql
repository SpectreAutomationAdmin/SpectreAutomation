-- WI-SYNC-1c (2026-10-18) — bidirectional Spectre↔Outlook actions.
--
--  * MailboxConnection.reconciliationCursorEmailMessageId — tie-
--    breaker on top of receivedAt so the bounded sweep cursor is
--    strictly monotonic even on duplicate timestamps.
--  * WorkIntakeItem.statusBeforeSuppression — captured when a WI
--    is suppressed by evidence deletion so the restore path can
--    return it to its prior status.
--  * WorkIntakeItem.userDismissedAt / userDismissedByUserId — set
--    only by the Dismiss action; blocks the restore path from
--    reactivating a WI the user explicitly dismissed.
--  * OutlookDeleteMutation — Spectre-initiated moves to Outlook's
--    Deleted Items.  Mirrors the OutlookArchiveMutation shape.

ALTER TABLE "MailboxConnection"
  ADD COLUMN "reconciliationCursorEmailMessageId" TEXT;

ALTER TABLE "WorkIntakeItem"
  ADD COLUMN "statusBeforeSuppression" TEXT,
  ADD COLUMN "userDismissedAt"         TIMESTAMP(3),
  ADD COLUMN "userDismissedByUserId"   TEXT;

CREATE TABLE "OutlookDeleteMutation" (
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
    CONSTRAINT "OutlookDeleteMutation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OutlookDeleteMutation_clubId_status_idx"
  ON "OutlookDeleteMutation" ("clubId", "status");
CREATE INDEX "OutlookDeleteMutation_workIntakeItemId_idx"
  ON "OutlookDeleteMutation" ("workIntakeItemId");
CREATE INDEX "OutlookDeleteMutation_mailbox_email_status_idx"
  ON "OutlookDeleteMutation" ("mailboxConnectionId", "emailMessageId", "status");
