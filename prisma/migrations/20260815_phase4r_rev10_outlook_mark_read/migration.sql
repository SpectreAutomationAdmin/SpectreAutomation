-- Phase 4R rev-10 (2026-08-15) — OutlookMarkReadMutation
-- (SQLite mirror of the postgres migration under
--  prisma-postgres/migrations/20260815_phase4r_rev10_outlook_mark_read/).

CREATE TABLE "OutlookMarkReadMutation" (
  "id"                  TEXT NOT NULL PRIMARY KEY,
  "clubId"              TEXT NOT NULL,
  "workIntakeItemId"    TEXT NOT NULL,
  "emailMessageId"      TEXT NOT NULL,
  "graphMessageId"      TEXT NOT NULL,
  "mailboxConnectionId" TEXT NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount"        INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt"       DATETIME,
  "completedAt"         DATETIME,
  "errorCode"           TEXT,
  "triggeredByUserId"   TEXT,
  "createdAt"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           DATETIME NOT NULL
);

CREATE UNIQUE INDEX "OutlookMarkReadMutation_conn_msg_uniq"
  ON "OutlookMarkReadMutation"("mailboxConnectionId", "emailMessageId");
CREATE INDEX "OutlookMarkReadMutation_clubId_status_idx"
  ON "OutlookMarkReadMutation"("clubId", "status");
CREATE INDEX "OutlookMarkReadMutation_workIntakeItemId_idx"
  ON "OutlookMarkReadMutation"("workIntakeItemId");
