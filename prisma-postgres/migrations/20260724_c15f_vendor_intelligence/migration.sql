-- Sprint 3 Checkpoint 15F (2026-07-24) — Vendor Master Intelligence.
-- Additive; no changes to existing tables. Safe to deploy in rolling
-- fashion; readers of older schemas ignore the two new tables.

CREATE TABLE "VendorAlias" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "canonicalVendorId" TEXT NOT NULL,
    "aliasKind" TEXT NOT NULL,
    "aliasValue" TEXT NOT NULL,
    "aliasValueNormalized" TEXT NOT NULL,
    "originVendorId" TEXT,
    "createdViaMergeId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VendorAlias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VendorAlias_clubId_aliasKind_aliasValueNormalized_key"
    ON "VendorAlias"("clubId", "aliasKind", "aliasValueNormalized");
CREATE INDEX "VendorAlias_canonicalVendorId_idx"
    ON "VendorAlias"("canonicalVendorId");
CREATE INDEX "VendorAlias_clubId_aliasKind_idx"
    ON "VendorAlias"("clubId", "aliasKind");

ALTER TABLE "VendorAlias"
    ADD CONSTRAINT "VendorAlias_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorAlias"
    ADD CONSTRAINT "VendorAlias_canonicalVendorId_fkey"
    FOREIGN KEY ("canonicalVendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "VendorMergeRecord" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "winnerVendorId" TEXT NOT NULL,
    "loserVendorId" TEXT NOT NULL,
    "initiatedByUserId" TEXT,
    "approvedByUserId" TEXT,
    "reason" TEXT NOT NULL,
    "movedInvoicesCount" INTEGER NOT NULL DEFAULT 0,
    "movedPaymentsCount" INTEGER NOT NULL DEFAULT 0,
    "movedContactsCount" INTEGER NOT NULL DEFAULT 0,
    "movedBankingCount" INTEGER NOT NULL DEFAULT 0,
    "movedDocumentsCount" INTEGER NOT NULL DEFAULT 0,
    "movedRiskFlagsCount" INTEGER NOT NULL DEFAULT 0,
    "movedApExceptionsCount" INTEGER NOT NULL DEFAULT 0,
    "movedInventoryItemsCount" INTEGER NOT NULL DEFAULT 0,
    "movedInventoryReceivingsCount" INTEGER NOT NULL DEFAULT 0,
    "movedGolfProfessionalsCount" INTEGER NOT NULL DEFAULT 0,
    "movedLibraryDocumentsCount" INTEGER NOT NULL DEFAULT 0,
    "cancelledApprovalsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAliasesCount" INTEGER NOT NULL DEFAULT 0,
    "simulationJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMMITTED',
    "reversalOfMergeId" TEXT,
    "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VendorMergeRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VendorMergeRecord_clubId_committedAt_idx"
    ON "VendorMergeRecord"("clubId", "committedAt");
CREATE INDEX "VendorMergeRecord_winnerVendorId_idx"
    ON "VendorMergeRecord"("winnerVendorId");
CREATE INDEX "VendorMergeRecord_loserVendorId_idx"
    ON "VendorMergeRecord"("loserVendorId");

ALTER TABLE "VendorMergeRecord"
    ADD CONSTRAINT "VendorMergeRecord_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorMergeRecord"
    ADD CONSTRAINT "VendorMergeRecord_winnerVendorId_fkey"
    FOREIGN KEY ("winnerVendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorMergeRecord"
    ADD CONSTRAINT "VendorMergeRecord_loserVendorId_fkey"
    FOREIGN KEY ("loserVendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
