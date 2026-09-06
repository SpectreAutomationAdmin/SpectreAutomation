-- Payroll-3D-3B Slice 1 (2026-09-06) — race-safe idempotency for
-- correction-review WorkIntakeOrigin rows.
--
-- Enforces a partial-unique on (clubId, kind, referenceId) filtered to
-- role='PRIMARY' AND kind IN the two correction-review kinds. This
-- guarantees "one PENDING correction → one canonical WorkIntakeItem"
-- at the DB level, closing the race that the findFirst-then-create
-- convention leaves open under concurrent producers.
--
-- SCOPE — narrow by explicit founder decision:
--   The constraint applies ONLY to
--     TIMECLOCK_CORRECTION_REVIEW
--     TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP
--   Every other WorkIntakeOrigin.kind is intentionally UNCHANGED. A
--   global variant would break the AP INGESTED_DOCUMENT dual-writer
--   pattern (AP invoice + AP statement materialisers) — tracked in
--   docs/backlog/ap-intake-ingested-document-dual-writer.md. The
--   broader platform-hardening slice is tracked in
--   docs/backlog/work-intake-primary-origin-uniqueness.md.
--
-- SAFETY — the pre-check DO block ABORTS the migration if any
-- duplicate tuple exists today for either kind. The migration will
-- NEVER silently delete or dedupe data; a human must reconcile
-- duplicates before applying.
--
-- Prisma migration mechanics — raw SQL only. Prisma cannot express
-- partial unique in schema.prisma. Precedent for raw-SQL partial
-- unique in this repo:
--   prisma-postgres/migrations/20260817_hr1h_banking_verified_partial_unique/migration.sql
--   prisma-postgres/migrations/20260830_hr_hotfix_dupe_fingerprints/migration.sql

-- 1. Pre-check: fail loudly if any existing rows already violate the
--    invariant. Zero rows today expected (the two kinds are new).
DO $$
DECLARE
  duplicate_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO duplicate_count FROM (
    SELECT "clubId", "kind", "referenceId"
    FROM "WorkIntakeOrigin"
    WHERE "role" = 'PRIMARY'
      AND "kind" IN (
        'TIMECLOCK_CORRECTION_REVIEW',
        'TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP'
      )
    GROUP BY "clubId", "kind", "referenceId"
    HAVING COUNT(*) > 1
  ) dupes;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'Payroll-3D-3B Slice 1 migration aborted: found % duplicate PRIMARY origin tuple(s) for TIMECLOCK_CORRECTION_REVIEW / TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP. Reconcile before re-running.',
      duplicate_count;
  END IF;
END $$;

-- 2. Apply the partial unique.
CREATE UNIQUE INDEX "WorkIntakeOrigin_timeclock_correction_primary_key"
  ON "WorkIntakeOrigin" ("clubId", "kind", "referenceId")
  WHERE "role" = 'PRIMARY'
    AND "kind" IN (
      'TIMECLOCK_CORRECTION_REVIEW',
      'TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP'
    );
