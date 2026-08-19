-- HR-2B.3 tail (2026-08-18) — Explicit Club-level designation of the
-- outbound Microsoft 365 mailbox.
--
-- A Club may connect many MailboxConnection rows (Controller, AP, HR,
-- GM, shared accounting, …). Connecting another mailbox MUST NEVER
-- silently change the Club's outbound sender. This column captures
-- the explicit operator designation.
--
-- ON DELETE SET NULL — if the underlying MailboxConnection is
-- hard-deleted, the Club's designation drops gracefully. The
-- disconnect flow (MAILBOX_STATUS.DISCONNECTED) does NOT delete the
-- row; the adapter selector refuses to use a non-CONNECTED designated
-- mailbox and falls through to the next canonical adapter tier.

ALTER TABLE "Club"
  ADD COLUMN "outboundMailboxConnectionId" TEXT;

ALTER TABLE "Club"
  ADD CONSTRAINT "Club_outboundMailboxConnectionId_fkey"
  FOREIGN KEY ("outboundMailboxConnectionId")
  REFERENCES "MailboxConnection"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "Club_outboundMailboxConnectionId_idx"
  ON "Club"("outboundMailboxConnectionId");
