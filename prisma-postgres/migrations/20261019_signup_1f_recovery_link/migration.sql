-- SIGNUP-1F (2026-10-20) — Dedicated recovery-link table.
-- Separates email-delivered recovery credentials from the persistent
-- SignupRegistration record.  Short-lived, single-use, revocable.

CREATE TABLE "SignupRecoveryLink" (
    "id"              TEXT NOT NULL,
    "registrationId"  TEXT NOT NULL,
    "tokenHash"       TEXT NOT NULL,
    "issuedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "consumedAt"      TIMESTAMP(3),
    "revokedAt"       TIMESTAMP(3),
    "revokeReason"    TEXT,
    "issuedToEmail"   TEXT NOT NULL,
    "issuedByIp"      TEXT,
    "consumedByIp"    TEXT,

    CONSTRAINT "SignupRecoveryLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SignupRecoveryLink_tokenHash_key"
    ON "SignupRecoveryLink"("tokenHash");

CREATE INDEX "SignupRecoveryLink_registrationId_issuedAt_idx"
    ON "SignupRecoveryLink"("registrationId", "issuedAt");

CREATE INDEX "SignupRecoveryLink_expiresAt_idx"
    ON "SignupRecoveryLink"("expiresAt");

ALTER TABLE "SignupRecoveryLink"
    ADD CONSTRAINT "SignupRecoveryLink_registrationId_fkey"
    FOREIGN KEY ("registrationId")
    REFERENCES "SignupRegistration"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
