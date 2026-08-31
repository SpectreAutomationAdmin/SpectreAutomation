-- Payroll-3B-5A (2026-08-31)
-- Statutory calculation packages + Employee opening balances + Pay
-- Group membership coverage windows on batch employee rows +
-- statutoryPackageId pin on PayrollBatch.
--
-- Additive-only, non-destructive. Safe to replay.

-- Coverage windows on PayrollBatchEmployee (§4).
ALTER TABLE "PayrollBatchEmployee"
  ADD COLUMN IF NOT EXISTS "membershipEffectiveFrom" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "membershipEffectiveTo"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "coverageStart"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "coverageEnd"             TIMESTAMP(3);

-- Statutory package pin on PayrollBatch (§22).
ALTER TABLE "PayrollBatch"
  ADD COLUMN IF NOT EXISTS "statutoryPackageId" TEXT;

-- PayrollStatutoryPackage — Spectre-owned rule packages.
CREATE TABLE IF NOT EXISTS "PayrollStatutoryPackage" (
  "id"                      TEXT NOT NULL,
  "jurisdictionCountry"     TEXT NOT NULL,
  "jurisdictionProvince"    TEXT,
  "effectiveFrom"           TIMESTAMP(3) NOT NULL,
  "effectiveTo"             TIMESTAMP(3),
  "packageVersion"          TEXT NOT NULL,
  "algorithmVersion"        TEXT NOT NULL DEFAULT 'v1',
  "sourcePublication"       TEXT NOT NULL,
  "sourceEdition"           TEXT,
  "sourcePublicationDate"   TIMESTAMP(3),
  "sourceUrl"               TEXT,
  "checksum"                TEXT NOT NULL,
  "paramsJson"              TEXT NOT NULL,
  "publishedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedByUserId"       TEXT,
  "supersededAt"            TIMESTAMP(3),
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollStatutoryPackage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollStatutoryPackage_country_province_effectiveFrom_uk"
  ON "PayrollStatutoryPackage"("jurisdictionCountry", "jurisdictionProvince", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "PayrollStatutoryPackage_country_province_effectiveFrom_ix"
  ON "PayrollStatutoryPackage"("jurisdictionCountry", "jurisdictionProvince", "effectiveFrom");

-- Wire the batch's statutoryPackageId to PayrollStatutoryPackage.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayrollBatch_statutoryPackageId_fkey'
  ) THEN
    ALTER TABLE "PayrollBatch"
      ADD CONSTRAINT "PayrollBatch_statutoryPackageId_fkey"
      FOREIGN KEY ("statutoryPackageId") REFERENCES "PayrollStatutoryPackage"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS "PayrollBatch_statutoryPackageId_ix" ON "PayrollBatch"("statutoryPackageId");

-- PayrollOpeningBalance — mid-year YTD entry per (Club, Employee, taxYear).
CREATE TABLE IF NOT EXISTS "PayrollOpeningBalance" (
  "id"                      TEXT NOT NULL,
  "clubId"                  TEXT NOT NULL,
  "employeeId"              TEXT NOT NULL,
  "taxYear"                 INTEGER NOT NULL,
  "status"                  TEXT NOT NULL DEFAULT 'DRAFT',
  "ytdGrossEarnings"        DECIMAL(65,30) NOT NULL DEFAULT 0,
  "ytdTaxableEarnings"      DECIMAL(65,30) NOT NULL DEFAULT 0,
  "ytdPensionableEarnings"  DECIMAL(65,30) NOT NULL DEFAULT 0,
  "ytdInsurableEarnings"    DECIMAL(65,30) NOT NULL DEFAULT 0,
  "ytdCppEE"                DECIMAL(65,30) NOT NULL DEFAULT 0,
  "ytdCpp2EE"               DECIMAL(65,30) NOT NULL DEFAULT 0,
  "ytdEiEE"                 DECIMAL(65,30) NOT NULL DEFAULT 0,
  "ytdFederalTax"           DECIMAL(65,30) NOT NULL DEFAULT 0,
  "ytdProvincialTax"        DECIMAL(65,30) NOT NULL DEFAULT 0,
  "ytdCppER"                DECIMAL(65,30) NOT NULL DEFAULT 0,
  "ytdCpp2ER"               DECIMAL(65,30) NOT NULL DEFAULT 0,
  "ytdEiER"                 DECIMAL(65,30) NOT NULL DEFAULT 0,
  "importBatchId"           TEXT,
  "importSource"            TEXT,
  "importedAt"              TIMESTAMP(3),
  "importedByUserId"        TEXT,
  "notes"                   TEXT,
  "supersededAt"            TIMESTAMP(3),
  "supersededByUserId"      TEXT,
  "supersededById"          TEXT,
  "activatedAt"             TIMESTAMP(3),
  "activatedByUserId"       TEXT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollOpeningBalance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PayrollOpeningBalance_club_emp_year_status_ix"
  ON "PayrollOpeningBalance"("clubId", "employeeId", "taxYear", "status");
CREATE INDEX IF NOT EXISTS "PayrollOpeningBalance_club_year_status_ix"
  ON "PayrollOpeningBalance"("clubId", "taxYear", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayrollOpeningBalance_clubId_fkey'
  ) THEN
    ALTER TABLE "PayrollOpeningBalance"
      ADD CONSTRAINT "PayrollOpeningBalance_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "Club"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayrollOpeningBalance_employeeId_fkey'
  ) THEN
    ALTER TABLE "PayrollOpeningBalance"
      ADD CONSTRAINT "PayrollOpeningBalance_employeeId_fkey"
      FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayrollOpeningBalance_supersededById_fkey'
  ) THEN
    ALTER TABLE "PayrollOpeningBalance"
      ADD CONSTRAINT "PayrollOpeningBalance_supersededById_fkey"
      FOREIGN KEY ("supersededById") REFERENCES "PayrollOpeningBalance"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
