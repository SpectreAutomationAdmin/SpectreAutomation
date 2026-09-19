-- Slice D (2026-09-19) — RRSP employer-match provenance on the
-- component snapshot. Nullable Int columns; populated ONLY on the
-- EMPLOYER-side snapshot of an RRSP-shaped enrolment. NULL on every
-- non-RRSP snapshot (LTD, Health, one-time earnings, recurring
-- components).

ALTER TABLE "PayrollBatchComponentSnapshot"
  ADD COLUMN "matchBps"    INTEGER,
  ADD COLUMN "matchCapBps" INTEGER;
