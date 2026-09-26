-- AUTH-2 (2026-09-26) — server-side authoritative Session records.
--
-- Adds a single new table plus its indexes and foreign keys. Purely
-- additive; touches no existing tables, no data migration required.
-- Existing User / Employee / Club rows are unaffected. Rollback is
-- `DROP TABLE "Session"` and revert the schema.prisma changes.
--
-- Foreign key ON DELETE CASCADE is chosen so deleting a User or
-- Employee or Club cleans up their sessions atomically (matches
-- application semantics where a deleted identity should not leave
-- orphaned session rows exploitable by DB-side manipulation).

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "userId" TEXT,
    "employeeId" TEXT,
    "clubId" TEXT,
    "activeClubId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "revokedBy" TEXT,
    "revokeReason" TEXT,
    "uaAtCreate" TEXT,
    "ipAtCreate" TEXT,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Session_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Session_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_employeeId_revokedAt_idx" ON "Session"("employeeId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_clubId_revokedAt_idx" ON "Session"("clubId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
