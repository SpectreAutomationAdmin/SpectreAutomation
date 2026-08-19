-- HR-2B.3 tail (2026-08-20) — invitation delivery attempt tracking.
--
-- Adds five nullable columns to EmployeeOnboardingInvitation. Existing
-- rows leave every new column NULL, which the service layer treats as
-- "delivery status unknown / pre-tracking row" and does NOT confuse
-- with any of the four canonical statuses.
--
-- Canonical status vocabulary (enforced at the service layer):
--   NOT_ATTEMPTED   — no recipient address on file at issue time.
--   DEV_LOGGED      — console-only devEmailAdapter fired; no external
--                     email was sent (staging with no EMAIL provider
--                     configured lands here).
--   DELIVERED       — a real provider accepted the message.
--   FAILED          — a real provider was selected but rejected the send.
--
-- Provider vocabulary:
--   console | smtp | ses | microsoft365
--
-- deliveryFailureReason MUST NOT carry raw invitation tokens, plaintext
-- SIN/banking data, or a full email body. Provider-returned reasons
-- (e.g. "554 5.7.1 relay access denied") are safe.

ALTER TABLE "EmployeeOnboardingInvitation"
  ADD COLUMN "deliveryStatus" TEXT,
  ADD COLUMN "deliveryProvider" TEXT,
  ADD COLUMN "deliveryProviderMessageId" TEXT,
  ADD COLUMN "deliveryAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "deliveryFailureReason" TEXT;
