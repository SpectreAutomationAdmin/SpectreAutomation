-- SIGNUP-2 M4-INT-B §3 (2026-10-29) -- SQLite (dev) mirror.
-- Additive nullable columns on BillingRenewalPreflight.

ALTER TABLE "BillingRenewalPreflight" ADD COLUMN "operatorReviewedByUserId" TEXT;
ALTER TABLE "BillingRenewalPreflight" ADD COLUMN "operatorReviewedAt" DATETIME;
ALTER TABLE "BillingRenewalPreflight" ADD COLUMN "operatorReviewOutcome" TEXT;
ALTER TABLE "BillingRenewalPreflight" ADD COLUMN "operatorReviewNotes" TEXT;
