-- WI-SYNC-1b (2026-10-18) — bounded reconciliation cursor on
-- MailboxConnection.  Each scheduled sweep walks older messages
-- across runs via this receivedAt cursor rather than repeatedly
-- re-scanning the same newest N rows.  Nullable; null means
-- "scan newest" (first sweep after connection, and the fresh-
-- start marker after a full-cycle completion).  Operator-
-- initiated runs ignore this column.

ALTER TABLE "MailboxConnection"
  ADD COLUMN "reconciliationCursorReceivedAt" TIMESTAMP(3);
