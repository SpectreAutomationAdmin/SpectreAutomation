-- EP-TRAIN-4Y-J (2026-11-07) — Transcription-job active-uniqueness fix (Postgres).
-- Mirror of `prisma/migrations/20261107_ep_train_4y_j_transcription_active_uniqueness_fix/migration.sql`.
--
-- Rationale: see the SQLite migration. The 4V state-inclusive unique
-- blocks `recordJobFailed()` and `cancelTranscriptionJob()` when an
-- earlier terminal row already occupies the target state slot. This
-- defect surfaced live on staging during the 4Y-G/4Y-H/4Y-I pilot and
-- left one transcription job stuck in RUNNING (cmw733kz1000pu4sgxm8pjpqp).
--
-- The new partial unique index permits at most ONE row in the active
-- set (REQUESTED, QUEUED, RUNNING) per (clubId, courseVersionId,
-- sourceVideoSha256). Terminal rows (COMPLETED, FAILED, CANCELLED)
-- are unconstrained at the DB boundary — multiple FAILED and CANCELLED
-- rows are now allowed as retry history, and COMPLETED idempotency
-- remains enforced by the application layer (`requestTranscription`).
--
-- Additive-only on data. Index drop/create. Zero rows touched.
-- Rollback: restore the 4V migration's state-based unique index.
--
-- Precondition: inspection on staging on 2026-11-08 confirmed only
-- ONE active row (cmw733kz1 in RUNNING) for the Silver Springs pilot
-- video, so CREATE UNIQUE INDEX will not raise.
--
-- Safety: DO block pre-checks the active-row count per identity and
-- refuses the index creation if any duplicates would collide.

DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT "clubId", "courseVersionId", "sourceVideoSha256", COUNT(*) AS c
      FROM "TrainingTranscriptionJob"
      WHERE "state" IN ('REQUESTED', 'QUEUED', 'RUNNING')
      GROUP BY "clubId", "courseVersionId", "sourceVideoSha256"
      HAVING COUNT(*) > 1
  ) t;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'EP-TRAIN-4Y-J refused: % active-row conflict(s) exist. Inspect TrainingTranscriptionJob before re-running the migration.',
      dup_count;
  END IF;
END $$;

DROP INDEX IF EXISTS "TrainingTranscriptionJob_club_version_sha_state_key";

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingTranscriptionJob_active_club_version_sha_key"
    ON "TrainingTranscriptionJob" ("clubId", "courseVersionId", "sourceVideoSha256")
    WHERE "state" IN ('REQUESTED', 'QUEUED', 'RUNNING');
