-- Payroll-3C-6 (2026-09-05) — component-aware GL mapping.
-- Additive migration only: two new nullable columns on
-- PayrollComponent (live catalogue mapping), two matching
-- snapshot columns on PayrollBatchComponentSnapshot (frozen at
-- PREPARE time), and the FK constraints back to Account.

-- ============================================================
-- PayrollComponent — live catalogue GL mapping
-- ============================================================
ALTER TABLE "PayrollComponent"
  ADD COLUMN "expenseAccountId"   TEXT,
  ADD COLUMN "liabilityAccountId" TEXT;

ALTER TABLE "PayrollComponent"
  ADD CONSTRAINT "PayrollComponent_expenseAccountId_fkey"
  FOREIGN KEY ("expenseAccountId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayrollComponent"
  ADD CONSTRAINT "PayrollComponent_liabilityAccountId_fkey"
  FOREIGN KEY ("liabilityAccountId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PayrollComponent_expenseAccountId_idx"
  ON "PayrollComponent"("expenseAccountId");
CREATE INDEX "PayrollComponent_liabilityAccountId_idx"
  ON "PayrollComponent"("liabilityAccountId");

-- ============================================================
-- PayrollBatchComponentSnapshot — frozen GL mapping
-- ============================================================
-- No FK: snapshot fields are id-only strings so a later Account
-- rename / archive cannot mutate historical journal descriptions.
-- Account validity at post time is enforced by the GL readiness
-- evaluator, not by the schema.
ALTER TABLE "PayrollBatchComponentSnapshot"
  ADD COLUMN "expenseAccountIdSnapshot"   TEXT,
  ADD COLUMN "liabilityAccountIdSnapshot" TEXT;
