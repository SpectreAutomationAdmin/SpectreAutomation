-- SIGNUP-2 Phase 2D (2026-10-25) -- Operator verification records.
-- Postgres mirror; one new table; no existing column altered.

CREATE TABLE "OperatorVerificationRecord" (
  "id"                   TEXT PRIMARY KEY,
  "signupRegistrationId" TEXT NOT NULL,
  "concept"              TEXT NOT NULL,
  "finding"              TEXT NOT NULL,
  "evidenceSource"       TEXT,
  "evidenceProvenance"   TEXT,
  "evidenceReference"    TEXT,
  "reason"               TEXT,
  "operatorUserId"       TEXT NOT NULL,
  "operatorIp"           TEXT,
  "operatorUserAgent"    TEXT,
  "verifiedAt"           TIMESTAMP(3) NOT NULL,
  "expiresAt"            TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OperatorVerificationRecord_signupRegistrationId_fkey"
    FOREIGN KEY ("signupRegistrationId") REFERENCES "SignupRegistration"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "OperatorVerificationRecord_signupRegistrationId_createdAt_idx"
  ON "OperatorVerificationRecord"("signupRegistrationId", "createdAt");
CREATE INDEX "OperatorVerificationRecord_operatorUserId_createdAt_idx"
  ON "OperatorVerificationRecord"("operatorUserId", "createdAt");
CREATE INDEX "OperatorVerificationRecord_concept_createdAt_idx"
  ON "OperatorVerificationRecord"("concept", "createdAt");
CREATE INDEX "OperatorVerificationRecord_expiresAt_idx"
  ON "OperatorVerificationRecord"("expiresAt");
