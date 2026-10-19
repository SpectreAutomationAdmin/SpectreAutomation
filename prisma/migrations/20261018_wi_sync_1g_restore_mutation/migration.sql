-- WI-SYNC-1g (2026-10-18) — SQLite mirror of the Postgres
-- migration.  Dev/test environments only.

CREATE TABLE "OutlookRestoreMutation" (
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
CREATE INDEX "OutlookRestoreMutation_clubId_status_idx"           ON "OutlookRestoreMutation"("clubId","status");
CREATE INDEX "OutlookRestoreMutation_workIntakeItemId_idx"        ON "OutlookRestoreMutation"("workIntakeItemId");
CREATE INDEX "OutlookRestoreMutation_mailbox_email_status_idx"    ON "OutlookRestoreMutation"("mailboxConnectionId","emailMessageId","status");
