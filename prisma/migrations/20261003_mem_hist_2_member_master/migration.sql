-- MEM-HIST-2 (2026-10-03) — Member Master architecture foundation (SQLite dev mirror).

CREATE TABLE "MemberMasterImportBatch" (
  "id"                     TEXT     NOT NULL PRIMARY KEY,
  "clubId"                 TEXT     NOT NULL,
  "status"                 TEXT     NOT NULL DEFAULT 'PREVIEW',
  "sourceSystem"           TEXT     NOT NULL,
  "sourceFileName"         TEXT,
  "sourceFileHash"         TEXT     NOT NULL,
  "sourceEffectiveDate"    DATETIME NOT NULL,
  "rowCount"               INTEGER  NOT NULL DEFAULT 0,
  "validCount"             INTEGER  NOT NULL DEFAULT 0,
  "invalidCount"           INTEGER  NOT NULL DEFAULT 0,
  "warningCount"           INTEGER  NOT NULL DEFAULT 0,
  "newMemberCount"         INTEGER  NOT NULL DEFAULT 0,
  "matchedMemberCount"     INTEGER  NOT NULL DEFAULT 0,
  "billToSelfCount"        INTEGER  NOT NULL DEFAULT 0,
  "billToResolvedCount"    INTEGER  NOT NULL DEFAULT 0,
  "billToUnresolvedCount"  INTEGER  NOT NULL DEFAULT 0,
  "classificationCount"    INTEGER  NOT NULL DEFAULT 0,
  "uploadedByUserId"       TEXT,
  "uploadedAt"             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt"            DATETIME,
  "committedByUserId"      TEXT,
  CONSTRAINT "MemberMasterImportBatch_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "MemberMasterImportBatch_idempotency"
  ON "MemberMasterImportBatch"("clubId", "sourceSystem", "sourceFileHash", "sourceEffectiveDate");
CREATE INDEX "MemberMasterImportBatch_clubId_status_idx"
  ON "MemberMasterImportBatch"("clubId", "status");

CREATE TABLE "MemberExternalIdentity" (
  "id"                 TEXT     NOT NULL PRIMARY KEY,
  "clubId"             TEXT     NOT NULL,
  "memberId"           TEXT     NOT NULL,
  "sourceSystem"       TEXT     NOT NULL,
  "externalIdentifier" TEXT     NOT NULL,
  "effectiveFrom"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effectiveTo"        DATETIME,
  "importBatchId"      TEXT,
  "createdAt"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          DATETIME NOT NULL,
  CONSTRAINT "MemberExternalIdentity_clubId_fkey"  FOREIGN KEY ("clubId")  REFERENCES "Club"("id")  ON DELETE RESTRICT,
  CONSTRAINT "MemberExternalIdentity_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE,
  CONSTRAINT "MemberExternalIdentity_importBatch_fkey" FOREIGN KEY ("importBatchId") REFERENCES "MemberMasterImportBatch"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "MemberExternalIdentity_tenant_source_key"
  ON "MemberExternalIdentity"("clubId", "sourceSystem", "externalIdentifier");
CREATE INDEX "MemberExternalIdentity_clubId_memberId_idx"
  ON "MemberExternalIdentity"("clubId", "memberId");

CREATE TABLE "MembershipHistoryEntry" (
  "id"                           TEXT     NOT NULL PRIMARY KEY,
  "clubId"                       TEXT     NOT NULL,
  "memberId"                     TEXT     NOT NULL,
  "sourceStatus"                 TEXT     NOT NULL,
  "sourceMembershipDescription"  TEXT,
  "sourceCategory1"              TEXT,
  "sourceCategory1Description"   TEXT,
  "sourceCategory2"              TEXT,
  "sourceGolfClassification"     TEXT,
  "interpretedStatus"            TEXT     NOT NULL,
  "isShareholder"                INTEGER  NOT NULL DEFAULT 0,
  "effectiveFrom"                DATETIME NOT NULL,
  "effectiveTo"                  DATETIME,
  "sourceSystem"                 TEXT     NOT NULL,
  "sourceEffectiveDate"          DATETIME NOT NULL,
  "importBatchId"                TEXT,
  "createdAt"                    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipHistoryEntry_clubId_fkey"  FOREIGN KEY ("clubId")  REFERENCES "Club"("id")  ON DELETE RESTRICT,
  CONSTRAINT "MembershipHistoryEntry_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE,
  CONSTRAINT "MembershipHistoryEntry_importBatch_fkey" FOREIGN KEY ("importBatchId") REFERENCES "MemberMasterImportBatch"("id") ON DELETE SET NULL
);
CREATE INDEX "MembershipHistoryEntry_member_effFrom_idx"
  ON "MembershipHistoryEntry"("clubId", "memberId", "effectiveFrom");
CREATE INDEX "MembershipHistoryEntry_club_window_idx"
  ON "MembershipHistoryEntry"("clubId", "effectiveFrom", "effectiveTo");

CREATE TABLE "MemberBillingRelationship" (
  "id"                             TEXT     NOT NULL PRIMARY KEY,
  "clubId"                         TEXT     NOT NULL,
  "memberId"                       TEXT     NOT NULL,
  "billedByMemberId"               TEXT,
  "outcome"                        TEXT     NOT NULL,
  "sourceBillToExternalIdentifier" TEXT,
  "importBatchId"                  TEXT,
  "createdAt"                      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemberBillingRelationship_clubId_fkey"   FOREIGN KEY ("clubId")   REFERENCES "Club"("id")   ON DELETE RESTRICT,
  CONSTRAINT "MemberBillingRelationship_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE,
  CONSTRAINT "MemberBillingRelationship_billedBy_fkey" FOREIGN KEY ("billedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL,
  CONSTRAINT "MemberBillingRelationship_importBatch_fkey" FOREIGN KEY ("importBatchId") REFERENCES "MemberMasterImportBatch"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "MemberBillingRelationship_tenant_member_key"
  ON "MemberBillingRelationship"("clubId", "memberId");
CREATE INDEX "MemberBillingRelationship_clubId_billedBy_idx"
  ON "MemberBillingRelationship"("clubId", "billedByMemberId");
