-- Slice E (2026-09-19) — Payroll Register + First-Pay Readiness
-- migration. Additive.
--
--   1. PayrollPayGroup.payDateAdjustment — explicit weekend/holiday
--      pay-date shift policy per pay group.
--        NONE | PREVIOUS_BUSINESS_DAY | NEXT_BUSINESS_DAY
--      Default = PREVIOUS_BUSINESS_DAY so historical rows match the
--      former hard-coded earlier-Friday shift and no existing SM
--      calendar drifts.
--
--   2. PayrollZeroHoursAcknowledgement — explicit acknowledgement
--      record satisfying the NO_APPROVED_HOURS_FOR_HOURLY blocker for
--      legitimate zero-hour cases (leave / no shifts / seasonal /
--      other). One row per batchEmployee.

ALTER TABLE "PayrollPayGroup"
  ADD COLUMN "payDateAdjustment" TEXT NOT NULL DEFAULT 'PREVIOUS_BUSINESS_DAY';

CREATE TABLE "PayrollZeroHoursAcknowledgement" (
  "id"                   TEXT PRIMARY KEY,
  "clubId"               TEXT NOT NULL,
  "batchId"              TEXT NOT NULL,
  "batchEmployeeId"      TEXT NOT NULL UNIQUE,
  "employeeId"           TEXT NOT NULL,
  "reason"               TEXT NOT NULL,
  "reasonDetail"         TEXT,
  "acknowledgedByUserId" TEXT NOT NULL,
  "acknowledgedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollZeroHoursAcknowledgement_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "PayrollZeroHoursAcknowledgement_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "PayrollBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PayrollZeroHoursAcknowledgement_batchEmployeeId_fkey"
    FOREIGN KEY ("batchEmployeeId") REFERENCES "PayrollBatchEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PayrollZeroHoursAcknowledgement_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE INDEX "PayrollZeroHoursAcknowledgement_clubId_batchId_idx"
  ON "PayrollZeroHoursAcknowledgement"("clubId", "batchId");
