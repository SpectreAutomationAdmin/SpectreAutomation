-- Payroll-3D-1 (2026-09-05) — Time & Attendance foundation.
-- Additive migration only:
--   • Employee.timekeepingMethod (default NO_TIME_ENTRY_REQUIRED).
--   • TimeClockEvent gets createdAt + employmentAssignmentId FK
--     + two extra indexes.

-- ============================================================
-- Employee.timekeepingMethod
-- ============================================================
ALTER TABLE "Employee"
  ADD COLUMN "timekeepingMethod" TEXT NOT NULL DEFAULT 'NO_TIME_ENTRY_REQUIRED';

-- ============================================================
-- TimeClockEvent: append-only clock events (extended)
-- ============================================================
ALTER TABLE "TimeClockEvent"
  ADD COLUMN "employmentAssignmentId" TEXT,
  ADD COLUMN "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TimeClockEvent"
  ADD CONSTRAINT "TimeClockEvent_employmentAssignmentId_fkey"
  FOREIGN KEY ("employmentAssignmentId")
  REFERENCES "EmployeeEmploymentAssignment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "TimeClockEvent_employeeId_kind_occurredAt_idx"
  ON "TimeClockEvent"("employeeId", "kind", "occurredAt");
CREATE INDEX "TimeClockEvent_employmentAssignmentId_occurredAt_idx"
  ON "TimeClockEvent"("employmentAssignmentId", "occurredAt");
