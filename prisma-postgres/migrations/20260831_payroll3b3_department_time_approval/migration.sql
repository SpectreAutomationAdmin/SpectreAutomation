-- Payroll-3B-3 (2026-08-28) — canonical department-level approval
-- of a Pay Period. One row per (Club, PayPeriod, Department) after
-- a manager approves. Additive-only; no existing rows touched.

CREATE TABLE "PayrollDepartmentTimeApproval" (
  "id"               TEXT NOT NULL,
  "clubId"           TEXT NOT NULL,
  "payPeriodId"      TEXT NOT NULL,
  "departmentId"     TEXT NOT NULL,
  "state"            TEXT NOT NULL DEFAULT 'APPROVED',
  "approvedAt"       TIMESTAMP(3) NOT NULL,
  "approvedByUserId" TEXT NOT NULL,
  "reopenedAt"       TIMESTAMP(3),
  "reopenedByUserId" TEXT,
  "reopenReason"     TEXT,
  "workIntakeItemId" TEXT,
  "notes"            TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PayrollDepartmentTimeApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayrollDepartmentTimeApproval_clubId_payPeriodId_departmentId_key"
  ON "PayrollDepartmentTimeApproval" ("clubId", "payPeriodId", "departmentId");

CREATE INDEX "PayrollDepartmentTimeApproval_clubId_payPeriodId_idx"
  ON "PayrollDepartmentTimeApproval" ("clubId", "payPeriodId");

CREATE INDEX "PayrollDepartmentTimeApproval_clubId_departmentId_idx"
  ON "PayrollDepartmentTimeApproval" ("clubId", "departmentId");

CREATE INDEX "PayrollDepartmentTimeApproval_workIntakeItemId_idx"
  ON "PayrollDepartmentTimeApproval" ("workIntakeItemId");

ALTER TABLE "PayrollDepartmentTimeApproval"
  ADD CONSTRAINT "PayrollDepartmentTimeApproval_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollDepartmentTimeApproval"
  ADD CONSTRAINT "PayrollDepartmentTimeApproval_payPeriodId_fkey"
  FOREIGN KEY ("payPeriodId") REFERENCES "PayrollPayPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollDepartmentTimeApproval"
  ADD CONSTRAINT "PayrollDepartmentTimeApproval_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
