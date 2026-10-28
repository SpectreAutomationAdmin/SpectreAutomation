-- SIGNUP-2 M4-schema (2026-10-28) -- Postgres mirror.
--
-- Additive, fully nullable where not required by business logic.
-- Rollback does NOT drop these tables; it only disables the (not-yet-
-- shipped) M4 behavior code.  Zero data migration required.
--
-- All seven new tables carry syntheticTestOnly for M3/M4 test isolation.

-- ClubContractExecution ---------------------------------------------------
CREATE TABLE "ClubContractExecution" (
  "id"                          TEXT PRIMARY KEY,
  "signupRegistrationId"        TEXT NOT NULL UNIQUE,
  "contractType"                TEXT NOT NULL,
  "contractVersionSha256"       TEXT NOT NULL,
  "contractExecutedAt"          TIMESTAMP(3) NOT NULL,
  "contractRecordedByUserId"    TEXT,
  "evidenceStorageKey"          TEXT NOT NULL,
  "evidenceContentType"         TEXT NOT NULL,
  "evidenceSha256"              TEXT NOT NULL,
  "evidenceByteLength"          INTEGER NOT NULL,
  "governanceRequired"          BOOLEAN NOT NULL DEFAULT false,
  "governanceApprovedByUserId"  TEXT,
  "governanceApprovedAt"        TIMESTAMP(3),
  "governanceReference"         TEXT,
  "syntheticTestOnly"           BOOLEAN NOT NULL DEFAULT false,
  "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClubContractExecution_signupRegistrationId_fkey"
    FOREIGN KEY ("signupRegistrationId") REFERENCES "SignupRegistration"("id")
);
CREATE INDEX "ClubContractExecution_contractExecutedAt_idx" ON "ClubContractExecution"("contractExecutedAt");
CREATE INDEX "ClubContractExecution_syntheticTestOnly_idx" ON "ClubContractExecution"("syntheticTestOnly");

-- ClubBillingPricing ------------------------------------------------------
CREATE TABLE "ClubBillingPricing" (
  "id"                      TEXT PRIMARY KEY,
  "signupRegistrationId"    TEXT NOT NULL UNIQUE,
  "contractExecutionId"     TEXT NOT NULL UNIQUE,
  "stripePriceId"           TEXT NOT NULL,
  "currency"                TEXT NOT NULL,
  "amountMinorUnits"        BIGINT NOT NULL,
  "billingInterval"         TEXT NOT NULL,
  "taxTreatment"            TEXT NOT NULL,
  "taxJurisdiction"         TEXT,
  "gstPercentBps"           INTEGER,
  "pstPercentBps"           INTEGER,
  "hstPercentBps"           INTEGER,
  "priceSelectedByUserId"   TEXT NOT NULL,
  "priceSelectedAt"         TIMESTAMP(3) NOT NULL,
  "priceEvidenceReference"  TEXT,
  "syntheticTestOnly"       BOOLEAN NOT NULL DEFAULT false,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClubBillingPricing_signupRegistrationId_fkey"
    FOREIGN KEY ("signupRegistrationId") REFERENCES "SignupRegistration"("id"),
  CONSTRAINT "ClubBillingPricing_contractExecutionId_fkey"
    FOREIGN KEY ("contractExecutionId") REFERENCES "ClubContractExecution"("id")
);
CREATE INDEX "ClubBillingPricing_stripePriceId_idx" ON "ClubBillingPricing"("stripePriceId");
CREATE INDEX "ClubBillingPricing_taxJurisdiction_idx" ON "ClubBillingPricing"("taxJurisdiction");
CREATE INDEX "ClubBillingPricing_syntheticTestOnly_idx" ON "ClubBillingPricing"("syntheticTestOnly");

-- ClubPaymentAuthorisation ------------------------------------------------
CREATE TABLE "ClubPaymentAuthorisation" (
  "id"                          TEXT PRIMARY KEY,
  "signupRegistrationId"        TEXT NOT NULL UNIQUE,
  "pricingId"                   TEXT NOT NULL UNIQUE,
  "contractExecutionId"         TEXT NOT NULL UNIQUE,
  "commercialApprovedByUserId"  TEXT NOT NULL,
  "commercialApprovedAt"        TIMESTAMP(3) NOT NULL,
  "commercialApprovalNotes"     TEXT,
  "authorisedAmountMinorUnits"  BIGINT NOT NULL,
  "authorisedCurrency"          TEXT NOT NULL,
  "syntheticTestOnly"           BOOLEAN NOT NULL DEFAULT false,
  "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClubPaymentAuthorisation_signupRegistrationId_fkey"
    FOREIGN KEY ("signupRegistrationId") REFERENCES "SignupRegistration"("id"),
  CONSTRAINT "ClubPaymentAuthorisation_pricingId_fkey"
    FOREIGN KEY ("pricingId") REFERENCES "ClubBillingPricing"("id"),
  CONSTRAINT "ClubPaymentAuthorisation_contractExecutionId_fkey"
    FOREIGN KEY ("contractExecutionId") REFERENCES "ClubContractExecution"("id")
);
CREATE INDEX "ClubPaymentAuthorisation_commercialApprovedByUserId_idx" ON "ClubPaymentAuthorisation"("commercialApprovedByUserId");
CREATE INDEX "ClubPaymentAuthorisation_commercialApprovedAt_idx" ON "ClubPaymentAuthorisation"("commercialApprovedAt");
CREATE INDEX "ClubPaymentAuthorisation_syntheticTestOnly_idx" ON "ClubPaymentAuthorisation"("syntheticTestOnly");

-- ClubBillingRelease ------------------------------------------------------
CREATE TABLE "ClubBillingRelease" (
  "id"                          TEXT PRIMARY KEY,
  "signupRegistrationId"        TEXT NOT NULL UNIQUE,
  "billingCycleId"              TEXT NOT NULL UNIQUE,
  "authorisationId"             TEXT NOT NULL UNIQUE,
  "releaseApprovedByUserId"     TEXT NOT NULL,
  "releaseApprovedAt"           TIMESTAMP(3) NOT NULL,
  "releaseApprovalNotes"        TEXT,
  "releaseToken"                TEXT NOT NULL UNIQUE,
  "releaseTokenConsumedAt"      TIMESTAMP(3),
  "consumedByBillingCommandId"  TEXT UNIQUE,
  "syntheticTestOnly"           BOOLEAN NOT NULL DEFAULT false,
  "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClubBillingRelease_signupRegistrationId_fkey"
    FOREIGN KEY ("signupRegistrationId") REFERENCES "SignupRegistration"("id"),
  CONSTRAINT "ClubBillingRelease_billingCycleId_fkey"
    FOREIGN KEY ("billingCycleId") REFERENCES "BillingCycle"("id"),
  CONSTRAINT "ClubBillingRelease_authorisationId_fkey"
    FOREIGN KEY ("authorisationId") REFERENCES "ClubPaymentAuthorisation"("id")
);
CREATE INDEX "ClubBillingRelease_releaseApprovedByUserId_idx" ON "ClubBillingRelease"("releaseApprovedByUserId");
CREATE INDEX "ClubBillingRelease_releaseTokenConsumedAt_idx" ON "ClubBillingRelease"("releaseTokenConsumedAt");
CREATE INDEX "ClubBillingRelease_syntheticTestOnly_idx" ON "ClubBillingRelease"("syntheticTestOnly");

-- BillingCommand ----------------------------------------------------------
CREATE TABLE "BillingCommand" (
  "id"                        TEXT PRIMARY KEY,
  "commandType"               TEXT NOT NULL,
  "stripeIdempotencyKey"      TEXT NOT NULL UNIQUE,
  "billingCycleId"            TEXT NOT NULL,
  "clubId"                    TEXT NOT NULL,
  "state"                     TEXT NOT NULL DEFAULT 'PENDING',
  "attemptNumber"             INTEGER NOT NULL DEFAULT 0,
  "maxAttempts"               INTEGER NOT NULL DEFAULT 1,
  "stripeResourceId"          TEXT,
  "stripeResourceType"        TEXT,
  "lastErrorCode"             TEXT,
  "lastErrorMessage"          TEXT,
  "lastErrorAt"               TIMESTAMP(3),
  "paramsJson"                TEXT,
  "releaseId"                 TEXT,
  "nextAttemptAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "succeededAt"               TIMESTAMP(3),
  "terminalAt"                TIMESTAMP(3),
  "syntheticTestOnly"         BOOLEAN NOT NULL DEFAULT false,
  "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                 TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingCommand_billingCycleId_fkey"
    FOREIGN KEY ("billingCycleId") REFERENCES "BillingCycle"("id"),
  CONSTRAINT "BillingCommand_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id")
);
CREATE INDEX "BillingCommand_state_nextAttemptAt_idx" ON "BillingCommand"("state", "nextAttemptAt");
CREATE INDEX "BillingCommand_billingCycleId_idx" ON "BillingCommand"("billingCycleId");
CREATE INDEX "BillingCommand_clubId_idx" ON "BillingCommand"("clubId");
CREATE INDEX "BillingCommand_stripeResourceId_idx" ON "BillingCommand"("stripeResourceId");
CREATE INDEX "BillingCommand_commandType_idx" ON "BillingCommand"("commandType");
CREATE INDEX "BillingCommand_syntheticTestOnly_idx" ON "BillingCommand"("syntheticTestOnly");

-- BillingInvoicePaymentAttempt -------------------------------------------
CREATE TABLE "BillingInvoicePaymentAttempt" (
  "id"                           TEXT PRIMARY KEY,
  "billingCycleId"               TEXT NOT NULL,
  "stripeInvoiceId"              TEXT NOT NULL,
  "stripePaymentIntentId"        TEXT,
  "stripeChargeId"               TEXT,
  "attemptNumber"                INTEGER NOT NULL,
  "attemptScheduledAt"           TIMESTAMP(3) NOT NULL,
  "attemptStartedAt"             TIMESTAMP(3),
  "attemptSettledAt"             TIMESTAMP(3),
  "outcome"                      TEXT,
  "outcomeStripeCode"            TEXT,
  "outcomeMessage"               TEXT,
  "originatingAttemptId"         TEXT,
  "clubNotifiedAt"               TIMESTAMP(3),
  "clubNotificationWorkIntakeId" TEXT,
  "mandateValidAtAttemptTime"    BOOLEAN,
  "stripeInvoicePeriodStart"     TIMESTAMP(3),
  "stripeInvoicePeriodEnd"       TIMESTAMP(3),
  "stripeSubscriptionId"         TEXT,
  "syntheticTestOnly"            BOOLEAN NOT NULL DEFAULT false,
  "createdAt"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingInvoicePaymentAttempt_billingCycleId_fkey"
    FOREIGN KEY ("billingCycleId") REFERENCES "BillingCycle"("id"),
  CONSTRAINT "BillingInvoicePaymentAttempt_originatingAttemptId_fkey"
    FOREIGN KEY ("originatingAttemptId") REFERENCES "BillingInvoicePaymentAttempt"("id")
);
CREATE UNIQUE INDEX "BillingInvoicePaymentAttempt_stripeInvoiceId_attemptNumber_key"
  ON "BillingInvoicePaymentAttempt"("stripeInvoiceId", "attemptNumber");
CREATE INDEX "BillingInvoicePaymentAttempt_billingCycleId_idx" ON "BillingInvoicePaymentAttempt"("billingCycleId");
CREATE INDEX "BillingInvoicePaymentAttempt_outcome_idx" ON "BillingInvoicePaymentAttempt"("outcome");
CREATE INDEX "BillingInvoicePaymentAttempt_attemptScheduledAt_idx" ON "BillingInvoicePaymentAttempt"("attemptScheduledAt");
CREATE INDEX "BillingInvoicePaymentAttempt_stripeSubscriptionId_idx" ON "BillingInvoicePaymentAttempt"("stripeSubscriptionId");
CREATE INDEX "BillingInvoicePaymentAttempt_syntheticTestOnly_idx" ON "BillingInvoicePaymentAttempt"("syntheticTestOnly");

-- BillingRenewalPreflight -------------------------------------------------
CREATE TABLE "BillingRenewalPreflight" (
  "id"                          TEXT PRIMARY KEY,
  "billingCycleId"              TEXT NOT NULL,
  "checkpointLabel"             TEXT NOT NULL,
  "scheduledFor"                TIMESTAMP(3) NOT NULL,
  "executedAt"                  TIMESTAMP(3),
  "mandateStillValid"           BOOLEAN,
  "mandateCheckError"           TEXT,
  "renewalPriceId"              TEXT,
  "renewalAmountMinorUnits"     BIGINT,
  "renewalCurrency"             TEXT,
  "renewalTaxTreatment"         TEXT,
  "renewalGstPercentBps"        INTEGER,
  "renewalPricingDriftDetected" BOOLEAN NOT NULL DEFAULT false,
  "outcome"                     TEXT,
  "outcomeNotes"                TEXT,
  "workIntakeId"                TEXT,
  "operatorInboxEntryId"        TEXT,
  "syntheticTestOnly"           BOOLEAN NOT NULL DEFAULT false,
  "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingRenewalPreflight_billingCycleId_fkey"
    FOREIGN KEY ("billingCycleId") REFERENCES "BillingCycle"("id")
);
CREATE UNIQUE INDEX "BillingRenewalPreflight_billingCycleId_checkpointLabel_key"
  ON "BillingRenewalPreflight"("billingCycleId", "checkpointLabel");
CREATE INDEX "BillingRenewalPreflight_scheduledFor_executedAt_idx" ON "BillingRenewalPreflight"("scheduledFor", "executedAt");
CREATE INDEX "BillingRenewalPreflight_outcome_idx" ON "BillingRenewalPreflight"("outcome");
CREATE INDEX "BillingRenewalPreflight_syntheticTestOnly_idx" ON "BillingRenewalPreflight"("syntheticTestOnly");

-- BillingExceptionCase ----------------------------------------------------
CREATE TABLE "BillingExceptionCase" (
  "id"                           TEXT PRIMARY KEY,
  "billingCycleId"               TEXT NOT NULL,
  "category"                     TEXT NOT NULL,
  "severity"                     TEXT NOT NULL,
  "stripeEventId"                TEXT,
  "stripeResourceId"             TEXT,
  "stripeResourceType"           TEXT,
  "autoRecordedAt"               TIMESTAMP(3),
  "autoRecordedPayloadJson"      TEXT,
  "stripeBalanceTransactionId"   TEXT,
  "balanceEffectAmountMinor"     BIGINT,
  "balanceEffectCurrency"        TEXT,
  "balanceAvailableAt"           TIMESTAMP(3),
  "requiresOperatorAction"       BOOLEAN NOT NULL DEFAULT false,
  "operatorInboxEntryId"         TEXT,
  "operatorAcknowledgedByUserId" TEXT,
  "operatorAcknowledgedAt"       TIMESTAMP(3),
  "operatorResolution"           TEXT,
  "operatorResolutionNotes"      TEXT,
  "syntheticTestOnly"            BOOLEAN NOT NULL DEFAULT false,
  "createdAt"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingExceptionCase_billingCycleId_fkey"
    FOREIGN KEY ("billingCycleId") REFERENCES "BillingCycle"("id")
);
CREATE INDEX "BillingExceptionCase_billingCycleId_idx" ON "BillingExceptionCase"("billingCycleId");
CREATE INDEX "BillingExceptionCase_category_idx" ON "BillingExceptionCase"("category");
CREATE INDEX "BillingExceptionCase_requiresOperatorAction_operatorAcknowledgedAt_idx"
  ON "BillingExceptionCase"("requiresOperatorAction", "operatorAcknowledgedAt");
CREATE INDEX "BillingExceptionCase_stripeEventId_idx" ON "BillingExceptionCase"("stripeEventId");
CREATE INDEX "BillingExceptionCase_syntheticTestOnly_idx" ON "BillingExceptionCase"("syntheticTestOnly");
