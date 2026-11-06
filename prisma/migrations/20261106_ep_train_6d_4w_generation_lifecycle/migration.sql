-- EP-TRAIN-6D-4W (2026-11-06) — generation-run lifecycle extension.
--
-- Additive-only. 7 new nullable columns + 1 unique constraint + 2
-- indexes on TrainingQuestionAiGenerationRun. Zero changes to any
-- other entity. Zero DROP / TRUNCATE. Rollback: drop the columns +
-- indexes.
--
-- Founder-authorised on 2026-11-06 with eight requirements. See
-- docs/training/ai-generation/PHASE-D-4W-GENERATION-DESIGN.md.

ALTER TABLE "TrainingQuestionAiGenerationRun" ADD COLUMN "queuedAt" DATETIME;
ALTER TABLE "TrainingQuestionAiGenerationRun" ADD COLUMN "startedAt" DATETIME;
ALTER TABLE "TrainingQuestionAiGenerationRun" ADD COLUMN "leaseToken" TEXT;
ALTER TABLE "TrainingQuestionAiGenerationRun" ADD COLUMN "leaseExpiresAt" DATETIME;
ALTER TABLE "TrainingQuestionAiGenerationRun" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TrainingQuestionAiGenerationRun" ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 2;

-- Canonical JSON of the course-level assessment plan. Immutable
-- once generation leaves REQUESTED state (service-layer enforced).
-- Schema version embedded in the body: "training-assessment-plan-v1".
ALTER TABLE "TrainingQuestionAiGenerationRun" ADD COLUMN "assessmentPlanJson" TEXT;

-- SHA-256 hex of the canonical plan body. Enforced non-null once
-- assessmentPlanJson is set (service-layer); the column itself is
-- nullable so 4B-era rows remain valid.
ALTER TABLE "TrainingQuestionAiGenerationRun" ADD COLUMN "planIdentity" TEXT;

-- Shortfall report (founder requirement 7 via §7 of the directive).
ALTER TABLE "TrainingQuestionAiGenerationRun" ADD COLUMN "shortfallReasonJson" TEXT;

-- DB-boundary dedup (founder condition 5): at most ONE non-terminal
-- row per (club, courseVersion, transcript build, plan identity,
-- state). Multiple FAILED/CANCELLED rows allowed as history;
-- multiple state values collapse because the state is part of the
-- key.
CREATE UNIQUE INDEX "TrainingQuestionAiGenerationRun_unique_live_run_key"
    ON "TrainingQuestionAiGenerationRun" (
      "clubId", "courseVersionId", "resolvedTranscriptBuildId",
      "planIdentity", "executionStatus"
    )
    WHERE "planIdentity" IS NOT NULL;

CREATE INDEX "TrainingQuestionAiGenerationRun_status_lease_idx"
    ON "TrainingQuestionAiGenerationRun" ("executionStatus", "leaseExpiresAt");

CREATE INDEX "TrainingQuestionAiGenerationRun_club_status_idx"
    ON "TrainingQuestionAiGenerationRun" ("clubId", "executionStatus");
