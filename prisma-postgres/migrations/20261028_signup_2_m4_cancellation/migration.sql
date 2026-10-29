-- SIGNUP-2 M4-cancellation (2026-10-28) -- Postgres migration.
-- Phase 6 of 6 under the authorised M4 sequence.
--
-- Additive change.  Introduces the BillingCancellationRequest table
-- for the controlled cancellation lifecycle:
--   REQUESTED -> AUTHORIZED | REJECTED
--   AUTHORIZED -> SCHEDULED (worker enqueues BillingCommand)
--   SCHEDULED  -> EFFECTIVE (customer.subscription.deleted arrives)
--              | REVERSED (operator reverses before effective)
--   EFFECTIVE  -> CANCELLED (terminal; access state recomputed)
--
-- Rollback does NOT drop this table.
--
-- No existing rows / columns / foreign keys are modified.  This
-- migration is safe to roll forward in production even if the
-- SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE flag is OFF (the service
-- refuses to write to the table while the flag is unset).

CREATE TABLE "BillingCancellationRequest" (
  "id"                        TEXT NOT NULL PRIMARY KEY,
  "clubId"                    TEXT NOT NULL,
  "billingCycleId"            TEXT NOT NULL,

  "requestedByUserId"         TEXT NOT NULL,
  "requestedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestReason"             TEXT NOT NULL,
  "requestedEffectiveDate"    TIMESTAMP(3),

  "authorizedByUserId"        TEXT,
  "authorizedAt"              TIMESTAMP(3),
  "authorizationNotes"        TEXT,
  "approvedEffectiveDate"     TIMESTAMP(3),

  "rejectedByUserId"          TEXT,
  "rejectedAt"                TIMESTAMP(3),
  "rejectionReason"           TEXT,

  "scheduledCommandId"        TEXT,
  "scheduledAt"               TIMESTAMP(3),

  "stripeSubscriptionId"      TEXT,
  "stripeCancelAt"            TIMESTAMP(3),

  "actualEffectiveAt"         TIMESTAMP(3),

  "reversedByUserId"          TEXT,
  "reversedAt"                TIMESTAMP(3),
  "reversalReason"            TEXT,

  "state"                     TEXT NOT NULL DEFAULT 'REQUESTED',
  "validationEvidenceJson"    TEXT,
  "operatorInboxEntryId"      TEXT,

  "syntheticTestOnly"         BOOLEAN NOT NULL DEFAULT false,
  "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                 TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BillingCancellationRequest_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id"),
  CONSTRAINT "BillingCancellationRequest_billingCycleId_fkey"
    FOREIGN KEY ("billingCycleId") REFERENCES "BillingCycle"("id")
);

CREATE UNIQUE INDEX "BillingCancellationRequest_scheduledCommandId_key"
  ON "BillingCancellationRequest"("scheduledCommandId")
  WHERE "scheduledCommandId" IS NOT NULL;

CREATE INDEX "BillingCancellationRequest_clubId_idx"               ON "BillingCancellationRequest"("clubId");
CREATE INDEX "BillingCancellationRequest_billingCycleId_idx"       ON "BillingCancellationRequest"("billingCycleId");
CREATE INDEX "BillingCancellationRequest_state_idx"                ON "BillingCancellationRequest"("state");
CREATE INDEX "BillingCancellationRequest_stripeSubscriptionId_idx" ON "BillingCancellationRequest"("stripeSubscriptionId");
CREATE INDEX "BillingCancellationRequest_actualEffectiveAt_idx"    ON "BillingCancellationRequest"("actualEffectiveAt");
CREATE INDEX "BillingCancellationRequest_syntheticTestOnly_idx"    ON "BillingCancellationRequest"("syntheticTestOnly");
