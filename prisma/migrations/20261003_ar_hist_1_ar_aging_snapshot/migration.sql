-- AR-HIST-1 (2026-10-03) — SQLite dev mirror.

CREATE TABLE "ArAgingImportBatch" (
  "id"                     TEXT     NOT NULL PRIMARY KEY,
  "clubId"                 TEXT     NOT NULL,
  "status"                 TEXT     NOT NULL DEFAULT 'PREVIEW',
  "sourceSystem"           TEXT     NOT NULL,
  "sourceFileName"         TEXT,
  "sourceFileHash"         TEXT     NOT NULL,
  "sourceEffectiveDate"    DATETIME NOT NULL,
  "rowCount"               INTEGER  NOT NULL DEFAULT 0,
  "invalidCount"           INTEGER  NOT NULL DEFAULT 0,
  "warningCount"           INTEGER  NOT NULL DEFAULT 0,
  "totalNet"               DECIMAL  NOT NULL DEFAULT 0,
  "totalCurrent"           DECIMAL  NOT NULL DEFAULT 0,
  "totalOneMonth"          DECIMAL  NOT NULL DEFAULT 0,
  "totalTwoMonths"         DECIMAL  NOT NULL DEFAULT 0,
  "totalThreeMonths"       DECIMAL  NOT NULL DEFAULT 0,
  "totalOverFourMonths"    DECIMAL  NOT NULL DEFAULT 0,
  "matchedMembers"         INTEGER  NOT NULL DEFAULT 0,
  "unmatchedMembers"       INTEGER  NOT NULL DEFAULT 0,
  "ambiguousMembers"       INTEGER  NOT NULL DEFAULT 0,
  "invalidMembers"         INTEGER  NOT NULL DEFAULT 0,
  "glControlAccountNumber" TEXT,
  "glControlAccountName"   TEXT,
  "glControlBalance"       DECIMAL,
  "reconciliationDifference" DECIMAL,
  "reconciliationStatus"   TEXT,
  "uploadedByUserId"       TEXT,
  "uploadedAt"             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt"            DATETIME,
  "committedByUserId"      TEXT,
  CONSTRAINT "ArAgingImportBatch_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "ArAgingImportBatch_idempotency"
  ON "ArAgingImportBatch"("clubId", "sourceSystem", "sourceFileHash", "sourceEffectiveDate");
CREATE INDEX "ArAgingImportBatch_clubId_status_idx"
  ON "ArAgingImportBatch"("clubId", "status");
CREATE INDEX "ArAgingImportBatch_clubId_effDate_idx"
  ON "ArAgingImportBatch"("clubId", "sourceEffectiveDate");

CREATE TABLE "ArAgingSnapshotRow" (
  "id"                        TEXT     NOT NULL PRIMARY KEY,
  "clubId"                    TEXT     NOT NULL,
  "importBatchId"             TEXT     NOT NULL,
  "memberId"                  TEXT     NOT NULL,
  "memberAccountId"           TEXT,
  "sourceMemberCode"          TEXT     NOT NULL,
  "sourceMemberName"          TEXT,
  "netAmount"                 DECIMAL  NOT NULL,
  "current"                   DECIMAL  NOT NULL,
  "oneMonth"                  DECIMAL  NOT NULL,
  "twoMonths"                 DECIMAL  NOT NULL,
  "threeMonths"               DECIMAL  NOT NULL,
  "overFourMonths"            DECIMAL  NOT NULL,
  "sourceSystem"              TEXT     NOT NULL,
  "sourceEffectiveDate"       DATETIME NOT NULL,
  "createdAt"                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ArAgingSnapshotRow_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT,
  CONSTRAINT "ArAgingSnapshotRow_batch_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ArAgingImportBatch"("id") ON DELETE CASCADE,
  CONSTRAINT "ArAgingSnapshotRow_member_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE,
  CONSTRAINT "ArAgingSnapshotRow_memberAccount_fkey" FOREIGN KEY ("memberAccountId") REFERENCES "MemberAccount"("id") ON DELETE SET NULL
);
CREATE INDEX "ArAgingSnapshotRow_clubId_effDate_idx"
  ON "ArAgingSnapshotRow"("clubId", "sourceEffectiveDate");
CREATE INDEX "ArAgingSnapshotRow_clubId_memberId_idx"
  ON "ArAgingSnapshotRow"("clubId", "memberId");
CREATE INDEX "ArAgingSnapshotRow_batchId_idx"
  ON "ArAgingSnapshotRow"("importBatchId");
