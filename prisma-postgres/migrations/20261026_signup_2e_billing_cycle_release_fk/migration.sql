-- SIGNUP-2 Phase 2E (2026-10-26) -- BillingCycle FK + mandate pre-tenancy.
-- Postgres mirror.

ALTER TABLE "BillingCycle" ADD COLUMN "releasedByOperatorRecordId" TEXT;
ALTER TABLE "BillingCycle"
  ADD CONSTRAINT "BillingCycle_releasedByOperatorRecordId_fkey"
  FOREIGN KEY ("releasedByOperatorRecordId")
  REFERENCES "OperatorVerificationRecord"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "BillingCycle_releasedByOperatorRecordId_idx"
  ON "BillingCycle"("releasedByOperatorRecordId");

-- Relax SubscriptionPaymentMandate.clubId to NULLABLE so Phase 2E
-- can persist a signed mandate before Phase 2G provisions the Club
-- shell.  No existing rows exist on staging today (Phase 2A ships
-- the table empty); the ALTER is safe.  Phase 2G backfills clubId
-- when a Club shell is created.
ALTER TABLE "SubscriptionPaymentMandate" ALTER COLUMN "clubId" DROP NOT NULL;
