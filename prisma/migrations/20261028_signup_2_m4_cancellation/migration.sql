-- SIGNUP-2 M4-cancellation (2026-10-28) -- SQLite (dev) mirror.
-- See prisma-postgres/migrations/20261028_signup_2_m4_cancellation/migration.sql
-- for inline documentation.  Additive; rollback does NOT drop tables.

CREATE TABLE "BillingCancellationRequest" (
  "id"                        TEXT NOT NULL PRIMARY KEY,
  "clubId"                    TEXT NOT NULL,
  "billingCycleId"            TEXT NOT NULL,

  "requestedByUserId"         TEXT NOT NULL,
  "requestedAt"               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestReason"             TEXT NOT NULL,
  "requestedEffectiveDate"    DATETIME,

  "authorizedByUserId"        TEXT,
  "authorizedAt"              DATETIME,
  "authorizationNotes"        TEXT,
  "approvedEffectiveDate"     DATETIME,

  "rejectedByUserId"          TEXT,
  "rejectedAt"                DATETIME,
  "rejectionReason"           TEXT,

  "scheduledCommandId"        TEXT,
  "scheduledAt"               DATETIME,

  "stripeSubscriptionId"      TEXT,
  "stripeCancelAt"            DATETIME,

  "actualEffectiveAt"         DATETIME,

  "reversedByUserId"          TEXT,
  "reversedAt"                DATETIME,
  "reversalReason"            TEXT,

  "state"                     TEXT NOT NULL DEFAULT 'REQUESTED',
  "validationEvidenceJson"    TEXT,
  "operatorInboxEntryId"      TEXT,

  "syntheticTestOnly"         BOOLEAN NOT NULL DEFAULT false,
  "createdAt"                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                 DATETIME NOT NULL,

  CONSTRAINT "BillingCancellationRequest_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id"),
  CONSTRAINT "BillingCancellationRequest_billingCycleId_fkey"
    FOREIGN KEY ("billingCycleId") REFERENCES "BillingCycle"("id")
);

CREATE UNIQUE INDEX "BillingCancellationRequest_scheduledCommandId_key"
  ON "BillingCancellationRequest"("scheduledCommandId");

CREATE INDEX "BillingCancellationRequest_clubId_idx"               ON "BillingCancellationRequest"("clubId");
CREATE INDEX "BillingCancellationRequest_billingCycleId_idx"       ON "BillingCancellationRequest"("billingCycleId");
CREATE INDEX "BillingCancellationRequest_state_idx"                ON "BillingCancellationRequest"("state");
CREATE INDEX "BillingCancellationRequest_stripeSubscriptionId_idx" ON "BillingCancellationRequest"("stripeSubscriptionId");
CREATE INDEX "BillingCancellationRequest_actualEffectiveAt_idx"    ON "BillingCancellationRequest"("actualEffectiveAt");
CREATE INDEX "BillingCancellationRequest_syntheticTestOnly_idx"    ON "BillingCancellationRequest"("syntheticTestOnly");
