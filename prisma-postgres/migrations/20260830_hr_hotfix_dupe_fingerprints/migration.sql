-- HR mobile-hotfix (2026-08-30) — keyed-fingerprint columns +
-- duplicate-detection unique indexes for SIN and Bank data.
--
-- Additive only. Existing rows land with NULL fingerprints; a
-- separate backfill script derives fingerprints from the encrypted
-- payload (dedicated commit) via the canonical KMS decrypt path.
-- Until backfilled, dedup only fires on new/replacement writes;
-- existing rows are grandfathered.
--
-- Uniqueness semantics:
--   * SIN: (clubId, sinFingerprint) UNIQUE — one active SIN per
--     employee is already enforced by (employeeId) unique; the new
--     Club-scoped fingerprint uniqueness catches DIFFERENT employees
--     with the same SIN in the same Club. NULLs are treated as
--     distinct by Postgres (default) so grandfathered rows do not
--     collide with each other.
--   * Bank: partial unique on the currently-ACTIVE (non-terminal)
--     row per Club: (clubId, bankFingerprint) WHERE status IN
--     ('PENDING_PENNY_TEST','VERIFIED'). Historical INACTIVE and
--     REJECTED rows are allowed to share a fingerprint (a returning
--     employee may re-enter the same bank; a Club that previously
--     had two employees at the same bank still has valid history).

-- ---------------------------------------------------------------
-- SIN fingerprint
-- ---------------------------------------------------------------
ALTER TABLE "EmployeeSensitiveIdentity" ADD COLUMN "sinFingerprint" TEXT;
CREATE UNIQUE INDEX "EmployeeSensitiveIdentity_clubId_sinFingerprint_key"
  ON "EmployeeSensitiveIdentity"("clubId", "sinFingerprint");

-- ---------------------------------------------------------------
-- Bank fingerprint
-- ---------------------------------------------------------------
ALTER TABLE "EmployeeBankAccount" ADD COLUMN "bankFingerprint" TEXT;
CREATE INDEX "EmployeeBankAccount_clubId_bankFingerprint_status_idx"
  ON "EmployeeBankAccount"("clubId", "bankFingerprint", "status");
CREATE UNIQUE INDEX "EmployeeBankAccount_clubId_bankFingerprint_active_key"
  ON "EmployeeBankAccount"("clubId", "bankFingerprint")
  WHERE "status" IN ('PENDING_PENNY_TEST', 'VERIFIED');
