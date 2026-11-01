-- EP-TRAIN-5A-1 (2026-11-01) — Completion history + obligation issuance.
-- Postgres mirror of the SQLite migration.  See the SQLite migration
-- SQL header for the full rationale.

-- Section 1: TrainingCompletion — swap (employeeId, courseVersionId)
-- UNIQUE for a plain index.
DROP INDEX IF EXISTS "TrainingCompletion_employeeId_courseVersionId_key";
CREATE INDEX IF NOT EXISTS "TrainingCompletion_employeeId_courseVersionId_idx"
    ON "TrainingCompletion"("employeeId", "courseVersionId");

-- Section 2: TrainingObligation — swap outstandingUniqueKey for a
-- caller-supplied issuanceKey + composite UNIQUE.
--
-- Postgres can DROP COLUMN / ADD COLUMN in place; no table rebuild
-- needed.  Table is dormant (0 rows at staging as of EP-TRAIN-5A
-- verification), so the backfill of issuanceKey for any legacy row
-- is a no-op in practice.
DROP INDEX IF EXISTS "TrainingObligation_outstandingUniqueKey_key";

-- Add issuanceKey with a provisional NULL to allow the backfill
-- UPDATE to run; then NOT NULL once populated.
ALTER TABLE "TrainingObligation" ADD COLUMN IF NOT EXISTS "issuanceKey" TEXT;

UPDATE "TrainingObligation"
   SET "issuanceKey" = COALESCE("outstandingUniqueKey", 'legacy:' || "id")
 WHERE "issuanceKey" IS NULL;

ALTER TABLE "TrainingObligation" ALTER COLUMN "issuanceKey" SET NOT NULL;

ALTER TABLE "TrainingObligation" DROP COLUMN IF EXISTS "outstandingUniqueKey";

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingObligation_clubId_employeeId_courseVersionId_reason_issuanceKey_key"
    ON "TrainingObligation"("clubId", "employeeId", "courseVersionId", "reason", "issuanceKey");
