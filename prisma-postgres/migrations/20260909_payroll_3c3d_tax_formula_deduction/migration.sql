-- Payroll-3C-3D (2026-09-09) — T4127 tax-formula deduction input.
--
-- Adds `taxFormulaDeductionType` to PayrollComponent (live catalogue)
-- and PayrollBatchComponentSnapshot (frozen at PREPARE time). A
-- non-null value routes the component's resolved amount into the F
-- input of the federal + provincial tax calculators, matching CRA
-- T4127 semantics for RRSP contributions deducted at source. The
-- taxable / CPP / EI bases are NOT altered — those are separate
-- statutory-remuneration dimensions.

ALTER TABLE "PayrollComponent"
  ADD COLUMN "taxFormulaDeductionType" TEXT;

ALTER TABLE "PayrollBatchComponentSnapshot"
  ADD COLUMN "taxFormulaDeductionType" TEXT;
