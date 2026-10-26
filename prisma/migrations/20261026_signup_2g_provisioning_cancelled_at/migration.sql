-- SIGNUP-2 Phase 2G (2026-10-26) -- provisioning-cancellation sentinel.
-- SQLite dev schema.  Additive-only; nullable.
-- Stamped by Phase 2G when a mid-provisioning reversal/invalidation
-- cancels the job; posting-guard refuses operational writes on
-- rows with the sentinel set.  Pre-SIGNUP-2 rows remain null.

ALTER TABLE "User"             ADD COLUMN "provisioningCancelledAt" DATETIME;
ALTER TABLE "Club"             ADD COLUMN "provisioningCancelledAt" DATETIME;
ALTER TABLE "ClubSubscription" ADD COLUMN "provisioningCancelledAt" DATETIME;
