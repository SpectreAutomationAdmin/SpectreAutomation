-- Phase 20 (Member Database, 2026-08-15) — admin Member Profile
-- schema. Extends existing Member + MemberHouseholdMember with
-- optional demographic fields (all nullable so no existing row is
-- invalidated) and introduces four new tables:
--   * MemberGroup                    — per-club segmentation vocabulary
--   * MemberGroupAssignment          — Member ↔ MemberGroup m:n
--   * MemberCustomFieldDefinition    — per-club custom-field catalog
--   * MemberCustomFieldValue         — sparse per-member values
--
-- Every new table carries clubId and is club-scoped by every
-- Spectre service that reads it.

-- ----- Member: add demographic fields -------------------------------------
ALTER TABLE "Member"
  ADD COLUMN "middleName"       TEXT,
  ADD COLUMN "nickname"         TEXT,
  ADD COLUMN "salutation"       TEXT,
  ADD COLUMN "gender"           TEXT,
  ADD COLUMN "homePhone"        TEXT,
  ADD COLUMN "profileImageUrl"  TEXT;

-- ----- MemberHouseholdMember: same additions ------------------------------
ALTER TABLE "MemberHouseholdMember"
  ADD COLUMN "middleName"       TEXT,
  ADD COLUMN "nickname"         TEXT,
  ADD COLUMN "salutation"       TEXT,
  ADD COLUMN "gender"           TEXT,
  ADD COLUMN "homePhone"        TEXT,
  ADD COLUMN "profileImageUrl"  TEXT;

-- ----- MemberGroup --------------------------------------------------------
CREATE TABLE "MemberGroup" (
  "id"         TEXT NOT NULL,
  "clubId"     TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "sortOrder"  INTEGER NOT NULL DEFAULT 100,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemberGroup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MemberGroup_clubId_name_key" ON "MemberGroup"("clubId","name");
CREATE INDEX "MemberGroup_clubId_sortOrder_idx" ON "MemberGroup"("clubId","sortOrder");
ALTER TABLE "MemberGroup"
  ADD CONSTRAINT "MemberGroup_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ----- MemberGroupAssignment ---------------------------------------------
CREATE TABLE "MemberGroupAssignment" (
  "id"                TEXT NOT NULL,
  "clubId"            TEXT NOT NULL,
  "memberId"          TEXT NOT NULL,
  "groupId"           TEXT NOT NULL,
  "assignedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assignedByUserId"  TEXT,

  CONSTRAINT "MemberGroupAssignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MemberGroupAssignment_memberId_groupId_key" ON "MemberGroupAssignment"("memberId","groupId");
CREATE INDEX "MemberGroupAssignment_clubId_groupId_idx" ON "MemberGroupAssignment"("clubId","groupId");
CREATE INDEX "MemberGroupAssignment_memberId_idx" ON "MemberGroupAssignment"("memberId");
ALTER TABLE "MemberGroupAssignment"
  ADD CONSTRAINT "MemberGroupAssignment_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberGroupAssignment"
  ADD CONSTRAINT "MemberGroupAssignment_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemberGroupAssignment"
  ADD CONSTRAINT "MemberGroupAssignment_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "MemberGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----- MemberCustomFieldDefinition ---------------------------------------
CREATE TABLE "MemberCustomFieldDefinition" (
  "id"          TEXT NOT NULL,
  "clubId"      TEXT NOT NULL,
  "key"         TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "kind"        TEXT NOT NULL DEFAULT 'TEXT',
  "helpText"    TEXT,
  "optionsJson" TEXT,
  "sortOrder"   INTEGER NOT NULL DEFAULT 100,
  "archivedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemberCustomFieldDefinition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MemberCustomFieldDefinition_clubId_key_key" ON "MemberCustomFieldDefinition"("clubId","key");
CREATE INDEX "MemberCustomFieldDefinition_clubId_sortOrder_idx" ON "MemberCustomFieldDefinition"("clubId","sortOrder");
ALTER TABLE "MemberCustomFieldDefinition"
  ADD CONSTRAINT "MemberCustomFieldDefinition_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ----- MemberCustomFieldValue --------------------------------------------
CREATE TABLE "MemberCustomFieldValue" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "memberId"        TEXT NOT NULL,
  "definitionId"    TEXT NOT NULL,
  "valueText"       TEXT,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  "updatedByUserId" TEXT,

  CONSTRAINT "MemberCustomFieldValue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MemberCustomFieldValue_memberId_definitionId_key" ON "MemberCustomFieldValue"("memberId","definitionId");
CREATE INDEX "MemberCustomFieldValue_clubId_definitionId_idx" ON "MemberCustomFieldValue"("clubId","definitionId");
ALTER TABLE "MemberCustomFieldValue"
  ADD CONSTRAINT "MemberCustomFieldValue_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberCustomFieldValue"
  ADD CONSTRAINT "MemberCustomFieldValue_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemberCustomFieldValue"
  ADD CONSTRAINT "MemberCustomFieldValue_definitionId_fkey"
  FOREIGN KEY ("definitionId") REFERENCES "MemberCustomFieldDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
