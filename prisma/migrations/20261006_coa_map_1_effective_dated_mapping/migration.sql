-- COA-MAP-1 (2026-10-06) — effective-dated Account→FsGroup +
-- FinancialStatementGroup.reportingRole + MappingChangeAudit.
--
-- Fully ADDITIVE. Preserves Account.fsGroupId as the current-
-- resolution compatibility column during the migration window.
-- Zero accounting-table mutations.

ALTER TABLE "FinancialStatementGroup" ADD COLUMN "reportingRole"   TEXT;
ALTER TABLE "FinancialStatementGroup" ADD COLUMN "isTenantCreated" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "FinancialStatementGroup_clubId_reportingRole_idx"
  ON "FinancialStatementGroup"("clubId", "reportingRole");

CREATE TABLE "AccountFinancialStatementAssignment" (
  "id"              TEXT     NOT NULL PRIMARY KEY,
  "clubId"          TEXT     NOT NULL,
  "accountId"       TEXT     NOT NULL,
  "fsGroupId"       TEXT     NOT NULL,
  "effectiveFrom"   DATETIME NOT NULL,
  "effectiveTo"     DATETIME,
  "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByUserId" TEXT,
  "reason"          TEXT,
  CONSTRAINT "AccountFinancialStatementAssignment_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE,
  CONSTRAINT "AccountFinancialStatementAssignment_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE,
  CONSTRAINT "AccountFinancialStatementAssignment_fsGroupId_fkey"
    FOREIGN KEY ("fsGroupId") REFERENCES "FinancialStatementGroup"("id")
);

CREATE UNIQUE INDEX "AccountFinancialStatementAssignment_account_effectiveFrom_unique"
  ON "AccountFinancialStatementAssignment"("accountId", "effectiveFrom");

CREATE INDEX "AccountFinancialStatementAssignment_club_account_effFrom_idx"
  ON "AccountFinancialStatementAssignment"("clubId", "accountId", "effectiveFrom");

CREATE INDEX "AccountFinancialStatementAssignment_club_fsGroupId_idx"
  ON "AccountFinancialStatementAssignment"("clubId", "fsGroupId");

CREATE TABLE "MappingChangeAudit" (
  "id"          TEXT     NOT NULL PRIMARY KEY,
  "clubId"      TEXT     NOT NULL,
  "action"      TEXT     NOT NULL,
  "entityType"  TEXT     NOT NULL,
  "entityId"    TEXT     NOT NULL,
  "payloadJson" TEXT     NOT NULL,
  "actorUserId" TEXT,
  "actorEmail"  TEXT,
  "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MappingChangeAudit_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE
);
CREATE INDEX "MappingChangeAudit_club_createdAt_idx"
  ON "MappingChangeAudit"("clubId", "createdAt");
CREATE INDEX "MappingChangeAudit_club_entityType_entityId_idx"
  ON "MappingChangeAudit"("clubId", "entityType", "entityId");
