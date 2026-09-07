-- Scheduling Foundation (2026-09-07) — Postgres parity for the new
-- scheduling models: ShiftTemplate, Shift, ShiftAssignment,
-- ShiftOpportunity, EmployeeAvailabilityProfile, EmployeeAvailabilityRule.
--
-- All additive. Zero mutation of existing tables. Orthogonal to the
-- worked-time stack (TimeClockEvent → PayrollTimesheet →
-- PayrollTimesheetEntry → PayrollApprovedTimeEntry). Joins the worked-
-- time stack on EmployeeEmploymentAssignment.id for scheduled-vs-actual
-- reconciliation.
--
-- Partial-unique indexes (Postgres-native, unlike SQLite's identical
-- syntax) enforce the single-active-assignment and single-open-
-- opportunity invariants at the DB layer. Same pattern used by
-- 20260911_payroll_3d3b_correction_review_partial_unique.

CREATE TABLE "ShiftTemplate" (
  "id"               TEXT NOT NULL PRIMARY KEY,
  "clubId"           TEXT NOT NULL,
  "departmentId"     TEXT NOT NULL,
  "code"             TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "startTimeMinutes" INTEGER NOT NULL,
  "endTimeMinutes"   INTEGER NOT NULL,
  "active"           BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"        INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "ShiftTemplate_clubId_departmentId_code_key"
  ON "ShiftTemplate" ("clubId", "departmentId", "code");
CREATE INDEX "ShiftTemplate_clubId_departmentId_active_idx"
  ON "ShiftTemplate" ("clubId", "departmentId", "active");

ALTER TABLE "ShiftTemplate"
  ADD CONSTRAINT "ShiftTemplate_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftTemplate_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Shift" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "clubId"            TEXT NOT NULL,
  "departmentId"      TEXT NOT NULL,
  "shiftTemplateId"   TEXT NOT NULL,
  "shiftDate"         TIMESTAMP(3) NOT NULL,
  "startAt"           TIMESTAMP(3) NOT NULL,
  "endAt"             TIMESTAMP(3) NOT NULL,
  "positionId"        TEXT,
  "state"             TEXT NOT NULL DEFAULT 'PUBLISHED',
  "publishedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedByUserId" TEXT,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL
);
CREATE INDEX "Shift_clubId_departmentId_shiftDate_idx"
  ON "Shift" ("clubId", "departmentId", "shiftDate");
CREATE INDEX "Shift_clubId_startAt_idx"
  ON "Shift" ("clubId", "startAt");

ALTER TABLE "Shift"
  ADD CONSTRAINT "Shift_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Shift_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Shift_shiftTemplateId_fkey"
    FOREIGN KEY ("shiftTemplateId") REFERENCES "ShiftTemplate"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Shift_positionId_fkey"
    FOREIGN KEY ("positionId") REFERENCES "EmployeePosition"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ShiftAssignment" (
  "id"                     TEXT NOT NULL PRIMARY KEY,
  "clubId"                 TEXT NOT NULL,
  "shiftId"                TEXT NOT NULL,
  "employeeId"             TEXT NOT NULL,
  "employmentAssignmentId" TEXT NOT NULL,
  "state"                  TEXT NOT NULL DEFAULT 'ASSIGNED',
  "replacedByAssignmentId" TEXT,
  "cancelledAt"            TIMESTAMP(3),
  "cancelledByUserId"      TEXT,
  "cancelledReason"        TEXT,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "ShiftAssignment_replacedByAssignmentId_key"
  ON "ShiftAssignment" ("replacedByAssignmentId");
CREATE INDEX "ShiftAssignment_clubId_employeeId_state_idx"
  ON "ShiftAssignment" ("clubId", "employeeId", "state");
CREATE INDEX "ShiftAssignment_clubId_shiftId_state_idx"
  ON "ShiftAssignment" ("clubId", "shiftId", "state");
-- Partial-unique: at most one ASSIGNED assignment per shift.
CREATE UNIQUE INDEX "ShiftAssignment_shiftId_active_unique"
  ON "ShiftAssignment" ("clubId", "shiftId")
  WHERE "state" = 'ASSIGNED';

ALTER TABLE "ShiftAssignment"
  ADD CONSTRAINT "ShiftAssignment_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftAssignment_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "Shift"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftAssignment_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftAssignment_employmentAssignmentId_fkey"
    FOREIGN KEY ("employmentAssignmentId") REFERENCES "EmployeeEmploymentAssignment"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftAssignment_replacedByAssignmentId_fkey"
    FOREIGN KEY ("replacedByAssignmentId") REFERENCES "ShiftAssignment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ShiftOpportunity" (
  "id"                    TEXT NOT NULL PRIMARY KEY,
  "clubId"                TEXT NOT NULL,
  "shiftId"               TEXT NOT NULL,
  "offeredByEmployeeId"   TEXT NOT NULL,
  "offeredByAssignmentId" TEXT NOT NULL,
  "state"                 TEXT NOT NULL DEFAULT 'OPEN',
  "reason"                TEXT,
  "note"                  TEXT,
  "expiresAt"             TIMESTAMP(3),
  "offeredAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedByEmployeeId"   TEXT,
  "claimedByAssignmentId" TEXT,
  "claimedAt"             TIMESTAMP(3),
  "withdrawnAt"           TIMESTAMP(3),
  "withdrawnByUserId"     TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ShiftOpportunity_clubId_state_idx"
  ON "ShiftOpportunity" ("clubId", "state");
CREATE INDEX "ShiftOpportunity_clubId_shiftId_state_idx"
  ON "ShiftOpportunity" ("clubId", "shiftId", "state");
-- Partial-unique: at most one OPEN opportunity per shift.
CREATE UNIQUE INDEX "ShiftOpportunity_shiftId_open_unique"
  ON "ShiftOpportunity" ("clubId", "shiftId")
  WHERE "state" = 'OPEN';

ALTER TABLE "ShiftOpportunity"
  ADD CONSTRAINT "ShiftOpportunity_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftOpportunity_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "Shift"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftOpportunity_offeredByEmployeeId_fkey"
    FOREIGN KEY ("offeredByEmployeeId") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftOpportunity_offeredByAssignmentId_fkey"
    FOREIGN KEY ("offeredByAssignmentId") REFERENCES "ShiftAssignment"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftOpportunity_claimedByEmployeeId_fkey"
    FOREIGN KEY ("claimedByEmployeeId") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftOpportunity_claimedByAssignmentId_fkey"
    FOREIGN KEY ("claimedByAssignmentId") REFERENCES "ShiftAssignment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "EmployeeAvailabilityProfile" (
  "id"                    TEXT NOT NULL PRIMARY KEY,
  "clubId"                TEXT NOT NULL,
  "employeeId"            TEXT NOT NULL,
  "effectiveFrom"         TIMESTAMP(3) NOT NULL,
  "preferredHoursPerWeek" INTEGER,
  "maximumHoursPerWeek"   INTEGER,
  "notes"                 TEXT,
  "createdByUserId"       TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "EmployeeAvailabilityProfile_employeeId_effectiveFrom_key"
  ON "EmployeeAvailabilityProfile" ("employeeId", "effectiveFrom");
CREATE INDEX "EmployeeAvailabilityProfile_clubId_employeeId_effectiveFrom_idx"
  ON "EmployeeAvailabilityProfile" ("clubId", "employeeId", "effectiveFrom");

ALTER TABLE "EmployeeAvailabilityProfile"
  ADD CONSTRAINT "EmployeeAvailabilityProfile_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeAvailabilityProfile_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "EmployeeAvailabilityRule" (
  "id"                    TEXT NOT NULL PRIMARY KEY,
  "availabilityProfileId" TEXT NOT NULL,
  "shiftTemplateId"       TEXT NOT NULL,
  "weekday"               INTEGER NOT NULL,
  "available"             BOOLEAN NOT NULL,
  "availableFrom"         TIMESTAMP(3),
  "availableUntil"        TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "EmployeeAvailabilityRule_profile_weekday_template_key"
  ON "EmployeeAvailabilityRule" ("availabilityProfileId", "weekday", "shiftTemplateId");
CREATE INDEX "EmployeeAvailabilityRule_shiftTemplateId_weekday_idx"
  ON "EmployeeAvailabilityRule" ("shiftTemplateId", "weekday");

ALTER TABLE "EmployeeAvailabilityRule"
  ADD CONSTRAINT "EmployeeAvailabilityRule_availabilityProfileId_fkey"
    FOREIGN KEY ("availabilityProfileId") REFERENCES "EmployeeAvailabilityProfile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeAvailabilityRule_shiftTemplateId_fkey"
    FOREIGN KEY ("shiftTemplateId") REFERENCES "ShiftTemplate"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
