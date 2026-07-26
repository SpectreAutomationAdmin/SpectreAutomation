-- CreateTable
CREATE TABLE "MailboxSyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clubId" TEXT NOT NULL,
    "mailboxConnectionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "triggerKind" TEXT NOT NULL,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "messagesExamined" INTEGER NOT NULL DEFAULT 0,
    "messagesImported" INTEGER NOT NULL DEFAULT 0,
    "messagesUpdated" INTEGER NOT NULL DEFAULT 0,
    "intakeCreatedActionable" INTEGER NOT NULL DEFAULT 0,
    "intakeCreatedInformational" INTEGER NOT NULL DEFAULT 0,
    "messagesSuppressed" INTEGER NOT NULL DEFAULT 0,
    "messagesFailed" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "failureCategory" TEXT,
    CONSTRAINT "MailboxSyncRun_mailboxConnectionId_fkey" FOREIGN KEY ("mailboxConnectionId") REFERENCES "MailboxConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EmailMessage" (
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
    "ingestFailedAt" DATETIME,
    "ingestFailReason" TEXT,
    "retryAttempts" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "EmailMessage_mailboxConnectionId_fkey" FOREIGN KEY ("mailboxConnectionId") REFERENCES "MailboxConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_EmailMessage" ("bodyHtmlSanitized", "bodyTextExtract", "clubId", "conversationId", "createdAt", "graphMessageId", "hasAttachments", "id", "immutableId", "importance", "internetMessageId", "isRead", "lastSyncedAt", "mailboxConnectionId", "preview", "receivedAt", "recipientsJson", "senderAddress", "senderName", "sentAt", "softDeletedAt", "subject", "updatedAt", "webLink") SELECT "bodyHtmlSanitized", "bodyTextExtract", "clubId", "conversationId", "createdAt", "graphMessageId", "hasAttachments", "id", "immutableId", "importance", "internetMessageId", "isRead", "lastSyncedAt", "mailboxConnectionId", "preview", "receivedAt", "recipientsJson", "senderAddress", "senderName", "sentAt", "softDeletedAt", "subject", "updatedAt", "webLink" FROM "EmailMessage";
DROP TABLE "EmailMessage";
ALTER TABLE "new_EmailMessage" RENAME TO "EmailMessage";
CREATE INDEX "EmailMessage_clubId_receivedAt_idx" ON "EmailMessage"("clubId", "receivedAt");
CREATE INDEX "EmailMessage_conversationId_idx" ON "EmailMessage"("conversationId");
CREATE UNIQUE INDEX "EmailMessage_mailboxConnectionId_graphMessageId_key" ON "EmailMessage"("mailboxConnectionId", "graphMessageId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "MailboxSyncRun_mailboxConnectionId_queuedAt_idx" ON "MailboxSyncRun"("mailboxConnectionId", "queuedAt");

-- CreateIndex
CREATE INDEX "MailboxSyncRun_clubId_queuedAt_idx" ON "MailboxSyncRun"("clubId", "queuedAt");

