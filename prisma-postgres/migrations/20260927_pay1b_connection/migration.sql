-- PAY-1B (2026-09-27) — Provider connection boundary + external event ingestion (Postgres).

CREATE TABLE "PaymentProviderConnection" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "connectionReference" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "capabilities" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentProviderConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentProviderConnection_clubId_providerType_connectionReference_key" ON "PaymentProviderConnection"("clubId", "providerType", "connectionReference");
CREATE INDEX "PaymentProviderConnection_clubId_status_idx" ON "PaymentProviderConnection"("clubId", "status");
CREATE INDEX "PaymentProviderConnection_environment_idx" ON "PaymentProviderConnection"("environment");
ALTER TABLE "PaymentProviderConnection" ADD CONSTRAINT "PaymentProviderConnection_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PaymentProviderConnectionVersion" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "credentialSecretRef" TEXT NOT NULL,
    "capabilities" TEXT,
    "activatedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentProviderConnectionVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentProviderConnectionVersion_connectionId_version_key" ON "PaymentProviderConnectionVersion"("connectionId", "version");
CREATE INDEX "PaymentProviderConnectionVersion_connectionId_activatedAt_idx" ON "PaymentProviderConnectionVersion"("connectionId", "activatedAt");
ALTER TABLE "PaymentProviderConnectionVersion" ADD CONSTRAINT "PaymentProviderConnectionVersion_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PaymentProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExternalPaymentEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "connectionId" TEXT,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "providerInstructionId" TEXT,
    "providerReference" TEXT,
    "eventType" TEXT NOT NULL,
    "providerTimestamp" TIMESTAMP(3),
    "status" TEXT,
    "amount" DECIMAL(65,30),
    "currency" TEXT,
    "returnCode" TEXT,
    "returnDescription" TEXT,
    "payloadHash" TEXT NOT NULL,
    "rawPayloadReference" TEXT,
    "verificationStatus" TEXT NOT NULL,
    "processingStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "processingNote" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "ExternalPaymentEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExternalPaymentEvent_provider_providerEventId_key" ON "ExternalPaymentEvent"("provider", "providerEventId");
CREATE INDEX "ExternalPaymentEvent_clubId_receivedAt_idx" ON "ExternalPaymentEvent"("clubId", "receivedAt");
CREATE INDEX "ExternalPaymentEvent_providerInstructionId_receivedAt_idx" ON "ExternalPaymentEvent"("providerInstructionId", "receivedAt");
CREATE INDEX "ExternalPaymentEvent_processingStatus_idx" ON "ExternalPaymentEvent"("processingStatus");
ALTER TABLE "ExternalPaymentEvent" ADD CONSTRAINT "ExternalPaymentEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExternalPaymentEvent" ADD CONSTRAINT "ExternalPaymentEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PaymentProviderConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
