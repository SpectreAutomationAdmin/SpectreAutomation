-- CreateTable
CREATE TABLE "MailboxOAuthTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "pkceVerifier" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "returnPath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "outcome" TEXT,
    CONSTRAINT "MailboxOAuthTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MailboxOAuthTransaction_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MailboxConnection" (
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
    "tokenRevision" INTEGER NOT NULL DEFAULT 0,
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
INSERT INTO "new_MailboxConnection" ("accessTokenExpiresAt", "accessTokenSecretRef", "clubId", "connectedEmail", "createdAt", "deltaLink", "disconnectedAt", "disconnectedByUserId", "externalUserId", "grantedScopes", "id", "lastAttemptedSyncAt", "lastSuccessfulSyncAt", "lastSyncError", "mailboxType", "microsoftTenantId", "provider", "refreshTokenSecretRef", "status", "updatedAt", "userId") SELECT "accessTokenExpiresAt", "accessTokenSecretRef", "clubId", "connectedEmail", "createdAt", "deltaLink", "disconnectedAt", "disconnectedByUserId", "externalUserId", "grantedScopes", "id", "lastAttemptedSyncAt", "lastSuccessfulSyncAt", "lastSyncError", "mailboxType", "microsoftTenantId", "provider", "refreshTokenSecretRef", "status", "updatedAt", "userId" FROM "MailboxConnection";
DROP TABLE "MailboxConnection";
ALTER TABLE "new_MailboxConnection" RENAME TO "MailboxConnection";
CREATE INDEX "MailboxConnection_clubId_status_idx" ON "MailboxConnection"("clubId", "status");
CREATE INDEX "MailboxConnection_microsoftTenantId_externalUserId_idx" ON "MailboxConnection"("microsoftTenantId", "externalUserId");
CREATE UNIQUE INDEX "MailboxConnection_userId_clubId_provider_externalUserId_key" ON "MailboxConnection"("userId", "clubId", "provider", "externalUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "MailboxOAuthTransaction_state_key" ON "MailboxOAuthTransaction"("state");

-- CreateIndex
CREATE INDEX "MailboxOAuthTransaction_userId_clubId_createdAt_idx" ON "MailboxOAuthTransaction"("userId", "clubId", "createdAt");

-- CreateIndex
CREATE INDEX "MailboxOAuthTransaction_expiresAt_idx" ON "MailboxOAuthTransaction"("expiresAt");

