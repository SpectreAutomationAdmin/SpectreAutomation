-- MEM-HIST-2A §2-E (2026-10-03) — Member.email nullable + backfill
-- the MEM-HIST-2 placeholder.invalid values to NULL.
--
-- Legitimate email addresses on PRE-existing Member rows are NEVER
-- touched — the UPDATE's WHERE clause pins to the exact
-- "no-email+<membernumber>@placeholder.invalid" pattern.
--
-- Zero accounting-table mutations.

ALTER TABLE "Member" ALTER COLUMN "email" DROP NOT NULL;

UPDATE "Member"
   SET "email" = NULL
 WHERE "email" LIKE 'no-email+%@placeholder.invalid';
