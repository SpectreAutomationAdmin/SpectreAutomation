-- Payroll-3B-5B-2 Pre-Calc Gate (2026-08-31) — opening-balance cutover boundary.
--
-- Adds `throughPayDate` to PayrollOpeningBalance so the YTD aggregator can
-- distinguish pre-cutover Spectre POSTED batches (which are already covered
-- by the opening balance and MUST NOT be re-counted) from post-cutover
-- Spectre POSTED batches (which contribute to YTD).
--
-- Nullable at the DB layer for additive forward-only compatibility. The
-- application layer REQUIRES the field for every new draft/validated/
-- active row (see src/lib/payroll/opening-balance.ts) and the YTD
-- aggregator REFUSES to aggregate an ACTIVE opening balance whose
-- throughPayDate is null (surfaces a BLOCKER — never silently assumes a
-- boundary).
--
-- Nothing has been deployed to staging or production, so no ACTIVE
-- opening-balance rows require backfill on this migration.

ALTER TABLE "PayrollOpeningBalance"
  ADD COLUMN "throughPayDate" TIMESTAMP(3);
