-- Slice B (2026-09-18) — pre-batch scheduled one-time earning.
-- Additive: three schema changes, none breaking.
--   1. PayrollComponent.usage — classifier for the employee-facing picker
--      (RECURRING | ONE_TIME | BOTH), defaults to RECURRING so every
--      existing catalogue row keeps its current behaviour.
--   2. New PayrollScheduledOneTimeEarning table — pre-batch scheduled
--      bonus / one-time earning per (clubId, employeeId, payPeriodId,
--      componentId).
--   3. Nothing further on PayrollBatchComponentSnapshot at the SQL layer
--      — the back-relation "sourceScheduledEarning" is expressed via a
--      unique FK from PayrollScheduledOneTimeEarning.appliedSnapshotId
--      → PayrollBatchComponentSnapshot.id (declared below), which
--      Prisma exposes as the back-relation on the snapshot side.

-- 1. Classifier on PayrollComponent.
ALTER TABLE "PayrollComponent"
  ADD COLUMN "usage" TEXT NOT NULL DEFAULT 'RECURRING';

-- 2. New table.
CREATE TABLE "PayrollScheduledOneTimeEarning" (
    "id"                 TEXT NOT NULL,
    "clubId"             TEXT NOT NULL,
    "employeeId"         TEXT NOT NULL,
    "payPeriodId"        TEXT NOT NULL,
    "componentId"        TEXT NOT NULL,
    "amount"             DECIMAL(65,30) NOT NULL,
    "currency"           TEXT,
    "reason"             TEXT NOT NULL,
    "notes"              TEXT,
    "status"             TEXT NOT NULL DEFAULT 'SCHEDULED',
    "appliedAt"          TIMESTAMP(3),
    "appliedToBatchId"   TEXT,
    "appliedSnapshotId"  TEXT,
    "cancelledAt"        TIMESTAMP(3),
    "cancelledByUserId"  TEXT,
    "cancelledReason"    TEXT,
    "enteredByUserId"    TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollScheduledOneTimeEarning_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayrollScheduledOneTimeEarning_clubId_employeeId_payPeriodId_componentId_key"
    ON "PayrollScheduledOneTimeEarning"("clubId", "employeeId", "payPeriodId", "componentId");

CREATE UNIQUE INDEX "PayrollScheduledOneTimeEarning_appliedSnapshotId_key"
    ON "PayrollScheduledOneTimeEarning"("appliedSnapshotId");

CREATE INDEX "PayrollScheduledOneTimeEarning_clubId_payPeriodId_status_idx"
    ON "PayrollScheduledOneTimeEarning"("clubId", "payPeriodId", "status");

CREATE INDEX "PayrollScheduledOneTimeEarning_clubId_employeeId_status_idx"
    ON "PayrollScheduledOneTimeEarning"("clubId", "employeeId", "status");

ALTER TABLE "PayrollScheduledOneTimeEarning"
    ADD CONSTRAINT "PayrollScheduledOneTimeEarning_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayrollScheduledOneTimeEarning"
    ADD CONSTRAINT "PayrollScheduledOneTimeEarning_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayrollScheduledOneTimeEarning"
    ADD CONSTRAINT "PayrollScheduledOneTimeEarning_payPeriodId_fkey"
    FOREIGN KEY ("payPeriodId") REFERENCES "PayrollPayPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollScheduledOneTimeEarning"
    ADD CONSTRAINT "PayrollScheduledOneTimeEarning_componentId_fkey"
    FOREIGN KEY ("componentId") REFERENCES "PayrollComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollScheduledOneTimeEarning"
    ADD CONSTRAINT "PayrollScheduledOneTimeEarning_appliedToBatchId_fkey"
    FOREIGN KEY ("appliedToBatchId") REFERENCES "PayrollBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayrollScheduledOneTimeEarning"
    ADD CONSTRAINT "PayrollScheduledOneTimeEarning_appliedSnapshotId_fkey"
    FOREIGN KEY ("appliedSnapshotId") REFERENCES "PayrollBatchComponentSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
