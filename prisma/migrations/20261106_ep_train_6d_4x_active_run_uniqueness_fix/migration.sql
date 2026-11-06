-- EP-TRAIN-6D-4X (2026-11-06) — active-run uniqueness correction.
--
-- Rationale: the 4W partial-unique index contained "executionStatus"
-- as part of the key. Two rows with the same (club, courseVersion,
-- transcriptBuild, planIdentity) but DIFFERENT statuses — for
-- example, one REQUESTED and one QUEUED — produced different index
-- tuples and did NOT collide. That weakened founder condition #5
-- ("concurrency safety at the database boundary, not merely through
-- application checks").
--
-- Correction: drop "executionStatus" from the key, keep it only in
-- the partial WHERE as an IN-list over non-terminal states. Now the
-- DB enforces "at most ONE live (REQUESTED/QUEUED/RUNNING) row per
-- identity." Terminal rows (COMPLETED/FAILED/CANCELLED) remain
-- unrestricted as history.
--
-- Additive-only. Zero data touched. Index drop/create is reversible
-- by restoring the 4W migration.

DROP INDEX IF EXISTS "TrainingQuestionAiGenerationRun_unique_live_run_key";

CREATE UNIQUE INDEX "TrainingQuestionAiGenerationRun_unique_live_run_key"
    ON "TrainingQuestionAiGenerationRun" (
      "clubId", "courseVersionId", "resolvedTranscriptBuildId",
      "planIdentity"
    )
    WHERE "planIdentity" IS NOT NULL
      AND "executionStatus" IN ('REQUESTED', 'QUEUED', 'RUNNING');
