-- Payroll-3C-2 (2026-09-07) — component-effect semantic correction
-- + immutable batch snapshot for recurring components.
--
-- Additive changes:
--   • PayrollComponent: drop `isCash BOOLEAN` (replaces with
--     `cashEffect TEXT`) and add `statutoryTreatmentSource TEXT
--     DEFAULT 'CUSTOM'`. The isCash column had ambiguous semantics
--     (§2 of 3C-2 brief) and 3C-1 was fresh local-only — safe to
--     replace before any real data exists.
--   • New PayrollBatchComponentSnapshot table capturing a frozen
--     copy of each applicable recurring component at prep time.
--
-- No changes to existing calculator, GL adapter, or legacy models
-- (EmployeeAllowance / PayrollBatchAllowanceSnapshot / PayrollBenefit
-- / PayrollDeduction remain untouched per §32).

ALTER TABLE "PayrollComponent" DROP COLUMN "isCash";
ALTER TABLE "PayrollComponent" ADD COLUMN "cashEffect" TEXT NOT NULL DEFAULT 'NO_NET_PAY_EFFECT';
ALTER TABLE "PayrollComponent" ALTER COLUMN "cashEffect" DROP DEFAULT;
ALTER TABLE "PayrollComponent" ADD COLUMN "statutoryTreatmentSource" TEXT NOT NULL DEFAULT 'CUSTOM';

CREATE TABLE "PayrollBatchComponentSnapshot" (
    "id"                       TEXT PRIMARY KEY,
    "clubId"                   TEXT NOT NULL REFERENCES "Club"("id"),
    "batchId"                  TEXT NOT NULL REFERENCES "PayrollBatch"("id") ON DELETE CASCADE,
    "batchEmployeeId"          TEXT NOT NULL REFERENCES "PayrollBatchEmployee"("id") ON DELETE CASCADE,
    "employeeId"               TEXT NOT NULL REFERENCES "Employee"("id"),
    "sourceComponentId"        TEXT NOT NULL REFERENCES "PayrollComponent"("id"),
    "sourceAssignmentId"       TEXT NOT NULL REFERENCES "EmployeeRecurringPayrollComponent"("id"),
    "componentCode"            TEXT NOT NULL,
    "displayName"              TEXT NOT NULL,
    "category"                 TEXT NOT NULL,
    "side"                     TEXT NOT NULL,
    "displaySection"           TEXT NOT NULL,
    "displayOrder"             INTEGER NOT NULL DEFAULT 0,
    "cashEffect"               TEXT NOT NULL,
    "affectsTaxable"           BOOLEAN NOT NULL,
    "affectsCppPensionable"    BOOLEAN NOT NULL,
    "affectsEiInsurable"       BOOLEAN NOT NULL,
    "calculationMethod"        TEXT NOT NULL,
    "statutoryTreatmentSource" TEXT NOT NULL DEFAULT 'CUSTOM',
    "resolvedAmount"           DECIMAL(65,30),
    "sourcePercentBps"         INTEGER,
    "sourceEffectiveFrom"      TIMESTAMP(3) NOT NULL,
    "sourceEffectiveTo"        TIMESTAMP(3),
    "warningCode"              TEXT,
    "warningMessage"           TEXT,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PayrollBatchComponentSnapshot_batchEmployeeId_sourceAssignmentId_key"
    ON "PayrollBatchComponentSnapshot"("batchEmployeeId", "sourceAssignmentId");
CREATE INDEX "PayrollBatchComponentSnapshot_clubId_batchId_idx"
    ON "PayrollBatchComponentSnapshot"("clubId", "batchId");
CREATE INDEX "PayrollBatchComponentSnapshot_componentCode_idx"
    ON "PayrollBatchComponentSnapshot"("componentCode");
