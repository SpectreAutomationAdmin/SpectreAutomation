-- FPP-9A (2026-09-22) — Post-posted payroll reversal foundation.
--
-- Adds three fields + one self-relation FK to `PayrollBatch` so a
-- reversal of a POSTED payroll can be represented as a separate
-- immutable payroll transaction linked back to the original.
--
--   transactionType         "STANDARD" (default) | "REVERSAL"
--   reversesPayrollBatchId  FK to the original POSTED batch
--   reversalReason          persisted audit text
--
-- The original PayrollBatch, its per-employee frozen results, its
-- componentSnapshots, and its GL journal are NEVER mutated by a
-- reversal — a reversal creates NEW rows only.

ALTER TABLE "PayrollBatch"
  ADD COLUMN IF NOT EXISTS "transactionType" TEXT NOT NULL DEFAULT 'STANDARD';

ALTER TABLE "PayrollBatch"
  ADD COLUMN IF NOT EXISTS "reversesPayrollBatchId" TEXT;

ALTER TABLE "PayrollBatch"
  ADD COLUMN IF NOT EXISTS "reversalReason" TEXT;

-- Self-relation FK. Deliberately NOT ON DELETE CASCADE — a reversal
-- must never delete just because the original is deleted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PayrollBatch_reversesPayrollBatchId_fkey'
  ) THEN
    ALTER TABLE "PayrollBatch"
      ADD CONSTRAINT "PayrollBatch_reversesPayrollBatchId_fkey"
      FOREIGN KEY ("reversesPayrollBatchId") REFERENCES "PayrollBatch"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "PayrollBatch_reversesPayrollBatchId_idx"
  ON "PayrollBatch"("reversesPayrollBatchId");
