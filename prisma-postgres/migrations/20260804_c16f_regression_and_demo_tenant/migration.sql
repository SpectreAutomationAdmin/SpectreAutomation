-- Sprint 3 · Checkpoint 16F (2026-08-04) — separate founder-review
-- data from regression data.
--
-- Adds:
--   1. Club.isDemoTenant boolean (default false). Fixture generators
--      hard-refuse to write to any club with isDemoTenant=false.
--   2. RegressionExpectation table — tenant-independent expectation
--      set keyed by document SHA-256. AP intelligence engine can be
--      benchmarked against this without creating Work Intake items.

-- --------------------------------------------------------------------------
-- 1. Club.isDemoTenant
-- --------------------------------------------------------------------------
ALTER TABLE "Club" ADD COLUMN "isDemoTenant" BOOLEAN NOT NULL DEFAULT false;

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
