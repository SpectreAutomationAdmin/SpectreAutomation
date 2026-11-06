-- EP-TRAIN-6D-4V (2026-11-06) — Transcription-job lifecycle sidecar.
-- Postgres mirror of `prisma/migrations/20261106_ep_train_6d_4v_transcription_job/migration.sql`.
--
-- Additive-only. Zero changes to any existing production entity.
-- Not applied to staging or production in this slice.

CREATE TABLE IF NOT EXISTS "TrainingTranscriptionJob" (
    "id"                                TEXT NOT NULL,
    "clubId"                            TEXT NOT NULL,

    "courseVersionId"                   TEXT NOT NULL,
    "sourceVideoSha256"                 TEXT NOT NULL,

    "state"                             TEXT NOT NULL DEFAULT 'REQUESTED',

    "leaseToken"                        TEXT,
    "leaseExpiresAt"                    TIMESTAMP(3),

    "requestedAt"                       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedAt"                          TIMESTAMP(3),
    "startedAt"                         TIMESTAMP(3),
    "completedAt"                       TIMESTAMP(3),
    "cancelledAt"                       TIMESTAMP(3),

    "attempts"                          INTEGER NOT NULL DEFAULT 0,
    "maxAttempts"                       INTEGER NOT NULL DEFAULT 2,

    "modelVariant"                      TEXT,
    "elapsedMsTotal"                    INTEGER,
    "elapsedMsColdBoot"                 INTEGER,
    "elapsedMsTranscribe"               INTEGER,
    "estimatedCostUsdMicros"            INTEGER,

    "failureCode"                       TEXT,
    "failureMessage"                    TEXT,

    "requestedByUserId"                 TEXT,
    "cancelledByUserId"                 TEXT,

    "resolvedTranscriptBuildId"         TEXT,

    "createdAt"                         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingTranscriptionJob_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrainingTranscriptionJob"
  ADD CONSTRAINT "TrainingTranscriptionJob_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrainingTranscriptionJob"
  ADD CONSTRAINT "TrainingTranscriptionJob_courseVersionId_fkey"
    FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrainingTranscriptionJob"
  ADD CONSTRAINT "TrainingTranscriptionJob_resolvedTranscriptBuildId_fkey"
    FOREIGN KEY ("resolvedTranscriptBuildId") REFERENCES "TrainingTranscriptBuild"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingTranscriptionJob_club_version_sha_state_key"
    ON "TrainingTranscriptionJob" ("clubId", "courseVersionId", "sourceVideoSha256", "state");

CREATE INDEX IF NOT EXISTS "TrainingTranscriptionJob_clubId_state_requestedAt_idx"
    ON "TrainingTranscriptionJob" ("clubId", "state", "requestedAt");

CREATE INDEX IF NOT EXISTS "TrainingTranscriptionJob_clubId_courseVersionId_state_idx"
    ON "TrainingTranscriptionJob" ("clubId", "courseVersionId", "state");

CREATE INDEX IF NOT EXISTS "TrainingTranscriptionJob_state_leaseExpiresAt_idx"
    ON "TrainingTranscriptionJob" ("state", "leaseExpiresAt");
