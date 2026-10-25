-- SIGNUP-2 Phase 2C (2026-10-25) -- Verification pipeline columns.
--
-- Adds five nullable columns + one composite index to the existing
-- SignupRegistration table.  Every column is additive and nullable;
-- no breaking change; no column rename; no column removal.
--
-- SQLite note: Prisma Migrate's SQLite driver does ALTER TABLE ADD
-- COLUMN cleanly for nullable columns.  No table rebuild needed.

ALTER TABLE "SignupRegistration" ADD COLUMN "verificationVerdict" TEXT;
ALTER TABLE "SignupRegistration" ADD COLUMN "verificationDecidedAt" DATETIME;
ALTER TABLE "SignupRegistration" ADD COLUMN "verificationDeciderUserId" TEXT;
ALTER TABLE "SignupRegistration" ADD COLUMN "verificationHoldCategory" TEXT;
ALTER TABLE "SignupRegistration" ADD COLUMN "signingAuthoritySignal" TEXT;

-- Composite index for the Phase 2H operator inbox query
-- (verdict + decidedAt).  Partial filter is not required at the
-- SQLite layer; filtering by non-null verdict is cheap enough.
CREATE INDEX "SignupRegistration_verificationVerdict_verificationDecidedAt_idx"
  ON "SignupRegistration"("verificationVerdict", "verificationDecidedAt");
