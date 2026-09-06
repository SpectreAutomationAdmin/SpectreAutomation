-- Payroll-3D-3B Slice 7B (2026-09-06) — SQLite parity for the
-- scope-state CAS. Mirror of the Postgres migration with
-- SQLite-native syntax (no ADD CONSTRAINT; FKs inline in CREATE
-- TABLE).

ALTER TABLE "PayrollDepartmentTimeApproval"
  ADD COLUMN "approvedScopeVersion" INTEGER;

CREATE TABLE "PayrollDepartmentTimeScopeState" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "clubId"       TEXT NOT NULL,
  "payPeriodId"  TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "version"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    DATETIME NOT NULL,
  CONSTRAINT "PayrollDepartmentTimeScopeState_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PayrollDepartmentTimeScopeState_payPeriodId_fkey"
    FOREIGN KEY ("payPeriodId") REFERENCES "PayrollPayPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PayrollDepartmentTimeScopeState_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PayrollDepartmentTimeScopeState_clubId_payPeriodId_departmentId_key"
  ON "PayrollDepartmentTimeScopeState" ("clubId", "payPeriodId", "departmentId");
CREATE INDEX "PayrollDepartmentTimeScopeState_clubId_payPeriodId_idx"
  ON "PayrollDepartmentTimeScopeState" ("clubId", "payPeriodId");
CREATE INDEX "PayrollDepartmentTimeScopeState_clubId_departmentId_idx"
  ON "PayrollDepartmentTimeScopeState" ("clubId", "departmentId");
