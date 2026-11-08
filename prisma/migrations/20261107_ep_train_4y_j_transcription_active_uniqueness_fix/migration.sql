-- EP-TRAIN-4Y-J (2026-11-07) — Transcription-job active-uniqueness fix.
--
-- Rationale: the 4V migration created a 4-column unique index
-- `TrainingTranscriptionJob_club_version_sha_state_key` that includes
-- "state". That constraint lets two rows with the same identity but
-- DIFFERENT terminal states (e.g. one FAILED and one CANCELLED) coexist —
-- but it ALSO blocks a second transition into a terminal state when
-- that slot is already occupied. Concretely, a worker trying to
-- `recordJobFailed()` raises Prisma P2002 when an earlier FAILED row
-- already exists for the same (clubId, courseVersionId, sourceVideoSha256).
--
-- This defect was observed live on staging on 2026-11-08 during the
-- EP-TRAIN-4Y-G pilot (REQUEST_BODY_INVALID surfaced from a Modal boot
-- ModuleNotFoundError), leaving cmw733kz1000pu4sgxm8pjpqp stuck in
-- RUNNING state at attempts=2=maxAttempts because `recordJobFailed()`
-- hit P2002 on the (…, state='FAILED') slot that cmw72y0zb000du4sg6t7l7g7g
-- already occupied.
--
-- Correction: drop "state" from the unique key, keep it only in the
-- partial WHERE as an IN-list over non-terminal (active) states.
-- Now the DB enforces "at most ONE live (REQUESTED/QUEUED/RUNNING) row
-- per (clubId, courseVersionId, sourceVideoSha256)". Terminal rows
-- (COMPLETED/FAILED/CANCELLED) remain unrestricted, so a failed,
-- cancelled, OR completed record can coexist with later retries of
-- the same video without blocking terminal-state transitions.
--
-- This mirrors the 2026-11-06 EP-TRAIN-6D-4X correction to the sibling
-- table TrainingQuestionAiGenerationRun.
--
-- Additive-only on data. Index drop/create. Zero rows touched.
-- Rollback: restore the 4V migration's state-based unique index.
--
-- Precondition: there must be AT MOST one row per
-- (clubId, courseVersionId, sourceVideoSha256) in the active set
-- (REQUESTED, QUEUED, RUNNING). Verified on staging on 2026-11-08
-- (only cmw733kz1 in RUNNING for the Silver Springs pilot video).
-- SQLite's CREATE UNIQUE INDEX will raise if duplicates exist.

DROP INDEX IF EXISTS "TrainingTranscriptionJob_club_version_sha_state_key";

CREATE UNIQUE INDEX "TrainingTranscriptionJob_active_club_version_sha_key"
    ON "TrainingTranscriptionJob" ("clubId", "courseVersionId", "sourceVideoSha256")
    WHERE "state" IN ('REQUESTED', 'QUEUED', 'RUNNING');
