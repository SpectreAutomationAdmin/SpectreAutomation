-- PAY-1A.2 (2026-09-26) — submission-attempt tracking on PaymentInstruction (SQLite).

ALTER TABLE "PaymentInstruction" ADD COLUMN "submissionAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PaymentInstruction" ADD COLUMN "lastSubmissionAttemptAt" DATETIME;
