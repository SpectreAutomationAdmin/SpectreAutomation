-- SIGNUP-2 Phase 2A (2026-10-25) -- subscription domain foundation.
-- Additive schema only.  Existing tenant rows get null for every new
-- column.  Access-tier enforcement is dormant for legacy rows
-- (null accessTier -> grandfathered PASS in access-tier.ts).

-- -----------------------------------------------------------------------
-- Extensions to existing ClubSubscription + BillingCycle.
-- -----------------------------------------------------------------------
ALTER TABLE "ClubSubscription" ADD COLUMN "subscriptionStatus"   TEXT;
ALTER TABLE "ClubSubscription" ADD COLUMN "accessTier"           TEXT;
ALTER TABLE "ClubSubscription" ADD COLUMN "source"               TEXT;
ALTER TABLE "ClubSubscription" ADD COLUMN "firstSettlementAt"    TIMESTAMP(3);
ALTER TABLE "ClubSubscription" ADD COLUMN "nextRenewalAt"        TIMESTAMP(3);
ALTER TABLE "ClubSubscription" ADD COLUMN "operatorNotes"        TEXT;
ALTER TABLE "ClubSubscription" ADD COLUMN "signupRegistrationId" TEXT;

CREATE INDEX "ClubSubscription_subscriptionStatus_idx" ON "ClubSubscription"("subscriptionStatus");
CREATE INDEX "ClubSubscription_accessTier_idx"         ON "ClubSubscription"("accessTier");

ALTER TABLE "BillingCycle" ADD COLUMN "subscriptionStatus"         TEXT;
ALTER TABLE "BillingCycle" ADD COLUMN "source"                     TEXT;
ALTER TABLE "BillingCycle" ADD COLUMN "stripePaymentIntentId"      TEXT;
ALTER TABLE "BillingCycle" ADD COLUMN "stripeChargeId"             TEXT;
ALTER TABLE "BillingCycle" ADD COLUMN "stripeBalanceTransactionId" TEXT;
ALTER TABLE "BillingCycle" ADD COLUMN "expectedDebitDate"          TIMESTAMP(3);
ALTER TABLE "BillingCycle" ADD COLUMN "settlementConfirmedAt"      TIMESTAMP(3);
ALTER TABLE "BillingCycle" ADD COLUMN "reversedAt"                 TIMESTAMP(3);
ALTER TABLE "BillingCycle" ADD COLUMN "reversalReason"             TEXT;

CREATE UNIQUE INDEX "BillingCycle_stripePaymentIntentId_key"       ON "BillingCycle"("stripePaymentIntentId");
CREATE UNIQUE INDEX "BillingCycle_stripeChargeId_key"              ON "BillingCycle"("stripeChargeId");
CREATE UNIQUE INDEX "BillingCycle_stripeBalanceTransactionId_key"  ON "BillingCycle"("stripeBalanceTransactionId");
CREATE INDEX        "BillingCycle_subscriptionStatus_idx"          ON "BillingCycle"("subscriptionStatus");
CREATE INDEX        "BillingCycle_stripePaymentIntentId_idx"       ON "BillingCycle"("stripePaymentIntentId");

-- -----------------------------------------------------------------------
-- SubscriptionAuthorisationAttestation
-- -----------------------------------------------------------------------
CREATE TABLE "SubscriptionAuthorisationAttestation" (
    "id"                     TEXT NOT NULL,
    "signupRegistrationId"   TEXT NOT NULL,
    "clubId"                 TEXT,
    "signatoryFullName"      TEXT NOT NULL,
    "signatoryTitle"         TEXT NOT NULL,
    "clubLegalName"          TEXT NOT NULL,
    "attestationTextHash"    TEXT NOT NULL,
    "attestationTextLength"  INTEGER NOT NULL,
    "termsVersionSha256"     TEXT NOT NULL,
    "termsVersionLabel"      TEXT NOT NULL,
    "acceptedAt"             TIMESTAMP(3) NOT NULL,
    "acceptedIp"             TEXT,
    "acceptedUserAgent"      TEXT,
    "acceptedByMicrosoftOid" TEXT,
    "acceptedByMicrosoftTid" TEXT,
    "supersededAt"           TIMESTAMP(3),
    "supersededReason"       TEXT,
    CONSTRAINT "SubscriptionAuthorisationAttestation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SubscriptionAuthorisationAttestation_signupRegistrationId_key"
    ON "SubscriptionAuthorisationAttestation"("signupRegistrationId");
CREATE INDEX "SubscriptionAuthorisationAttestation_clubId_idx"
    ON "SubscriptionAuthorisationAttestation"("clubId");
CREATE INDEX "SubscriptionAuthorisationAttestation_acceptedAt_idx"
    ON "SubscriptionAuthorisationAttestation"("acceptedAt");
ALTER TABLE "SubscriptionAuthorisationAttestation"
    ADD CONSTRAINT "SubscriptionAuthorisationAttestation_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "ClubSubscription"("clubId")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------
-- SubscriptionPaymentMandate
-- -----------------------------------------------------------------------
CREATE TABLE "SubscriptionPaymentMandate" (
    "id"                     TEXT NOT NULL,
    "clubId"                 TEXT NOT NULL,
    "signupRegistrationId"   TEXT,
    "stripePaymentMethodId"  TEXT NOT NULL,
    "stripeMandateId"        TEXT NOT NULL,
    "mandateType"            TEXT NOT NULL,
    "mandateVariant"         TEXT NOT NULL,
    "transactionType"        TEXT NOT NULL,
    "acceptedAt"             TIMESTAMP(3) NOT NULL,
    "acceptedByUserId"       TEXT,
    "acceptedByMicrosoftOid" TEXT,
    "acceptedIp"             TEXT,
    "acceptedUserAgent"      TEXT,
    "mandateTextHash"        TEXT NOT NULL,
    "mandateTextLength"      INTEGER NOT NULL,
    "revokedAt"              TIMESTAMP(3),
    "revokeReason"           TEXT,
    CONSTRAINT "SubscriptionPaymentMandate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SubscriptionPaymentMandate_stripePaymentMethodId_key"
    ON "SubscriptionPaymentMandate"("stripePaymentMethodId");
CREATE UNIQUE INDEX "SubscriptionPaymentMandate_stripeMandateId_key"
    ON "SubscriptionPaymentMandate"("stripeMandateId");
CREATE INDEX "SubscriptionPaymentMandate_clubId_acceptedAt_idx"
    ON "SubscriptionPaymentMandate"("clubId", "acceptedAt");
ALTER TABLE "SubscriptionPaymentMandate"
    ADD CONSTRAINT "SubscriptionPaymentMandate_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "ClubSubscription"("clubId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------
-- EntityStandingCheck
-- -----------------------------------------------------------------------
CREATE TABLE "EntityStandingCheck" (
    "id"                   TEXT NOT NULL,
    "signupRegistrationId" TEXT NOT NULL,
    "clubId"               TEXT,
    "jurisdiction"         TEXT NOT NULL,
    "businessNumber"       TEXT,
    "standing"             TEXT NOT NULL,
    "officerMatch"         TEXT,
    "registryPayloadJson"  TEXT,
    "fetchedAt"            TIMESTAMP(3) NOT NULL,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EntityStandingCheck_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EntityStandingCheck_signupRegistrationId_idx"
    ON "EntityStandingCheck"("signupRegistrationId");
CREATE INDEX "EntityStandingCheck_clubId_idx"
    ON "EntityStandingCheck"("clubId");
CREATE INDEX "EntityStandingCheck_standing_idx"
    ON "EntityStandingCheck"("standing");
ALTER TABLE "EntityStandingCheck"
    ADD CONSTRAINT "EntityStandingCheck_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "ClubSubscription"("clubId")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------
-- TenantProvisioningJob
-- -----------------------------------------------------------------------
CREATE TABLE "TenantProvisioningJob" (
    "id"                               TEXT NOT NULL,
    "billingCycleId"                   TEXT NOT NULL,
    "clubSubscriptionClubId"           TEXT NOT NULL,
    "signupRegistrationId"             TEXT NOT NULL,
    "state"                            TEXT NOT NULL,
    "attempts"                         INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt"                    TIMESTAMP(3),
    "lastError"                        TEXT,
    "startedAt"                        TIMESTAMP(3),
    "completedAt"                      TIMESTAMP(3),
    "cancelledAt"                      TIMESTAMP(3),
    "cancelReason"                     TEXT,
    "provisionedUserId"                TEXT,
    "provisionedClubId"                TEXT,
    "rolesAssignedBatchKey"            TEXT,
    "committedCoaBatchKey"             TEXT,
    "committedOpeningBalanceBatchKey"  TEXT,
    "committedBrandingBatchKey"        TEXT,
    "invitationsDeliveredBatchKey"     TEXT,
    "welcomeEmailProviderMessageId"    TEXT,
    "createdAt"                        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantProvisioningJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantProvisioningJob_billingCycleId_key"
    ON "TenantProvisioningJob"("billingCycleId");
CREATE INDEX "TenantProvisioningJob_state_nextAttemptAt_idx"
    ON "TenantProvisioningJob"("state", "nextAttemptAt");
CREATE INDEX "TenantProvisioningJob_clubSubscriptionClubId_idx"
    ON "TenantProvisioningJob"("clubSubscriptionClubId");
ALTER TABLE "TenantProvisioningJob"
    ADD CONSTRAINT "TenantProvisioningJob_billingCycleId_fkey"
    FOREIGN KEY ("billingCycleId") REFERENCES "BillingCycle"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantProvisioningJob"
    ADD CONSTRAINT "TenantProvisioningJob_clubSubscriptionClubId_fkey"
    FOREIGN KEY ("clubSubscriptionClubId") REFERENCES "ClubSubscription"("clubId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------
-- PaymentReconciliationEntry (append-only)
-- -----------------------------------------------------------------------
CREATE TABLE "PaymentReconciliationEntry" (
    "id"                            TEXT NOT NULL,
    "clubId"                        TEXT,
    "billingCycleId"                TEXT,
    "entryType"                     TEXT NOT NULL,
    "amountMinorUnits"              BIGINT NOT NULL,
    "currency"                      TEXT NOT NULL,
    "providerEventId"               TEXT,
    "providerPaymentIntentId"       TEXT,
    "providerChargeId"              TEXT,
    "providerBalanceTransactionId"  TEXT,
    "providerFeeAmount"             BIGINT,
    "providerNetAmount"             BIGINT,
    "occurredAt"                    TIMESTAMP(3) NOT NULL,
    "recordedAt"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reconciledWithProvider"        BOOLEAN NOT NULL DEFAULT false,
    "reconciledAt"                  TIMESTAMP(3),
    "reconciliationNotes"           TEXT,
    "operatorUserId"                TEXT,
    "correctsEntryId"               TEXT,
    CONSTRAINT "PaymentReconciliationEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PaymentReconciliationEntry_clubId_occurredAt_idx"
    ON "PaymentReconciliationEntry"("clubId", "occurredAt");
CREATE INDEX "PaymentReconciliationEntry_billingCycleId_entryType_idx"
    ON "PaymentReconciliationEntry"("billingCycleId", "entryType");
CREATE INDEX "PaymentReconciliationEntry_providerEventId_idx"
    ON "PaymentReconciliationEntry"("providerEventId");
CREATE INDEX "PaymentReconciliationEntry_reconciledWithProvider_recordedAt_idx"
    ON "PaymentReconciliationEntry"("reconciledWithProvider", "recordedAt");
ALTER TABLE "PaymentReconciliationEntry"
    ADD CONSTRAINT "PaymentReconciliationEntry_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "ClubSubscription"("clubId")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentReconciliationEntry"
    ADD CONSTRAINT "PaymentReconciliationEntry_billingCycleId_fkey"
    FOREIGN KEY ("billingCycleId") REFERENCES "BillingCycle"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------
-- StripeWebhookEvent (dedup)
-- -----------------------------------------------------------------------
CREATE TABLE "StripeWebhookEvent" (
    "id"                TEXT NOT NULL,
    "eventType"         TEXT NOT NULL,
    "receivedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt"       TIMESTAMP(3),
    "processingResult"  TEXT,
    "payloadJson"       TEXT NOT NULL,
    "errorDetail"       TEXT,
    CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StripeWebhookEvent_eventType_receivedAt_idx"
    ON "StripeWebhookEvent"("eventType", "receivedAt");
CREATE INDEX "StripeWebhookEvent_processedAt_idx"
    ON "StripeWebhookEvent"("processedAt");

-- -----------------------------------------------------------------------
-- OperatorInboxEntry
-- -----------------------------------------------------------------------
CREATE TABLE "OperatorInboxEntry" (
    "id"                 TEXT NOT NULL,
    "severity"           TEXT NOT NULL,
    "category"           TEXT NOT NULL,
    "clubId"             TEXT,
    "billingCycleId"     TEXT,
    "providerEventId"    TEXT,
    "title"              TEXT NOT NULL,
    "body"               TEXT NOT NULL,
    "recommendedAction"  TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readByUserId"       TEXT,
    "readAt"             TIMESTAMP(3),
    "resolvedByUserId"   TEXT,
    "resolvedAt"         TIMESTAMP(3),
    "resolutionNote"     TEXT,
    CONSTRAINT "OperatorInboxEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OperatorInboxEntry_severity_resolvedAt_idx"
    ON "OperatorInboxEntry"("severity", "resolvedAt");
CREATE INDEX "OperatorInboxEntry_clubId_createdAt_idx"
    ON "OperatorInboxEntry"("clubId", "createdAt");
CREATE INDEX "OperatorInboxEntry_category_createdAt_idx"
    ON "OperatorInboxEntry"("category", "createdAt");
