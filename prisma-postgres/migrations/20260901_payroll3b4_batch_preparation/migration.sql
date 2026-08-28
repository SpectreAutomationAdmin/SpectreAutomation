-- Payroll-3B-4 (2026-08-29) — structural batch preparation.
--
-- Additive-only migration:
--   * PayrollBatch gains sourceSnapshotAt (nullable timestamp).
--   * PayrollBatchEmployee gains snapshot fields (salaried,
--     employmentStartInPeriod, employmentEndInPeriod,
--     approvedHoursSnapshot, sourceFactsJson).
--   * New PayrollBatchException table for machine-readable
--     structural readiness / preparation exceptions.
--
-- No existing rows are modified. No columns dropped.

ALTER TABLE "PayrollBatch"
  ADD COLUMN IF NOT EXISTS "sourceSnapshotAt" TIMESTAMP(3);

ALTER TABLE "PayrollBatchEmployee"
  ADD COLUMN IF NOT EXISTS "salaried"                BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "employmentStartInPeriod" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "employmentEndInPeriod"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approvedHoursSnapshot"   DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "sourceFactsJson"         TEXT;

CREATE TABLE "PayrollBatchException" (
  "id"                TEXT NOT NULL,
  "clubId"            TEXT NOT NULL,
  "batchId"           TEXT NOT NULL,
  "batchEmployeeId"   TEXT,
  "employeeId"        TEXT,
  "severity"          TEXT NOT NULL,
  "code"              TEXT NOT NULL,
  "message"           TEXT NOT NULL,
  "recommendedAction" TEXT,
  "resolvedAt"        TIMESTAMP(3),
  "resolvedByUserId"  TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PayrollBatchException_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PayrollBatchException_clubId_batchId_idx"
  ON "PayrollBatchException" ("clubId", "batchId");

CREATE INDEX "PayrollBatchException_batchId_severity_idx"
  ON "PayrollBatchException" ("batchId", "severity");

CREATE INDEX "PayrollBatchException_batchEmployeeId_severity_idx"
  ON "PayrollBatchException" ("batchEmployeeId", "severity");

ALTER TABLE "PayrollBatchException"
  ADD CONSTRAINT "PayrollBatchException_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollBatchException"
  ADD CONSTRAINT "PayrollBatchException_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "PayrollBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayrollBatchException"
  ADD CONSTRAINT "PayrollBatchException_batchEmployeeId_fkey"
  FOREIGN KEY ("batchEmployeeId") REFERENCES "PayrollBatchEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayrollBatchException"
  ADD CONSTRAINT "PayrollBatchException_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
