-- PAY-1A (2026-09-26) - Shared Payments Infrastructure (Postgres).
-- SQLite mirror at prisma/migrations/20260926_pay1a_payments_core/.
-- Purely additive; no data migration.

CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "institutionReference" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "maskedIdentifier" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "glAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BankAccount_clubId_status_idx" ON "BankAccount"("clubId", "status");
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PaymentDestinationSnapshot" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "recipientType" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "sourceModel" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL DEFAULT 1,
    "maskedIdentifier" TEXT NOT NULL,
    "bankFingerprint" TEXT,
    "institutionSecretRef" TEXT NOT NULL,
    "transitSecretRef" TEXT NOT NULL,
    "accountSecretRef" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentDestinationSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PaymentDestinationSnapshot_clubId_recipient_idx" ON "PaymentDestinationSnapshot"("clubId", "recipientType", "recipientId");
CREATE INDEX "PaymentDestinationSnapshot_clubId_source_idx" ON "PaymentDestinationSnapshot"("clubId", "sourceModel", "sourceId");
ALTER TABLE "PaymentDestinationSnapshot" ADD CONSTRAINT "PaymentDestinationSnapshot_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PaymentRun" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "runNumber" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceReference" TEXT,
    "fundingBankAccountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "requestedExecutionDate" TIMESTAMP(3) NOT NULL,
    "totalAmount" DECIMAL(65,30) NOT NULL,
    "instructionCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "paymentFingerprint" TEXT,
    "workIntakeItemId" TEXT,
    "providerType" TEXT,
    "providerRunReference" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "preparedAt" TIMESTAMP(3),
    "authorizedAt" TIMESTAMP(3),
    "authorizedByUserId" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancelReason" TEXT,
    "fullySettledAt" TIMESTAMP(3),
    "settlementJournalId" TEXT,
    CONSTRAINT "PaymentRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentRun_clubId_runNumber_key" ON "PaymentRun"("clubId", "runNumber");
CREATE UNIQUE INDEX "PaymentRun_paymentFingerprint_key" ON "PaymentRun"("paymentFingerprint");
CREATE UNIQUE INDEX "PaymentRun_workIntakeItemId_key" ON "PaymentRun"("workIntakeItemId");
CREATE UNIQUE INDEX "PaymentRun_settlementJournalId_key" ON "PaymentRun"("settlementJournalId");
CREATE INDEX "PaymentRun_clubId_status_idx" ON "PaymentRun"("clubId", "status");
CREATE INDEX "PaymentRun_sourceType_sourceId_idx" ON "PaymentRun"("sourceType", "sourceId");
ALTER TABLE "PaymentRun" ADD CONSTRAINT "PaymentRun_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRun" ADD CONSTRAINT "PaymentRun_fundingBankAccountId_fkey" FOREIGN KEY ("fundingBankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRun" ADD CONSTRAINT "PaymentRun_settlementJournalId_fkey" FOREIGN KEY ("settlementJournalId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PaymentInstruction" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceReference" TEXT,
    "recipientType" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "destinationSnapshotId" TEXT NOT NULL,
    "requestedExecutionDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "instructionFingerprint" TEXT NOT NULL,
    "instructionVersion" INTEGER NOT NULL DEFAULT 1,
    "providerType" TEXT,
    "providerInstructionId" TEXT,
    "providerReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "authorizedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "returnCode" TEXT,
    "returnDescription" TEXT,
    CONSTRAINT "PaymentInstruction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentInstruction_runId_recipient_key" ON "PaymentInstruction"("runId", "recipientType", "recipientId");
CREATE UNIQUE INDEX "PaymentInstruction_provider_key" ON "PaymentInstruction"("providerType", "providerInstructionId");
CREATE INDEX "PaymentInstruction_clubId_status_idx" ON "PaymentInstruction"("clubId", "status");
CREATE INDEX "PaymentInstruction_recipient_idx" ON "PaymentInstruction"("recipientType", "recipientId");
ALTER TABLE "PaymentInstruction" ADD CONSTRAINT "PaymentInstruction_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentInstruction" ADD CONSTRAINT "PaymentInstruction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PaymentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentInstruction" ADD CONSTRAINT "PaymentInstruction_destinationSnapshotId_fkey" FOREIGN KEY ("destinationSnapshotId") REFERENCES "PaymentDestinationSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PaymentAuthorization" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "authorizedByUserId" TEXT NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentFingerprint" TEXT NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "invalidatedAt" TIMESTAMP(3),
    "invalidatedReason" TEXT,
    CONSTRAINT "PaymentAuthorization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentAuthorization_runId_key" ON "PaymentAuthorization"("runId");
CREATE INDEX "PaymentAuthorization_clubId_idx" ON "PaymentAuthorization"("clubId");
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PaymentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "runId" TEXT,
    "instructionId" TEXT,
    "eventType" TEXT NOT NULL,
    "previousStatus" TEXT,
    "newStatus" TEXT,
    "actorUserId" TEXT,
    "actorSource" TEXT NOT NULL,
    "providerReference" TEXT,
    "metaJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PaymentEvent_clubId_createdAt_idx" ON "PaymentEvent"("clubId", "createdAt");
CREATE INDEX "PaymentEvent_runId_createdAt_idx" ON "PaymentEvent"("runId", "createdAt");
CREATE INDEX "PaymentEvent_instructionId_createdAt_idx" ON "PaymentEvent"("instructionId", "createdAt");
CREATE INDEX "PaymentEvent_eventType_idx" ON "PaymentEvent"("eventType");
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PaymentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_instructionId_fkey" FOREIGN KEY ("instructionId") REFERENCES "PaymentInstruction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
