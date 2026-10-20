-- SIGNUP-1 (2026-10-19) — self-service club registration.
--
-- Two new tables.  Zero FK to User / Club / UserClubRole / ClubSubscription —
-- SIGNUP-1 does NOT provision tenants.  Provisioning happens in SIGNUP-3
-- under its own reviewed slice and will carry the FKs there.

CREATE TABLE "SignupRegistration" (
    "id"                           TEXT NOT NULL,
    "resumeTokenHash"              TEXT NOT NULL,
    "emailResumeTokenHash"         TEXT,
    "emailResumeTokenExpiresAt"    TIMESTAMP(3),

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
    "adminVerifiedAt"              TIMESTAMP(3),

    "step"                         TEXT NOT NULL DEFAULT 'IDENTITY',
    "status"                       TEXT NOT NULL DEFAULT 'DRAFT',

    "ownershipVerificationState"   TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "ownershipAutomatedCheckJson"  TEXT,
    "ownershipNote"                TEXT,

    "startedByIp"                  TEXT,
    "startedUserAgent"             TEXT,
    "expiresAt"                    TIMESTAMP(3) NOT NULL,
    "completedAt"                  TIMESTAMP(3),
    "createdAt"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignupRegistration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SignupRegistration_resumeTokenHash_key"
  ON "SignupRegistration" ("resumeTokenHash");
CREATE UNIQUE INDEX "SignupRegistration_emailResumeTokenHash_key"
  ON "SignupRegistration" ("emailResumeTokenHash");
CREATE INDEX "SignupRegistration_status_expiresAt_idx"
  ON "SignupRegistration" ("status", "expiresAt");
CREATE INDEX "SignupRegistration_adminMicrosoftOid_status_idx"
  ON "SignupRegistration" ("adminMicrosoftOid", "status");
CREATE INDEX "SignupRegistration_ownershipVerificationState_idx"
  ON "SignupRegistration" ("ownershipVerificationState");
CREATE INDEX "SignupRegistration_legalNameNormalized_idx"
  ON "SignupRegistration" ("legalNameNormalized");
CREATE INDEX "SignupRegistration_operatingNameNormalized_idx"
  ON "SignupRegistration" ("operatingNameNormalized");

CREATE TABLE "SignupOAuthTransaction" (
    "id"             TEXT NOT NULL,
    "state"          TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "pkceVerifier"   TEXT NOT NULL,
    "nonce"          TEXT NOT NULL,
    "returnPath"     TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"      TIMESTAMP(3) NOT NULL,
    "consumedAt"     TIMESTAMP(3),
    "outcome"        TEXT,

    CONSTRAINT "SignupOAuthTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SignupOAuthTransaction_state_key"
  ON "SignupOAuthTransaction" ("state");
CREATE INDEX "SignupOAuthTransaction_registrationId_createdAt_idx"
  ON "SignupOAuthTransaction" ("registrationId", "createdAt");
CREATE INDEX "SignupOAuthTransaction_expiresAt_idx"
  ON "SignupOAuthTransaction" ("expiresAt");

ALTER TABLE "SignupOAuthTransaction"
  ADD CONSTRAINT "SignupOAuthTransaction_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "SignupRegistration" ("id") ON DELETE CASCADE;
