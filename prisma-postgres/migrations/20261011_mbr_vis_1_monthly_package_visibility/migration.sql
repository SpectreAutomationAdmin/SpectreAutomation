-- MBR-VIS-1 (2026-10-11) — Monthly Board Reporting Publication
-- Visibility Controls.
--
-- Per-(clubId, reportingYear, reportingMonth, componentKey) hidden
-- flag. Draft edits live here; the published snapshot is frozen into
-- `MonthlyPackage.packagePayloadJson.visibility` at publish time and
-- is read verbatim by the Board snapshot + PDF path, so draft edits
-- never alter what the Board sees until explicit republish.

CREATE TABLE "MonthlyPackageVisibility" (
    "id"              TEXT NOT NULL,
    "clubId"          TEXT NOT NULL,
    "reportingYear"   INTEGER NOT NULL,
    "reportingMonth"  INTEGER NOT NULL,
    "componentKey"    TEXT NOT NULL,
    "hidden"          BOOLEAN NOT NULL DEFAULT false,
    "updatedByUserId" TEXT,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthlyPackageVisibility_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MonthlyPackageVisibility_period_key_unique"
    ON "MonthlyPackageVisibility"("clubId", "reportingYear", "reportingMonth", "componentKey");

CREATE INDEX "MonthlyPackageVisibility_period_idx"
    ON "MonthlyPackageVisibility"("clubId", "reportingYear", "reportingMonth");

ALTER TABLE "MonthlyPackageVisibility"
    ADD CONSTRAINT "MonthlyPackageVisibility_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
