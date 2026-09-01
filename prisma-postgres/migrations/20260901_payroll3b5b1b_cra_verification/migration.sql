-- Payroll-3B-5B-1b (2026-09-01)
-- TD1 source facts + allowance statutory-classification decouple.
-- Additive-only; existing rows remain valid.
--
-- Statutory-params Zod schema additions (base + first-additional
-- CPP components, published EI maxima) do NOT require a SQL
-- migration — paramsJson is a String column already.

ALTER TABLE "EmployeeTaxProfile"
  ADD COLUMN IF NOT EXISTS "additionalFederalTaxAmount"    DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "additionalProvincialTaxAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "claimZeroFederal"              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "claimZeroProvincial"           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "totalIncomeLessThanClaim"      BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "EmployeeAllowance"
  ADD COLUMN IF NOT EXISTS "pensionable" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "insurable"   BOOLEAN;

ALTER TABLE "PayrollBatchAllowanceSnapshot"
  ADD COLUMN IF NOT EXISTS "pensionable" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "insurable"   BOOLEAN;
