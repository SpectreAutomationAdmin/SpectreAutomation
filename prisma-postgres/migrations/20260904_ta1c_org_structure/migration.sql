-- TA-1C (2026-09-04) — Organizational structure.
--
-- Additive-only. Introduces the OrganizationalPosition catalogue
-- (Club-defined administrative titles, distinct from HR
-- EmployeePosition which carries payroll fields), and extends
-- UserClubProfile with:
--   positionId          — FK to OrganizationalPosition
--   reportsToProfileId  — self-FK to another UserClubProfile at the
--                          SAME club (same-tenant + no-cycle
--                          invariants enforced service-side)
--
-- See docs/tenant-admin/TA-1A-architecture.md and TA-1C prompt.

-- ---------------------------------------------------------------------
-- OrganizationalPosition
-- ---------------------------------------------------------------------
CREATE TABLE "OrganizationalPosition" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "departmentId"    TEXT,
  "description"     TEXT,
  "sortOrder"       INTEGER NOT NULL DEFAULT 0,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  "createdByUserId" TEXT,
  CONSTRAINT "OrganizationalPosition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganizationalPosition_clubId_name_key"
  ON "OrganizationalPosition"("clubId", "name");
CREATE INDEX "OrganizationalPosition_clubId_isActive_sortOrder_idx"
  ON "OrganizationalPosition"("clubId", "isActive", "sortOrder");
CREATE INDEX "OrganizationalPosition_departmentId_idx"
  ON "OrganizationalPosition"("departmentId");
ALTER TABLE "OrganizationalPosition" ADD CONSTRAINT "OrganizationalPosition_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationalPosition" ADD CONSTRAINT "OrganizationalPosition_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrganizationalPosition" ADD CONSTRAINT "OrganizationalPosition_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- UserClubProfile — additive columns + FKs + indexes
-- ---------------------------------------------------------------------
ALTER TABLE "UserClubProfile" ADD COLUMN "positionId" TEXT;
ALTER TABLE "UserClubProfile" ADD COLUMN "reportsToProfileId" TEXT;

CREATE INDEX "UserClubProfile_positionId_idx" ON "UserClubProfile"("positionId");
CREATE INDEX "UserClubProfile_clubId_reportsToProfileId_idx"
  ON "UserClubProfile"("clubId", "reportsToProfileId");

ALTER TABLE "UserClubProfile" ADD CONSTRAINT "UserClubProfile_positionId_fkey"
  FOREIGN KEY ("positionId") REFERENCES "OrganizationalPosition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserClubProfile" ADD CONSTRAINT "UserClubProfile_reportsToProfileId_fkey"
  FOREIGN KEY ("reportsToProfileId") REFERENCES "UserClubProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
