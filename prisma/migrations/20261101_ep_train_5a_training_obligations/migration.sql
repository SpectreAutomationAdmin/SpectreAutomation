-- EP-TRAIN-5A (2026-11-01) — Training obligation foundation.
--
-- Additive-only.  No existing data is mutated.  No existing columns
-- are dropped or altered.  Rolling back this migration deletes the
-- (empty) TrainingObligation table and the unique indexes that
-- reference it — no other table is affected.

CREATE TABLE "TrainingObligation" (
    "id"                       TEXT NOT NULL PRIMARY KEY,
    "clubId"                   TEXT NOT NULL,
    "employeeId"               TEXT NOT NULL,
    "courseId"                 TEXT NOT NULL,
    "courseVersionId"          TEXT NOT NULL,
    "reason"                   TEXT NOT NULL,
    "reasonNote"               TEXT,
    "issuedByUserId"           TEXT,
    "issuedAt"                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt"                    DATETIME,
    "status"                   TEXT NOT NULL DEFAULT 'OUTSTANDING',
    "satisfiedByCompletionId"  TEXT,
    "satisfiedAt"              DATETIME,
    "supersededByObligationId" TEXT,
    "outstandingUniqueKey"     TEXT,
    "createdAt"                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                DATETIME NOT NULL,
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

-- Invariant 2: one completion satisfies AT MOST one obligation.
CREATE UNIQUE INDEX "TrainingObligation_satisfiedByCompletionId_key"
    ON "TrainingObligation"("satisfiedByCompletionId");

-- Invariant 1: at most ONE OUTSTANDING per (employee, courseVersionId, reason).
-- The service layer sets outstandingUniqueKey = <employeeId>|<versionId>|<reason>
-- on OUTSTANDING rows and NULL on terminal rows; both engines treat multiple
-- NULLs as distinct in a UNIQUE index, so terminal rows don't collide.
CREATE UNIQUE INDEX "TrainingObligation_outstandingUniqueKey_key"
    ON "TrainingObligation"("outstandingUniqueKey");

CREATE INDEX "TrainingObligation_clubId_employeeId_status_idx"
    ON "TrainingObligation"("clubId", "employeeId", "status");
CREATE INDEX "TrainingObligation_clubId_courseId_status_idx"
    ON "TrainingObligation"("clubId", "courseId", "status");
CREATE INDEX "TrainingObligation_clubId_courseVersionId_status_idx"
    ON "TrainingObligation"("clubId", "courseVersionId", "status");
CREATE INDEX "TrainingObligation_employeeId_status_idx"
    ON "TrainingObligation"("employeeId", "status");
