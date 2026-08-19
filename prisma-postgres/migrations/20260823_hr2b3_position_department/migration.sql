-- HR-2B.3.6 (2026-08-19) — EmployeePosition.departmentId
--
-- Positions now belong to a Department. Nullable during backfill;
-- the admin Add Employee form requires Department to be picked
-- before Position. A one-shot post-deploy script maps the 16
-- Coulee Ridge staging positions to their proper Departments.

ALTER TABLE "EmployeePosition" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "EmployeePosition"
  ADD CONSTRAINT "EmployeePosition_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "EmployeePosition_clubId_departmentId_isActive_idx"
  ON "EmployeePosition"("clubId", "departmentId", "isActive");
