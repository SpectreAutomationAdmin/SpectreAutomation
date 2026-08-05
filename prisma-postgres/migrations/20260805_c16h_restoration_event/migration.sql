-- Sprint 3 · Checkpoint 16H completion (2026-08-05) — audit record
-- for restoring a completed Work Intake back to Active. Asymmetric:
-- restoration returns the WI to the feed without reversing
-- accounting or moving archived Outlook mail back to Inbox.

CREATE TABLE "WorkRestorationEvent" (
  "id"                     TEXT NOT NULL,
  "clubId"                 TEXT NOT NULL,
  "workIntakeItemId"       TEXT NOT NULL,
  "restoredByUserId"       TEXT NOT NULL,
  "restoredAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "priorCompletionEventId" TEXT,
  "reason"                 TEXT,

  CONSTRAINT "WorkRestorationEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkRestorationEvent_workIntakeItemId_fkey"
    FOREIGN KEY ("workIntakeItemId") REFERENCES "WorkIntakeItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WorkRestorationEvent_clubId_restoredAt_idx"    ON "WorkRestorationEvent"("clubId", "restoredAt");
CREATE INDEX "WorkRestorationEvent_workIntakeItemId_idx"     ON "WorkRestorationEvent"("workIntakeItemId");
