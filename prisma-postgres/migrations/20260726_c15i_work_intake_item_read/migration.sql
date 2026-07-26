-- Sprint 3 Checkpoint 15I — per-user Work Intake read state.
--
-- Adds `WorkIntakeItemRead(workIntakeItemId, userId, readAt)` so the
-- Mission Control card's unread hierarchy is per-user, not per-mailbox.
-- Two admins working the same queue see their own unread counts.
--
-- Merely rendering the feed does NOT mark items read — a row appears
-- here only when the user intentionally opens a card. Absence of a
-- row → unread for that user.
--
-- ON DELETE CASCADE on both foreign keys: a removed intake or a
-- removed user cleans up its read rows.

CREATE TABLE "WorkIntakeItemRead" (
    "workIntakeItemId" TEXT NOT NULL,
    "userId"           TEXT NOT NULL,
    "readAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkIntakeItemRead_pkey" PRIMARY KEY ("workIntakeItemId", "userId")
);

ALTER TABLE "WorkIntakeItemRead"
    ADD CONSTRAINT "WorkIntakeItemRead_workIntakeItemId_fkey"
    FOREIGN KEY ("workIntakeItemId") REFERENCES "WorkIntakeItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkIntakeItemRead"
    ADD CONSTRAINT "WorkIntakeItemRead_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "WorkIntakeItemRead_userId_readAt_idx"
    ON "WorkIntakeItemRead"("userId", "readAt");
