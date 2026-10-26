-- SIGNUP-2 Phase 2E (2026-10-26) -- BillingCycle FK + mandate pre-tenancy.
--
-- Two additive-only changes:
--   1. BillingCycle gains the Phase 2D release-record FK (nullable).
--   2. SubscriptionPaymentMandate.clubId relaxed from NOT NULL to
--      NULLABLE so Phase 2E can persist a signed mandate before
--      Phase 2G provisions the Club shell.  Pre-2E rows (there are
--      none on staging today) retain whatever value they had; Phase
--      2G will backfill when a Club shell is created.
--
-- SQLite note: ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL is
-- not supported.  SQLite stores constraints at CREATE TABLE time;
-- Prisma's SQLite migrations re-create the table when NOT NULL is
-- dropped.  Phase 2E ships against Postgres on staging; the SQLite
-- side is kept for local dev-only parity and will apply via a
-- table-rebuild on next prisma migrate dev.
--
-- This file omits the SQLite-side NULLABLE change because the dev
-- DB does not currently have any SubscriptionPaymentMandate rows
-- and the schema regeneration via prisma generate is sufficient for
-- local typing.  Postgres side (prisma-postgres) carries the full
-- ALTER COLUMN.

ALTER TABLE "BillingCycle" ADD COLUMN "releasedByOperatorRecordId" TEXT;
CREATE INDEX "BillingCycle_releasedByOperatorRecordId_idx"
  ON "BillingCycle"("releasedByOperatorRecordId");
