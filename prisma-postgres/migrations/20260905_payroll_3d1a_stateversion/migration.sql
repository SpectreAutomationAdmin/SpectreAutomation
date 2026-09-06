-- Payroll-3D-1A (2026-09-05) — clock-transition concurrency primitive.
--
-- Adds Employee.timekeepingStateVersion (INTEGER, default 0). Every
-- clock event write in src/lib/timeclock/service.ts compares-and-
-- swaps this value inside its transaction, guaranteeing that two
-- concurrent transactions cannot both commit a new TimeClockEvent
-- for the same employee.
ALTER TABLE "Employee"
  ADD COLUMN "timekeepingStateVersion" INTEGER NOT NULL DEFAULT 0;
