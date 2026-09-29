-- DIM-1 (2026-09-29) — dimensional accounting foundation.
--
-- Introduces Fund + AccountFund as first-class per-club models,
-- adds line-level fundId dimension columns to JournalEntryLine /
-- APInvoiceLine / BudgetLine / ForecastLine, and adds departmentPolicy
-- + fundPolicy columns to Account so posting validation can enforce
-- REQUIRED / OPTIONAL / NOT_APPLICABLE per account.
--
-- Backward-compatibility guarantees:
--   * Every new column is nullable OR has a DEFAULT so existing rows
--     in the shared staging database survive the migration untouched.
--   * Fund + AccountFund are new tables with no prior data.
--   * Account.fundApplicability CSV is preserved unchanged; it is now
--     documented as legacy (retirement path in DIM-2).
--   * Line-level fundId FKs use ON DELETE SET NULL so future Fund
--     deactivation cannot orphan historical accounting activity.

-- 1. Account policy columns (safe defaults).
ALTER TABLE "Account"
  ADD COLUMN "departmentPolicy" TEXT NOT NULL DEFAULT 'OPTIONAL',
  ADD COLUMN "fundPolicy"       TEXT NOT NULL DEFAULT 'OPTIONAL';

-- 2. Fund — first-class dimension.
CREATE TABLE "Fund" (
  "id"        TEXT NOT NULL,
  "clubId"    TEXT NOT NULL,
  "key"       TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "isActive"  BOOLEAN NOT NULL DEFAULT TRUE,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Fund_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Fund_clubId_key_key"      ON "Fund" ("clubId", "key");
CREATE INDEX        "Fund_clubId_isActive_idx" ON "Fund" ("clubId", "isActive");

ALTER TABLE "Fund"
  ADD CONSTRAINT "Fund_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. AccountFund — applicability M2M, analogous to AccountDepartment.
CREATE TABLE "AccountFund" (
  "id"        TEXT NOT NULL,
  "clubId"    TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "fundId"    TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountFund_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountFund_accountId_fundId_key" ON "AccountFund" ("accountId", "fundId");
CREATE INDEX        "AccountFund_clubId_idx"           ON "AccountFund" ("clubId");
CREATE INDEX        "AccountFund_fundId_idx"           ON "AccountFund" ("fundId");

ALTER TABLE "AccountFund"
  ADD CONSTRAINT "AccountFund_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AccountFund_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AccountFund_fundId_fkey"
    FOREIGN KEY ("fundId") REFERENCES "Fund" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Line-level fundId (nullable) on the accounting-line tables.
ALTER TABLE "JournalEntryLine" ADD COLUMN "fundId" TEXT;
ALTER TABLE "APInvoiceLine"    ADD COLUMN "fundId" TEXT;
ALTER TABLE "BudgetLine"       ADD COLUMN "fundId" TEXT;
ALTER TABLE "ForecastLine"     ADD COLUMN "fundId" TEXT;

CREATE INDEX "JournalEntryLine_fundId_idx"     ON "JournalEntryLine" ("fundId");
CREATE INDEX "JournalEntryLine_departmentId_idx" ON "JournalEntryLine" ("departmentId");
CREATE INDEX "APInvoiceLine_fundId_idx"        ON "APInvoiceLine" ("fundId");
CREATE INDEX "BudgetLine_fundId_idx"           ON "BudgetLine" ("fundId");
CREATE INDEX "ForecastLine_fundId_idx"         ON "ForecastLine" ("fundId");

ALTER TABLE "JournalEntryLine"
  ADD CONSTRAINT "JournalEntryLine_fundId_fkey"
    FOREIGN KEY ("fundId") REFERENCES "Fund" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "APInvoiceLine"
  ADD CONSTRAINT "APInvoiceLine_fundId_fkey"
    FOREIGN KEY ("fundId") REFERENCES "Fund" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BudgetLine"
  ADD CONSTRAINT "BudgetLine_fundId_fkey"
    FOREIGN KEY ("fundId") REFERENCES "Fund" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ForecastLine"
  ADD CONSTRAINT "ForecastLine_fundId_fkey"
    FOREIGN KEY ("fundId") REFERENCES "Fund" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
