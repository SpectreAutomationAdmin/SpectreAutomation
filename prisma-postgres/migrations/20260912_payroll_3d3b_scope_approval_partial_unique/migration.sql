-- Payroll-3D-3B Slice 7 (2026-09-06) — race-safe idempotency for the
-- department timesheet-approval WorkIntakeOrigin rows (§4 / §5).
--
-- Enforces a partial-unique on (clubId, kind, referenceId) filtered
-- to role='PRIMARY' AND kind IN
--   ('PAYROLL_TIMESHEET_APPROVAL', 'PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP').
--
-- Pattern mirrors Slice 1's TIMECLOCK_CORRECTION_REVIEW guarantee:
-- narrow, kind-filtered, does NOT touch the pre-existing convention
-- for INGESTED_DOCUMENT / any other origin kind. See Slice 0A audit
-- and docs/backlog/{work-intake-primary-origin-uniqueness.md,
-- ap-intake-ingested-document-dual-writer.md}.
--
-- SAFETY — the pre-check DO block ABORTS if any duplicate tuple
-- exists today. The migration will NEVER silently delete or dedupe
-- data; a human must reconcile duplicates before applying.

-- 1. Pre-check: fail loudly if any existing rows already violate the
--    invariant.
DO $$
DECLARE
  duplicate_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO duplicate_count FROM (
    SELECT "clubId", "kind", "referenceId"
    FROM "WorkIntakeOrigin"
    WHERE "role" = 'PRIMARY'
      AND "kind" IN (
        'PAYROLL_TIMESHEET_APPROVAL',
        'PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP'
      )
    GROUP BY "clubId", "kind", "referenceId"
    HAVING COUNT(*) > 1
  ) dupes;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'Payroll-3D-3B Slice 7 migration aborted: found % duplicate PRIMARY origin tuple(s) for PAYROLL_TIMESHEET_APPROVAL / PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP. Reconcile before re-running.',
      duplicate_count;
  END IF;
END $$;

-- 2. Apply the partial unique.
CREATE UNIQUE INDEX "WorkIntakeOrigin_timesheet_approval_primary_key"
  ON "WorkIntakeOrigin" ("clubId", "kind", "referenceId")
  WHERE "role" = 'PRIMARY'
    AND "kind" IN (
      'PAYROLL_TIMESHEET_APPROVAL',
      'PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP'
    );
