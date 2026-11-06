-- EP-TRAIN-6D-4X (2026-11-06) — active-run uniqueness correction.
-- Postgres mirror of
-- `prisma/migrations/20261106_ep_train_6d_4x_active_run_uniqueness_fix/migration.sql`.
--
-- See the SQLite migration for the full rationale. Summary: the 4W
-- partial-unique index included "executionStatus" as part of the
-- key, so two rows with (club, courseVersion, transcriptBuild,
-- planIdentity) but different statuses did NOT collide. That broke
-- founder condition #5. Correction: key becomes
-- (club, courseVersion, transcriptBuild, planIdentity) and the
-- partial WHERE restricts to non-terminal statuses.
--
-- Not applied to staging / production in this slice.

DROP INDEX IF EXISTS "TrainingQuestionAiGenerationRun_unique_live_run_key";

CREATE UNIQUE INDEX "TrainingQuestionAiGenerationRun_unique_live_run_key"
    ON "TrainingQuestionAiGenerationRun" (
      "clubId", "courseVersionId", "resolvedTranscriptBuildId",
      "planIdentity"
    )
    WHERE "planIdentity" IS NOT NULL
      AND "executionStatus" IN ('REQUESTED', 'QUEUED', 'RUNNING');
