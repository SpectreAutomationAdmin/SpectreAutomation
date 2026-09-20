-- CRPC-1 (2026-09-20) — period-boundary strategy for SEMI_MONTHLY pay groups.
-- Additive column; default CALENDAR_SEMI_MONTHLY preserves the shipped behaviour.
ALTER TABLE "PayrollPayGroup"
  ADD COLUMN "periodBoundaryStrategy" TEXT NOT NULL DEFAULT 'CALENDAR_SEMI_MONTHLY';
