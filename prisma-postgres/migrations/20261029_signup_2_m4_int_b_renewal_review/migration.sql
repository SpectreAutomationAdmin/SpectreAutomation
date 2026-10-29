-- SIGNUP-2 M4-INT-B §3 (2026-10-29) -- Postgres migration.
-- Adds operator review decision fields to BillingRenewalPreflight.
-- Additive; nullable; rollback does NOT drop columns.

ALTER TABLE "BillingRenewalPreflight"
  ADD COLUMN "operatorReviewedByUserId" TEXT,
  ADD COLUMN "operatorReviewedAt" TIMESTAMP(3),
  ADD COLUMN "operatorReviewOutcome" TEXT,
  ADD COLUMN "operatorReviewNotes" TEXT;
