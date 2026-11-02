-- EP-TRAIN-5C-2 (2026-11-02) — Obligation-scoped sessions (Postgres mirror).
-- See the SQLite migration SQL header for the full rationale.

-- Section 1 — TrainingProgress
ALTER TABLE "TrainingProgress" ADD COLUMN IF NOT EXISTS "obligationId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'TrainingProgress'
      AND constraint_name = 'TrainingProgress_obligationId_fkey'
  ) THEN
    ALTER TABLE "TrainingProgress"
      ADD CONSTRAINT "TrainingProgress_obligationId_fkey"
      FOREIGN KEY ("obligationId") REFERENCES "TrainingObligation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DROP INDEX IF EXISTS "TrainingProgress_employeeId_courseVersionId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingProgress_legacy_singleton_idx"
    ON "TrainingProgress"("employeeId", "courseVersionId")
    WHERE "obligationId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingProgress_per_obligation_idx"
    ON "TrainingProgress"("employeeId", "courseVersionId", "obligationId")
    WHERE "obligationId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "TrainingProgress_employeeId_courseVersionId_idx"
    ON "TrainingProgress"("employeeId", "courseVersionId");
CREATE INDEX IF NOT EXISTS "TrainingProgress_employeeId_courseVersionId_obligationId_idx"
    ON "TrainingProgress"("employeeId", "courseVersionId", "obligationId");
CREATE INDEX IF NOT EXISTS "TrainingProgress_obligationId_idx"
    ON "TrainingProgress"("obligationId");

-- Section 2 — TrainingAttempt
ALTER TABLE "TrainingAttempt" ADD COLUMN IF NOT EXISTS "obligationId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'TrainingAttempt'
      AND constraint_name = 'TrainingAttempt_obligationId_fkey'
  ) THEN
    ALTER TABLE "TrainingAttempt"
      ADD CONSTRAINT "TrainingAttempt_obligationId_fkey"
      FOREIGN KEY ("obligationId") REFERENCES "TrainingObligation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "TrainingAttempt_obligationId_idx"
    ON "TrainingAttempt"("obligationId");
