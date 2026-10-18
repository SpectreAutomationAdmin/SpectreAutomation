-- WI-SYNC-1d (2026-10-18) — Graph change-notification subscription
-- lifecycle + observability columns.
--
--   * clubId — tenant denorm so webhook validation can tenant-
--     check without joining the mailbox row.
--   * lastNotificationTriggeredDeltaAt — when the most recent
--     incoming notification triggered an expedited delta enqueue.
--   * renewalFailureCount — consecutive renewal failures since
--     the last successful renew; reset to 0 on success.
--   * lastRenewalError — most recent renew/recreate failure.

-- The GraphSubscription table has zero rows on staging today (per
-- the WI-SYNC-1a audit).  Backfilling `clubId` is therefore a
-- no-op; we add the column NOT NULL + default an empty string
-- which the first subscription-creation service call overwrites.
ALTER TABLE "GraphSubscription"
  ADD COLUMN "clubId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "lastNotificationTriggeredDeltaAt" TIMESTAMP(3),
  ADD COLUMN "renewalFailureCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastRenewalError" TEXT;

CREATE INDEX "GraphSubscription_clubId_lifecycleState_idx"
  ON "GraphSubscription" ("clubId", "lifecycleState");
