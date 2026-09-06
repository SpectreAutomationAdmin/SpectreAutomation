-- Payroll-3D-2 (2026-09-05) — canonical Time & Attendance timesheet
-- + correction-request models. Additive only. Legacy Timesheet /
-- TimesheetEntry (bound to legacy PayrollPeriod) are untouched.

-- ============================================================
-- PayrollTimesheet
-- ============================================================
CREATE TABLE "PayrollTimesheet" (
  "id"           TEXT NOT NULL,
  "clubId"       TEXT NOT NULL,
  "employeeId"   TEXT NOT NULL,
  "payPeriodId"  TEXT NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'OPEN',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollTimesheet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollTimesheet_clubId_employeeId_payPeriodId_key"
  ON "PayrollTimesheet"("clubId","employeeId","payPeriodId");
CREATE INDEX "PayrollTimesheet_clubId_payPeriodId_status_idx"
  ON "PayrollTimesheet"("clubId","payPeriodId","status");
CREATE INDEX "PayrollTimesheet_clubId_status_idx"
  ON "PayrollTimesheet"("clubId","status");
ALTER TABLE "PayrollTimesheet"
  ADD CONSTRAINT "PayrollTimesheet_clubId_fkey"      FOREIGN KEY ("clubId")      REFERENCES "Club"("id")             ON UPDATE CASCADE,
  ADD CONSTRAINT "PayrollTimesheet_employeeId_fkey"  FOREIGN KEY ("employeeId")  REFERENCES "Employee"("id")         ON UPDATE CASCADE,
  ADD CONSTRAINT "PayrollTimesheet_payPeriodId_fkey" FOREIGN KEY ("payPeriodId") REFERENCES "PayrollPayPeriod"("id") ON UPDATE CASCADE;

-- ============================================================
-- PayrollTimesheetEntry
-- ============================================================
CREATE TABLE "PayrollTimesheetEntry" (
  "id"                     TEXT NOT NULL,
  "clubId"                 TEXT NOT NULL,
  "timesheetId"            TEXT NOT NULL,
  "employeeId"             TEXT NOT NULL,
  "workDate"               TIMESTAMP(3) NOT NULL,
  "employmentAssignmentId" TEXT,
  "earningClassification"  TEXT NOT NULL DEFAULT 'REGULAR',
  "clockInAt"              TIMESTAMP(3) NOT NULL,
  "clockOutAt"             TIMESTAMP(3) NOT NULL,
  "recordedSeconds"        INTEGER NOT NULL,
  "breakSeconds"           INTEGER NOT NULL DEFAULT 0,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollTimesheetEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollTimesheetEntry_timesheetId_clockInAt_key"
  ON "PayrollTimesheetEntry"("timesheetId","clockInAt");
CREATE INDEX "PayrollTimesheetEntry_timesheetId_workDate_idx"
  ON "PayrollTimesheetEntry"("timesheetId","workDate");
CREATE INDEX "PayrollTimesheetEntry_employmentAssignmentId_workDate_idx"
  ON "PayrollTimesheetEntry"("employmentAssignmentId","workDate");
CREATE INDEX "PayrollTimesheetEntry_clubId_employeeId_workDate_idx"
  ON "PayrollTimesheetEntry"("clubId","employeeId","workDate");
ALTER TABLE "PayrollTimesheetEntry"
  ADD CONSTRAINT "PayrollTimesheetEntry_clubId_fkey"                 FOREIGN KEY ("clubId")                 REFERENCES "Club"("id")                         ON UPDATE CASCADE,
  ADD CONSTRAINT "PayrollTimesheetEntry_timesheetId_fkey"            FOREIGN KEY ("timesheetId")            REFERENCES "PayrollTimesheet"("id")             ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PayrollTimesheetEntry_employeeId_fkey"             FOREIGN KEY ("employeeId")             REFERENCES "Employee"("id")                     ON UPDATE CASCADE,
  ADD CONSTRAINT "PayrollTimesheetEntry_employmentAssignmentId_fkey" FOREIGN KEY ("employmentAssignmentId") REFERENCES "EmployeeEmploymentAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- PayrollTimesheetEntryClockEvent  (provenance join)
-- ============================================================
CREATE TABLE "PayrollTimesheetEntryClockEvent" (
  "id"               TEXT NOT NULL,
  "clubId"           TEXT NOT NULL,
  "timesheetEntryId" TEXT NOT NULL,
  "clockEventId"     TEXT NOT NULL,
  "role"             TEXT NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollTimesheetEntryClockEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollTimesheetEntryClockEvent_teId_ceId_key"
  ON "PayrollTimesheetEntryClockEvent"("timesheetEntryId","clockEventId");
CREATE INDEX "PayrollTimesheetEntryClockEvent_clockEventId_idx"
  ON "PayrollTimesheetEntryClockEvent"("clockEventId");
ALTER TABLE "PayrollTimesheetEntryClockEvent"
  ADD CONSTRAINT "PTECE_clubId_fkey"           FOREIGN KEY ("clubId")           REFERENCES "Club"("id")                  ON UPDATE CASCADE,
  ADD CONSTRAINT "PTECE_timesheetEntryId_fkey" FOREIGN KEY ("timesheetEntryId") REFERENCES "PayrollTimesheetEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PTECE_clockEventId_fkey"     FOREIGN KEY ("clockEventId")     REFERENCES "TimeClockEvent"("id")        ON UPDATE CASCADE;

-- ============================================================
-- TimeClockCorrectionRequest
-- ============================================================
CREATE TABLE "TimeClockCorrectionRequest" (
  "id"                     TEXT NOT NULL,
  "clubId"                 TEXT NOT NULL,
  "employeeId"             TEXT NOT NULL,
  "originalClockEventId"   TEXT,
  "requestType"            TEXT NOT NULL,
  "requestedOccurredAt"    TIMESTAMP(3),
  "employmentAssignmentId" TEXT,
  "reason"                 TEXT NOT NULL,
  "status"                 TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  "reviewedAt"             TIMESTAMP(3),
  "reviewedByUserId"       TEXT,
  "resolutionClockEventId" TEXT,
  CONSTRAINT "TimeClockCorrectionRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TimeClockCorrectionRequest_employee_type_original_status_key"
  ON "TimeClockCorrectionRequest"("employeeId","requestType","originalClockEventId","status");
CREATE INDEX "TimeClockCorrectionRequest_clubId_employeeId_status_idx"
  ON "TimeClockCorrectionRequest"("clubId","employeeId","status");
CREATE INDEX "TimeClockCorrectionRequest_status_createdAt_idx"
  ON "TimeClockCorrectionRequest"("status","createdAt");
ALTER TABLE "TimeClockCorrectionRequest"
  ADD CONSTRAINT "TCCR_clubId_fkey"                 FOREIGN KEY ("clubId")                 REFERENCES "Club"("id")           ON UPDATE CASCADE,
  ADD CONSTRAINT "TCCR_employeeId_fkey"             FOREIGN KEY ("employeeId")             REFERENCES "Employee"("id")       ON UPDATE CASCADE,
  ADD CONSTRAINT "TCCR_originalClockEventId_fkey"   FOREIGN KEY ("originalClockEventId")   REFERENCES "TimeClockEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "TCCR_resolutionClockEventId_fkey" FOREIGN KEY ("resolutionClockEventId") REFERENCES "TimeClockEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
