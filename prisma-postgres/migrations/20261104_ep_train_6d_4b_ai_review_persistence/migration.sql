-- EP-TRAIN-6D-4B (2026-11-04) — AI Training Review Persistence Foundation.
-- Postgres mirror of the SQLite migration at
-- `prisma/migrations/20261104_ep_train_6d_4b_ai_review_persistence/migration.sql`.
--
-- Additive-only. Six new tables + indexes + foreign keys. No existing
-- table is modified; no existing row is touched.
--
-- Rollback: dropping the six tables below removes the AI review
-- surface entirely; no other training table is affected.
--
-- Authored as part of EP-TRAIN-6D-4E preflight (2026-11-04). This
-- file is REQUIRED for a Postgres staging deployment of 6D-4D; the
-- Fly release_command runs `prisma migrate deploy --schema
-- prisma-postgres/schema.prisma` and will refuse to promote a
-- release when the SQLite migration has no Postgres mirror.

-- ═══════════════════════════════════════════════════════════════════
-- Section 1 — TrainingQuestionAiGenerationRun
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "TrainingQuestionAiGenerationRun" (
    "id"                             TEXT NOT NULL,
    "clubId"                         TEXT NOT NULL,
    "courseId"                       TEXT NOT NULL,
    "courseVersionId"                TEXT NOT NULL,
    "pilotAuthorizationId"           TEXT NOT NULL,
    "pilotAuthorizationFingerprint"  TEXT NOT NULL,
    "sourceVideoSha256"              TEXT NOT NULL,
    "resolvedTranscriptBuildId"      TEXT NOT NULL,
    "groundingProjectionSha256"      TEXT NOT NULL,
    "modelName"                      TEXT NOT NULL,
    "modelBackend"                   TEXT NOT NULL,
    "modelFormatEnforcer"            TEXT NOT NULL,
    "modalAppIdentity"               TEXT,
    "requestedByUserId"              TEXT,
    "requestedAt"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"                    TIMESTAMP(3),
    "executionStatus"                TEXT NOT NULL DEFAULT 'REQUESTED',
    "executionErrorCode"             TEXT,
    "executionErrorMessage"          TEXT,
    "inferenceMs"                    INTEGER,
    "promptTokenCount"               INTEGER,
    "outputTokenCount"               INTEGER,
    "gpuSeconds"                     NUMERIC(65,30),
    "createdAt"                      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrainingQuestionAiGenerationRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrainingQuestionAiGenerationRun"
  ADD CONSTRAINT "TrainingQuestionAiGenerationRun_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingQuestionAiGenerationRun_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingQuestionAiGenerationRun_courseVersionId_fkey"
    FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "TrainingQuestionAiGenerationRun_clubId_courseVersionId_requ_idx"
    ON "TrainingQuestionAiGenerationRun" ("clubId", "courseVersionId", "requestedAt");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiGenerationRun_clubId_requestedAt_idx"
    ON "TrainingQuestionAiGenerationRun" ("clubId", "requestedAt");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiGenerationRun_executionStatus_idx"
    ON "TrainingQuestionAiGenerationRun" ("executionStatus");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiGenerationRun_pilotAuthorizationId_idx"
    ON "TrainingQuestionAiGenerationRun" ("pilotAuthorizationId");

-- ═══════════════════════════════════════════════════════════════════
-- Section 2 — TrainingQuestionAiDraft
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "TrainingQuestionAiDraft" (
    "id"                             TEXT NOT NULL,
    "clubId"                         TEXT NOT NULL,
    "courseId"                       TEXT NOT NULL,
    "courseVersionId"                TEXT NOT NULL,
    "generationRunId"                TEXT,
    "draftJson"                      TEXT NOT NULL,
    "contentHash"                    TEXT NOT NULL,
    "sourceVideoSha256"              TEXT NOT NULL,
    "resolvedTranscriptBuildId"      TEXT NOT NULL,
    "groundingProjectionSha256"      TEXT NOT NULL,
    "pilotAuthorizationId"           TEXT NOT NULL,
    "pilotAuthorizationFingerprint"  TEXT NOT NULL,
    "state"                          TEXT NOT NULL DEFAULT 'GENERATED',
    "stateChangedAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stateChangedByUserId"           TEXT,
    "recordVersion"                  INTEGER NOT NULL DEFAULT 0,
    "supersedesDraftId"              TEXT,
    "generatedAt"                    TIMESTAMP(3) NOT NULL,
    "generatedByUserId"              TEXT,
    "createdAt"                      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrainingQuestionAiDraft_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrainingQuestionAiDraft"
  ADD CONSTRAINT "TrainingQuestionAiDraft_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingQuestionAiDraft_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingQuestionAiDraft_courseVersionId_fkey"
    FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingQuestionAiDraft_generationRunId_fkey"
    FOREIGN KEY ("generationRunId") REFERENCES "TrainingQuestionAiGenerationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingQuestionAiDraft_clubId_courseVersionId_contentHash_key"
    ON "TrainingQuestionAiDraft" ("clubId", "courseVersionId", "contentHash");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiDraft_clubId_courseVersionId_state_idx"
    ON "TrainingQuestionAiDraft" ("clubId", "courseVersionId", "state");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiDraft_clubId_state_generatedAt_idx"
    ON "TrainingQuestionAiDraft" ("clubId", "state", "generatedAt");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiDraft_clubId_generatedByUserId_idx"
    ON "TrainingQuestionAiDraft" ("clubId", "generatedByUserId");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiDraft_supersedesDraftId_idx"
    ON "TrainingQuestionAiDraft" ("supersedesDraftId");

-- ═══════════════════════════════════════════════════════════════════
-- Section 3 — TrainingQuestionAiValidation
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "TrainingQuestionAiValidation" (
    "id"                      TEXT NOT NULL,
    "clubId"                  TEXT NOT NULL,
    "draftId"                 TEXT NOT NULL,
    "draftContentHash"        TEXT NOT NULL,
    "validatorVersion"        TEXT NOT NULL,
    "validatorSource"         TEXT NOT NULL,
    "validatorModuleShaHex"   TEXT,
    "verdict"                 TEXT NOT NULL,
    "stage"                   TEXT NOT NULL,
    "errorsJson"              TEXT NOT NULL,
    "warningsJson"            TEXT NOT NULL,
    "flagsJson"               TEXT NOT NULL,
    "proposalJson"            TEXT,
    "errorCodeHistogram"      TEXT,
    "runAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runByUserId"             TEXT,
    "runByJobId"              TEXT,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingQuestionAiValidation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrainingQuestionAiValidation"
  ADD CONSTRAINT "TrainingQuestionAiValidation_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingQuestionAiValidation_draftId_fkey"
    FOREIGN KEY ("draftId") REFERENCES "TrainingQuestionAiDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "TrainingQuestionAiValidation_clubId_draftId_runAt_idx"
    ON "TrainingQuestionAiValidation" ("clubId", "draftId", "runAt");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiValidation_clubId_verdict_idx"
    ON "TrainingQuestionAiValidation" ("clubId", "verdict");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiValidation_draftContentHash_idx"
    ON "TrainingQuestionAiValidation" ("draftContentHash");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiValidation_draftId_draftContentHash_runAt_idx"
    ON "TrainingQuestionAiValidation" ("draftId", "draftContentHash", "runAt");

-- ═══════════════════════════════════════════════════════════════════
-- Section 4 — TrainingQuestionAiReview
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "TrainingQuestionAiReview" (
    "id"                 TEXT NOT NULL,
    "clubId"             TEXT NOT NULL,
    "draftId"            TEXT NOT NULL,
    "draftContentHash"   TEXT NOT NULL,
    "validationId"       TEXT,
    "disposition"        TEXT NOT NULL,
    "reviewerNote"       TEXT,
    "reviewedByUserId"   TEXT NOT NULL,
    "reviewedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingQuestionAiReview_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrainingQuestionAiReview"
  ADD CONSTRAINT "TrainingQuestionAiReview_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingQuestionAiReview_draftId_fkey"
    FOREIGN KEY ("draftId") REFERENCES "TrainingQuestionAiDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingQuestionAiReview_reviewedByUserId_fkey"
    FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingQuestionAiReview_validationId_fkey"
    FOREIGN KEY ("validationId") REFERENCES "TrainingQuestionAiValidation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "TrainingQuestionAiReview_clubId_disposition_idx"
    ON "TrainingQuestionAiReview" ("clubId", "disposition");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiReview_clubId_draftId_reviewedAt_idx"
    ON "TrainingQuestionAiReview" ("clubId", "draftId", "reviewedAt");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiReview_clubId_reviewedByUserId_reviewedAt_idx"
    ON "TrainingQuestionAiReview" ("clubId", "reviewedByUserId", "reviewedAt");

-- ═══════════════════════════════════════════════════════════════════
-- Section 5 — TrainingQuestionAiStateTransition
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "TrainingQuestionAiStateTransition" (
    "id"                   TEXT NOT NULL,
    "clubId"               TEXT NOT NULL,
    "draftId"              TEXT NOT NULL,
    "fromState"            TEXT,
    "toState"              TEXT NOT NULL,
    "reasonCode"           TEXT NOT NULL,
    "reasonDetail"         TEXT,
    "byUserId"             TEXT,
    "recordVersionBefore"  INTEGER NOT NULL,
    "recordVersionAfter"   INTEGER NOT NULL,
    "reviewId"             TEXT,
    "validationId"         TEXT,
    "metaJson"             TEXT,
    "occurredAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingQuestionAiStateTransition_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrainingQuestionAiStateTransition"
  ADD CONSTRAINT "TrainingQuestionAiStateTransition_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingQuestionAiStateTransition_draftId_fkey"
    FOREIGN KEY ("draftId") REFERENCES "TrainingQuestionAiDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingQuestionAiStateTransition_byUserId_fkey"
    FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "TrainingQuestionAiStateTransition_clubId_draftId_occurredAt_idx"
    ON "TrainingQuestionAiStateTransition" ("clubId", "draftId", "occurredAt");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiStateTransition_clubId_occurredAt_idx"
    ON "TrainingQuestionAiStateTransition" ("clubId", "occurredAt");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiStateTransition_clubId_toState_occurredAt_idx"
    ON "TrainingQuestionAiStateTransition" ("clubId", "toState", "occurredAt");

-- ═══════════════════════════════════════════════════════════════════
-- Section 6 — TrainingQuestionAiOperationKey
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "TrainingQuestionAiOperationKey" (
    "id"                  TEXT NOT NULL,
    "clubId"              TEXT NOT NULL,
    "draftId"             TEXT NOT NULL,
    "route"               TEXT NOT NULL,
    "requestKey"          TEXT NOT NULL,
    "reviewerUserId"      TEXT NOT NULL,
    "responseHttpStatus"  INTEGER NOT NULL,
    "responseBodyJson"    TEXT NOT NULL,
    "expiresAt"           TIMESTAMP(3) NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingQuestionAiOperationKey_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrainingQuestionAiOperationKey"
  ADD CONSTRAINT "TrainingQuestionAiOperationKey_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingQuestionAiOperationKey_draftId_fkey"
    FOREIGN KEY ("draftId") REFERENCES "TrainingQuestionAiDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingQuestionAiOperationKey_route_requestKey_reviewerUse_key"
    ON "TrainingQuestionAiOperationKey" ("route", "requestKey", "reviewerUserId", "draftId");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiOperationKey_draftId_idx"
    ON "TrainingQuestionAiOperationKey" ("draftId");
CREATE INDEX IF NOT EXISTS "TrainingQuestionAiOperationKey_clubId_expiresAt_idx"
    ON "TrainingQuestionAiOperationKey" ("clubId", "expiresAt");
