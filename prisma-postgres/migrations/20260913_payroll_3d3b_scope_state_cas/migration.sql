-- Payroll-3D-3B Slice 7B (2026-09-06) — DB-controlled concurrency
-- token for the (clubId × payPeriodId × departmentId) approval scope.
-- Adds:
--   1. `approvedScopeVersion` (nullable Int) on PayrollDepartmentTimeApproval
--      — legacy approvals get NULL, new approvals persist the value.
--   2. PayrollDepartmentTimeScopeState table with unique
--      (clubId, payPeriodId, departmentId) — every material writer that
--      changes computeScopeRevision inputs bumps `version` inside its
--      own transaction; approveTimesheetScope performs a version CAS
--      inside the same transaction as the upsert.

ALTER TABLE "PayrollDepartmentTimeApproval"
  ADD COLUMN "approvedScopeVersion" INTEGER;

CREATE TABLE "PayrollDepartmentTimeScopeState" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "clubId"       TEXT NOT NULL,
  "payPeriodId"  TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "version"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "PayrollDepartmentTimeScopeState_clubId_payPeriodId_departmentId_key"
  ON "PayrollDepartmentTimeScopeState" ("clubId", "payPeriodId", "departmentId");
CREATE INDEX "PayrollDepartmentTimeScopeState_clubId_payPeriodId_idx"
  ON "PayrollDepartmentTimeScopeState" ("clubId", "payPeriodId");
CREATE INDEX "PayrollDepartmentTimeScopeState_clubId_departmentId_idx"
  ON "PayrollDepartmentTimeScopeState" ("clubId", "departmentId");

ALTER TABLE "PayrollDepartmentTimeScopeState"
  ADD CONSTRAINT "PayrollDepartmentTimeScopeState_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PayrollDepartmentTimeScopeState_payPeriodId_fkey"
    FOREIGN KEY ("payPeriodId") REFERENCES "PayrollPayPeriod"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PayrollDepartmentTimeScopeState_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
