-- SIGNUP-2 M2-SyntheticSandbox (2026-10-27)
-- Add syntheticTestOnly marker column to the five tables that
-- participate in the pre-tenancy signup chain.  Default false
-- (production path).  Written true ONLY by
-- `signup-2m2-synthetic-sandbox-service.ts`.  Phase 2F / 2G / 2H
-- production paths refuse any row carrying this marker.
--
-- Idempotent-safe: uses ADD COLUMN IF NOT EXISTS where supported;
-- for Postgres <= 11 compatibility, the "IF NOT EXISTS" is omitted
-- and the migration is applied once (as always).

-- SignupRegistration
ALTER TABLE "SignupRegistration" ADD COLUMN "syntheticTestOnly" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "SignupRegistration_syntheticTestOnly_idx" ON "SignupRegistration"("syntheticTestOnly");

-- SubscriptionAuthorisationAttestation
ALTER TABLE "SubscriptionAuthorisationAttestation" ADD COLUMN "syntheticTestOnly" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "SubscriptionAuthorisationAttestation_syntheticTestOnly_idx" ON "SubscriptionAuthorisationAttestation"("syntheticTestOnly");

-- SubscriptionPaymentMandate
ALTER TABLE "SubscriptionPaymentMandate" ADD COLUMN "syntheticTestOnly" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "SubscriptionPaymentMandate_syntheticTestOnly_idx" ON "SubscriptionPaymentMandate"("syntheticTestOnly");

-- OperatorVerificationRecord
ALTER TABLE "OperatorVerificationRecord" ADD COLUMN "syntheticTestOnly" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "OperatorVerificationRecord_syntheticTestOnly_idx" ON "OperatorVerificationRecord"("syntheticTestOnly");

-- BillingCycle
ALTER TABLE "BillingCycle" ADD COLUMN "syntheticTestOnly" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "BillingCycle_syntheticTestOnly_idx" ON "BillingCycle"("syntheticTestOnly");
