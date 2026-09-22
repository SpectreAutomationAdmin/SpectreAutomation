-- FPP-9B (2026-09-22) — Reverse & Correct chain.
-- Adds three nullable columns + two indexes + two self-FKs to PayrollBatch.
-- Fully additive; safe for existing POSTED payrolls (all new columns are nullable).

ALTER TABLE "PayrollBatch"
  ADD COLUMN IF NOT EXISTS "correctsPayrollBatchId" TEXT,
  ADD COLUMN IF NOT EXISTS "pairedReversalBatchId"  TEXT,
  ADD COLUMN IF NOT EXISTS "correctionReason"       TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PayrollBatch_correctsPayrollBatchId_fkey'
  ) THEN
    ALTER TABLE "PayrollBatch"
      ADD CONSTRAINT "PayrollBatch_correctsPayrollBatchId_fkey"
      FOREIGN KEY ("correctsPayrollBatchId") REFERENCES "PayrollBatch"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PayrollBatch_pairedReversalBatchId_fkey'
  ) THEN
    ALTER TABLE "PayrollBatch"
      ADD CONSTRAINT "PayrollBatch_pairedReversalBatchId_fkey"
      FOREIGN KEY ("pairedReversalBatchId") REFERENCES "PayrollBatch"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "PayrollBatch_correctsPayrollBatchId_idx"
  ON "PayrollBatch"("correctsPayrollBatchId");

CREATE INDEX IF NOT EXISTS "PayrollBatch_pairedReversalBatchId_idx"
  ON "PayrollBatch"("pairedReversalBatchId");
