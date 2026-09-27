-- PAY-1B (2026-09-27) — Provider connection boundary + external event ingestion (SQLite).

CREATE TABLE "PaymentProviderConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clubId" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "connectionReference" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "capabilities" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaymentProviderConnection_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PaymentProviderConnection_club_key" ON "PaymentProviderConnection"("clubId", "providerType", "connectionReference");
CREATE INDEX "PaymentProviderConnection_clubId_status_idx" ON "PaymentProviderConnection"("clubId", "status");
CREATE INDEX "PaymentProviderConnection_environment_idx" ON "PaymentProviderConnection"("environment");

CREATE TABLE "PaymentProviderConnectionVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "credentialSecretRef" TEXT NOT NULL,
    "capabilities" TEXT,
    "activatedAt" DATETIME,
    "deactivatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentProviderConnectionVersion_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PaymentProviderConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PaymentProviderConnectionVersion_conn_ver_key" ON "PaymentProviderConnectionVersion"("connectionId", "version");
CREATE INDEX "PaymentProviderConnectionVersion_connectionId_activatedAt_idx" ON "PaymentProviderConnectionVersion"("connectionId", "activatedAt");

CREATE TABLE "ExternalPaymentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clubId" TEXT NOT NULL,
    "connectionId" TEXT,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "providerInstructionId" TEXT,
    "providerReference" TEXT,
    "eventType" TEXT NOT NULL,
    "providerTimestamp" DATETIME,
    "status" TEXT,
    "amount" DECIMAL,
    "currency" TEXT,
    "returnCode" TEXT,
    "returnDescription" TEXT,
    "payloadHash" TEXT NOT NULL,
    "rawPayloadReference" TEXT,
    "verificationStatus" TEXT NOT NULL,
    "processingStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "processingNote" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    CONSTRAINT "ExternalPaymentEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ExternalPaymentEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PaymentProviderConnection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ExternalPaymentEvent_provider_eventId_key" ON "ExternalPaymentEvent"("provider", "providerEventId");
CREATE INDEX "ExternalPaymentEvent_clubId_receivedAt_idx" ON "ExternalPaymentEvent"("clubId", "receivedAt");
CREATE INDEX "ExternalPaymentEvent_providerInstructionId_receivedAt_idx" ON "ExternalPaymentEvent"("providerInstructionId", "receivedAt");
CREATE INDEX "ExternalPaymentEvent_processingStatus_idx" ON "ExternalPaymentEvent"("processingStatus");
