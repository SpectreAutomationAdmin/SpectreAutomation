-- EP-TRAIN-6D-4B (2026-11-04) — AI Training Review Persistence Foundation.
--
-- Additive-only. No existing table is modified; no existing row is touched.
-- Six new tables support the manager-facing AI question-review workflow
-- designed in EP-TRAIN-6D-4A. Approved drafts are CANDIDATES for future
-- inclusion in a TrainingCourseVersion DRAFT — they are NEVER auto-
-- inserted into TrainingQuestion.
--
-- Rollback: dropping the six tables below removes the AI review
-- surface entirely; no other training table is affected.
--
-- Table order chosen so every foreign key references a previously-
-- created table (both existing tables and new tables in this file).

-- -------------------------------------------------------------------
-- Section 1 — TrainingQuestionAiGenerationRun
-- -------------------------------------------------------------------
-- Provenance of a single generation invocation. No credentials stored.
CREATE TABLE "TrainingQuestionAiGenerationRun" (
    "id"                            TEXT NOT NULL PRIMARY KEY,
    "clubId"                        TEXT NOT NULL,
    "courseId"                      TEXT NOT NULL,
    "courseVersionId"               TEXT NOT NULL,
    "pilotAuthorizationId"          TEXT NOT NULL,
    "pilotAuthorizationFingerprint" TEXT NOT NULL,
    "sourceVideoSha256"             TEXT NOT NULL,
    "resolvedTranscriptBuildId"     TEXT NOT NULL,
    "groundingProjectionSha256"     TEXT NOT NULL,
    "modelName"                     TEXT NOT NULL,
    "modelBackend"                  TEXT NOT NULL,
    "modelFormatEnforcer"           TEXT NOT NULL,
    "modalAppIdentity"              TEXT,
    "requestedByUserId"             TEXT,
    "requestedAt"                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"                   DATETIME,
    "executionStatus"               TEXT NOT NULL DEFAULT 'REQUESTED',
    "executionErrorCode"            TEXT,
    "executionErrorMessage"         TEXT,
    "inferenceMs"                   INTEGER,
    "promptTokenCount"              INTEGER,
    "outputTokenCount"              INTEGER,
    "gpuSeconds"                    DECIMAL,
    "createdAt"                     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                     DATETIME NOT NULL,
    CONSTRAINT "TrainingQuestionAiGenerationRun_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "Club" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiGenerationRun_courseId_fkey"
        FOREIGN KEY ("courseId") REFERENCES "TrainingCourse" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiGenerationRun_courseVersionId_fkey"
        FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "TrainingQuestionAiGenerationRun_clubId_requestedAt_idx"
    ON "TrainingQuestionAiGenerationRun"("clubId", "requestedAt");
CREATE INDEX "TrainingQuestionAiGenerationRun_clubId_courseVersionId_requestedAt_idx"
    ON "TrainingQuestionAiGenerationRun"("clubId", "courseVersionId", "requestedAt");
CREATE INDEX "TrainingQuestionAiGenerationRun_executionStatus_idx"
    ON "TrainingQuestionAiGenerationRun"("executionStatus");
CREATE INDEX "TrainingQuestionAiGenerationRun_pilotAuthorizationId_idx"
    ON "TrainingQuestionAiGenerationRun"("pilotAuthorizationId");

-- -------------------------------------------------------------------
-- Section 2 — TrainingQuestionAiDraft
-- -------------------------------------------------------------------
-- The immutable draft row. Edits produce a new row (new contentHash);
-- the superseded row transitions to ARCHIVED but is retained.
CREATE TABLE "TrainingQuestionAiDraft" (
    "id"                            TEXT NOT NULL PRIMARY KEY,
    "clubId"                        TEXT NOT NULL,
    "courseId"                      TEXT NOT NULL,
    "courseVersionId"               TEXT NOT NULL,
    "generationRunId"               TEXT,
    "draftJson"                     TEXT NOT NULL,
    "contentHash"                   TEXT NOT NULL,
    "sourceVideoSha256"             TEXT NOT NULL,
    "resolvedTranscriptBuildId"     TEXT NOT NULL,
    "groundingProjectionSha256"     TEXT NOT NULL,
    "pilotAuthorizationId"          TEXT NOT NULL,
    "pilotAuthorizationFingerprint" TEXT NOT NULL,
    "state"                         TEXT NOT NULL DEFAULT 'GENERATED',
    "stateChangedAt"                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stateChangedByUserId"          TEXT,
    "recordVersion"                 INTEGER NOT NULL DEFAULT 0,
    "supersedesDraftId"             TEXT,
    "generatedAt"                   DATETIME NOT NULL,
    "generatedByUserId"             TEXT,
    "createdAt"                     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                     DATETIME NOT NULL,
    CONSTRAINT "TrainingQuestionAiDraft_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "Club" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiDraft_courseId_fkey"
        FOREIGN KEY ("courseId") REFERENCES "TrainingCourse" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiDraft_courseVersionId_fkey"
        FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiDraft_generationRunId_fkey"
        FOREIGN KEY ("generationRunId") REFERENCES "TrainingQuestionAiGenerationRun" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);
-- A given canonical content body can only exist once per (club, version).
CREATE UNIQUE INDEX "TrainingQuestionAiDraft_clubId_courseVersionId_contentHash_key"
    ON "TrainingQuestionAiDraft"("clubId", "courseVersionId", "contentHash");
CREATE INDEX "TrainingQuestionAiDraft_clubId_courseVersionId_state_idx"
    ON "TrainingQuestionAiDraft"("clubId", "courseVersionId", "state");
CREATE INDEX "TrainingQuestionAiDraft_clubId_state_generatedAt_idx"
    ON "TrainingQuestionAiDraft"("clubId", "state", "generatedAt");
CREATE INDEX "TrainingQuestionAiDraft_clubId_generatedByUserId_idx"
    ON "TrainingQuestionAiDraft"("clubId", "generatedByUserId");
CREATE INDEX "TrainingQuestionAiDraft_supersedesDraftId_idx"
    ON "TrainingQuestionAiDraft"("supersedesDraftId");

-- -------------------------------------------------------------------
-- Section 3 — TrainingQuestionAiValidation
-- -------------------------------------------------------------------
-- Append-only. Every pipeline run against a draft produces one row.
-- The guard refuses approval unless draftContentHash == draft.contentHash.
CREATE TABLE "TrainingQuestionAiValidation" (
    "id"                      TEXT NOT NULL PRIMARY KEY,
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
    "runAt"                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runByUserId"             TEXT,
    "runByJobId"              TEXT,
    "createdAt"               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingQuestionAiValidation_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "Club" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiValidation_draftId_fkey"
        FOREIGN KEY ("draftId") REFERENCES "TrainingQuestionAiDraft" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TrainingQuestionAiValidation_clubId_draftId_runAt_idx"
    ON "TrainingQuestionAiValidation"("clubId", "draftId", "runAt");
CREATE INDEX "TrainingQuestionAiValidation_draftId_draftContentHash_runAt_idx"
    ON "TrainingQuestionAiValidation"("draftId", "draftContentHash", "runAt");
CREATE INDEX "TrainingQuestionAiValidation_clubId_verdict_idx"
    ON "TrainingQuestionAiValidation"("clubId", "verdict");
CREATE INDEX "TrainingQuestionAiValidation_draftContentHash_idx"
    ON "TrainingQuestionAiValidation"("draftContentHash");

-- -------------------------------------------------------------------
-- Section 4 — TrainingQuestionAiReview
-- -------------------------------------------------------------------
-- Append-only reviewer-decision events.
CREATE TABLE "TrainingQuestionAiReview" (
    "id"                 TEXT NOT NULL PRIMARY KEY,
    "clubId"             TEXT NOT NULL,
    "draftId"            TEXT NOT NULL,
    "draftContentHash"   TEXT NOT NULL,
    "validationId"       TEXT,
    "disposition"        TEXT NOT NULL,
    "reviewerNote"       TEXT,
    "reviewedByUserId"   TEXT NOT NULL,
    "reviewedAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingQuestionAiReview_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "Club" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiReview_draftId_fkey"
        FOREIGN KEY ("draftId") REFERENCES "TrainingQuestionAiDraft" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiReview_validationId_fkey"
        FOREIGN KEY ("validationId") REFERENCES "TrainingQuestionAiValidation" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiReview_reviewedByUserId_fkey"
        FOREIGN KEY ("reviewedByUserId") REFERENCES "User" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "TrainingQuestionAiReview_clubId_draftId_reviewedAt_idx"
    ON "TrainingQuestionAiReview"("clubId", "draftId", "reviewedAt");
CREATE INDEX "TrainingQuestionAiReview_clubId_reviewedByUserId_reviewedAt_idx"
    ON "TrainingQuestionAiReview"("clubId", "reviewedByUserId", "reviewedAt");
CREATE INDEX "TrainingQuestionAiReview_clubId_disposition_idx"
    ON "TrainingQuestionAiReview"("clubId", "disposition");

-- -------------------------------------------------------------------
-- Section 5 — TrainingQuestionAiStateTransition
-- -------------------------------------------------------------------
-- AUTHORITATIVE, append-only lifecycle history. Written in the SAME
-- database transaction as the corresponding state change on
-- TrainingQuestionAiDraft (see src/lib/hr/training/ai-review/
-- transactional-audit.ts :: writeStateTransition). If this insert
-- fails, the enclosing transaction rolls back and the draft stays
-- unchanged. This is the authoritative state-history record.
CREATE TABLE "TrainingQuestionAiStateTransition" (
    "id"                   TEXT NOT NULL PRIMARY KEY,
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
    "occurredAt"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingQuestionAiStateTransition_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "Club" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiStateTransition_draftId_fkey"
        FOREIGN KEY ("draftId") REFERENCES "TrainingQuestionAiDraft" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiStateTransition_byUserId_fkey"
        FOREIGN KEY ("byUserId") REFERENCES "User" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "TrainingQuestionAiStateTransition_clubId_draftId_occurredAt_idx"
    ON "TrainingQuestionAiStateTransition"("clubId", "draftId", "occurredAt");
CREATE INDEX "TrainingQuestionAiStateTransition_clubId_occurredAt_idx"
    ON "TrainingQuestionAiStateTransition"("clubId", "occurredAt");
CREATE INDEX "TrainingQuestionAiStateTransition_clubId_toState_occurredAt_idx"
    ON "TrainingQuestionAiStateTransition"("clubId", "toState", "occurredAt");

-- -------------------------------------------------------------------
-- Section 6 — TrainingQuestionAiOperationKey
-- -------------------------------------------------------------------
-- Durable idempotency row — §2.5 approved governance. Compound UNIQUE
-- (route, requestKey, reviewerUserId, draftId) is the database-level
-- de-duplication guarantee for replay-within-TTL semantics.
CREATE TABLE "TrainingQuestionAiOperationKey" (
    "id"                   TEXT NOT NULL PRIMARY KEY,
    "clubId"               TEXT NOT NULL,
    "draftId"              TEXT NOT NULL,
    "route"                TEXT NOT NULL,
    "requestKey"           TEXT NOT NULL,
    "reviewerUserId"       TEXT NOT NULL,
    "responseHttpStatus"   INTEGER NOT NULL,
    "responseBodyJson"     TEXT NOT NULL,
    "expiresAt"            DATETIME NOT NULL,
    "createdAt"            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingQuestionAiOperationKey_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "Club" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiOperationKey_draftId_fkey"
        FOREIGN KEY ("draftId") REFERENCES "TrainingQuestionAiDraft" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrainingQuestionAiOperationKey_route_requestKey_reviewerUserId_draftId_key"
    ON "TrainingQuestionAiOperationKey"("route", "requestKey", "reviewerUserId", "draftId");
CREATE INDEX "TrainingQuestionAiOperationKey_clubId_expiresAt_idx"
    ON "TrainingQuestionAiOperationKey"("clubId", "expiresAt");
CREATE INDEX "TrainingQuestionAiOperationKey_draftId_idx"
    ON "TrainingQuestionAiOperationKey"("draftId");
