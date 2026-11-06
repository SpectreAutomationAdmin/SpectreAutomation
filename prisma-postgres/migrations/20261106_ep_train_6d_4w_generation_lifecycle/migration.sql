-- EP-TRAIN-6D-4W (2026-11-06) — generation-run lifecycle extension.
-- Postgres mirror of
-- `prisma/migrations/20261106_ep_train_6d_4w_generation_lifecycle/migration.sql`.
--
-- Additive-only. 7 nullable columns + 1 partial-unique constraint +
-- 2 indexes. Zero changes to any other entity.
--
-- Not applied to staging / production in this slice.

ALTER TABLE "TrainingQuestionAiGenerationRun"
    ADD COLUMN IF NOT EXISTS "queuedAt" TIMESTAMP(3);
ALTER TABLE "TrainingQuestionAiGenerationRun"
    ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);
ALTER TABLE "TrainingQuestionAiGenerationRun"
    ADD COLUMN IF NOT EXISTS "leaseToken" TEXT;
ALTER TABLE "TrainingQuestionAiGenerationRun"
    ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "TrainingQuestionAiGenerationRun"
    ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TrainingQuestionAiGenerationRun"
    ADD COLUMN IF NOT EXISTS "maxAttempts" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "TrainingQuestionAiGenerationRun"
    ADD COLUMN IF NOT EXISTS "assessmentPlanJson" TEXT;
ALTER TABLE "TrainingQuestionAiGenerationRun"
    ADD COLUMN IF NOT EXISTS "planIdentity" TEXT;
ALTER TABLE "TrainingQuestionAiGenerationRun"
    ADD COLUMN IF NOT EXISTS "shortfallReasonJson" TEXT;

-- DB-boundary dedup — partial unique on non-null planIdentity so
-- pre-4W rows (with NULL planIdentity) don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS "TrainingQuestionAiGenerationRun_unique_live_run_key"
    ON "TrainingQuestionAiGenerationRun" (
      "clubId", "courseVersionId", "resolvedTranscriptBuildId",
      "planIdentity", "executionStatus"
    )
    WHERE "planIdentity" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "TrainingQuestionAiGenerationRun_status_lease_idx"
    ON "TrainingQuestionAiGenerationRun" ("executionStatus", "leaseExpiresAt");

CREATE INDEX IF NOT EXISTS "TrainingQuestionAiGenerationRun_club_status_idx"
    ON "TrainingQuestionAiGenerationRun" ("clubId", "executionStatus");
