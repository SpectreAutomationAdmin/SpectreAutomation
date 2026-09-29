-- TB-RESET-1d.b (2026-09-29) — SQLite mirror of the postgres migration.
-- See prisma-postgres/migrations/20260929_tb_reset_1db_source_hash for
-- the full narrative.
--
-- Note: SQLite cannot ADD a REFERENCES constraint via ALTER TABLE;
-- FK enforcement on new self-referential columns is a soft
-- invariant at the SQLite dev tier (Prisma still generates the
-- correct client typings from schema.prisma). Postgres staging
-- enforces the FK properly.

ALTER TABLE "ReportingLedgerBatch" ADD COLUMN "sourceFileHash" TEXT;
ALTER TABLE "ReportingLedgerBatch" ADD COLUMN "supersededByBatchId" TEXT;
ALTER TABLE "ReportingLedgerBatch" ADD COLUMN "createdByUserId" TEXT;

CREATE INDEX "ReportingLedgerBatch_clubId_sourceFileHash_idx"
  ON "ReportingLedgerBatch"("clubId", "sourceFileHash");

CREATE INDEX "ReportingLedgerBatch_supersededByBatchId_idx"
  ON "ReportingLedgerBatch"("supersededByBatchId");
