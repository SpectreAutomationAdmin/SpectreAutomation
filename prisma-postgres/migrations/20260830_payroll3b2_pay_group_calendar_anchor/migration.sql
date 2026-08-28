-- Payroll-3B-2 (2026-08-28) — add a nullable calendar anchor to
-- PayrollPayGroup. Payroll-3A shipped without one; adding it here as
-- a forward-only, non-destructive migration.
--
-- Nullable is deliberate: existing Pay Groups (if any) migrate cleanly
-- without Spectre inventing dates for them. Generation refuses when
-- the frequency requires an anchor (WEEKLY / BIWEEKLY) and none is
-- set, surfacing an actionable validation error to the admin instead.
--
-- Semi-monthly and monthly cadences are anchor-agnostic (calendar-rule
-- driven), so a Pay Group in those modes can generate pay periods
-- without ever setting a calendar anchor.

ALTER TABLE "PayrollPayGroup"
  ADD COLUMN IF NOT EXISTS "calendarAnchorDate" TIMESTAMP(3);
