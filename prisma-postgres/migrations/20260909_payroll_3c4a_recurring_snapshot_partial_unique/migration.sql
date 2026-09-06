-- Payroll-3C-4A (2026-09-09) — hard database-level guarantee that a
-- given recurring assignment cannot be snapshotted more than once
-- for the same batch employee. Application-level find-first-then-write
-- is not sufficient under concurrency.
--
-- One-time adjustments carry sourceAssignmentId = NULL and are
-- deliberately excluded from this constraint (an employee can have
-- many one-time rows on the same batch).

CREATE UNIQUE INDEX IF NOT EXISTS
  "PayrollBatchComponentSnapshot_recurring_assignment_unique"
ON "PayrollBatchComponentSnapshot" ("batchEmployeeId", "sourceAssignmentId")
WHERE "sourceAssignmentId" IS NOT NULL;
