-- HR-2C B4 (2026-08-23) — Employee weekly availability persistence.
-- Additive-only. No back-fill.

CREATE TABLE "EmployeeAvailabilityWeek" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "clubId"      TEXT NOT NULL,
  "employeeId"  TEXT NOT NULL,
  "weekStart"   TIMESTAMP(3) NOT NULL,
  "monday"      BOOLEAN NOT NULL DEFAULT FALSE,
  "tuesday"     BOOLEAN NOT NULL DEFAULT FALSE,
  "wednesday"   BOOLEAN NOT NULL DEFAULT FALSE,
  "thursday"    BOOLEAN NOT NULL DEFAULT FALSE,
  "friday"      BOOLEAN NOT NULL DEFAULT FALSE,
  "saturday"    BOOLEAN NOT NULL DEFAULT FALSE,
  "sunday"      BOOLEAN NOT NULL DEFAULT FALSE,
  "notes"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeAvailabilityWeek_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeAvailabilityWeek_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmployeeAvailabilityWeek_employeeId_weekStart_key"
  ON "EmployeeAvailabilityWeek"("employeeId", "weekStart");
CREATE INDEX "EmployeeAvailabilityWeek_clubId_weekStart_idx"
  ON "EmployeeAvailabilityWeek"("clubId", "weekStart");
