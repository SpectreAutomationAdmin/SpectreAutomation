-- Sprint 3 Checkpoint 15G (2026-07-24) — Vendor statement reconciliation.
-- Three additive tables. Nothing else changes.

CREATE TABLE "VendorStatementReconciliation" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "ingestedDocumentId" TEXT NOT NULL,
    "canonicalVendorId" TEXT,
    "statementDate" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "openingBalance" DECIMAL(65,30) DEFAULT 0,
    "closingBalance" DECIMAL(65,30) DEFAULT 0,
    "amountDue" DECIMAL(65,30) DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "extractionState" TEXT NOT NULL,
    "reconciliationState" TEXT NOT NULL,
    "extractionRuleVersion" INTEGER NOT NULL DEFAULT 1,
    "reconciliationRuleVersion" INTEGER NOT NULL DEFAULT 1,
    "lastAnalysedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VendorStatementReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VendorStatementReconciliation_ingestedDocumentId_key"
    ON "VendorStatementReconciliation"("ingestedDocumentId");
CREATE INDEX "VendorStatementReconciliation_clubId_statementDate_idx"
    ON "VendorStatementReconciliation"("clubId", "statementDate");
CREATE INDEX "VendorStatementReconciliation_clubId_canonicalVendorId_idx"
    ON "VendorStatementReconciliation"("clubId", "canonicalVendorId");
CREATE INDEX "VendorStatementReconciliation_clubId_reconciliationState_idx"
    ON "VendorStatementReconciliation"("clubId", "reconciliationState");

ALTER TABLE "VendorStatementReconciliation"
    ADD CONSTRAINT "VendorStatementReconciliation_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorStatementReconciliation"
    ADD CONSTRAINT "VendorStatementReconciliation_ingestedDocumentId_fkey"
    FOREIGN KEY ("ingestedDocumentId") REFERENCES "IngestedDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorStatementReconciliation"
    ADD CONSTRAINT "VendorStatementReconciliation_canonicalVendorId_fkey"
    FOREIGN KEY ("canonicalVendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;


CREATE TABLE "VendorStatementLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "reconciliationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "transactionDate" TIMESTAMP(3),
    "referenceNumber" TEXT,
    "description" TEXT,
    "transactionKind" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "debitAmount" DECIMAL(65,30) DEFAULT 0,
    "creditAmount" DECIMAL(65,30) DEFAULT 0,
    "runningBalance" DECIMAL(65,30),
    "extractionEvidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VendorStatementLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VendorStatementLine_reconciliationId_sequence_key"
    ON "VendorStatementLine"("reconciliationId", "sequence");
CREATE INDEX "VendorStatementLine_reconciliationId_idx"
    ON "VendorStatementLine"("reconciliationId");
CREATE INDEX "VendorStatementLine_clubId_referenceNumber_idx"
    ON "VendorStatementLine"("clubId", "referenceNumber");

ALTER TABLE "VendorStatementLine"
    ADD CONSTRAINT "VendorStatementLine_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorStatementLine"
    ADD CONSTRAINT "VendorStatementLine_reconciliationId_fkey"
    FOREIGN KEY ("reconciliationId") REFERENCES "VendorStatementReconciliation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "VendorStatementLineMatch" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "statementLineId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetReferenceId" TEXT,
    "matchState" TEXT NOT NULL,
    "matchBasis" TEXT,
    "amountDifference" DECIMAL(65,30),
    "dateDifferenceDays" INTEGER,
    "reviewerDecision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VendorStatementLineMatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VendorStatementLineMatch_statementLineId_idx"
    ON "VendorStatementLineMatch"("statementLineId");
CREATE INDEX "VendorStatementLineMatch_clubId_target_idx"
    ON "VendorStatementLineMatch"("clubId", "targetKind", "targetReferenceId");

ALTER TABLE "VendorStatementLineMatch"
    ADD CONSTRAINT "VendorStatementLineMatch_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorStatementLineMatch"
    ADD CONSTRAINT "VendorStatementLineMatch_statementLineId_fkey"
    FOREIGN KEY ("statementLineId") REFERENCES "VendorStatementLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
