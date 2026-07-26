-- CreateTable
CREATE TABLE "WorkIntakeItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clubId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "ownerUserId" TEXT,
    "judgmentRequired" BOOLEAN NOT NULL DEFAULT false,
    "deferredUntil" DATETIME,
    "resolvedAt" DATETIME,
    "resolvedByUserId" TEXT,
    "classification" TEXT,
    "classificationReason" TEXT,
    "classificationMethod" TEXT,
    "classificationConfidence" REAL,
    "classificationRuleKey" TEXT,
    "classificationRuleVersion" INTEGER,
    "classificationOverriddenByUserId" TEXT,
    "classificationOverriddenAt" DATETIME,
    "displaySourceLabel" TEXT NOT NULL,
    "displaySender" TEXT NOT NULL,
    "displaySubject" TEXT NOT NULL,
    "displayPreview" TEXT NOT NULL,
    "displayReceivedAt" DATETIME NOT NULL,
    "displayHasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkIntakeItem_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WorkIntakeItem_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "WorkIntakeItem_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "WorkIntakeItem_classificationOverriddenByUserId_fkey" FOREIGN KEY ("classificationOverriddenByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkIntakeActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workIntakeItemId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkIntakeActivity_workIntakeItemId_fkey" FOREIGN KEY ("workIntakeItemId") REFERENCES "WorkIntakeItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkIntakeActivity_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmailWorkIntakeOrigin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clubId" TEXT NOT NULL,
    "workIntakeItemId" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'PRIMARY',
    "linkReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    CONSTRAINT "EmailWorkIntakeOrigin_workIntakeItemId_fkey" FOREIGN KEY ("workIntakeItemId") REFERENCES "WorkIntakeItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EmailWorkIntakeOrigin_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MailboxConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mailboxType" TEXT NOT NULL DEFAULT 'PERSONAL',
    "externalUserId" TEXT NOT NULL,
    "microsoftTenantId" TEXT NOT NULL,
    "connectedEmail" TEXT NOT NULL,
    "accessTokenSecretRef" TEXT NOT NULL,
    "refreshTokenSecretRef" TEXT NOT NULL,
    "accessTokenExpiresAt" DATETIME NOT NULL,
    "grantedScopes" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "lastSuccessfulSyncAt" DATETIME,
    "lastAttemptedSyncAt" DATETIME,
    "lastSyncError" TEXT,
    "deltaLink" TEXT,
    "disconnectedAt" DATETIME,
    "disconnectedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MailboxConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MailboxConnection_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MailboxConnection_disconnectedByUserId_fkey" FOREIGN KEY ("disconnectedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MailboxAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mailboxConnectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "revokedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MailboxAccess_mailboxConnectionId_fkey" FOREIGN KEY ("mailboxConnectionId") REFERENCES "MailboxConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MailboxAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MailboxAccess_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MailboxAccess_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GraphSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mailboxConnectionId" TEXT NOT NULL,
    "microsoftSubscriptionId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "changeTypes" TEXT NOT NULL,
    "clientStateSecretRef" TEXT NOT NULL,
    "expirationDateTime" DATETIME NOT NULL,
    "lifecycleState" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastRenewalAt" DATETIME,
    "lastNotificationAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GraphSubscription_mailboxConnectionId_fkey" FOREIGN KEY ("mailboxConnectionId") REFERENCES "MailboxConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clubId" TEXT NOT NULL,
    "mailboxConnectionId" TEXT NOT NULL,
    "graphMessageId" TEXT NOT NULL,
    "immutableId" TEXT,
    "internetMessageId" TEXT,
    "conversationId" TEXT,
    "senderName" TEXT NOT NULL,
    "senderAddress" TEXT NOT NULL,
    "recipientsJson" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL,
    "sentAt" DATETIME,
    "preview" TEXT NOT NULL,
    "bodyHtmlSanitized" TEXT,
    "bodyTextExtract" TEXT,
    "importance" TEXT NOT NULL DEFAULT 'normal',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "webLink" TEXT,
    "lastSyncedAt" DATETIME NOT NULL,
    "softDeletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailMessage_mailboxConnectionId_fkey" FOREIGN KEY ("mailboxConnectionId") REFERENCES "MailboxConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmailAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emailMessageId" TEXT NOT NULL,
    "graphAttachmentId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "isInline" BOOLEAN NOT NULL DEFAULT false,
    "storageState" TEXT NOT NULL DEFAULT 'METADATA_ONLY',
    "storageKey" TEXT,
    "scanState" TEXT NOT NULL DEFAULT 'NOT_SCANNED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailAttachment_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WorkIntakeItem_clubId_status_displayReceivedAt_idx" ON "WorkIntakeItem"("clubId", "status", "displayReceivedAt");

-- CreateIndex
CREATE INDEX "WorkIntakeItem_ownerUserId_status_idx" ON "WorkIntakeItem"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "WorkIntakeItem_clubId_updatedAt_idx" ON "WorkIntakeItem"("clubId", "updatedAt");

-- CreateIndex
CREATE INDEX "WorkIntakeActivity_workIntakeItemId_createdAt_idx" ON "WorkIntakeActivity"("workIntakeItemId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailWorkIntakeOrigin_emailMessageId_role_idx" ON "EmailWorkIntakeOrigin"("emailMessageId", "role");

-- CreateIndex
CREATE INDEX "EmailWorkIntakeOrigin_clubId_idx" ON "EmailWorkIntakeOrigin"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailWorkIntakeOrigin_workIntakeItemId_emailMessageId_key" ON "EmailWorkIntakeOrigin"("workIntakeItemId", "emailMessageId");

-- CreateIndex
CREATE INDEX "MailboxConnection_clubId_status_idx" ON "MailboxConnection"("clubId", "status");

-- CreateIndex
CREATE INDEX "MailboxConnection_microsoftTenantId_externalUserId_idx" ON "MailboxConnection"("microsoftTenantId", "externalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxConnection_userId_clubId_provider_externalUserId_key" ON "MailboxConnection"("userId", "clubId", "provider", "externalUserId");

-- CreateIndex
CREATE INDEX "MailboxAccess_userId_revokedAt_idx" ON "MailboxAccess"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxAccess_mailboxConnectionId_userId_role_key" ON "MailboxAccess"("mailboxConnectionId", "userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "GraphSubscription_microsoftSubscriptionId_key" ON "GraphSubscription"("microsoftSubscriptionId");

-- CreateIndex
CREATE INDEX "GraphSubscription_expirationDateTime_idx" ON "GraphSubscription"("expirationDateTime");

-- CreateIndex
CREATE INDEX "GraphSubscription_mailboxConnectionId_lifecycleState_idx" ON "GraphSubscription"("mailboxConnectionId", "lifecycleState");

-- CreateIndex
CREATE INDEX "EmailMessage_clubId_receivedAt_idx" ON "EmailMessage"("clubId", "receivedAt");

-- CreateIndex
CREATE INDEX "EmailMessage_conversationId_idx" ON "EmailMessage"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_mailboxConnectionId_graphMessageId_key" ON "EmailMessage"("mailboxConnectionId", "graphMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAttachment_emailMessageId_graphAttachmentId_key" ON "EmailAttachment"("emailMessageId", "graphAttachmentId");

