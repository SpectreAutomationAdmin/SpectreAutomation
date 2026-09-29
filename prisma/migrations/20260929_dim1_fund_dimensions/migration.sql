-- DIM-1 (2026-09-29) — SQLite dev mirror of the Postgres migration.
-- SQLite semantics: no ALTER TABLE ADD CONSTRAINT and no per-statement
-- FK add after table creation; the FKs on new tables are declared
-- inline. For fundId on existing tables we add a nullable column and
-- rely on Prisma-Client-driven FK behaviour (SQLite enforces FKs only
-- when PRAGMA foreign_keys=ON, which the dev environment has enabled
-- in setup.ts).

-- 1. Account policy columns.
ALTER TABLE "Account" ADD COLUMN "departmentPolicy" TEXT NOT NULL DEFAULT 'OPTIONAL';
ALTER TABLE "Account" ADD COLUMN "fundPolicy"       TEXT NOT NULL DEFAULT 'OPTIONAL';

-- 2. Fund.
CREATE TABLE "Fund" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "clubId"    TEXT NOT NULL,
  "key"       TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "isActive"  BOOLEAN NOT NULL DEFAULT TRUE,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Fund_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Fund_clubId_key_key"      ON "Fund" ("clubId", "key");
CREATE INDEX        "Fund_clubId_isActive_idx" ON "Fund" ("clubId", "isActive");

-- 3. AccountFund.
CREATE TABLE "AccountFund" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "clubId"    TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "fundId"    TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountFund_clubId_fkey"    FOREIGN KEY ("clubId")    REFERENCES "Club" ("id")    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AccountFund_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AccountFund_fundId_fkey"    FOREIGN KEY ("fundId")    REFERENCES "Fund" ("id")    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AccountFund_accountId_fundId_key" ON "AccountFund" ("accountId", "fundId");
CREATE INDEX        "AccountFund_clubId_idx"           ON "AccountFund" ("clubId");
CREATE INDEX        "AccountFund_fundId_idx"           ON "AccountFund" ("fundId");

-- 4. Line-level fundId columns + indexes on existing tables.
ALTER TABLE "JournalEntryLine" ADD COLUMN "fundId" TEXT REFERENCES "Fund" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "APInvoiceLine"    ADD COLUMN "fundId" TEXT REFERENCES "Fund" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BudgetLine"       ADD COLUMN "fundId" TEXT REFERENCES "Fund" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ForecastLine"     ADD COLUMN "fundId" TEXT REFERENCES "Fund" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "JournalEntryLine_fundId_idx"       ON "JournalEntryLine" ("fundId");
CREATE INDEX "JournalEntryLine_departmentId_idx" ON "JournalEntryLine" ("departmentId");
CREATE INDEX "APInvoiceLine_fundId_idx"          ON "APInvoiceLine" ("fundId");
CREATE INDEX "BudgetLine_fundId_idx"             ON "BudgetLine" ("fundId");
CREATE INDEX "ForecastLine_fundId_idx"           ON "ForecastLine" ("fundId");
