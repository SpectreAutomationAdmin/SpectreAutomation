-- Slice E closeout (2026-09-19) — historical identity snapshot for
-- payroll documents. Nullable so legacy batches pre-dating this slice
-- fall back to live Employee.firstName/lastName; new batches at Prepare
-- freeze the display name here.

ALTER TABLE "PayrollBatchEmployee"
  ADD COLUMN "firstNameSnapshot" TEXT,
  ADD COLUMN "lastNameSnapshot"  TEXT;
