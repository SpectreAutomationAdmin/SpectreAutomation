-- Organizational Foundation (2026-09-13) — canonical Position model.
--
-- Additive migration. All new columns are nullable; no existing data
-- is rewritten. Existing OrganizationalPosition rows keep working
-- unchanged; new fields (code, reportsToPositionId) are populated by
-- the domain-side provisionDefaultOrganization + backfill.
--
-- Also adds Employee.orgPositionId (canonical Position FK) and
-- Employee.managerProfileId (cross-type manager reference to
-- UserClubProfile). New Employee writes populate orgPositionId; the
-- legacy Employee.positionId → EmployeePosition remains readable
-- during transition (temporary compatibility per founder §2).

-- OrganizationalPosition columns
ALTER TABLE "OrganizationalPosition" ADD COLUMN "code" TEXT;
ALTER TABLE "OrganizationalPosition" ADD COLUMN "reportsToPositionId" TEXT;

-- Foreign key + partial unique
ALTER TABLE "OrganizationalPosition"
  ADD CONSTRAINT "OrganizationalPosition_reportsToPositionId_fkey"
  FOREIGN KEY ("reportsToPositionId") REFERENCES "OrganizationalPosition"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Unique when populated: (clubId, code)
CREATE UNIQUE INDEX "OrganizationalPosition_clubId_code_key"
  ON "OrganizationalPosition"("clubId", "code");

CREATE INDEX "OrganizationalPosition_reportsToPositionId_idx"
  ON "OrganizationalPosition"("reportsToPositionId");

-- Employee columns
ALTER TABLE "Employee" ADD COLUMN "managerProfileId" TEXT;
ALTER TABLE "Employee" ADD COLUMN "orgPositionId" TEXT;

ALTER TABLE "Employee"
  ADD CONSTRAINT "Employee_managerProfileId_fkey"
  FOREIGN KEY ("managerProfileId") REFERENCES "UserClubProfile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Employee"
  ADD CONSTRAINT "Employee_orgPositionId_fkey"
  FOREIGN KEY ("orgPositionId") REFERENCES "OrganizationalPosition"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
