-- SIGNUP-1F (2026-10-20) — SQLite mirror of the Postgres migration.
-- Separates email-delivered recovery credentials from the persistent
-- SignupRegistration record.

CREATE TABLE "SignupRecoveryLink" (
    "id"              TEXT NOT NULL PRIMARY KEY,
    "registrationId"  TEXT NOT NULL,
    "tokenHash"       TEXT NOT NULL,
    "issuedAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"       DATETIME NOT NULL,
    "consumedAt"      DATETIME,
    "revokedAt"       DATETIME,
    "revokeReason"    TEXT,
    "issuedToEmail"   TEXT NOT NULL,
    "issuedByIp"      TEXT,
    "consumedByIp"    TEXT,
    CONSTRAINT "SignupRecoveryLink_registrationId_fkey"
        FOREIGN KEY ("registrationId")
        REFERENCES "SignupRegistration"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SignupRecoveryLink_tokenHash_key"
    ON "SignupRecoveryLink"("tokenHash");

CREATE INDEX "SignupRecoveryLink_registrationId_issuedAt_idx"
    ON "SignupRecoveryLink"("registrationId", "issuedAt");

CREATE INDEX "SignupRecoveryLink_expiresAt_idx"
    ON "SignupRecoveryLink"("expiresAt");
