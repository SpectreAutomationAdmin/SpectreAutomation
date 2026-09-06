-- Payroll-3C-3 (2026-09-08) — directional statutory effects on
-- PayrollComponent + PayrollBatchComponentSnapshot; explicit
-- eligible-earnings basis for PERCENT_OF_ELIGIBLE_EARNINGS.
--
-- Migration semantics (§4 of 3C-3 brief):
--   affectsX = true  → xxxEffect = 'ADD'
--   affectsX = false → xxxEffect = 'NONE'
--   Nothing is auto-migrated to 'SUBTRACT'.
--
-- 3C is unreleased and local-only; the boolean columns are dropped
-- after the enum-style String columns are populated. Legacy models
-- (EmployeeAllowance / PayrollBatchAllowanceSnapshot / PayrollBenefit
-- / PayrollDeduction) are untouched.

-- PayrollComponent -----------------------------------------------------
ALTER TABLE "PayrollComponent" ADD COLUMN "taxableEffect"        TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "PayrollComponent" ADD COLUMN "cppPensionableEffect" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "PayrollComponent" ADD COLUMN "eiInsurableEffect"    TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "PayrollComponent" ADD COLUMN "eligibleEarningsBase" TEXT;

UPDATE "PayrollComponent" SET "taxableEffect"        = 'ADD' WHERE "affectsTaxable"        = true;
UPDATE "PayrollComponent" SET "cppPensionableEffect" = 'ADD' WHERE "affectsCppPensionable" = true;
UPDATE "PayrollComponent" SET "eiInsurableEffect"    = 'ADD' WHERE "affectsEiInsurable"    = true;

ALTER TABLE "PayrollComponent" DROP COLUMN "affectsTaxable";
ALTER TABLE "PayrollComponent" DROP COLUMN "affectsCppPensionable";
ALTER TABLE "PayrollComponent" DROP COLUMN "affectsEiInsurable";

-- PayrollBatchComponentSnapshot ---------------------------------------
ALTER TABLE "PayrollBatchComponentSnapshot" ADD COLUMN "taxableEffect"          TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "PayrollBatchComponentSnapshot" ADD COLUMN "cppPensionableEffect"   TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "PayrollBatchComponentSnapshot" ADD COLUMN "eiInsurableEffect"      TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "PayrollBatchComponentSnapshot" ADD COLUMN "eligibleEarningsBase"   TEXT;
ALTER TABLE "PayrollBatchComponentSnapshot" ADD COLUMN "eligibleEarningsAmount" DECIMAL(65,30);

UPDATE "PayrollBatchComponentSnapshot" SET "taxableEffect"        = 'ADD' WHERE "affectsTaxable"        = true;
UPDATE "PayrollBatchComponentSnapshot" SET "cppPensionableEffect" = 'ADD' WHERE "affectsCppPensionable" = true;
UPDATE "PayrollBatchComponentSnapshot" SET "eiInsurableEffect"    = 'ADD' WHERE "affectsEiInsurable"    = true;

ALTER TABLE "PayrollBatchComponentSnapshot" DROP COLUMN "affectsTaxable";
ALTER TABLE "PayrollBatchComponentSnapshot" DROP COLUMN "affectsCppPensionable";
ALTER TABLE "PayrollBatchComponentSnapshot" DROP COLUMN "affectsEiInsurable";
