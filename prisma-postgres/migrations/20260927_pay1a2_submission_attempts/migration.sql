-- PAY-1A.2 (2026-09-26) — submission-attempt tracking on PaymentInstruction (Postgres).
-- Purely additive; no data migration.

ALTER TABLE "PaymentInstruction"
  ADD COLUMN "submissionAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastSubmissionAttemptAt" TIMESTAMP(3);
