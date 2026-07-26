-- Sprint 3 Checkpoint 15D (2026-07-24) — Immutable ingested-document
-- store. Additive; no changes to existing tables. Safe to deploy in
-- rolling fashion; readers of older schemas ignore the new tables.

CREATE TABLE "IngestedDocument" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceReferenceId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "sha256Hash" TEXT NOT NULL,
    "storageBucket" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "classification" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "classificationSource" TEXT NOT NULL DEFAULT 'RULE',
    "classificationRuleKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'STORED',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IngestedDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IngestedDocument_clubId_sha256Hash_key"
    ON "IngestedDocument"("clubId", "sha256Hash");
CREATE INDEX "IngestedDocument_clubId_receivedAt_idx"
    ON "IngestedDocument"("clubId", "receivedAt");
CREATE INDEX "IngestedDocument_clubId_classification_idx"
    ON "IngestedDocument"("clubId", "classification");
CREATE INDEX "IngestedDocument_clubId_sourceKind_sourceReferenceId_idx"
    ON "IngestedDocument"("clubId", "sourceKind", "sourceReferenceId");

ALTER TABLE "IngestedDocument"
    ADD CONSTRAINT "IngestedDocument_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE TABLE "IngestedDocumentEvidenceLink" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "ingestedDocumentId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetReferenceId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'EVIDENCE',
    "linkReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    CONSTRAINT "IngestedDocumentEvidenceLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IngestedDocumentEvidenceLink_doc_target_role_key"
    ON "IngestedDocumentEvidenceLink"("ingestedDocumentId", "targetKind", "targetReferenceId", "role");
CREATE INDEX "IngestedDocumentEvidenceLink_clubId_target_idx"
    ON "IngestedDocumentEvidenceLink"("clubId", "targetKind", "targetReferenceId");

ALTER TABLE "IngestedDocumentEvidenceLink"
    ADD CONSTRAINT "IngestedDocumentEvidenceLink_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IngestedDocumentEvidenceLink"
    ADD CONSTRAINT "IngestedDocumentEvidenceLink_ingestedDocumentId_fkey"
    FOREIGN KEY ("ingestedDocumentId") REFERENCES "IngestedDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "IngestedDocumentAuditLog" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "ingestedDocumentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorUserId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "detailsJson" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IngestedDocumentAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IngestedDocumentAuditLog_doc_occurredAt_idx"
    ON "IngestedDocumentAuditLog"("ingestedDocumentId", "occurredAt");
CREATE INDEX "IngestedDocumentAuditLog_clubId_occurredAt_idx"
    ON "IngestedDocumentAuditLog"("clubId", "occurredAt");

ALTER TABLE "IngestedDocumentAuditLog"
    ADD CONSTRAINT "IngestedDocumentAuditLog_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IngestedDocumentAuditLog"
    ADD CONSTRAINT "IngestedDocumentAuditLog_ingestedDocumentId_fkey"
    FOREIGN KEY ("ingestedDocumentId") REFERENCES "IngestedDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
