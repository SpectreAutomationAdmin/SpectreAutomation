-- EP-TRAIN-6D-4V (2026-11-06) — Transcription-job lifecycle sidecar.
--
-- Additive-only. ONE new table + four indexes. Zero changes to any
-- existing production entity. Rollback: DROP TABLE on this one table.
--
-- Founder-authorised on 2026-11-06 with eight explicit requirements.
-- See docs/training/ai-generation/PHASE-D-4V-TRANSCRIPTION-DESIGN.md.
--
-- Includes requirement #3's bounded-lease columns (leaseToken +
-- leaseExpiresAt) for stale-lease recovery.

CREATE TABLE "TrainingTranscriptionJob" (
    "id"                                TEXT NOT NULL PRIMARY KEY,
    "clubId"                            TEXT NOT NULL,

    -- Target.
    "courseVersionId"                   TEXT NOT NULL,
    "sourceVideoSha256"                 TEXT NOT NULL,

    -- State machine.
    --   REQUESTED  — created, not yet enqueued
    --   QUEUED     — enqueued into bin/worker.ts
    --   RUNNING    — a worker has claimed the job (holds lease)
    --   COMPLETED  — Modal returned success, 4L persistence succeeded,
    --                integrity verified, resolvedTranscriptBuildId set
    --   FAILED     — bounded retries exhausted or a non-retryable
    --                failure code fired
    --   CANCELLED  — operator cancellation OR system cancellation
    --                (credential absence, cost-cap refusal). A late
    --                provider response MUST NOT flip CANCELLED to
    --                COMPLETED — the worker checks state before each
    --                mutation.
    "state"                             TEXT NOT NULL DEFAULT 'REQUESTED',

    -- Bounded-lease fields (founder requirement #3). A worker claims a
    -- QUEUED job by setting (leaseToken, leaseExpiresAt). A separate
    -- worker may reclaim a RUNNING job whose leaseExpiresAt has passed
    -- (stale lease), incrementing attempts. A COMPLETED / FAILED /
    -- CANCELLED job never carries a non-null lease.
    "leaseToken"                        TEXT,
    "leaseExpiresAt"                    DATETIME,

    -- Lifecycle timestamps.
    "requestedAt"                       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedAt"                          DATETIME,
    "startedAt"                         DATETIME,
    "completedAt"                       DATETIME,
    "cancelledAt"                       DATETIME,

    -- Bounded retry budget. Service-layer enforced.
    "attempts"                          INTEGER NOT NULL DEFAULT 0,
    "maxAttempts"                       INTEGER NOT NULL DEFAULT 2,

    -- Cost-governance snapshot. Populated at COMPLETED time from the
    -- Modal response's elapsedMs + Spectre-side rate × elapsed math.
    "modelVariant"                      TEXT,
    "elapsedMsTotal"                    INTEGER,
    "elapsedMsColdBoot"                 INTEGER,
    "elapsedMsTranscribe"               INTEGER,
    "estimatedCostUsdMicros"            INTEGER,

    -- Failure classification. Populated at FAILED time.
    --   MODAL_HTTP_ERROR      — non-2xx response
    --   MODAL_TIMEOUT         — AbortController fired
    --   MODAL_HMAC_INVALID    — response HMAC did not verify
    --   SHA_MISMATCH          — Modal response sha != stored sha
    --   INGEST_FAILED         — 4L persistence raised
    --   CREDENTIAL_ABSENT     — Fly secrets missing at run time
    --   COST_CAP_EXCEEDED     — tenant-day cap refused acceptance
    --   INTEGRITY_FAILURE     — transcript integrity check refused
    "failureCode"                       TEXT,
    "failureMessage"                    TEXT,

    -- Audit attribution.
    "requestedByUserId"                 TEXT,
    "cancelledByUserId"                 TEXT,

    -- FK: on COMPLETED, links the 4L-written TrainingTranscriptBuild.
    "resolvedTranscriptBuildId"         TEXT,

    "createdAt"                         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                         DATETIME NOT NULL,

    CONSTRAINT "TrainingTranscriptionJob_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingTranscriptionJob_courseVersionId_fkey"
        FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingTranscriptionJob_resolvedTranscriptBuildId_fkey"
        FOREIGN KEY ("resolvedTranscriptBuildId") REFERENCES "TrainingTranscriptBuild"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- At most ONE job per (club, courseVersion, sourceVideoSha256, state) —
-- the service layer forbids creating a REQUESTED/QUEUED/RUNNING row
-- when any non-terminal row already exists, so multiple FAILED or
-- CANCELLED rows are allowed (for retry history) but only one live
-- row at a time.
CREATE UNIQUE INDEX "TrainingTranscriptionJob_club_version_sha_state_key"
    ON "TrainingTranscriptionJob" ("clubId", "courseVersionId", "sourceVideoSha256", "state");

CREATE INDEX "TrainingTranscriptionJob_clubId_state_requestedAt_idx"
    ON "TrainingTranscriptionJob" ("clubId", "state", "requestedAt");

CREATE INDEX "TrainingTranscriptionJob_clubId_courseVersionId_state_idx"
    ON "TrainingTranscriptionJob" ("clubId", "courseVersionId", "state");

-- For the stale-lease sweeper: find RUNNING jobs whose lease has
-- expired OR QUEUED jobs waiting to be claimed.
CREATE INDEX "TrainingTranscriptionJob_state_leaseExpiresAt_idx"
    ON "TrainingTranscriptionJob" ("state", "leaseExpiresAt");
