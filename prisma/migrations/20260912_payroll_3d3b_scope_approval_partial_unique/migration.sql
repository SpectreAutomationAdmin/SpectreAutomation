-- Payroll-3D-3B Slice 7 (2026-09-06) — SQLite parity for the
-- timesheet-approval scope partial-unique.
--
-- Mirror of prisma-postgres/migrations/20260912_payroll_3d3b_scope_approval_partial_unique/migration.sql
-- without the PL/pgSQL pre-check (SQLite has no DO block).

CREATE UNIQUE INDEX "WorkIntakeOrigin_timesheet_approval_primary_key"
  ON "WorkIntakeOrigin" ("clubId", "kind", "referenceId")
  WHERE "role" = 'PRIMARY'
    AND "kind" IN (
      'PAYROLL_TIMESHEET_APPROVAL',
      'PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP'
    );
