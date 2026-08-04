-- Sprint 3 · Checkpoint 16G Stage A (2026-08-04) — Club.timezone.
--
-- Nullable IANA timezone identifier. Onboarding must set it
-- explicitly for every new club; there is no global default. All
-- Mission Control "today" / "since midnight" / "overnight"
-- calculations resolve against this field.
--
-- Coulee Ridge (staging FOUNDER_REVIEW tenant) is initialised to
-- America/Edmonton per founder decision.

ALTER TABLE "Club" ADD COLUMN "timezone" TEXT;

-- Backfill Coulee Ridge only. Other staging test clubs remain NULL
-- and will fall back to UTC with a "timezone not configured" warning
-- until onboarding sets them.
UPDATE "Club"
   SET "timezone" = 'America/Edmonton'
 WHERE "id" = 'cmrvdeny7000144372ktmmg9c';
