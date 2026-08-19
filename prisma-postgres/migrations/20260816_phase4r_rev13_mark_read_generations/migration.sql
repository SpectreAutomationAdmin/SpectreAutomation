-- Phase 4R rev-13 (2026-08-16) — retire the permanent
-- mark-read latch on (mailboxConnectionId, emailMessageId).
--
-- Rev-10 modelled the OutlookMarkReadMutation table as ONE row
-- per (mailbox, message), enforced by a @@unique constraint.
-- Combined with the worker's `if (status === "SUCCEEDED") return`
-- short-circuit, this meant every future Spectre-side click on
-- an email that had ever been marked read PERMANENTLY skipped
-- Graph — for life. The rev-12 diagnostic proved this was the
-- root cause of founder observation #2 (invoice #221007's
-- Spectre interaction did not propagate to Outlook after a
-- subsequent Outlook-side unmark).
--
-- Rev-13 models mark-read as INTENTS / GENERATIONS. Each new
-- Spectre-initiated read attempt creates a NEW row. Historical
-- rows remain as immutable audit. Active-intent deduplication
-- is moved to the ENQUEUE site (application-layer query for a
-- currently-active row with status IN
-- ['PENDING','RUNNING','RETRYABLE']) instead of a DB unique
-- constraint that couldn't distinguish "active" from "historical".
--
-- Migration:
--   1. Add `generationCursor` audit column (nullable — historical
--      rows carry NULL, new rows record EmailMessage.updatedAt at
--      enqueue time).
--   2. Drop the (mailboxConnectionId, emailMessageId) unique.
--   3. Add a (mailboxConnectionId, emailMessageId, status)
--      composite index so the active-intent dedupe query is fast.
--   4. Historical rows are preserved verbatim.
--
-- Rollback: dropping the added index + column is safe. Restoring
-- the @@unique would fail if any (mailbox, message) now has more
-- than one row; that would require a data cleanup step BEFORE
-- re-adding the constraint. Document this in the checkpoint.

ALTER TABLE "OutlookMarkReadMutation" ADD COLUMN "generationCursor" TEXT;

DROP INDEX IF EXISTS "OutlookMarkReadMutation_conn_msg_uniq";

CREATE INDEX "OutlookMarkReadMutation_conn_msg_status_idx"
  ON "OutlookMarkReadMutation"("mailboxConnectionId", "emailMessageId", "status");
