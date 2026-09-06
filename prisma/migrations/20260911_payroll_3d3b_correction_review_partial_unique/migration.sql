-- Payroll-3D-3B Slice 1 (2026-09-06) — SQLite parity for the
-- correction-review partial-unique.
--
-- Mirror of prisma-postgres/migrations/20260911_payroll_3d3b_correction_review_partial_unique/migration.sql
-- with two adaptations:
--   1. SQLite has no PL/pgSQL DO blocks. The pre-check is a plain
--      SELECT ... assertion via a CHECK-style approach that would
--      require pragmas we don't want to introduce mid-schema; the
--      Postgres side carries the hard guard. This file relies on
--      convention (the two kinds don't exist yet in local/dev/test
--      data) and on the application-level idempotency shim in
--      src/lib/work-intake/origin-conflict.ts.
--   2. SQLite supports "CREATE UNIQUE INDEX ... WHERE ..." with IN
--      predicates natively (v3.8+); the DDL is otherwise identical.

CREATE UNIQUE INDEX "WorkIntakeOrigin_timeclock_correction_primary_key"
  ON "WorkIntakeOrigin" ("clubId", "kind", "referenceId")
  WHERE "role" = 'PRIMARY'
    AND "kind" IN (
      'TIMECLOCK_CORRECTION_REVIEW',
      'TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP'
    );
