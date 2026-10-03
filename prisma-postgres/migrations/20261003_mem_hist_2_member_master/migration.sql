-- MEM-HIST-2 (2026-10-03) — Member Master architecture foundation.
--
-- Adds four tables + required back-reference FKs:
--   MemberExternalIdentity         — external-system identity key (JONAS Member #)
--   MemberMasterImportBatch        — upload / preview / commit batch provenance
--   MembershipHistoryEntry         — effective-dated classification/status history
--   MemberBillingRelationship      — explicit bill-to edge between Members
--
-- Idempotency keys:
--   MemberExternalIdentity    (clubId, sourceSystem, externalIdentifier)
--   MemberMasterImportBatch   (clubId, sourceSystem, sourceFileHash, sourceEffectiveDate)
--   MemberBillingRelationship (clubId, memberId)                      -- one current relationship per Member
--
-- Zero accounting-table mutations.

CREATE TABLE "MemberMasterImportBatch" (
  "id"                     TEXT         NOT NULL PRIMARY KEY,
  "clubId"                 TEXT         NOT NULL REFERENCES "Club"("id"),
  "status"                 TEXT         NOT NULL DEFAULT 'PREVIEW',
  "sourceSystem"           TEXT         NOT NULL,
  "sourceFileName"         TEXT,
  "sourceFileHash"         TEXT         NOT NULL,
  "sourceEffectiveDate"    TIMESTAMP(3) NOT NULL,
  "rowCount"               INTEGER      NOT NULL DEFAULT 0,
  "validCount"             INTEGER      NOT NULL DEFAULT 0,
  "invalidCount"           INTEGER      NOT NULL DEFAULT 0,
  "warningCount"           INTEGER      NOT NULL DEFAULT 0,
  "newMemberCount"         INTEGER      NOT NULL DEFAULT 0,
  "matchedMemberCount"     INTEGER      NOT NULL DEFAULT 0,
  "billToSelfCount"        INTEGER      NOT NULL DEFAULT 0,
  "billToResolvedCount"    INTEGER      NOT NULL DEFAULT 0,
  "billToUnresolvedCount"  INTEGER      NOT NULL DEFAULT 0,
  "classificationCount"    INTEGER      NOT NULL DEFAULT 0,
  "uploadedByUserId"       TEXT,
  "uploadedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt"            TIMESTAMP(3),
  "committedByUserId"      TEXT
);
CREATE UNIQUE INDEX "MemberMasterImportBatch_idempotency"
  ON "MemberMasterImportBatch"("clubId", "sourceSystem", "sourceFileHash", "sourceEffectiveDate");
CREATE INDEX "MemberMasterImportBatch_clubId_status_idx"
  ON "MemberMasterImportBatch"("clubId", "status");

CREATE TABLE "MemberExternalIdentity" (
  "id"                 TEXT         NOT NULL PRIMARY KEY,
  "clubId"             TEXT         NOT NULL REFERENCES "Club"("id"),
  "memberId"           TEXT         NOT NULL REFERENCES "Member"("id") ON DELETE CASCADE,
  "sourceSystem"       TEXT         NOT NULL,
  "externalIdentifier" TEXT         NOT NULL,
  "effectiveFrom"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effectiveTo"        TIMESTAMP(3),
  "importBatchId"      TEXT REFERENCES "MemberMasterImportBatch"("id"),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "MemberExternalIdentity_tenant_source_key"
  ON "MemberExternalIdentity"("clubId", "sourceSystem", "externalIdentifier");
CREATE INDEX "MemberExternalIdentity_clubId_memberId_idx"
  ON "MemberExternalIdentity"("clubId", "memberId");

CREATE TABLE "MembershipHistoryEntry" (
  "id"                           TEXT         NOT NULL PRIMARY KEY,
  "clubId"                       TEXT         NOT NULL REFERENCES "Club"("id"),
  "memberId"                     TEXT         NOT NULL REFERENCES "Member"("id") ON DELETE CASCADE,
  "sourceStatus"                 TEXT         NOT NULL,
  "sourceMembershipDescription"  TEXT,
  "sourceCategory1"              TEXT,
  "sourceCategory1Description"   TEXT,
  "sourceCategory2"              TEXT,
  "sourceGolfClassification"     TEXT,
  "interpretedStatus"            TEXT         NOT NULL,
  "isShareholder"                BOOLEAN      NOT NULL DEFAULT false,
  "effectiveFrom"                TIMESTAMP(3) NOT NULL,
  "effectiveTo"                  TIMESTAMP(3),
  "sourceSystem"                 TEXT         NOT NULL,
  "sourceEffectiveDate"          TIMESTAMP(3) NOT NULL,
  "importBatchId"                TEXT REFERENCES "MemberMasterImportBatch"("id"),
  "createdAt"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MembershipHistoryEntry_member_effFrom_idx"
  ON "MembershipHistoryEntry"("clubId", "memberId", "effectiveFrom");
CREATE INDEX "MembershipHistoryEntry_club_window_idx"
  ON "MembershipHistoryEntry"("clubId", "effectiveFrom", "effectiveTo");

CREATE TABLE "MemberBillingRelationship" (
  "id"                            TEXT         NOT NULL PRIMARY KEY,
  "clubId"                        TEXT         NOT NULL REFERENCES "Club"("id"),
  "memberId"                      TEXT         NOT NULL REFERENCES "Member"("id") ON DELETE CASCADE,
  "billedByMemberId"              TEXT REFERENCES "Member"("id"),
  "outcome"                       TEXT         NOT NULL,
  "sourceBillToExternalIdentifier" TEXT,
  "importBatchId"                 TEXT REFERENCES "MemberMasterImportBatch"("id"),
  "createdAt"                     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MemberBillingRelationship_tenant_member_key"
  ON "MemberBillingRelationship"("clubId", "memberId");
CREATE INDEX "MemberBillingRelationship_clubId_billedBy_idx"
  ON "MemberBillingRelationship"("clubId", "billedByMemberId");
