-- PAY-1C (2026-09-26) — PSP & Canadian rail readiness.
-- Incident architecture + provider-neutral limits + adapter certification.
-- No PAY-1A / PAY-1B state is mutated by this migration.

-- PaymentIncident ---------------------------------------------------------
CREATE TABLE "PaymentIncident" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "incidentNumber" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DETECTED',
    "summary" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triagedAt" TIMESTAMP(3),
    "containedAt" TIMESTAMP(3),
    "investigatedAt" TIMESTAMP(3),
    "recoveredAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "detectedByUserId" TEXT,
    "detectedSource" TEXT NOT NULL,
    "regulatoryAssessmentRequired" BOOLEAN NOT NULL DEFAULT false,
    "timelineJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentIncident_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentIncident_incidentNumber_key" ON "PaymentIncident"("incidentNumber");
CREATE INDEX "PaymentIncident_clubId_status_idx" ON "PaymentIncident"("clubId", "status");
CREATE INDEX "PaymentIncident_category_idx" ON "PaymentIncident"("category");
CREATE INDEX "PaymentIncident_severity_idx" ON "PaymentIncident"("severity");
CREATE INDEX "PaymentIncident_detectedAt_idx" ON "PaymentIncident"("detectedAt");
ALTER TABLE "PaymentIncident" ADD CONSTRAINT "PaymentIncident_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PaymentIncidentLink -----------------------------------------------------
CREATE TABLE "PaymentIncidentLink" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentIncidentLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentIncidentLink_incidentId_entityType_entityId_key" ON "PaymentIncidentLink"("incidentId", "entityType", "entityId");
CREATE INDEX "PaymentIncidentLink_entityType_entityId_idx" ON "PaymentIncidentLink"("entityType", "entityId");
ALTER TABLE "PaymentIncidentLink" ADD CONSTRAINT "PaymentIncidentLink_incidentId_fkey"
    FOREIGN KEY ("incidentId") REFERENCES "PaymentIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PaymentLimit ------------------------------------------------------------
CREATE TABLE "PaymentLimit" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "providerType" TEXT,
    "kind" TEXT NOT NULL,
    "paymentType" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "amountLimit" DECIMAL(65,30) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveUntil" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentLimit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PaymentLimit_clubId_kind_status_idx" ON "PaymentLimit"("clubId", "kind", "status");
CREATE INDEX "PaymentLimit_providerType_kind_idx" ON "PaymentLimit"("providerType", "kind");
ALTER TABLE "PaymentLimit" ADD CONSTRAINT "PaymentLimit_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PaymentProviderCertification -------------------------------------------
CREATE TABLE "PaymentProviderCertification" (
    "id" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "readiness" TEXT NOT NULL DEFAULT 'DEVELOPMENT',
    "conformancePassedAt" TIMESTAMP(3),
    "sandboxAcceptedAt" TIMESTAMP(3),
    "productionApprovedAt" TIMESTAMP(3),
    "productionApprovedBy" TEXT,
    "evidenceJson" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentProviderCertification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentProviderCertification_providerType_key" ON "PaymentProviderCertification"("providerType");
