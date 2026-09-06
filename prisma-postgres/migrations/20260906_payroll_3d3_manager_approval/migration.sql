-- Payroll-3D-3 (2026-09-05) — Manager Timesheet Approval + Work Intake Routing.
--
-- Additive-only. No column drops, no destructive constraints.
--
-- 1. PayrollDepartmentTimeApproval.approvedRevision — nullable so
--    pre-3D-3 rows continue to load (they are treated as revision-
--    less legacy approvals by the service layer). New writes always
--    populate this field.
-- 2. TimeClockCorrectionRequest.reviewerNote — optional short (< 500 char)
--    manager rationale surfaced to the employee on rejection/approval.
-- 3. TimeClockEvent.supersededByEventId — self-FK. When a
--    CORRECT_CLOCK_* correction is approved, the ORIGINAL row stays
--    untouched and this column points at the new ADMIN_CORRECTION
--    resolution event. The materializer filters out superseded events
--    so history remains append-only.
-- 4. DepartmentResponsibility — department-scoped bridge from
--    Responsibility catalogue to responsible User. Introduced now for
--    DEPARTMENT_TIME_APPROVAL; extensible for other department-scoped
--    keys before TA-1F ships the generic resolver.

ALTER TABLE "PayrollDepartmentTimeApproval"
  ADD COLUMN "approvedRevision" TEXT;

ALTER TABLE "TimeClockCorrectionRequest"
  ADD COLUMN "reviewerNote" TEXT;

ALTER TABLE "TimeClockEvent"
  ADD COLUMN "supersededByEventId" TEXT;

ALTER TABLE "TimeClockEvent"
  ADD CONSTRAINT "TimeClockEvent_supersededByEventId_fkey"
  FOREIGN KEY ("supersededByEventId") REFERENCES "TimeClockEvent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "TimeClockEvent_supersededByEventId_idx"
  ON "TimeClockEvent"("supersededByEventId");

CREATE TABLE "DepartmentResponsibility" (
  "id"                 TEXT     NOT NULL,
  "clubId"             TEXT     NOT NULL,
  "departmentId"       TEXT     NOT NULL,
  "responsibilityKey"  TEXT     NOT NULL,
  "userId"             TEXT     NOT NULL,
  "assignedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assignedByUserId"   TEXT,
  CONSTRAINT "DepartmentResponsibility_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DepartmentResponsibility_clubId_departmentId_responsibilityKey_key"
  ON "DepartmentResponsibility"("clubId", "departmentId", "responsibilityKey");

CREATE INDEX "DepartmentResponsibility_clubId_responsibilityKey_idx"
  ON "DepartmentResponsibility"("clubId", "responsibilityKey");

CREATE INDEX "DepartmentResponsibility_userId_idx"
  ON "DepartmentResponsibility"("userId");

ALTER TABLE "DepartmentResponsibility"
  ADD CONSTRAINT "DepartmentResponsibility_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DepartmentResponsibility"
  ADD CONSTRAINT "DepartmentResponsibility_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DepartmentResponsibility"
  ADD CONSTRAINT "DepartmentResponsibility_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Payroll-3D-3A (2026-09-05) — additive FK from
-- EmployeeEmploymentAssignment.departmentId to Department.id so the
-- new Prisma `department` relation resolves without a second query.
-- Every existing row already carries a valid departmentId (nullable
-- column, no orphan rows in production seed / preview data).
ALTER TABLE "EmployeeEmploymentAssignment"
  ADD CONSTRAINT "EmployeeEmploymentAssignment_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
