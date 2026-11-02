-- EP-TRAIN-5C-2 (2026-11-02) — Obligation-scoped sessions.
--
-- Additive-only.  Every existing TrainingProgress + TrainingAttempt
-- row gets `obligationId = NULL` by default (the "legacy singleton"
-- shape).  The strict @@unique([employeeId, courseVersionId]) on
-- TrainingProgress is swapped for TWO partial uniques:
--
--   1. UNIQUE WHERE obligationId IS NULL — guarantees one legacy
--      singleton row per (employee, version).  Every existing row
--      satisfies this trivially.
--   2. UNIQUE WHERE obligationId IS NOT NULL — guarantees one
--      obligation-scoped row per (employee, version, obligation)
--      for new 5C-2 training sessions.
--
-- TrainingAttempt gets a new nullable obligationId column as metadata
-- (its existing @@unique([employeeId, courseVersionId, attemptNumber])
-- is unchanged — attempt numbers remain serial per (employee × version)
-- across all sessions).

-- Section 1 — TrainingProgress
ALTER TABLE "TrainingProgress" ADD COLUMN "obligationId" TEXT REFERENCES "TrainingObligation"("id") ON DELETE SET NULL;

DROP INDEX IF EXISTS "TrainingProgress_employeeId_courseVersionId_key";

CREATE UNIQUE INDEX "TrainingProgress_legacy_singleton_idx"
    ON "TrainingProgress"("employeeId", "courseVersionId")
    WHERE "obligationId" IS NULL;

CREATE UNIQUE INDEX "TrainingProgress_per_obligation_idx"
    ON "TrainingProgress"("employeeId", "courseVersionId", "obligationId")
    WHERE "obligationId" IS NOT NULL;

-- Plain indexes for query speed (match the Prisma schema).
CREATE INDEX "TrainingProgress_employeeId_courseVersionId_idx"
    ON "TrainingProgress"("employeeId", "courseVersionId");
CREATE INDEX "TrainingProgress_employeeId_courseVersionId_obligationId_idx"
    ON "TrainingProgress"("employeeId", "courseVersionId", "obligationId");
CREATE INDEX "TrainingProgress_obligationId_idx"
    ON "TrainingProgress"("obligationId");

-- Section 2 — TrainingAttempt
ALTER TABLE "TrainingAttempt" ADD COLUMN "obligationId" TEXT REFERENCES "TrainingObligation"("id") ON DELETE SET NULL;

CREATE INDEX "TrainingAttempt_obligationId_idx"
    ON "TrainingAttempt"("obligationId");
