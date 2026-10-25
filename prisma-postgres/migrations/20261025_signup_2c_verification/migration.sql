-- SIGNUP-2 Phase 2C (2026-10-25) -- Verification pipeline columns.
--
-- Postgres mirror of prisma/migrations/20261025_signup_2c_verification/
-- migration.sql.  Additive-only: five nullable columns + one
-- composite index.  Zero existing-tenant impact: pre-2C rows get
-- null on every new column, which the Phase 2C corroborator treats
-- as "verification pending" (Phase 2E will refuse to proceed on
-- null, preserving the gate).

ALTER TABLE "SignupRegistration" ADD COLUMN "verificationVerdict"       TEXT;
ALTER TABLE "SignupRegistration" ADD COLUMN "verificationDecidedAt"     TIMESTAMP(3);
ALTER TABLE "SignupRegistration" ADD COLUMN "verificationDeciderUserId" TEXT;
ALTER TABLE "SignupRegistration" ADD COLUMN "verificationHoldCategory"  TEXT;
ALTER TABLE "SignupRegistration" ADD COLUMN "signingAuthoritySignal"    TEXT;

CREATE INDEX "SignupRegistration_verificationVerdict_verificationDecidedAt_idx"
  ON "SignupRegistration"("verificationVerdict", "verificationDecidedAt");
