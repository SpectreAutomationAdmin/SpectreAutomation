-- EP-TRAIN-3 Slice 1 (2026-10-29) -- interactive-training schema +
-- dormant infrastructure.  Additive-only; rollback does NOT drop
-- the new table or columns.  No destructive statements; no backfill
-- UPDATE on existing rows (schema defaults handle every existing
-- row).

-- 1. New TrainingCheckpoint table.
CREATE TABLE "TrainingCheckpoint" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "courseVersionId"   TEXT NOT NULL,
  "atSecond"          INTEGER NOT NULL,
  "label"             TEXT,
  "requiredToProceed" BOOLEAN NOT NULL DEFAULT true,
  "maxRetries"        INTEGER NOT NULL DEFAULT 3,
  "displayOrder"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TrainingCheckpoint_courseVersionId_fkey"
    FOREIGN KEY ("courseVersionId")
    REFERENCES "TrainingCourseVersion"("id") ON DELETE CASCADE
);

CREATE INDEX "TrainingCheckpoint_courseVersionId_atSecond_idx"
  ON "TrainingCheckpoint"("courseVersionId", "atSecond");
CREATE INDEX "TrainingCheckpoint_courseVersionId_displayOrder_idx"
  ON "TrainingCheckpoint"("courseVersionId", "displayOrder");

-- 2. Additive nullable columns on existing models.  Existing rows
--    adopt the DEFAULT value for `kind` + `questionType` without a
--    rewrite; the three ID / JSON columns are nullable.

ALTER TABLE "TrainingAttempt"
  ADD COLUMN "kind"         TEXT    NOT NULL DEFAULT 'FINAL',
  ADD COLUMN "checkpointId" TEXT;

ALTER TABLE "TrainingAttempt"
  ADD CONSTRAINT "TrainingAttempt_checkpointId_fkey"
    FOREIGN KEY ("checkpointId")
    REFERENCES "TrainingCheckpoint"("id") ON DELETE SET NULL;

CREATE INDEX "TrainingAttempt_checkpointId_idx"
  ON "TrainingAttempt"("checkpointId");

ALTER TABLE "TrainingQuestion"
  ADD COLUMN "checkpointId" TEXT,
  ADD COLUMN "questionType" TEXT NOT NULL DEFAULT 'SINGLE_CHOICE';

ALTER TABLE "TrainingQuestion"
  ADD CONSTRAINT "TrainingQuestion_checkpointId_fkey"
    FOREIGN KEY ("checkpointId")
    REFERENCES "TrainingCheckpoint"("id") ON DELETE SET NULL;

CREATE INDEX "TrainingQuestion_checkpointId_idx"
  ON "TrainingQuestion"("checkpointId");

ALTER TABLE "TrainingProgress"
  ADD COLUMN "checkpointClearedJson" TEXT;
