-- Phase 4R rev-13 (2026-08-16) — SQLite mirror of the postgres
-- migration under prisma-postgres/migrations/20260816_phase4r_rev13_...

ALTER TABLE "OutlookMarkReadMutation" ADD COLUMN "generationCursor" TEXT;

DROP INDEX IF EXISTS "OutlookMarkReadMutation_conn_msg_uniq";

CREATE INDEX "OutlookMarkReadMutation_conn_msg_status_idx"
  ON "OutlookMarkReadMutation"("mailboxConnectionId", "emailMessageId", "status");
