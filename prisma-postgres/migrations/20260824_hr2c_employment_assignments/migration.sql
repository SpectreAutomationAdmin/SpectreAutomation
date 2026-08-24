-- HR-2C Employment (2026-08-24) — Multi-role assignments + allowances.
-- Additive-only. No back-fill.

CREATE TABLE "EmployeeEmploymentAssignment" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "clubId"            TEXT NOT NULL,
  "employeeId"        TEXT NOT NULL,
  "role"              TEXT NOT NULL,
  "departmentId"      TEXT,
  "positionId"        TEXT,
  "managerEmployeeId" TEXT,
  "employmentType"    TEXT NOT NULL,
  "effectiveFrom"     TIMESTAMP(3) NOT NULL,
  "effectiveTo"       TIMESTAMP(3),
  "notes"             TEXT,
  "createdByUserId"   TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeEmploymentAssignment_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeEmploymentAssignment_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "EmployeeEmploymentAssignment_clubId_employeeId_effectiveFrom_idx"
  ON "EmployeeEmploymentAssignment"("clubId", "employeeId", "effectiveFrom");
CREATE INDEX "EmployeeEmploymentAssignment_employeeId_role_idx"
  ON "EmployeeEmploymentAssignment"("employeeId", "role");

CREATE TABLE "EmployeeAllowance" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "clubId"          TEXT NOT NULL,
  "employeeId"      TEXT NOT NULL,
  "assignmentId"    TEXT,
  "allowanceType"   TEXT NOT NULL,
  "description"     TEXT,
  "amount"          DECIMAL(65,30) NOT NULL,
  "currency"        TEXT,
  "frequency"       TEXT NOT NULL,
  "taxable"         BOOLEAN NOT NULL DEFAULT TRUE,
  "effectiveFrom"   TIMESTAMP(3) NOT NULL,
  "effectiveTo"     TIMESTAMP(3),
  "notes"           TEXT,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeAllowance_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeAllowance_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeAllowance_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "EmployeeEmploymentAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "EmployeeAllowance_clubId_employeeId_effectiveFrom_idx"
  ON "EmployeeAllowance"("clubId", "employeeId", "effectiveFrom");

-- EmployeeCompensation gets an optional assignmentId FK so a raise
-- can target a specific role. Existing rows keep assignmentId NULL
-- (employee-wide) — backwards-compatible.
ALTER TABLE "EmployeeCompensation"
  ADD COLUMN "assignmentId" TEXT;
ALTER TABLE "EmployeeCompensation"
  ADD CONSTRAINT "EmployeeCompensation_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "EmployeeEmploymentAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "EmployeeCompensation_assignmentId_effectiveFrom_idx"
  ON "EmployeeCompensation"("assignmentId", "effectiveFrom");
