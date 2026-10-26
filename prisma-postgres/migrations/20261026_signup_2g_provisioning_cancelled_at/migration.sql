-- SIGNUP-2 Phase 2G (2026-10-26) -- provisioning-cancellation sentinel.
-- Postgres mirror.  Additive-only; nullable.
-- Stamped by Phase 2G when a mid-provisioning reversal/invalidation
-- cancels the job; posting-guard refuses operational writes on
-- rows with the sentinel set.  Pre-SIGNUP-2 rows remain null.

ALTER TABLE "User"             ADD COLUMN "provisioningCancelledAt" TIMESTAMP(3);
ALTER TABLE "Club"             ADD COLUMN "provisioningCancelledAt" TIMESTAMP(3);
ALTER TABLE "ClubSubscription" ADD COLUMN "provisioningCancelledAt" TIMESTAMP(3);

CREATE INDEX "User_provisioningCancelledAt_idx"             ON "User"("provisioningCancelledAt");
CREATE INDEX "Club_provisioningCancelledAt_idx"             ON "Club"("provisioningCancelledAt");
CREATE INDEX "ClubSubscription_provisioningCancelledAt_idx" ON "ClubSubscription"("provisioningCancelledAt");
