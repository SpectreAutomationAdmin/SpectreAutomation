-- Sprint 3 · Post-16H Phase 2.1 (2026-08-06) — durable Account.accountRole
-- Closes the Jonas-convention gap where accumulated-depreciation accounts
-- are stored as ASSET/DEBIT and cannot be identified structurally by the
-- type + normalBalance rule alone.
--
-- Default STANDARD so existing rows stay eligible. Backfill via
-- scripts/backfill-account-role.ts (dry-run first, apply after review).
-- Runtime accounting eligibility uses THIS field structurally; the
-- reporting-side name helper (isAccumulatedDepreciationLine) is used
-- ONLY as one-time migration input, never at request time.

ALTER TABLE "Account"
  ADD COLUMN "accountRole" TEXT NOT NULL DEFAULT 'STANDARD';

-- Index optional — the eligibility service reads accountRole alongside
-- the full account row so a dedicated index is unnecessary for now.
