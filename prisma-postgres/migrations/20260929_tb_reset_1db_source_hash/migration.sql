-- TB-RESET-1d.b (2026-09-29) — original uploaded-file identity +
-- explicit supersession pointer on ReportingLedgerBatch.
--
--   sourceFileHash      — SHA-256 hex of the raw uploaded bytes.
--                         Distinct from ReportingLedgerSnapshot.
--                         payloadHash (which hashes the normalised
--                         snapshot). Answers "has this exact file
--                         already been imported?" — enforced at the
--                         application layer in TB-RESET-1d.b.2, NOT
--                         via a global unique constraint (same file
--                         may legitimately import into different
--                         tenants).
--
--   supersededByBatchId — self-relation FK to another
--                         ReportingLedgerBatch (SetNull on delete).
--                         When founder replaces a committed snapshot
--                         for a duplicate effective date, the OLD
--                         batch flips state='rolled-back' and this
--                         pointer is set to the NEW batch's id.
--                         Not unique — enforcement of
--                         at-most-one-committed-per-date lives in
--                         the b.2 replace-flow application logic.
--
--   createdByUserId     — actor identity for the batch opener.
--                         Deliberately NOT an FK to "User" — matches
--                         the AuditLog convention (nullable, no
--                         cross-tenant referential brittleness,
--                         survives user deletion).
--
-- All three columns nullable so pre-1d.b legacy rows (currently zero
-- on production, verified in TB-RESET-1c acceptance) remain valid.

ALTER TABLE "ReportingLedgerBatch"
  ADD COLUMN "sourceFileHash" TEXT,
  ADD COLUMN "supersededByBatchId" TEXT,
  ADD COLUMN "createdByUserId" TEXT;

CREATE INDEX "ReportingLedgerBatch_clubId_sourceFileHash_idx"
  ON "ReportingLedgerBatch"("clubId", "sourceFileHash");

CREATE INDEX "ReportingLedgerBatch_supersededByBatchId_idx"
  ON "ReportingLedgerBatch"("supersededByBatchId");

-- Self-referential FK for supersession chain. SetNull on delete so
-- discarding a bad new batch cannot corrupt the audit trail of the
-- OLD batch it superseded.
ALTER TABLE "ReportingLedgerBatch"
  ADD CONSTRAINT "ReportingLedgerBatch_supersededByBatchId_fkey"
    FOREIGN KEY ("supersededByBatchId")
    REFERENCES "ReportingLedgerBatch"("batchId")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
