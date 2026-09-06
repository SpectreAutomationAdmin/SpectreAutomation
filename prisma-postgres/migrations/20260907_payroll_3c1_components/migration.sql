-- Payroll-3C-1 (2026-09-07) — Payroll Component catalogue +
-- Employee recurring component assignments.
--
-- Additive only. No changes to the calculator, GL adapter, or
-- existing Payroll models. Downstream slices (3C-2 .. 3C-6) will
-- wire these into batch preparation, calculation, review, and GL.

CREATE TABLE "PayrollComponent" (
    "id"                     TEXT PRIMARY KEY,
    "clubId"                 TEXT NOT NULL REFERENCES "Club"("id") ON DELETE CASCADE,
    "code"                   TEXT NOT NULL,
    "displayName"            TEXT NOT NULL,
    "description"            TEXT,
    "category"               TEXT NOT NULL,
    "side"                   TEXT NOT NULL,
    "isCash"                 BOOLEAN NOT NULL,
    "affectsTaxable"         BOOLEAN NOT NULL,
    "affectsCppPensionable"  BOOLEAN NOT NULL,
    "affectsEiInsurable"     BOOLEAN NOT NULL,
    "calculationMethod"      TEXT NOT NULL,
    "glAccountId"            TEXT REFERENCES "Account"("id"),
    "displaySection"         TEXT NOT NULL,
    "displayOrder"           INTEGER NOT NULL DEFAULT 0,
    "active"                 BOOLEAN NOT NULL DEFAULT true,
    "notes"                  TEXT,
    "createdByUserId"        TEXT,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "PayrollComponent_clubId_code_key" ON "PayrollComponent"("clubId", "code");
CREATE INDEX "PayrollComponent_clubId_category_active_idx" ON "PayrollComponent"("clubId", "category", "active");

CREATE TABLE "EmployeeRecurringPayrollComponent" (
    "id"              TEXT PRIMARY KEY,
    "clubId"          TEXT NOT NULL REFERENCES "Club"("id") ON DELETE CASCADE,
    "employeeId"      TEXT NOT NULL REFERENCES "Employee"("id") ON DELETE CASCADE,
    "componentId"     TEXT NOT NULL REFERENCES "PayrollComponent"("id"),
    "amount"          DECIMAL(65,30),
    "percentBps"      INTEGER,
    "effectiveFrom"   TIMESTAMP(3) NOT NULL,
    "effectiveTo"     TIMESTAMP(3),
    "active"          BOOLEAN NOT NULL DEFAULT true,
    "notes"           TEXT,
    "createdByUserId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL
);
CREATE INDEX "EmployeeRecurringPayrollComponent_clubId_employeeId_effectiveFrom_idx" ON "EmployeeRecurringPayrollComponent"("clubId", "employeeId", "effectiveFrom");
CREATE INDEX "EmployeeRecurringPayrollComponent_componentId_idx" ON "EmployeeRecurringPayrollComponent"("componentId");
