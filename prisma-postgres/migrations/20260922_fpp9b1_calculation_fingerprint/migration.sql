-- FPP-9B.1 (2026-09-22) — calculation fingerprint column.
-- Nullable, additive, idempotent. No historical data mutated.

ALTER TABLE "PayrollBatch"
  ADD COLUMN IF NOT EXISTS "calculationFingerprint" TEXT;

CREATE INDEX IF NOT EXISTS "PayrollBatch_calculationFingerprint_idx"
  ON "PayrollBatch"("calculationFingerprint");
