-- EP-TRAIN-6D-4K (2026-11-05) — Immutable Transcript Evidence Schema.
--
-- Additive-only. Three new tables (TrainingTranscriptBuild,
-- TrainingTranscriptSegment, TrainingGroundingProjection) + three
-- nullable columns on existing AI-review tables
-- (TrainingQuestionAiDraft.groundingProjectionId,
-- TrainingQuestionAiDraft.modelSelectedAnswerSnapshotJson,
-- TrainingQuestionAiValidation.verifiedCorrectAnswerSnapshotJson).
--
-- No existing row is modified. No existing table is altered beyond
-- the ADD COLUMN NULL statements below. Rollback: drop the three
-- new tables + drop the three new columns.
--
-- The three-table shape is a preflight correction of the EP-TRAIN-
-- 6D-4J two-table architecture, surfaced in PHASE-D-4K-SCHEMA-
-- DESIGN.md §2. Transcription-run metadata (transcriber name /
-- model / version / config SHA / produced-at) is lifted off the
-- segment row into TrainingTranscriptBuild so run-level identity
-- is single-sourced and immutable (per founder directive §4).

-- ═══════════════════════════════════════════════════════════════════
-- Section 1 — TrainingTranscriptBuild
-- ═══════════════════════════════════════════════════════════════════
-- One row per deterministic transcription run of a given source
-- video for a given tenant. Immutable after insert; re-transcription
-- produces a new resolvedTranscriptBuildId and therefore a new row.

CREATE TABLE "TrainingTranscriptBuild" (
    "id"                            TEXT NOT NULL PRIMARY KEY,
    "clubId"                        TEXT NOT NULL,
    "sourceVideoSha256"             TEXT NOT NULL,
    "resolvedTranscriptBuildId"     TEXT NOT NULL,
    "transcriberName"               TEXT NOT NULL,
    "transcriberVersion"            TEXT NOT NULL,
    "transcriberModelName"          TEXT NOT NULL,
    "transcriberModelVersion"       TEXT NOT NULL,
    "transcriberConfigSha256"       TEXT NOT NULL,
    "producedAt"                    DATETIME NOT NULL,
    "createdAt"                     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingTranscriptBuild_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "Club" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrainingTranscriptBuild_clubId_sourceVideoSha256_resolvedTranscriptBuildId_key"
    ON "TrainingTranscriptBuild"("clubId", "sourceVideoSha256", "resolvedTranscriptBuildId");
CREATE INDEX "TrainingTranscriptBuild_clubId_sourceVideoSha256_idx"
    ON "TrainingTranscriptBuild"("clubId", "sourceVideoSha256");
CREATE INDEX "TrainingTranscriptBuild_clubId_producedAt_idx"
    ON "TrainingTranscriptBuild"("clubId", "producedAt");

-- ═══════════════════════════════════════════════════════════════════
-- Section 2 — TrainingTranscriptSegment
-- ═══════════════════════════════════════════════════════════════════
-- One row per segment of a build. Immutable after insert.
-- startSec / endSec are DECIMAL. Range invariants enforced by the
-- CHECK constraint. segmentIndex is 0-based and matches the Lite
-- draft's sourceSegmentIds[].

CREATE TABLE "TrainingTranscriptSegment" (
    "id"                            TEXT NOT NULL PRIMARY KEY,
    "clubId"                        TEXT NOT NULL,
    "transcriptBuildId"             TEXT NOT NULL,
    "segmentIndex"                  INTEGER NOT NULL,
    "text"                          TEXT NOT NULL,
    "startSec"                      DECIMAL NOT NULL,
    "endSec"                        DECIMAL NOT NULL,
    "pendingReviewJson"             TEXT NOT NULL DEFAULT '[]',
    "sourceOrgMismatchJson"         TEXT NOT NULL DEFAULT '[]',
    "uncertaintyWarning"            TEXT,
    "createdAt"                     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingTranscriptSegment_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "Club" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingTranscriptSegment_transcriptBuildId_fkey"
        FOREIGN KEY ("transcriptBuildId") REFERENCES "TrainingTranscriptBuild" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingTranscriptSegment_segmentIndex_nonneg_chk"
        CHECK ("segmentIndex" >= 0),
    CONSTRAINT "TrainingTranscriptSegment_timestamps_chk"
        CHECK ("startSec" >= 0 AND "endSec" >= "startSec")
);
CREATE UNIQUE INDEX "TrainingTranscriptSegment_clubId_transcriptBuildId_segmentIndex_key"
    ON "TrainingTranscriptSegment"("clubId", "transcriptBuildId", "segmentIndex");
CREATE INDEX "TrainingTranscriptSegment_clubId_transcriptBuildId_idx"
    ON "TrainingTranscriptSegment"("clubId", "transcriptBuildId");

-- ═══════════════════════════════════════════════════════════════════
-- Section 3 — TrainingGroundingProjection
-- ═══════════════════════════════════════════════════════════════════
-- One row per immutable projection subset authorised for generation.
-- Linked back from TrainingQuestionAiDraft via groundingProjectionId.
-- The service layer asserts projection.sha256 == draft.groundingProjectionSha256
-- on every read; mismatch is a 500-class evidence-integrity failure.

CREATE TABLE "TrainingGroundingProjection" (
    "id"                              TEXT NOT NULL PRIMARY KEY,
    "clubId"                          TEXT NOT NULL,
    "courseVersionId"                 TEXT NOT NULL,
    "sha256"                          TEXT NOT NULL,
    "sourceVideoSha256"               TEXT NOT NULL,
    "resolvedTranscriptBuildId"       TEXT NOT NULL,
    "passagesJson"                    TEXT NOT NULL,
    "excludedPassagesJson"            TEXT NOT NULL DEFAULT '[]',
    "sourceOrgMismatchFlagsPresent"   BOOLEAN NOT NULL DEFAULT false,
    "pendingReviewPresent"            BOOLEAN NOT NULL DEFAULT false,
    "authoredAt"                      DATETIME NOT NULL,
    "createdAt"                       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingGroundingProjection_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "Club" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingGroundingProjection_courseVersionId_fkey"
        FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrainingGroundingProjection_clubId_courseVersionId_sha256_key"
    ON "TrainingGroundingProjection"("clubId", "courseVersionId", "sha256");
CREATE INDEX "TrainingGroundingProjection_clubId_courseVersionId_idx"
    ON "TrainingGroundingProjection"("clubId", "courseVersionId");
CREATE INDEX "TrainingGroundingProjection_clubId_sha256_idx"
    ON "TrainingGroundingProjection"("clubId", "sha256");

-- ═══════════════════════════════════════════════════════════════════
-- Section 4 — Nullable additive columns on TrainingQuestionAiDraft
-- ═══════════════════════════════════════════════════════════════════
-- Nullable so that every existing EP-TRAIN-6D-4H historical row stays
-- byte-perfect. New drafts written via the Modal path populate both
-- columns at generation time.

ALTER TABLE "TrainingQuestionAiDraft"
    ADD COLUMN "groundingProjectionId" TEXT
        REFERENCES "TrainingGroundingProjection" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrainingQuestionAiDraft"
    ADD COLUMN "modelSelectedAnswerSnapshotJson" TEXT;

CREATE INDEX "TrainingQuestionAiDraft_groundingProjectionId_idx"
    ON "TrainingQuestionAiDraft"("groundingProjectionId");

-- ═══════════════════════════════════════════════════════════════════
-- Section 5 — Nullable additive column on TrainingQuestionAiValidation
-- ═══════════════════════════════════════════════════════════════════
-- Set ONLY by the future approval route (EP-TRAIN-6D-4N) inside the
-- same DB transaction that advances the draft to APPROVED_DRAFT.
-- NULL on every REJECTED / REQUIRES_HUMAN_REVIEW / GENERATED /
-- EDITED_VALIDATION_STALE / VALIDATION_FAILED / ARCHIVED row. The
-- shape (JSON) binds optionIndex + optionText + verifiedByUserId +
-- verifiedAt + draftContentHash + validationId to the exact
-- immutable draft + validation version.

ALTER TABLE "TrainingQuestionAiValidation"
    ADD COLUMN "verifiedCorrectAnswerSnapshotJson" TEXT;
