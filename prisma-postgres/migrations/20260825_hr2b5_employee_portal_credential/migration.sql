-- HR-2B.5 (2026-08-19) — Employee Portal credentials + first-login tour flag
--
-- Adds the permanent Employee Portal authentication surface:
--
--   EmployeePortalCredential    — one bcrypt hash per employee
--   EmployeePortalPasswordReset — one-shot reset tokens (sha256-hashed)
--   Employee.portalTourCompletedAt — first-login tour dismissal marker
--
-- Additive-only. No back-fill required. Employees who have already
-- completed HR-2B.4 onboarding will get a credential row when they
-- next resume the portal-password step; existing rows are untouched.

CREATE TABLE "EmployeePortalCredential" (
  "id"                  TEXT NOT NULL PRIMARY KEY,
  "clubId"              TEXT NOT NULL,
  "employeeId"          TEXT NOT NULL,
  "passwordHash"        TEXT NOT NULL,
  "passwordUpdatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastLoginAt"         TIMESTAMP(3),
  "failedAttemptCount"  INTEGER NOT NULL DEFAULT 0,
  "lockedUntil"         TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeePortalCredential_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeePortalCredential_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmployeePortalCredential_employeeId_key"
  ON "EmployeePortalCredential"("employeeId");
CREATE INDEX "EmployeePortalCredential_clubId_idx"
  ON "EmployeePortalCredential"("clubId");

CREATE TABLE "EmployeePortalPasswordReset" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "clubId"      TEXT NOT NULL,
  "employeeId"  TEXT NOT NULL,
  "tokenHash"   TEXT NOT NULL,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "consumedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeePortalPasswordReset_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeePortalPasswordReset_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmployeePortalPasswordReset_tokenHash_key"
  ON "EmployeePortalPasswordReset"("tokenHash");
CREATE INDEX "EmployeePortalPasswordReset_clubId_employeeId_idx"
  ON "EmployeePortalPasswordReset"("clubId", "employeeId");

ALTER TABLE "Employee"
  ADD COLUMN "portalTourCompletedAt" TIMESTAMP(3);
