-- Phase 4R rev-10 (2026-08-15) — OutlookMarkReadMutation.
--
-- Durable idempotency + audit row for the Spectre → Outlook
-- mark-as-read Graph PATCH triggered when a founder first
-- meaningfully interacts with an unread email-backed Work Intake
-- card. See src/lib/mailbox/mark-read.ts for the consumer and
-- prisma-postgres/schema.prisma :: model OutlookMarkReadMutation
-- for the full model docs.
--
-- Unique on (mailboxConnectionId, emailMessageId) so a second
-- click cannot enqueue a duplicate PATCH: the worker finds the
-- existing SUCCEEDED row and returns immediately.

CREATE TABLE "OutlookMarkReadMutation" (
  "id"                  TEXT NOT NULL,
  "clubId"              TEXT NOT NULL,
  "workIntakeItemId"    TEXT NOT NULL,
  "emailMessageId"      TEXT NOT NULL,
  "graphMessageId"      TEXT NOT NULL,
  "mailboxConnectionId" TEXT NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount"        INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt"       TIMESTAMP(3),
  "completedAt"         TIMESTAMP(3),
  "errorCode"           TEXT,
  "triggeredByUserId"   TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OutlookMarkReadMutation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutlookMarkReadMutation_conn_msg_uniq"
  ON "OutlookMarkReadMutation"("mailboxConnectionId", "emailMessageId");
CREATE INDEX "OutlookMarkReadMutation_clubId_status_idx"
  ON "OutlookMarkReadMutation"("clubId", "status");
CREATE INDEX "OutlookMarkReadMutation_workIntakeItemId_idx"
  ON "OutlookMarkReadMutation"("workIntakeItemId");
