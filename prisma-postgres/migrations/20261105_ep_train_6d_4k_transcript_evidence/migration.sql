-- EP-TRAIN-6D-4K (2026-11-05) — Immutable Transcript Evidence Schema.
-- Postgres mirror of the SQLite migration at
-- `prisma/migrations/20261105_ep_train_6d_4k_transcript_evidence/migration.sql`.
--
-- Additive-only. Three new tables + three nullable columns on existing
-- AI-review tables. No existing row is touched. Rollback: drop the
-- three new tables and drop the three new columns.
--
-- The three-table shape is a preflight correction of the EP-TRAIN-
-- 6D-4J two-table architecture — see PHASE-D-4K-SCHEMA-DESIGN.md §2.
--
-- Authored for the Fly release_command. Not applied to staging or
-- production in this slice (6D-4K is offline / disposable-Postgres
-- only); the migration is on-disk ready for a separately-authorised
-- deploy slice.

-- ═══════════════════════════════════════════════════════════════════
-- Section 1 — TrainingTranscriptBuild
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "TrainingTranscriptBuild" (
    "id"                            TEXT NOT NULL,
    "clubId"                        TEXT NOT NULL,
    "sourceVideoSha256"             TEXT NOT NULL,
    "resolvedTranscriptBuildId"     TEXT NOT NULL,
    "transcriberName"               TEXT NOT NULL,
    "transcriberVersion"            TEXT NOT NULL,
    "transcriberModelName"          TEXT NOT NULL,
    "transcriberModelVersion"       TEXT NOT NULL,
    "transcriberConfigSha256"       TEXT NOT NULL,
    "producedAt"                    TIMESTAMP(3) NOT NULL,
    "createdAt"                     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingTranscriptBuild_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrainingTranscriptBuild"
  ADD CONSTRAINT "TrainingTranscriptBuild_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingTranscriptBuild_clubId_srcSha_bldId_key"
    ON "TrainingTranscriptBuild" ("clubId", "sourceVideoSha256", "resolvedTranscriptBuildId");
CREATE INDEX IF NOT EXISTS "TrainingTranscriptBuild_clubId_sourceVideoSha256_idx"
    ON "TrainingTranscriptBuild" ("clubId", "sourceVideoSha256");
CREATE INDEX IF NOT EXISTS "TrainingTranscriptBuild_clubId_producedAt_idx"
    ON "TrainingTranscriptBuild" ("clubId", "producedAt");

-- ═══════════════════════════════════════════════════════════════════
-- Section 2 — TrainingTranscriptSegment
-- ═══════════════════════════════════════════════════════════════════
-- startSec / endSec stored as NUMERIC with Prisma's default scale.
-- Range invariants (startSec >= 0, endSec >= startSec, segmentIndex >= 0)
-- are enforced by CHECK constraints.

CREATE TABLE IF NOT EXISTS "TrainingTranscriptSegment" (
    "id"                            TEXT NOT NULL,
    "clubId"                        TEXT NOT NULL,
    "transcriptBuildId"             TEXT NOT NULL,
    "segmentIndex"                  INTEGER NOT NULL,
    "text"                          TEXT NOT NULL,
    "startSec"                      NUMERIC(65,30) NOT NULL,
    "endSec"                        NUMERIC(65,30) NOT NULL,
    "pendingReviewJson"             TEXT NOT NULL DEFAULT '[]',
    "sourceOrgMismatchJson"         TEXT NOT NULL DEFAULT '[]',
    "uncertaintyWarning"            TEXT,
    "createdAt"                     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingTranscriptSegment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrainingTranscriptSegment_segmentIndex_nonneg_chk"
        CHECK ("segmentIndex" >= 0),
    CONSTRAINT "TrainingTranscriptSegment_timestamps_chk"
        CHECK ("startSec" >= 0 AND "endSec" >= "startSec")
);

ALTER TABLE "TrainingTranscriptSegment"
  ADD CONSTRAINT "TrainingTranscriptSegment_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingTranscriptSegment_transcriptBuildId_fkey"
    FOREIGN KEY ("transcriptBuildId") REFERENCES "TrainingTranscriptBuild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingTranscriptSegment_clubId_buildId_idx_key"
    ON "TrainingTranscriptSegment" ("clubId", "transcriptBuildId", "segmentIndex");
CREATE INDEX IF NOT EXISTS "TrainingTranscriptSegment_clubId_transcriptBuildId_idx"
    ON "TrainingTranscriptSegment" ("clubId", "transcriptBuildId");

-- ═══════════════════════════════════════════════════════════════════
-- Section 3 — TrainingGroundingProjection
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "TrainingGroundingProjection" (
    "id"                              TEXT NOT NULL,
    "clubId"                          TEXT NOT NULL,
    "courseVersionId"                 TEXT NOT NULL,
    "sha256"                          TEXT NOT NULL,
    "sourceVideoSha256"               TEXT NOT NULL,
    "resolvedTranscriptBuildId"       TEXT NOT NULL,
    "passagesJson"                    TEXT NOT NULL,
    "excludedPassagesJson"            TEXT NOT NULL DEFAULT '[]',
    "sourceOrgMismatchFlagsPresent"   BOOLEAN NOT NULL DEFAULT false,
    "pendingReviewPresent"            BOOLEAN NOT NULL DEFAULT false,
    "authoredAt"                      TIMESTAMP(3) NOT NULL,
    "createdAt"                       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingGroundingProjection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrainingGroundingProjection"
  ADD CONSTRAINT "TrainingGroundingProjection_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TrainingGroundingProjection_courseVersionId_fkey"
    FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingGroundingProjection_clubId_cvId_sha256_key"
    ON "TrainingGroundingProjection" ("clubId", "courseVersionId", "sha256");
CREATE INDEX IF NOT EXISTS "TrainingGroundingProjection_clubId_courseVersionId_idx"
    ON "TrainingGroundingProjection" ("clubId", "courseVersionId");
CREATE INDEX IF NOT EXISTS "TrainingGroundingProjection_clubId_sha256_idx"
    ON "TrainingGroundingProjection" ("clubId", "sha256");

-- ═══════════════════════════════════════════════════════════════════
-- Section 4 — Nullable additive columns on TrainingQuestionAiDraft
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "TrainingQuestionAiDraft"
    ADD COLUMN IF NOT EXISTS "groundingProjectionId" TEXT;

ALTER TABLE "TrainingQuestionAiDraft"
    ADD COLUMN IF NOT EXISTS "modelSelectedAnswerSnapshotJson" TEXT;

ALTER TABLE "TrainingQuestionAiDraft"
    ADD CONSTRAINT "TrainingQuestionAiDraft_groundingProjectionId_fkey"
        FOREIGN KEY ("groundingProjectionId") REFERENCES "TrainingGroundingProjection"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "TrainingQuestionAiDraft_groundingProjectionId_idx"
    ON "TrainingQuestionAiDraft" ("groundingProjectionId");

-- ═══════════════════════════════════════════════════════════════════
-- Section 5 — Nullable additive column on TrainingQuestionAiValidation
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "TrainingQuestionAiValidation"
    ADD COLUMN IF NOT EXISTS "verifiedCorrectAnswerSnapshotJson" TEXT;
