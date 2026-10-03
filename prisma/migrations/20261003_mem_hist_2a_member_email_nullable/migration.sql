-- MEM-HIST-2A §2-E (2026-10-03) — SQLite mirror. SQLite does not
-- support ALTER COLUMN DROP NOT NULL; the dev schema already carries
-- `email String?` via a fresh database. If the dev DB predates this
-- change the operator re-runs `npx prisma migrate dev reset` locally.
-- Production path uses the Postgres migration (same slice) which
-- performs the real ALTER + backfill.

UPDATE "Member"
   SET "email" = NULL
 WHERE "email" LIKE 'no-email+%@placeholder.invalid';
