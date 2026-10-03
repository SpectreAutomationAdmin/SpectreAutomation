-- AR-HIST-1 (2026-10-03) — Historical AR aging subledger snapshots.
--
-- Adds two tables:
--   ArAgingImportBatch        — upload / preview / reconcile / commit batch
--   ArAgingSnapshotRow        — one row per committed AR aging row
--
-- Idempotency key:
--   (clubId, sourceSystem, sourceFileHash, sourceEffectiveDate)
--
-- Zero accounting-table changes.

CREATE TABLE "ArAgingImportBatch" (
  "id"                     TEXT         NOT NULL PRIMARY KEY,
  "clubId"                 TEXT         NOT NULL REFERENCES "Club"("id"),
  "status"                 TEXT         NOT NULL DEFAULT 'PREVIEW',
  "sourceSystem"           TEXT         NOT NULL,
  "sourceFileName"         TEXT,
  "sourceFileHash"         TEXT         NOT NULL,
  "sourceEffectiveDate"    TIMESTAMP(3) NOT NULL,
  "rowCount"               INTEGER      NOT NULL DEFAULT 0,
  "invalidCount"           INTEGER      NOT NULL DEFAULT 0,
  "warningCount"           INTEGER      NOT NULL DEFAULT 0,
  "totalNet"               DECIMAL(18, 2) NOT NULL DEFAULT 0,
  "totalCurrent"           DECIMAL(18, 2) NOT NULL DEFAULT 0,
  "totalOneMonth"          DECIMAL(18, 2) NOT NULL DEFAULT 0,
  "totalTwoMonths"         DECIMAL(18, 2) NOT NULL DEFAULT 0,
  "totalThreeMonths"       DECIMAL(18, 2) NOT NULL DEFAULT 0,
  "totalOverFourMonths"    DECIMAL(18, 2) NOT NULL DEFAULT 0,
  "matchedMembers"         INTEGER      NOT NULL DEFAULT 0,
  "unmatchedMembers"       INTEGER      NOT NULL DEFAULT 0,
  "ambiguousMembers"       INTEGER      NOT NULL DEFAULT 0,
  "invalidMembers"         INTEGER      NOT NULL DEFAULT 0,
  "glControlAccountNumber" TEXT,
  "glControlAccountName"   TEXT,
  "glControlBalance"       DECIMAL(18, 2),
  "reconciliationDifference" DECIMAL(18, 2),
  "reconciliationStatus"   TEXT,
  "uploadedByUserId"       TEXT,
  "uploadedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt"            TIMESTAMP(3),
  "committedByUserId"      TEXT
);
CREATE UNIQUE INDEX "ArAgingImportBatch_idempotency"
  ON "ArAgingImportBatch"("clubId", "sourceSystem", "sourceFileHash", "sourceEffectiveDate");
CREATE INDEX "ArAgingImportBatch_clubId_status_idx"
  ON "ArAgingImportBatch"("clubId", "status");
CREATE INDEX "ArAgingImportBatch_clubId_effDate_idx"
  ON "ArAgingImportBatch"("clubId", "sourceEffectiveDate");

CREATE TABLE "ArAgingSnapshotRow" (
  "id"                        TEXT         NOT NULL PRIMARY KEY,
  "clubId"                    TEXT         NOT NULL REFERENCES "Club"("id"),
  "importBatchId"             TEXT         NOT NULL REFERENCES "ArAgingImportBatch"("id") ON DELETE CASCADE,
  "memberId"                  TEXT         NOT NULL REFERENCES "Member"("id") ON DELETE CASCADE,
  "memberAccountId"           TEXT REFERENCES "MemberAccount"("id"),
  "sourceMemberCode"          TEXT         NOT NULL,
  "sourceMemberName"          TEXT,
  "netAmount"                 DECIMAL(18, 2) NOT NULL,
  "current"                   DECIMAL(18, 2) NOT NULL,
  "oneMonth"                  DECIMAL(18, 2) NOT NULL,
  "twoMonths"                 DECIMAL(18, 2) NOT NULL,
  "threeMonths"               DECIMAL(18, 2) NOT NULL,
  "overFourMonths"            DECIMAL(18, 2) NOT NULL,
  "sourceSystem"              TEXT         NOT NULL,
  "sourceEffectiveDate"       TIMESTAMP(3) NOT NULL,
  "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ArAgingSnapshotRow_clubId_effDate_idx"
  ON "ArAgingSnapshotRow"("clubId", "sourceEffectiveDate");
CREATE INDEX "ArAgingSnapshotRow_clubId_memberId_idx"
  ON "ArAgingSnapshotRow"("clubId", "memberId");
CREATE INDEX "ArAgingSnapshotRow_batchId_idx"
  ON "ArAgingSnapshotRow"("importBatchId");
