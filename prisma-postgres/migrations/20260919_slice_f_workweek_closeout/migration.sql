-- Slice F workweek-closeout (2026-09-19)
-- ---------------------------------------
-- Separates the CLUB workweek boundary from the statutory OT policy.
--
--   * Adds `PayrollClubConfig.workweekStartsOn` (nullable String,
--     "SUNDAY".."SATURDAY") as the durable workweek representation.
--     NULLABLE by design: hourly payrolls must explicitly configure
--     the workweek — no silent Sunday default.
--   * Adds `PayrollBatchEmployee.workweekStartsOnSnapshot` (nullable
--     String) so the workweek used at Prepare is frozen alongside the
--     other Slice F snapshot columns.
--
-- Backfill: for the synthetic staging tenant only (slug
-- 'slice-c-benefits-test'), seed workweekStartsOn = 'SUNDAY' so the
-- existing 40/10 acceptance results remain reproducible. Every other
-- tenant remains NULL — hourly Prepare will fail-close on
-- WORKWEEK_NOT_CONFIGURED until the operator sets a value.
--
-- Do NOT touch Coulee Ridge configuration.

ALTER TABLE "PayrollClubConfig"
  ADD COLUMN IF NOT EXISTS "workweekStartsOn" TEXT;

ALTER TABLE "PayrollBatchEmployee"
  ADD COLUMN IF NOT EXISTS "workweekStartsOnSnapshot" TEXT;

-- Synthetic staging tenant only. The subquery narrows to the exact
-- synthetic slug and updates NULL rows in place. Any other tenant is
-- untouched.
UPDATE "PayrollClubConfig" pc
   SET "workweekStartsOn" = 'SUNDAY'
  FROM "Club" c
 WHERE pc."clubId" = c.id
   AND c.slug = 'slice-c-benefits-test'
   AND pc."workweekStartsOn" IS NULL;
