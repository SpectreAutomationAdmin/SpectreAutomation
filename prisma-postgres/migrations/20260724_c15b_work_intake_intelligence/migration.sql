-- Sprint 3 Checkpoint 15B (2026-07-24) — Operational Intelligence
-- foundation migration. Additive only. Rollback = DROP.
--
-- Adds:
--   * WorkIntakeItem.lastAnalysedAt (nullable)
--   * WorkIntakeOrigin (new table)
--   * WorkIntakeFinding (new table)
--
-- No columns removed. No columns renamed. No existing data altered.

ALTER TABLE "WorkIntakeItem" ADD COLUMN "lastAnalysedAt" TIMESTAMP(3);

CREATE TABLE "WorkIntakeOrigin" (
  "id"                TEXT      NOT NULL PRIMARY KEY,
  "clubId"            TEXT      NOT NULL,
  "workIntakeItemId"  TEXT      NOT NULL,
  "kind"              TEXT      NOT NULL,
  "referenceId"       TEXT      NOT NULL,
  "role"              TEXT      NOT NULL DEFAULT 'PRIMARY',
  "linkReason"        TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByUserId"   TEXT,
  CONSTRAINT "WorkIntakeOrigin_workIntakeItemId_fkey"
    FOREIGN KEY ("workIntakeItemId") REFERENCES "WorkIntakeItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkIntakeOrigin_workIntakeItemId_kind_referenceId_role_key"
  ON "WorkIntakeOrigin" ("workIntakeItemId", "kind", "referenceId", "role");
CREATE INDEX "WorkIntakeOrigin_workIntakeItemId_idx"
  ON "WorkIntakeOrigin" ("workIntakeItemId");
CREATE INDEX "WorkIntakeOrigin_clubId_kind_referenceId_idx"
  ON "WorkIntakeOrigin" ("clubId", "kind", "referenceId");

CREATE TABLE "WorkIntakeFinding" (
  "id"                 TEXT      NOT NULL PRIMARY KEY,
  "clubId"             TEXT      NOT NULL,
  "workIntakeItemId"   TEXT      NOT NULL,
  "key"                TEXT      NOT NULL,
  "statement"          TEXT      NOT NULL,
  "state"              TEXT      NOT NULL DEFAULT 'CONFIRMED',
  "severity"           TEXT      NOT NULL DEFAULT 'INFO',
  "materialityCents"   BIGINT,
  "ruleKey"            TEXT      NOT NULL,
  "ruleVersion"        INTEGER   NOT NULL DEFAULT 1,
  "evidenceRefsJson"   TEXT      NOT NULL DEFAULT '[]',
  "analysisRunId"      TEXT,
  "overriddenByUserId" TEXT,
  "overriddenAt"       TIMESTAMP(3),
  "overrideReason"     TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkIntakeFinding_workIntakeItemId_fkey"
    FOREIGN KEY ("workIntakeItemId") REFERENCES "WorkIntakeItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WorkIntakeFinding_workIntakeItemId_key_idx"
  ON "WorkIntakeFinding" ("workIntakeItemId", "key");
CREATE INDEX "WorkIntakeFinding_clubId_key_state_idx"
  ON "WorkIntakeFinding" ("clubId", "key", "state");
