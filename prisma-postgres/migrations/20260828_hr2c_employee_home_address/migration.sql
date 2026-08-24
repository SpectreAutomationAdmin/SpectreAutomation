-- HR-2C Portal Refinement (2026-08-28) — Employee home / mailing address.
--
-- Employee-editable via the Employee Portal (§10 of the refinement brief).
-- All six columns are added as NULLABLE with no default — additive only, no
-- backfill needed. Existing rows continue to work; the portal renders "—"
-- for empty fields and shows an inline "Add address" affordance.
--
-- No unique constraints, no foreign keys — this is denormalised address on
-- the Employee row (same shape as personalEmail / mobilePhone, which already
-- live directly on Employee). Choice explained in the accompanying commit:
-- there is no canonical address service to reuse, and matching the
-- existing personal-contact shape keeps the self-service surface uniform.

ALTER TABLE "Employee" ADD COLUMN "homeAddressLine1" TEXT;
ALTER TABLE "Employee" ADD COLUMN "homeAddressLine2" TEXT;
ALTER TABLE "Employee" ADD COLUMN "homeCity"         TEXT;
ALTER TABLE "Employee" ADD COLUMN "homeProvince"     TEXT;
ALTER TABLE "Employee" ADD COLUMN "homePostalCode"   TEXT;
ALTER TABLE "Employee" ADD COLUMN "homeCountry"      TEXT;
