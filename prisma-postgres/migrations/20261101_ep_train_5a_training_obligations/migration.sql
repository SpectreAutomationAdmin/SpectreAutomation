-- EP-TRAIN-5A (2026-11-01) — Training obligation foundation (Postgres mirror).
--
-- Additive-only; `IF NOT EXISTS` keeps the migration idempotent so a
-- re-run against a database that already has the table is a no-op.

CREATE TABLE IF NOT EXISTS "TrainingObligation" (
    "id"                       TEXT NOT NULL PRIMARY KEY,
    "clubId"                   TEXT NOT NULL,
    "employeeId"               TEXT NOT NULL,
    "courseId"                 TEXT NOT NULL,
    "courseVersionId"          TEXT NOT NULL,
    "reason"                   TEXT NOT NULL,
    "reasonNote"               TEXT,
    "issuedByUserId"           TEXT,
    "issuedAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt"                    TIMESTAMP(3),
    "status"                   TEXT NOT NULL DEFAULT 'OUTSTANDING',
    "satisfiedByCompletionId"  TEXT,
    "satisfiedAt"              TIMESTAMP(3),
    "supersededByObligationId" TEXT,
    "outstandingUniqueKey"     TEXT,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrainingObligation_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "Club" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingObligation_employeeId_fkey"
        FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingObligation_courseId_fkey"
        FOREIGN KEY ("courseId") REFERENCES "TrainingCourse" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingObligation_courseVersionId_fkey"
        FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingObligation_satisfiedByCompletionId_fkey"
        FOREIGN KEY ("satisfiedByCompletionId") REFERENCES "TrainingCompletion" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TrainingObligation_supersededByObligationId_fkey"
        FOREIGN KEY ("supersededByObligationId") REFERENCES "TrainingObligation" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingObligation_satisfiedByCompletionId_key"
    ON "TrainingObligation"("satisfiedByCompletionId");

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingObligation_outstandingUniqueKey_key"
    ON "TrainingObligation"("outstandingUniqueKey");

CREATE INDEX IF NOT EXISTS "TrainingObligation_clubId_employeeId_status_idx"
    ON "TrainingObligation"("clubId", "employeeId", "status");
CREATE INDEX IF NOT EXISTS "TrainingObligation_clubId_courseId_status_idx"
    ON "TrainingObligation"("clubId", "courseId", "status");
CREATE INDEX IF NOT EXISTS "TrainingObligation_clubId_courseVersionId_status_idx"
    ON "TrainingObligation"("clubId", "courseVersionId", "status");
CREATE INDEX IF NOT EXISTS "TrainingObligation_employeeId_status_idx"
    ON "TrainingObligation"("employeeId", "status");
