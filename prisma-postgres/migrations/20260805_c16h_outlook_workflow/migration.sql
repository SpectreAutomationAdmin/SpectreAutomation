-- Sprint 3 · Checkpoint 16H (2026-08-04) — Outlook workflow tables.
--
-- Three new tables support the three founder-approved capabilities:
--   * WorkCompletionEvent   — canonical WI-completed emitter
--   * OutlookReplyMutation  — Spectre-originated reply record
--   * OutlookArchiveMutation — durable archive job with idempotency

CREATE TABLE "WorkCompletionEvent" (
  "id"                TEXT NOT NULL,
  "clubId"            TEXT NOT NULL,
  "workIntakeItemId"  TEXT NOT NULL,
  "completedByUserId" TEXT NOT NULL,
  "completedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completionType"    TEXT NOT NULL,
  "metadataJson"      TEXT,

  CONSTRAINT "WorkCompletionEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkCompletionEvent_workIntakeItemId_fkey"
    FOREIGN KEY ("workIntakeItemId") REFERENCES "WorkIntakeItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WorkCompletionEvent_clubId_completedAt_idx"   ON "WorkCompletionEvent"("clubId", "completedAt");
CREATE INDEX "WorkCompletionEvent_workIntakeItemId_idx"     ON "WorkCompletionEvent"("workIntakeItemId");

CREATE TABLE "OutlookReplyMutation" (
  "id"                    TEXT NOT NULL,
  "clubId"                TEXT NOT NULL,
  "workIntakeId"          TEXT NOT NULL,
  "mailboxConnectionId"   TEXT NOT NULL,
  "sourceEmailMessageId"  TEXT NOT NULL,
  "initiatedByUserId"     TEXT NOT NULL,
  "mode"                  TEXT NOT NULL,
  "status"                TEXT NOT NULL DEFAULT 'DRAFT',
  "graphMessageId"        TEXT,
  "graphConversationId"   TEXT,
  "sentAt"                TIMESTAMP(3),
  "attemptCount"          INTEGER NOT NULL DEFAULT 0,
  "errorCode"             TEXT,
  "idempotencyKey"        TEXT NOT NULL,
  "bodyCiphertext"        TEXT,
  "bodySecretRef"         TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OutlookReplyMutation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OutlookReplyMutation_idempotencyKey_key" ON "OutlookReplyMutation"("idempotencyKey");
CREATE INDEX "OutlookReplyMutation_clubId_createdAt_idx"     ON "OutlookReplyMutation"("clubId", "createdAt");
CREATE INDEX "OutlookReplyMutation_workIntakeId_idx"         ON "OutlookReplyMutation"("workIntakeId");
CREATE INDEX "OutlookReplyMutation_sourceEmailMessageId_idx" ON "OutlookReplyMutation"("sourceEmailMessageId");

CREATE TABLE "OutlookArchiveMutation" (
  "id"                        TEXT NOT NULL,
  "clubId"                    TEXT NOT NULL,
  "workIntakeId"              TEXT NOT NULL,
  "workCompletionEventId"     TEXT,
  "emailMessageId"            TEXT NOT NULL,
  "originalExternalMessageId" TEXT NOT NULL,
  "resultingExternalMessageId" TEXT,
  "originalFolderId"          TEXT,
  "destinationFolderId"       TEXT,
  "mailboxConnectionId"       TEXT NOT NULL,
  "status"                    TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount"              INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt"             TIMESTAMP(3),
  "completedAt"               TIMESTAMP(3),
  "errorCode"                 TEXT,
  "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                 TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OutlookArchiveMutation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OutlookArchiveMutation_workCompletionEventId_fkey"
    FOREIGN KEY ("workCompletionEventId") REFERENCES "WorkCompletionEvent"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OutlookArchiveMutation_completion_msg_uniq"
  ON "OutlookArchiveMutation"("workCompletionEventId", "emailMessageId");
CREATE INDEX "OutlookArchiveMutation_clubId_status_idx"     ON "OutlookArchiveMutation"("clubId", "status");
CREATE INDEX "OutlookArchiveMutation_workIntakeId_idx"      ON "OutlookArchiveMutation"("workIntakeId");
