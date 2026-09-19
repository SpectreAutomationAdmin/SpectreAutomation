-- Slice F (2026-09-19) — Alberta ES default overtime policy
-- ---------------------------------------------------------
-- Adds:
--   1. PayrollClubConfig overtime policy columns (kind + thresholds +
--      multiplier + workweek anchor). Default: ALBERTA_DEFAULT_ES,
--      8-hour daily, 44-hour weekly greater-of, 1.5×, Sunday-anchored.
--   2. Employee.overtimePolicyState — per-employee treatment
--      (STANDARD | EXEMPT | AGREEMENT_REQUIRED | AVERAGING_REQUIRED).
--      Prepare Payroll fail-closes on the two "_REQUIRED" states so
--      unsupported arrangements cannot silently miscalculate.
--   3. PayrollBatchEmployee hourly-freeze snapshot columns — regular /
--      overtime hours, base rate, multiplier, derived OT rate, policy
--      kind, and workweek DOW frozen at Prepare time.
--
-- The overtime classifier (src/lib/payroll/overtime-classifier.ts)
-- reads the config columns; Prepare writes the snapshot columns.

-- 1. Overtime policy on PayrollClubConfig -----------------------------
ALTER TABLE "PayrollClubConfig"
  ADD COLUMN IF NOT EXISTS "overtimePolicyKind"           TEXT     NOT NULL DEFAULT 'ALBERTA_DEFAULT_ES',
  ADD COLUMN IF NOT EXISTS "overtimeDailyThresholdHours"  DECIMAL(65,30) NOT NULL DEFAULT 8.0,
  ADD COLUMN IF NOT EXISTS "overtimeWeeklyThresholdHours" DECIMAL(65,30) NOT NULL DEFAULT 44.0,
  ADD COLUMN IF NOT EXISTS "overtimeMultiplier"           DECIMAL(65,30) NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS "workweekStartDow"             INTEGER  NOT NULL DEFAULT 0;

-- 2. Overtime policy state per Employee -------------------------------
ALTER TABLE "Employee"
  ADD COLUMN IF NOT EXISTS "overtimePolicyState" TEXT NOT NULL DEFAULT 'STANDARD';

-- 3. Hourly overtime freeze on PayrollBatchEmployee -------------------
ALTER TABLE "PayrollBatchEmployee"
  ADD COLUMN IF NOT EXISTS "regularHoursSnapshot"       DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "overtimeHoursSnapshot"      DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "hourlyBaseRateSnapshot"     DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "overtimeMultiplierSnapshot" DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "overtimeRateSnapshot"       DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "overtimePolicyKindSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "workweekStartDowSnapshot"   INTEGER;
