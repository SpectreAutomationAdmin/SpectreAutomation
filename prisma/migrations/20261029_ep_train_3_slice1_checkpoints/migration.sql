-- EP-TRAIN-3 Slice 1 (2026-10-29) -- SQLite (dev) mirror.  Additive;
-- rollback does NOT drop the table or columns.

CREATE TABLE "TrainingCheckpoint" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "courseVersionId"   TEXT NOT NULL,
  "atSecond"          INTEGER NOT NULL,
  "label"             TEXT,
  "requiredToProceed" BOOLEAN NOT NULL DEFAULT true,
  "maxRetries"        INTEGER NOT NULL DEFAULT 3,
  "displayOrder"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         DATETIME NOT NULL,

  CONSTRAINT "TrainingCheckpoint_courseVersionId_fkey"
    FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion"("id") ON DELETE CASCADE
);

CREATE INDEX "TrainingCheckpoint_courseVersionId_atSecond_idx"
  ON "TrainingCheckpoint"("courseVersionId", "atSecond");
CREATE INDEX "TrainingCheckpoint_courseVersionId_displayOrder_idx"
  ON "TrainingCheckpoint"("courseVersionId", "displayOrder");

ALTER TABLE "TrainingAttempt"  ADD COLUMN "kind"         TEXT    NOT NULL DEFAULT 'FINAL';
ALTER TABLE "TrainingAttempt"  ADD COLUMN "checkpointId" TEXT;
CREATE INDEX "TrainingAttempt_checkpointId_idx" ON "TrainingAttempt"("checkpointId");

ALTER TABLE "TrainingQuestion" ADD COLUMN "checkpointId" TEXT;
ALTER TABLE "TrainingQuestion" ADD COLUMN "questionType" TEXT NOT NULL DEFAULT 'SINGLE_CHOICE';
CREATE INDEX "TrainingQuestion_checkpointId_idx" ON "TrainingQuestion"("checkpointId");

ALTER TABLE "TrainingProgress" ADD COLUMN "checkpointClearedJson" TEXT;
