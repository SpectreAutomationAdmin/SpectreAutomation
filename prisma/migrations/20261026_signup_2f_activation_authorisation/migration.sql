-- SIGNUP-2 Phase 2F (2026-10-26) -- Activation authorisation evidence.
-- Additive-only: 4 new nullable columns + 2 indexes on
-- TenantProvisioningJob.  Pre-2F rows get null for every new column.
--
-- SQLite note: ALTER TABLE ... DROP NOT NULL on clubSubscriptionClubId
-- would require a table rebuild in SQLite; Phase 2A seeded zero rows
-- on dev (TenantProvisioningJob is a Phase-2G-written table on
-- staging + prod), so the dev schema simply regenerates via `prisma
-- generate` with the relaxed NOT NULL.  Postgres side carries the
-- full ALTER COLUMN below.

ALTER TABLE "TenantProvisioningJob" ADD COLUMN "authorisationEvidenceSource" TEXT;
ALTER TABLE "TenantProvisioningJob" ADD COLUMN "authorisationExpiresAt"      DATETIME;
ALTER TABLE "TenantProvisioningJob" ADD COLUMN "invalidatedAt"               DATETIME;
ALTER TABLE "TenantProvisioningJob" ADD COLUMN "invalidatedReason"           TEXT;

CREATE INDEX "TenantProvisioningJob_authorisationEvidenceSource_idx"
  ON "TenantProvisioningJob"("authorisationEvidenceSource");
CREATE INDEX "TenantProvisioningJob_invalidatedAt_idx"
  ON "TenantProvisioningJob"("invalidatedAt");
