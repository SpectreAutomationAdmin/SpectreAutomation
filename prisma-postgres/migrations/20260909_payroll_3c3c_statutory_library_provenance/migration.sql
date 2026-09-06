-- Payroll-3C-3C (2026-09-09) — SPECTRE_LIBRARY rule provenance.
--
-- Additive columns on PayrollComponent (rule key + variant) and
-- PayrollBatchComponentSnapshot (frozen rule key + variant + version +
-- source authority + title + reference). The service layer refuses
-- SPECTRE_LIBRARY component upserts that cannot resolve a rule
-- (fail-closed per §15 of the brief).

ALTER TABLE "PayrollComponent"
  ADD COLUMN "statutoryRuleKey"     TEXT,
  ADD COLUMN "statutoryRuleVariant" TEXT;

ALTER TABLE "PayrollBatchComponentSnapshot"
  ADD COLUMN "statutoryRuleKey"             TEXT,
  ADD COLUMN "statutoryRuleVariant"         TEXT,
  ADD COLUMN "statutoryRuleVersion"         TEXT,
  ADD COLUMN "statutoryRuleSourceAuthority" TEXT,
  ADD COLUMN "statutoryRuleSourceTitle"     TEXT,
  ADD COLUMN "statutoryRuleSourceReference" TEXT;
