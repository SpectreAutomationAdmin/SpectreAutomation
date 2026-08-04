-- Sprint 3 · Checkpoint 16F revised (2026-08-04) — separate founder-review
-- data from regression data. Coulee Ridge remains the sole staging /
-- demo / founder-review tenant; regression data is separated by
-- *data-mode* within the same tenant, not by a second tenant.
--
-- Adds:
--   1. Club.isDemoTenant boolean (environment safeguard; NOT the
--      primary discriminator).
--   2. Club.stagingDataMode string default "FOUNDER_REVIEW" — the
--      primary write-mode discriminator. Fixture writers must check
--      this per operation class.
--   3. RegressionExpectation table — per-SHA-256 expected results for
--      the benchmark runner. Regression documents live on the
--      founder-review tenant but do NOT materialise operational
--      wrappers (Work Intake, Members, Vendors, AR).

-- --------------------------------------------------------------------------
-- 1. Club.isDemoTenant + Club.stagingDataMode
-- --------------------------------------------------------------------------
ALTER TABLE "Club" ADD COLUMN "isDemoTenant" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Club" ADD COLUMN "stagingDataMode" TEXT NOT NULL DEFAULT 'FOUNDER_REVIEW';

-- --------------------------------------------------------------------------
-- 2. RegressionExpectation
-- --------------------------------------------------------------------------
CREATE TABLE "RegressionExpectation" (
    "id"                        TEXT NOT NULL,
    "documentSha256"            TEXT NOT NULL,
    "label"                     TEXT NOT NULL,
    "category"                  TEXT NOT NULL,
    "expectedSupplier"          TEXT,
    "expectedInvoiceNumber"     TEXT,
    "expectedGrossTotalCents"   INTEGER,
    "expectedCurrency"          TEXT,
    "expectedAccountingNature"  TEXT,
    "expectedDepartmentKey"     TEXT,
    "expectedGlAccountNumber"   TEXT,
    "expectedAllocationCount"   INTEGER,
    "assertSupplier"            BOOLEAN NOT NULL DEFAULT true,
    "assertGlAccount"           BOOLEAN NOT NULL DEFAULT true,
    "assertAccountingNature"    BOOLEAN NOT NULL DEFAULT true,
    "assertDepartment"          BOOLEAN NOT NULL DEFAULT false,
    "notes"                     TEXT,
    "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                 TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegressionExpectation_pkey" PRIMARY KEY ("id")
);

-- SHA-256 is the identity — at most one expectation per document.
CREATE UNIQUE INDEX "RegressionExpectation_documentSha256_key"
  ON "RegressionExpectation"("documentSha256");
CREATE INDEX "RegressionExpectation_category_idx"
  ON "RegressionExpectation"("category");
