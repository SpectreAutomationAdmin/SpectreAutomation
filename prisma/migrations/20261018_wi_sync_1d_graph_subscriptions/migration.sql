-- WI-SYNC-1d (2026-10-18) — SQLite mirror.

ALTER TABLE "GraphSubscription" ADD COLUMN "clubId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "GraphSubscription" ADD COLUMN "lastNotificationTriggeredDeltaAt" DATETIME;
ALTER TABLE "GraphSubscription" ADD COLUMN "renewalFailureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GraphSubscription" ADD COLUMN "lastRenewalError" TEXT;

CREATE INDEX "GraphSubscription_clubId_lifecycleState_idx"
  ON "GraphSubscription"("clubId", "lifecycleState");
