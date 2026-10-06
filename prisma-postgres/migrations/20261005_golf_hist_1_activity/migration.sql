-- GOLF-HIST-1 (2026-10-05) — canonical Historical Golf Activity.
-- Provider-neutral model for daily golf-activity data. First source
-- is a monthly GGGolf PDF export; the reporting layer is unaware of
-- provider identity. See prisma-postgres/schema.prisma for full
-- documentation.
--
-- Zero accounting-table mutations.

-- =====================================================================
-- GolfActivityImportBatch
-- =====================================================================
CREATE TABLE "GolfActivityImportBatch" (
  "id"                   TEXT         NOT NULL PRIMARY KEY,
  "clubId"               TEXT         NOT NULL REFERENCES "Club"("id"),
  "status"               TEXT         NOT NULL DEFAULT 'PREVIEW',
  "sourceSystem"         TEXT         NOT NULL,
  "sourceFileName"       TEXT,
  "sourceFileHash"       TEXT         NOT NULL,
  "reportingPeriodStart" TIMESTAMP(3) NOT NULL,
  "reportingPeriodEnd"   TIMESTAMP(3) NOT NULL,
  "rowCount"             INTEGER      NOT NULL DEFAULT 0,
  "activeDays"           INTEGER      NOT NULL DEFAULT 0,
  "realZeroDays"         INTEGER      NOT NULL DEFAULT 0,
  "invalidCount"         INTEGER      NOT NULL DEFAULT 0,
  "warningCount"         INTEGER      NOT NULL DEFAULT 0,
  "conflictCount"        INTEGER      NOT NULL DEFAULT 0,
  "sourceTotalGuests"    INTEGER,
  "sourceTotalGreenFees" INTEGER,
  "sourceTotalMembers"   INTEGER,
  "sourceTotalRounds"    INTEGER,
  "sourceTotalJuniors"   INTEGER,
  "sourceTotalWomen"     INTEGER,
  "parsedTotalGuests"    INTEGER      NOT NULL DEFAULT 0,
  "parsedTotalGreenFees" INTEGER      NOT NULL DEFAULT 0,
  "parsedTotalMembers"   INTEGER      NOT NULL DEFAULT 0,
  "parsedTotalRounds"    INTEGER      NOT NULL DEFAULT 0,
  "parsedTotalJuniors"   INTEGER      NOT NULL DEFAULT 0,
  "parsedTotalWomen"     INTEGER      NOT NULL DEFAULT 0,
  "reconciliationStatus" TEXT         NOT NULL DEFAULT 'UNKNOWN',
  "uploadedByUserId"     TEXT,
  "uploadedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt"          TIMESTAMP(3),
  "committedByUserId"    TEXT
);

CREATE UNIQUE INDEX "GolfActivityImportBatch_idempotency"
  ON "GolfActivityImportBatch"("clubId", "sourceSystem", "sourceFileHash", "reportingPeriodStart");
CREATE INDEX "GolfActivityImportBatch_clubId_status_idx"
  ON "GolfActivityImportBatch"("clubId", "status");
CREATE INDEX "GolfActivityImportBatch_clubId_period_idx"
  ON "GolfActivityImportBatch"("clubId", "reportingPeriodStart");

-- =====================================================================
-- GolfActivityImportRow
-- =====================================================================
CREATE TABLE "GolfActivityImportRow" (
  "id"                        TEXT         NOT NULL PRIMARY KEY,
  "batchId"                   TEXT         NOT NULL REFERENCES "GolfActivityImportBatch"("id") ON DELETE CASCADE,
  "rowIndex"                  INTEGER      NOT NULL,
  "activityDate"              TIMESTAMP(3) NOT NULL,
  "rawDateLabel"              TEXT         NOT NULL,
  "rawWeatherCode"            TEXT,
  "guests"                    INTEGER      NOT NULL DEFAULT 0,
  "greenFees"                 INTEGER      NOT NULL DEFAULT 0,
  "members"                   INTEGER      NOT NULL DEFAULT 0,
  "totalRounds"               INTEGER      NOT NULL DEFAULT 0,
  "juniors"                   INTEGER      NOT NULL DEFAULT 0,
  "women"                     INTEGER      NOT NULL DEFAULT 0,
  "corpos"                    INTEGER      NOT NULL DEFAULT 0,
  "corposHalf"                INTEGER      NOT NULL DEFAULT 0,
  "fullCart"                  INTEGER      NOT NULL DEFAULT 0,
  "nineCart"                  INTEGER      NOT NULL DEFAULT 0,
  "halfCart"                  INTEGER      NOT NULL DEFAULT 0,
  "freeCart"                  INTEGER      NOT NULL DEFAULT 0,
  "conflictWithCommittedDayId" TEXT,
  "warningsJson"              TEXT
);

CREATE UNIQUE INDEX "GolfActivityImportRow_batchId_rowIndex_unique"
  ON "GolfActivityImportRow"("batchId", "rowIndex");
CREATE INDEX "GolfActivityImportRow_batchId_activityDate_idx"
  ON "GolfActivityImportRow"("batchId", "activityDate");

-- =====================================================================
-- GolfActivityDay
-- =====================================================================
CREATE TABLE "GolfActivityDay" (
  "id"                   TEXT         NOT NULL PRIMARY KEY,
  "clubId"               TEXT         NOT NULL REFERENCES "Club"("id") ON DELETE CASCADE,
  "activityDate"         TIMESTAMP(3) NOT NULL,
  "sourceSystem"         TEXT         NOT NULL,
  "sourceBatchId"        TEXT         REFERENCES "GolfActivityImportBatch"("id") ON DELETE SET NULL,
  "guests"               INTEGER      NOT NULL DEFAULT 0,
  "greenFees"            INTEGER      NOT NULL DEFAULT 0,
  "members"              INTEGER      NOT NULL DEFAULT 0,
  "totalRounds"          INTEGER      NOT NULL DEFAULT 0,
  "juniors"              INTEGER      NOT NULL DEFAULT 0,
  "women"                INTEGER      NOT NULL DEFAULT 0,
  "corpos"               INTEGER      NOT NULL DEFAULT 0,
  "corposHalf"           INTEGER      NOT NULL DEFAULT 0,
  "fullCart"             INTEGER      NOT NULL DEFAULT 0,
  "nineCart"             INTEGER      NOT NULL DEFAULT 0,
  "halfCart"             INTEGER      NOT NULL DEFAULT 0,
  "freeCart"             INTEGER      NOT NULL DEFAULT 0,
  "committedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedByUserId"    TEXT
);

CREATE UNIQUE INDEX "GolfActivityDay_clubId_activityDate_unique"
  ON "GolfActivityDay"("clubId", "activityDate");
CREATE INDEX "GolfActivityDay_clubId_activityDate_idx"
  ON "GolfActivityDay"("clubId", "activityDate");
