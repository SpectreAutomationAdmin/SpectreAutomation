-- Payroll-3D-4 (2026-09-05) — Approved-time freeze + late/retro model.
--
-- Additive only. No column drops.
--
-- 1. PayrollApprovedTimeEntry gains explicit source provenance
--    (payrollTimesheetEntryId UNIQUE; sourceApprovalId;
--    sourceApprovalRevision) and a supersession self-FK
--    (supersededByApprovedTimeEntryId) so unconsumed stale freezes
--    are marked, not mutated, when a correction changes the source
--    timesheet entry.
-- 2. PayrollTimeAdjustment records signed retro / late-time
--    obligations that a Payroll Admin resolves out-of-band; the row
--    NEVER retroactively mutates a consumed PayrollApprovedTimeEntry.
-- 3. PayrollClubConfig.payrollCutoffLeadDays lets a club override the
--    default 5-day cutoff-lead used by src/lib/payroll/cutoff.ts.

ALTER TABLE "PayrollApprovedTimeEntry"
  ADD COLUMN "payrollTimesheetEntryId" TEXT,
  ADD COLUMN "sourceApprovalId" TEXT,
  ADD COLUMN "sourceApprovalRevision" TEXT,
  ADD COLUMN "supersededByApprovedTimeEntryId" TEXT;

CREATE UNIQUE INDEX "PayrollApprovedTimeEntry_payrollTimesheetEntryId_key"
  ON "PayrollApprovedTimeEntry"("payrollTimesheetEntryId");

CREATE INDEX "PayrollApprovedTimeEntry_supersededByApprovedTimeEntryId_idx"
  ON "PayrollApprovedTimeEntry"("supersededByApprovedTimeEntryId");

CREATE INDEX "PayrollApprovedTimeEntry_sourceApprovalId_idx"
  ON "PayrollApprovedTimeEntry"("sourceApprovalId");

ALTER TABLE "PayrollApprovedTimeEntry"
  ADD CONSTRAINT "PayrollApprovedTimeEntry_payrollTimesheetEntryId_fkey"
  FOREIGN KEY ("payrollTimesheetEntryId") REFERENCES "PayrollTimesheetEntry"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayrollApprovedTimeEntry"
  ADD CONSTRAINT "PayrollApprovedTimeEntry_sourceApprovalId_fkey"
  FOREIGN KEY ("sourceApprovalId") REFERENCES "PayrollDepartmentTimeApproval"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayrollApprovedTimeEntry"
  ADD CONSTRAINT "PayrollApprovedTimeEntry_supersededByApprovedTimeEntryId_fkey"
  FOREIGN KEY ("supersededByApprovedTimeEntryId") REFERENCES "PayrollApprovedTimeEntry"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PayrollTimeAdjustment" (
  "id"                   TEXT NOT NULL,
  "clubId"               TEXT NOT NULL,
  "employeeId"           TEXT NOT NULL,
  "employmentAssignmentId" TEXT,
  "payPeriodId"          TEXT NOT NULL,
  "targetPayPeriodId"    TEXT,
  "sourceTimesheetEntryId" TEXT,
  "originalApprovedTimeEntryId" TEXT,
  "reason"               TEXT NOT NULL,
  "differenceHours"      DECIMAL NOT NULL,
  "earningClassification" TEXT NOT NULL DEFAULT 'REGULAR',
  "status"               TEXT NOT NULL DEFAULT 'OPEN',
  "createdByUserId"      TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"           TIMESTAMP(3),
  "resolvedByUserId"     TEXT,
  "resolutionType"       TEXT,
  "notes"                TEXT,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollTimeAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PayrollTimeAdjustment_clubId_payPeriodId_status_idx"
  ON "PayrollTimeAdjustment"("clubId", "payPeriodId", "status");
CREATE INDEX "PayrollTimeAdjustment_clubId_targetPayPeriodId_idx"
  ON "PayrollTimeAdjustment"("clubId", "targetPayPeriodId");
CREATE INDEX "PayrollTimeAdjustment_sourceTimesheetEntryId_idx"
  ON "PayrollTimeAdjustment"("sourceTimesheetEntryId");
CREATE INDEX "PayrollTimeAdjustment_originalApprovedTimeEntryId_idx"
  ON "PayrollTimeAdjustment"("originalApprovedTimeEntryId");

ALTER TABLE "PayrollTimeAdjustment"
  ADD CONSTRAINT "PayrollTimeAdjustment_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollTimeAdjustment"
  ADD CONSTRAINT "PayrollTimeAdjustment_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollTimeAdjustment"
  ADD CONSTRAINT "PayrollTimeAdjustment_payPeriodId_fkey"
  FOREIGN KEY ("payPeriodId") REFERENCES "PayrollPayPeriod"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollTimeAdjustment"
  ADD CONSTRAINT "PayrollTimeAdjustment_targetPayPeriodId_fkey"
  FOREIGN KEY ("targetPayPeriodId") REFERENCES "PayrollPayPeriod"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayrollTimeAdjustment"
  ADD CONSTRAINT "PayrollTimeAdjustment_sourceTimesheetEntryId_fkey"
  FOREIGN KEY ("sourceTimesheetEntryId") REFERENCES "PayrollTimesheetEntry"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayrollTimeAdjustment"
  ADD CONSTRAINT "PayrollTimeAdjustment_originalApprovedTimeEntryId_fkey"
  FOREIGN KEY ("originalApprovedTimeEntryId") REFERENCES "PayrollApprovedTimeEntry"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayrollClubConfig"
  ADD COLUMN "payrollCutoffLeadDays" INTEGER;
