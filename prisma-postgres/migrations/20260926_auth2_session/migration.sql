-- AUTH-2 (2026-09-26) — server-side authoritative Session records (Postgres).
--
-- SQLite mirror lives at prisma/migrations/20260926_auth2_session/migration.sql.
-- Adds a single new table plus indexes and foreign keys. Purely additive; touches
-- no existing tables, no data migration required. Existing User / Employee / Club
-- rows are unaffected. Rollback is `DROP TABLE "Session"` and revert the
-- prisma-postgres/schema.prisma changes.
--
-- ON DELETE CASCADE is chosen so deleting a User / Employee / Club cleans up
-- their sessions atomically (application semantics: a deleted identity should
-- not leave orphaned session rows exploitable by DB-side manipulation).

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "userId" TEXT,
    "employeeId" TEXT,
    "clubId" TEXT,
    "activeClubId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokeReason" TEXT,
    "uaAtCreate" TEXT,
    "ipAtCreate" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
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

-- AddForeignKey
ALTER TABLE "Session"
    ADD CONSTRAINT "Session_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session"
    ADD CONSTRAINT "Session_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session"
    ADD CONSTRAINT "Session_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
