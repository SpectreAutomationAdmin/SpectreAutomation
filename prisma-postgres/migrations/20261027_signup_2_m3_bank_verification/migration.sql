-- SIGNUP-2 M3 Bank Verification (2026-10-27) -- Postgres mirror.
--
-- Additive, fully nullable columns on BillingCycle.  Rollback does NOT
-- drop these columns.  Zero data migration required.

ALTER TABLE "BillingCycle" ADD COLUMN "stripeSetupIntentId" TEXT;
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerificationMethod" TEXT;
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerifiedAt" TIMESTAMP(3);
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerificationPendingAt" TIMESTAMP(3);
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerificationFailedAt" TIMESTAMP(3);
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerificationExpiresAt" TIMESTAMP(3);
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerificationHostedUrl" TEXT;
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerificationFailureReason" TEXT;

CREATE UNIQUE INDEX "BillingCycle_stripeSetupIntentId_key" ON "BillingCycle"("stripeSetupIntentId");
CREATE INDEX "BillingCycle_stripeSetupIntentId_idx" ON "BillingCycle"("stripeSetupIntentId");
