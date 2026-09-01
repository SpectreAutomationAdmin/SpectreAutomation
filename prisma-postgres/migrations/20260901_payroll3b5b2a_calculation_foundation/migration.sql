-- Payroll-3B-5B-2a Gross-to-Net Calculator Foundation (2026-08-31).
--
-- Additive forward-only migration. All new columns are nullable
-- (Decimal / DateTime / String) or take a safe integer default,
-- so no data-loss risk on existing rows.
--
-- Scope:
--   PayrollBatch — calculation provenance (calculatedAt,
--     calculationVersion, algorithmVersion, packageChecksum).
--     Status enum comment extended to include CALCULATED between
--     PREPARED and SUBMITTED_FOR_APPROVAL; the string column itself
--     already permits any value, so no ALTER TYPE required.
--   PayrollBatchEmployee — additional persisted statutory result
--     fields the calculator will populate at CALCULATED:
--       deductionCppEeCombined  = base + first-additional (T4 Box 16)
--       employerCppCombined     = employer equivalent
--       additionalFederalTax    = TD1 additional withholding (kept
--                                 separate from base statutory tax per
--                                 T4127 + PDOC Scenario 3)
--       additionalProvincialTax = Alberta equivalent
--       totalEmployeeDeductions = paystub reconciliation convenience
--       ytdSnapshotJson         = frozen YTD state at calculation time
--                                 (result stays explainable even after
--                                 opening-balance or POSTED-batch
--                                 corrections land later)
--
-- Zero calculator arithmetic ships in 3B-5B-2a; these columns exist
-- ahead of the 3B-5B-2b/2c calculator to prevent future writes from
-- needing schema-drift PRs.

ALTER TABLE "PayrollBatch"
  ADD COLUMN "calculatedAt"       TIMESTAMP(3),
  ADD COLUMN "calculationVersion" INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN "algorithmVersion"   TEXT,
  ADD COLUMN "packageChecksum"    TEXT;

ALTER TABLE "PayrollBatchEmployee"
  ADD COLUMN "deductionCppEeCombined"  DECIMAL(65,30),
  ADD COLUMN "employerCppCombined"     DECIMAL(65,30),
  ADD COLUMN "additionalFederalTax"    DECIMAL(65,30),
  ADD COLUMN "additionalProvincialTax" DECIMAL(65,30),
  ADD COLUMN "totalEmployeeDeductions" DECIMAL(65,30),
  ADD COLUMN "ytdSnapshotJson"         TEXT;
