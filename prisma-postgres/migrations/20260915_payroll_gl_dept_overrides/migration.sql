-- Phase 3 (2026-09-15) — Departmental Payroll Accounting.
--
-- Adds one override row per (clubId, departmentId) with optional
-- overrides for the three EXPENSE mappings on PayrollGlAccountingProfile:
--   * salary / wage expense
--   * employer CPP expense
--   * employer EI expense
--
-- Any FK left NULL falls back to the global PayrollGlAccountingProfile
-- mapping at resolver time. Central liabilities (net pay payable, CPP
-- payable, EI payable, federal tax payable, provincial tax payable)
-- are intentionally NOT overridable — payroll remittance stays
-- centralized. See prisma/schema.prisma for the full block comment.

CREATE TABLE "PayrollGlDepartmentOverride" (
    "id"                          TEXT NOT NULL,
    "clubId"                      TEXT NOT NULL,
    "departmentId"                TEXT NOT NULL,
    "salaryExpenseAccountId"      TEXT,
    "employerCppExpenseAccountId" TEXT,
    "employerEiExpenseAccountId"  TEXT,
    "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollGlDepartmentOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayrollGlDepartmentOverride_clubId_departmentId_key"
    ON "PayrollGlDepartmentOverride"("clubId", "departmentId");

CREATE INDEX "PayrollGlDepartmentOverride_clubId_idx"
    ON "PayrollGlDepartmentOverride"("clubId");

ALTER TABLE "PayrollGlDepartmentOverride"
    ADD CONSTRAINT "PayrollGlDepartmentOverride_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayrollGlDepartmentOverride"
    ADD CONSTRAINT "PayrollGlDepartmentOverride_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayrollGlDepartmentOverride"
    ADD CONSTRAINT "PayrollGlDepartmentOverride_salaryExpenseAccountId_fkey"
    FOREIGN KEY ("salaryExpenseAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayrollGlDepartmentOverride"
    ADD CONSTRAINT "PayrollGlDepartmentOverride_employerCppExpenseAccountId_fkey"
    FOREIGN KEY ("employerCppExpenseAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayrollGlDepartmentOverride"
    ADD CONSTRAINT "PayrollGlDepartmentOverride_employerEiExpenseAccountId_fkey"
    FOREIGN KEY ("employerEiExpenseAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
