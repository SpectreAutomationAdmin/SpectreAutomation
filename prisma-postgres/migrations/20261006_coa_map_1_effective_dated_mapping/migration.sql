-- COA-MAP-1 (2026-10-06) — effective-dated Account→FsGroup +
-- FinancialStatementGroup.reportingRole + MappingChangeAudit.
-- Fully additive. Zero accounting-table mutations.

ALTER TABLE "FinancialStatementGroup" ADD COLUMN "reportingRole"   TEXT;
ALTER TABLE "FinancialStatementGroup" ADD COLUMN "isTenantCreated" BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX "FinancialStatementGroup_clubId_reportingRole_idx"
  ON "FinancialStatementGroup"("clubId", "reportingRole");

CREATE TABLE "AccountFinancialStatementAssignment" (
  "id"              TEXT         NOT NULL PRIMARY KEY,
  "clubId"          TEXT         NOT NULL REFERENCES "Club"("id") ON DELETE CASCADE,
  "accountId"       TEXT         NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
  "fsGroupId"       TEXT         NOT NULL REFERENCES "FinancialStatementGroup"("id"),
  "effectiveFrom"   TIMESTAMP(3) NOT NULL,
  "effectiveTo"     TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByUserId" TEXT,
  "reason"          TEXT
);

CREATE UNIQUE INDEX "AccountFinancialStatementAssignment_account_effectiveFrom_unique"
  ON "AccountFinancialStatementAssignment"("accountId", "effectiveFrom");
CREATE INDEX "AccountFinancialStatementAssignment_club_account_effFrom_idx"
  ON "AccountFinancialStatementAssignment"("clubId", "accountId", "effectiveFrom");
CREATE INDEX "AccountFinancialStatementAssignment_club_fsGroupId_idx"
  ON "AccountFinancialStatementAssignment"("clubId", "fsGroupId");

CREATE TABLE "MappingChangeAudit" (
  "id"          TEXT         NOT NULL PRIMARY KEY,
  "clubId"      TEXT         NOT NULL REFERENCES "Club"("id") ON DELETE CASCADE,
  "action"      TEXT         NOT NULL,
  "entityType"  TEXT         NOT NULL,
  "entityId"    TEXT         NOT NULL,
  "payloadJson" TEXT         NOT NULL,
  "actorUserId" TEXT,
  "actorEmail"  TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MappingChangeAudit_club_createdAt_idx"
  ON "MappingChangeAudit"("clubId", "createdAt");
CREATE INDEX "MappingChangeAudit_club_entityType_entityId_idx"
  ON "MappingChangeAudit"("clubId", "entityType", "entityId");
