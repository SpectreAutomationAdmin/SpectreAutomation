-- Payroll-3C-5 (2026-09-09) — per-Component opening YTD row.
--
-- Additive extension to PayrollOpeningBalance so that pay statements
-- can render Current + YTD for every Payroll Component (Cell Phone
-- Allowance, RRSP EE/ER, LTD, etc.) even when opening YTD comes from
-- a prior payroll system.

CREATE TABLE "PayrollOpeningBalanceComponent" (
  "id"                TEXT PRIMARY KEY,
  "clubId"            TEXT NOT NULL,
  "openingBalanceId"  TEXT NOT NULL,
  "sourceComponentId" TEXT,
  "componentCode"     TEXT NOT NULL,
  "displayName"       TEXT NOT NULL,
  "category"          TEXT NOT NULL,
  "side"              TEXT NOT NULL,
  "cashEffect"        TEXT NOT NULL,
  "ytdAmount"         DECIMAL NOT NULL DEFAULT 0,
  "ytdQuantity"       DECIMAL,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PayrollOpeningBalanceComponent_openingBalance_fk"
    FOREIGN KEY ("openingBalanceId") REFERENCES "PayrollOpeningBalance"("id") ON DELETE CASCADE,
  CONSTRAINT "PayrollOpeningBalanceComponent_club_fk"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id"),
  CONSTRAINT "PayrollOpeningBalanceComponent_source_fk"
    FOREIGN KEY ("sourceComponentId") REFERENCES "PayrollComponent"("id")
);

CREATE UNIQUE INDEX "PayrollOpeningBalanceComponent_openingBalanceId_componentCode_key"
  ON "PayrollOpeningBalanceComponent" ("openingBalanceId", "componentCode");
CREATE INDEX "PayrollOpeningBalanceComponent_clubId_componentCode_idx"
  ON "PayrollOpeningBalanceComponent" ("clubId", "componentCode");
CREATE INDEX "PayrollOpeningBalanceComponent_openingBalanceId_idx"
  ON "PayrollOpeningBalanceComponent" ("openingBalanceId");
