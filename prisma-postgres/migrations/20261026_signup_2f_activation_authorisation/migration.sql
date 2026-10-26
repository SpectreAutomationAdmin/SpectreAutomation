-- SIGNUP-2 Phase 2F (2026-10-26) -- Activation authorisation evidence.
-- Postgres mirror.  Additive-only.

ALTER TABLE "TenantProvisioningJob" ADD COLUMN "authorisationEvidenceSource" TEXT;
ALTER TABLE "TenantProvisioningJob" ADD COLUMN "authorisationExpiresAt"      TIMESTAMP(3);
ALTER TABLE "TenantProvisioningJob" ADD COLUMN "invalidatedAt"               TIMESTAMP(3);
ALTER TABLE "TenantProvisioningJob" ADD COLUMN "invalidatedReason"           TEXT;

CREATE INDEX "TenantProvisioningJob_authorisationEvidenceSource_idx"
  ON "TenantProvisioningJob"("authorisationEvidenceSource");
CREATE INDEX "TenantProvisioningJob_invalidatedAt_idx"
  ON "TenantProvisioningJob"("invalidatedAt");

-- Relax clubSubscriptionClubId to NULLABLE so Phase 2F can create
-- the authorisation BEFORE Phase 2G provisions the Club shell.
-- The TenantProvisioningJob table is empty on staging today (Phase
-- 2A seeded no rows); the ALTER is safe.
ALTER TABLE "TenantProvisioningJob" ALTER COLUMN "clubSubscriptionClubId" DROP NOT NULL;
