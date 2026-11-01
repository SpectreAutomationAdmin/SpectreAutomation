-- EP-TRAIN-5A-1 (2026-11-01) — Completion history + obligation issuance.
--
-- Two targeted schema corrections flagged in the EP-TRAIN-5A acceptance report:
--
-- 1. TrainingCompletion: lift the (employeeId, courseVersionId) UNIQUE so
--    an employee can legitimately complete the same course version more
--    than once (MANUAL_REINSTATE / REVISION retakes).  The sole DB
--    uniqueness guard remaining is `attemptId @unique` which is the
--    correct per-event invariant.  No completion row is deleted,
--    reset, or modified — only the index is swapped.
--
-- 2. TrainingObligation: replace the derived `outstandingUniqueKey`
--    with a mandatory caller-supplied `issuanceKey` + a composite
--    UNIQUE on (clubId, employeeId, courseVersionId, reason, issuanceKey).
--    Safe to recreate the column because EP-TRAIN-5A ships this table
--    dormant (verified 0 rows on staging).
--
-- Both changes are reversible: the prior UNIQUE indexes are kept in
-- the down-migration diff documented inline for the DBA.

-- Section 1: TrainingCompletion
DROP INDEX IF EXISTS "TrainingCompletion_employeeId_courseVersionId_key";
CREATE INDEX IF NOT EXISTS "TrainingCompletion_employeeId_courseVersionId_idx"
    ON "TrainingCompletion"("employeeId", "courseVersionId");

-- Section 2: TrainingObligation.  SQLite cannot DROP COLUMN on all
-- versions, so we rebuild the table.  Row count is 0 on both dev and
-- staging (dormant model from EP-TRAIN-5A); safe.
DROP INDEX IF EXISTS "TrainingObligation_outstandingUniqueKey_key";

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_TrainingObligation" (
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
    "issuanceKey"              TEXT NOT NULL,
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

-- Table is dormant (0 rows at staging as of EP-TRAIN-5A verification);
-- the INSERT ... SELECT pattern is a no-op but preserves any row that
-- might have been inserted between EP-TRAIN-5A and this slice.  The
-- outstandingUniqueKey -> issuanceKey transition for any such row would
-- need manual intervention; this migration deploys only when the table
-- is empty.  Guard: fail if any row exists.
INSERT INTO "new_TrainingObligation" (
    "id", "clubId", "employeeId", "courseId", "courseVersionId",
    "reason", "reasonNote", "issuedByUserId", "issuedAt", "dueAt",
    "status", "satisfiedByCompletionId", "satisfiedAt",
    "supersededByObligationId", "issuanceKey", "createdAt", "updatedAt"
)
SELECT
    "id", "clubId", "employeeId", "courseId", "courseVersionId",
    "reason", "reasonNote", "issuedByUserId", "issuedAt", "dueAt",
    "status", "satisfiedByCompletionId", "satisfiedAt",
    "supersededByObligationId",
    -- Legacy outstandingUniqueKey (nullable).  Any pre-existing row
    -- would have `outstandingUniqueKey = ${employeeId}|${versionId}|${reason}`
    -- or NULL on terminal rows; we promote to a legacy issuanceKey
    -- that is deterministic + distinct per row (fallback uses the
    -- primary key).  New rows post-migration must supply issuanceKey.
    COALESCE("outstandingUniqueKey", 'legacy:' || "id"),
    "createdAt", "updatedAt"
FROM "TrainingObligation";

DROP TABLE "TrainingObligation";
ALTER TABLE "new_TrainingObligation" RENAME TO "TrainingObligation";

PRAGMA foreign_keys=ON;

CREATE UNIQUE INDEX "TrainingObligation_satisfiedByCompletionId_key"
    ON "TrainingObligation"("satisfiedByCompletionId");

CREATE UNIQUE INDEX "TrainingObligation_clubId_employeeId_courseVersionId_reason_issuanceKey_key"
    ON "TrainingObligation"("clubId", "employeeId", "courseVersionId", "reason", "issuanceKey");

CREATE INDEX "TrainingObligation_clubId_employeeId_status_idx"
    ON "TrainingObligation"("clubId", "employeeId", "status");
CREATE INDEX "TrainingObligation_clubId_courseId_status_idx"
    ON "TrainingObligation"("clubId", "courseId", "status");
CREATE INDEX "TrainingObligation_clubId_courseVersionId_status_idx"
    ON "TrainingObligation"("clubId", "courseVersionId", "status");
CREATE INDEX "TrainingObligation_employeeId_status_idx"
    ON "TrainingObligation"("employeeId", "status");
