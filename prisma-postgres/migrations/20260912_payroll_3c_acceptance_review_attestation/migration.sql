-- Payroll-3C-acceptance (2026-09-12) — governance review attestation.
--
-- Additive migration. Creates ONE new table, TWO indexes. Zero
-- destructive changes. No enum types. No ALTER on existing tables.
--
-- The application layer treats a row with `invalidatedAt IS NULL`
-- as the CURRENT attestation for (batchId, dimension); every other
-- row is a historical / superseded attestation preserved for audit.
-- The mutation that supersedes an attestation sets `invalidatedAt`
-- + `invalidatedByReason` atomically with the write that caused
-- it, so the CURRENT attestation always reflects the current
-- dataset revision.

CREATE TABLE "PayrollBatchReviewAttestation" (
  "id"                  TEXT NOT NULL,
  "clubId"              TEXT NOT NULL,
  "batchId"             TEXT NOT NULL,
  "dimension"           TEXT NOT NULL,
  "fingerprint"         TEXT NOT NULL,
  "attestedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attestedByUserId"    TEXT NOT NULL,
  "invalidatedAt"       TIMESTAMP(3),
  "invalidatedByReason" TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PayrollBatchReviewAttestation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PayrollBatchReviewAttestation"
  ADD CONSTRAINT "PayrollBatchReviewAttestation_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollBatchReviewAttestation"
  ADD CONSTRAINT "PayrollBatchReviewAttestation_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "PayrollBatch"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "PayrollBatchReviewAttestation_clubId_batchId_dimension_idx"
  ON "PayrollBatchReviewAttestation" ("clubId", "batchId", "dimension");

CREATE INDEX "PayrollBatchReviewAttestation_batchId_dimension_invalid_idx"
  ON "PayrollBatchReviewAttestation" ("batchId", "dimension", "invalidatedAt");
