-- SIGNUP-2 M3 Bank Verification (2026-10-27)
--
-- Additive, fully nullable columns on BillingCycle.  Rollback does NOT
-- drop these columns.  Zero data migration required.
--
-- Semantics:
--   stripeSetupIntentId         -- correlation anchor for setup_intent.* webhooks
--   bankVerificationMethod      -- 'INSTANT' | 'MICRODEPOSITS'
--   bankVerifiedAt              -- SetupIntent.succeeded timestamp
--   bankVerificationPendingAt   -- SetupIntent.requires_action timestamp
--   bankVerificationFailedAt    -- SetupIntent.setup_failed / canceled timestamp
--   bankVerificationExpiresAt   -- Stripe-reported arrival_date (informational)
--   bankVerificationHostedUrl   -- Stripe hosted_verification_url for microdeposit confirmation
--   bankVerificationFailureReason  -- 'STRIPE_SETUP_FAILED' | 'SIGNATORY_CANCELED' | 'STRIPE_TTL_EXCEEDED'

ALTER TABLE "BillingCycle" ADD COLUMN "stripeSetupIntentId" TEXT;
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerificationMethod" TEXT;
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerifiedAt" DATETIME;
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerificationPendingAt" DATETIME;
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerificationFailedAt" DATETIME;
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerificationExpiresAt" DATETIME;
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerificationHostedUrl" TEXT;
ALTER TABLE "BillingCycle" ADD COLUMN "bankVerificationFailureReason" TEXT;

CREATE UNIQUE INDEX "BillingCycle_stripeSetupIntentId_key" ON "BillingCycle"("stripeSetupIntentId");
CREATE INDEX "BillingCycle_stripeSetupIntentId_idx" ON "BillingCycle"("stripeSetupIntentId");
