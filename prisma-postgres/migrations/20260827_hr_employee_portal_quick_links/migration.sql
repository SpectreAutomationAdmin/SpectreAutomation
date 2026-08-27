-- Employee Portal Quick Links (2026-08-27) — tenant-configured
-- destinations rendered in the Employee Portal right rail (desktop)
-- and the mobile Quick Links strip. Each row points either to a
-- validated URL or an uploaded document; the service enforces that
-- exactly one destination field is populated.

CREATE TABLE "EmployeePortalQuickLink" (
  "id"                TEXT NOT NULL,
  "clubId"            TEXT NOT NULL,
  "label"             TEXT NOT NULL,
  "destinationType"   TEXT NOT NULL,
  "url"               TEXT,
  "storageKey"        TEXT,
  "fileMimeType"      TEXT,
  "fileSizeBytes"     INTEGER,
  "fileOriginalName"  TEXT,
  "sortOrder"         INTEGER NOT NULL DEFAULT 0,
  "isActive"          BOOLEAN NOT NULL DEFAULT true,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  "createdByUserId"   TEXT,
  "updatedByUserId"   TEXT,

  CONSTRAINT "EmployeePortalQuickLink_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmployeePortalQuickLink_clubId_sortOrder_idx"
  ON "EmployeePortalQuickLink" ("clubId", "sortOrder");

CREATE INDEX "EmployeePortalQuickLink_clubId_isActive_idx"
  ON "EmployeePortalQuickLink" ("clubId", "isActive");

ALTER TABLE "EmployeePortalQuickLink"
  ADD CONSTRAINT "EmployeePortalQuickLink_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
