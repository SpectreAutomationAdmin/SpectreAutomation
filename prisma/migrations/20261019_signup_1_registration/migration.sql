-- SIGNUP-1 (2026-10-19) — SQLite mirror of the Postgres migration.

CREATE TABLE "SignupRegistration" (
    "id"                           TEXT NOT NULL PRIMARY KEY,
    "resumeTokenHash"              TEXT NOT NULL,
    "emailResumeTokenHash"         TEXT,
    "emailResumeTokenExpiresAt"    DATETIME,
    "legalName"                    TEXT NOT NULL,
    "legalNameNormalized"          TEXT NOT NULL,
    "operatingName"                TEXT,
    "operatingNameNormalized"      TEXT,
    "country"                      TEXT NOT NULL,
    "provinceState"                TEXT NOT NULL,
    "addressLine1"                 TEXT NOT NULL,
    "addressLine2"                 TEXT,
    "city"                         TEXT NOT NULL,
    "postalCode"                   TEXT NOT NULL,
    "websiteUrl"                   TEXT,
    "adminEmail"                   TEXT,
    "adminMicrosoftOid"            TEXT,
    "adminMicrosoftTenantId"       TEXT,
    "adminDisplayName"             TEXT,
    "adminGivenName"               TEXT,
    "adminSurname"                 TEXT,
    "adminPosition"                TEXT,
    "adminVerifiedAt"              DATETIME,
    "step"                         TEXT NOT NULL DEFAULT 'IDENTITY',
    "status"                       TEXT NOT NULL DEFAULT 'DRAFT',
    "ownershipVerificationState"   TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "ownershipAutomatedCheckJson"  TEXT,
    "ownershipNote"                TEXT,
    "startedByIp"                  TEXT,
    "startedUserAgent"             TEXT,
    "expiresAt"                    DATETIME NOT NULL,
    "completedAt"                  DATETIME,
    "createdAt"                    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                    DATETIME NOT NULL
);
CREATE UNIQUE INDEX "SignupRegistration_resumeTokenHash_key"      ON "SignupRegistration" ("resumeTokenHash");
CREATE UNIQUE INDEX "SignupRegistration_emailResumeTokenHash_key" ON "SignupRegistration" ("emailResumeTokenHash");
CREATE INDEX "SignupRegistration_status_expiresAt_idx"            ON "SignupRegistration" ("status", "expiresAt");
CREATE INDEX "SignupRegistration_adminMicrosoftOid_status_idx"    ON "SignupRegistration" ("adminMicrosoftOid", "status");
CREATE INDEX "SignupRegistration_ownershipVerificationState_idx"  ON "SignupRegistration" ("ownershipVerificationState");
CREATE INDEX "SignupRegistration_legalNameNormalized_idx"         ON "SignupRegistration" ("legalNameNormalized");
CREATE INDEX "SignupRegistration_operatingNameNormalized_idx"     ON "SignupRegistration" ("operatingNameNormalized");

CREATE TABLE "SignupOAuthTransaction" (
    "id"             TEXT NOT NULL PRIMARY KEY,
    "state"          TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "pkceVerifier"   TEXT NOT NULL,
    "nonce"          TEXT NOT NULL,
    "returnPath"     TEXT NOT NULL,
    "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"      DATETIME NOT NULL,
    "consumedAt"     DATETIME,
    "outcome"        TEXT,
    CONSTRAINT "SignupOAuthTransaction_registrationId_fkey"
      FOREIGN KEY ("registrationId") REFERENCES "SignupRegistration" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "SignupOAuthTransaction_state_key"                      ON "SignupOAuthTransaction" ("state");
CREATE INDEX "SignupOAuthTransaction_registrationId_createdAt_idx"          ON "SignupOAuthTransaction" ("registrationId", "createdAt");
CREATE INDEX "SignupOAuthTransaction_expiresAt_idx"                         ON "SignupOAuthTransaction" ("expiresAt");
