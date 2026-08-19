-- HR-2B.3.5 (2026-08-19) — Club.payrollProvince
--
-- Canonical province of employment used by the payroll TD1 flow.
-- Nullable during rollout; the runtime resolver
-- (src/lib/hr/club-payroll-province.ts) falls back to
-- ClubProfile.provinceState when this is null so existing clubs keep
-- working while admins fill it in.
--
-- No back-fill in this migration — the fallback keeps behaviour
-- correct. Coulee Ridge (staging founder tenant) is stamped
-- explicitly via a one-shot post-deploy script so the intent is
-- explicit rather than fallback-derived.

ALTER TABLE "Club" ADD COLUMN "payrollProvince" TEXT;
