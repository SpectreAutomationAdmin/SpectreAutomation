-- WI-SYNC-1c (2026-10-18) — SQLite mirror of the Postgres
-- migration.  Dev/test environments only.

ALTER TABLE "MailboxConnection" ADD COLUMN "reconciliationCursorEmailMessageId" TEXT;

ALTER TABLE "WorkIntakeItem" ADD COLUMN "statusBeforeSuppression" TEXT;
ALTER TABLE "WorkIntakeItem" ADD COLUMN "userDismissedAt"         DATETIME;
ALTER TABLE "WorkIntakeItem" ADD COLUMN "userDismissedByUserId"   TEXT;

CREATE TABLE "OutlookDeleteMutation" (
    "id"                      TEXT NOT NULL PRIMARY KEY,
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
    "lastAttemptAt"           DATETIME,
    "completedAt"             DATETIME,
    "errorCode"               TEXT,
    "createdAt"               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               DATETIME NOT NULL
);
CREATE INDEX "OutlookDeleteMutation_clubId_status_idx"           ON "OutlookDeleteMutation"("clubId","status");
CREATE INDEX "OutlookDeleteMutation_workIntakeItemId_idx"        ON "OutlookDeleteMutation"("workIntakeItemId");
CREATE INDEX "OutlookDeleteMutation_mailbox_email_status_idx"    ON "OutlookDeleteMutation"("mailboxConnectionId","emailMessageId","status");
