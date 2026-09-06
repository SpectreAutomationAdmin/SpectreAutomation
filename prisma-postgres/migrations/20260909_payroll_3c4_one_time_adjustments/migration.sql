-- Payroll-3C-4 (2026-09-09) — one-time payroll adjustments on top
-- of the existing PayrollBatchComponentSnapshot model.
--
-- Additive changes:
--   • `sourceAssignmentId` → nullable (one-time adjustments have no
--     recurring EmployeeRecurringPayrollComponent backing them).
--   • `provenance` (RECURRING_EMPLOYEE_SETUP | ONE_TIME_PAYROLL_ADJUSTMENT)
--     — every existing row is RECURRING by definition.
--   • `enteredByUserId` — the Payroll Admin who added a one-time row.
--   • `reason` — required for ONE_TIME rows (enforced in service).
--   • Drop the strict uniqueness on (batchEmployeeId, sourceAssignmentId)
--     and replace with an index. One-time rows carry NULL there and
--     multiple such rows may exist per batch employee.
--
-- Legacy models untouched.

ALTER TABLE "PayrollBatchComponentSnapshot" ALTER COLUMN "sourceAssignmentId" DROP NOT NULL;
ALTER TABLE "PayrollBatchComponentSnapshot" ADD COLUMN "provenance" TEXT NOT NULL DEFAULT 'RECURRING_EMPLOYEE_SETUP';
ALTER TABLE "PayrollBatchComponentSnapshot" ADD COLUMN "enteredByUserId" TEXT;
ALTER TABLE "PayrollBatchComponentSnapshot" ADD COLUMN "reason" TEXT;

DROP INDEX IF EXISTS "PayrollBatchComponentSnapshot_batchEmployeeId_sourceAssignmentId_key";
ALTER TABLE "PayrollBatchComponentSnapshot"
  DROP CONSTRAINT IF EXISTS "PayrollBatchComponentSnapshot_batchEmployeeId_sourceAssignmentId_key";

CREATE INDEX "PayrollBatchComponentSnapshot_batchEmployeeId_sourceAssignmentId_idx"
  ON "PayrollBatchComponentSnapshot"("batchEmployeeId", "sourceAssignmentId");
CREATE INDEX "PayrollBatchComponentSnapshot_batchEmployeeId_provenance_idx"
  ON "PayrollBatchComponentSnapshot"("batchEmployeeId", "provenance");
