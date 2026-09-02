-- TA-1B (2026-09-03) — Tenant Administration foundation.
--
-- Additive-only migration. No existing rows are modified, no columns
-- dropped, no existing tables touched. Introduces four new tenant-scoped
-- tables + one platform-catalogue table:
--
--   UserClubProfile          — organizational identity per (User × Club)
--   Responsibility           — canonical operational-key catalogue
--   ResponsibilityAssignment — (User × Club × Responsibility × role)
--   AdminInvitation          — administrative-user invitation lifecycle
--
-- Every FK is ON DELETE CASCADE from Club (so tenant deletion cleans up
-- cleanly) or ON DELETE RESTRICT from User/Responsibility/Employee/
-- Department (so we detect stale refs instead of silently orphaning).
--
-- See docs/tenant-admin/TA-1A-architecture.md for the full design.


-- ---------------------------------------------------------------------
-- UserClubProfile
-- ---------------------------------------------------------------------
CREATE TABLE "UserClubProfile" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "displayTitle"    TEXT,
  "departmentId"    TEXT,
  "employeeId"      TEXT,
  "status"          TEXT NOT NULL DEFAULT 'ACTIVE',
  "suspendedAt"     TIMESTAMP(3),
  "revokedAt"       TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  "createdByUserId" TEXT,
  "updatedByUserId" TEXT,
  CONSTRAINT "UserClubProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserClubProfile_employeeId_key" ON "UserClubProfile"("employeeId");
CREATE UNIQUE INDEX "UserClubProfile_clubId_userId_key" ON "UserClubProfile"("clubId", "userId");
CREATE INDEX "UserClubProfile_clubId_status_idx" ON "UserClubProfile"("clubId", "status");
CREATE INDEX "UserClubProfile_userId_idx" ON "UserClubProfile"("userId");
CREATE INDEX "UserClubProfile_departmentId_idx" ON "UserClubProfile"("departmentId");
ALTER TABLE "UserClubProfile" ADD CONSTRAINT "UserClubProfile_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserClubProfile" ADD CONSTRAINT "UserClubProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserClubProfile" ADD CONSTRAINT "UserClubProfile_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserClubProfile" ADD CONSTRAINT "UserClubProfile_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserClubProfile" ADD CONSTRAINT "UserClubProfile_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserClubProfile" ADD CONSTRAINT "UserClubProfile_updatedByUserId_fkey"
  FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------
-- Responsibility (platform-canonical catalogue)
-- ---------------------------------------------------------------------
CREATE TABLE "Responsibility" (
  "key"              TEXT NOT NULL,
  "displayLabel"     TEXT NOT NULL,
  "scopeKind"        TEXT NOT NULL DEFAULT 'CLUB',
  "cardinality"      TEXT NOT NULL DEFAULT 'SINGLE_PRIMARY',
  "description"      TEXT,
  "isSpectreDefined" BOOLEAN NOT NULL DEFAULT true,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Responsibility_pkey" PRIMARY KEY ("key")
);


-- ---------------------------------------------------------------------
-- ResponsibilityAssignment
-- ---------------------------------------------------------------------
CREATE TABLE "ResponsibilityAssignment" (
  "id"                TEXT NOT NULL,
  "clubId"            TEXT NOT NULL,
  "userId"            TEXT NOT NULL,
  "responsibilityKey" TEXT NOT NULL,
  "role"              TEXT NOT NULL DEFAULT 'PRIMARY',
  "effectiveFrom"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effectiveTo"       TIMESTAMP(3),
  "assignedByUserId"  TEXT,
  "endedByUserId"     TEXT,
  "endReason"         TEXT,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResponsibilityAssignment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ResponsibilityAssignment_clubId_responsibilityKey_role_effectiveTo_idx"
  ON "ResponsibilityAssignment"("clubId", "responsibilityKey", "role", "effectiveTo");
CREATE INDEX "ResponsibilityAssignment_userId_effectiveTo_idx"
  ON "ResponsibilityAssignment"("userId", "effectiveTo");
ALTER TABLE "ResponsibilityAssignment" ADD CONSTRAINT "ResponsibilityAssignment_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResponsibilityAssignment" ADD CONSTRAINT "ResponsibilityAssignment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResponsibilityAssignment" ADD CONSTRAINT "ResponsibilityAssignment_responsibilityKey_fkey"
  FOREIGN KEY ("responsibilityKey") REFERENCES "Responsibility"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResponsibilityAssignment" ADD CONSTRAINT "ResponsibilityAssignment_assignedByUserId_fkey"
  FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResponsibilityAssignment" ADD CONSTRAINT "ResponsibilityAssignment_endedByUserId_fkey"
  FOREIGN KEY ("endedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------
-- AdminInvitation
-- ---------------------------------------------------------------------
CREATE TABLE "AdminInvitation" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "email"           TEXT NOT NULL,
  "firstName"       TEXT,
  "lastName"        TEXT,
  "displayName"     TEXT,
  "displayTitle"    TEXT,
  "departmentId"    TEXT,
  "employeeId"      TEXT,
  "initialRoleKeys" TEXT NOT NULL,
  "bootstrap"       BOOLEAN NOT NULL DEFAULT false,
  "tokenHash"       TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'PENDING',
  "sentAt"          TIMESTAMP(3),
  "openedAt"        TIMESTAMP(3),
  "activatedAt"     TIMESTAMP(3),
  "revokedAt"       TIMESTAMP(3),
  "failedAt"        TIMESTAMP(3),
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "lastError"       TEXT,
  "sendCount"       INTEGER NOT NULL DEFAULT 0,
  "invitedByUserId" TEXT,
  "revokedByUserId" TEXT,
  "activatedUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminInvitation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminInvitation_tokenHash_key" ON "AdminInvitation"("tokenHash");
CREATE INDEX "AdminInvitation_clubId_status_idx" ON "AdminInvitation"("clubId", "status");
CREATE INDEX "AdminInvitation_email_idx" ON "AdminInvitation"("email");
ALTER TABLE "AdminInvitation" ADD CONSTRAINT "AdminInvitation_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminInvitation" ADD CONSTRAINT "AdminInvitation_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminInvitation" ADD CONSTRAINT "AdminInvitation_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminInvitation" ADD CONSTRAINT "AdminInvitation_invitedByUserId_fkey"
  FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminInvitation" ADD CONSTRAINT "AdminInvitation_revokedByUserId_fkey"
  FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminInvitation" ADD CONSTRAINT "AdminInvitation_activatedUserId_fkey"
  FOREIGN KEY ("activatedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------
-- Seed the TENANT_ADMINISTRATION responsibility.
-- ---------------------------------------------------------------------
-- TA-1B only introduces one canonical key: the Tenant Super Admin role.
-- Additional keys (PAYROLL_ADMINISTRATION, PAYROLL_FINAL_APPROVAL,
-- AP_APPROVAL, etc.) are seeded in later slices when their consumers
-- exist.
INSERT INTO "Responsibility"
  ("key", "displayLabel", "scopeKind", "cardinality", "description", "isSpectreDefined", "createdAt")
VALUES
  (
    'TENANT_ADMINISTRATION',
    'Tenant Administrator',
    'CLUB',
    'PRIMARY_AND_BACKUPS',
    'Holds Tenant Administration authority for this Club. Primary invites and manages administrative users; may assign further responsibilities. Every Club must have at least one active Primary at all times.',
    true,
    CURRENT_TIMESTAMP
  );
