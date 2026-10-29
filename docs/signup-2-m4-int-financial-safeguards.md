# SIGNUP-2 M4-INT §4 — Financial safeguards verification

Each §4 safeguard with the specific code site and evidence that it
holds.  Documentation-only; no code changes are introduced here
beyond the §5 corrections already applied.

## Safeguard 1 — Bank verification cannot trigger premature activation

**Code site:** `src/lib/billing/signup-2m3-bank-verification-service.ts` →
`markBankVerified` writes `bankVerifiedAt` + sets registration status
to `BANK_VERIFIED` only.  It does NOT touch `BillingCycle.status`
or `TenantProvisioningJob`.

**Gate between bank verification and activation:** `advanceToPaymentInitiated`
in the same module performs the §5 Stripe-state re-validation (M3
authorisation condition) before any payment-initiation state transition.

**Why it holds:** the state machine requires an explicit `advanceToPaymentInitiated`
call after `BANK_VERIFIED`, and `authoriseActivation` (Phase 2F)
requires an *approved settlement + funds-availability* evidence
record whose `evidenceSource` is `live-stripe`.  Mock-source
evidence is rejected in the production path (persisted
`evidenceSource` on job + production rejects `"mock-stripe"`,
confirmed by Phase 2F baseline contract tests).

## Safeguard 2 — Subscription initiation cannot trigger premature activation

**Code site:** `drainOneBillingCommand` in
`src/lib/billing/signup-2m4-triggering-service.ts` writes
`BillingCycle.stripeSubscriptionId` + `subscriptionStatus`.  It
does NOT invoke `authoriseActivation` or write any
`TenantProvisioningJob` row.

**Why it holds:** M4-triggering's SUCCEEDED command only marks the
subscription as created.  Activation requires the independent
`invoice.paid` + `balance_transaction.available` path in M4-
settlement, which lands separately.  No code path transitions from
`SUBSCRIPTION_CREATE_FIRST.SUCCEEDED` directly to
`ACTIVATION_READY`.

## Safeguard 3 — Invoice payment success cannot independently establish available funds

**Code site:** `handleInvoicePaid` in
`src/lib/billing/signup-2m4-settlement-service.ts` records the
payment but routes to settlement reconciliation; it does NOT
authorise activation.  `assertSettlementAuthoritative`
cross-references `balance_transaction.status` and
`balance_transaction.available_on` BEFORE flipping the gate.

**Why it holds:** the activation gate predicate (Phase 2A
`evaluateActivationGate`) requires BOTH `invoice.paid` and
`balance_transaction.status === "available"` AND
`balance_transaction.available_on <= now`.  A paid invoice alone
sets neither of the last two conditions.  M2-Validation added the
reconciliation-as-durable-state-machine refactor so the probe
keeps checking the balance transaction until Stripe reports
`available`.

## Safeguard 4 — Activation requires the approved settlement and funds-availability evidence

**Code site:** Phase 2F `authoriseActivation` reads
`SubscriptionActivationEvidence` + requires the four-field proof
record (settlement timestamp, balance-transaction id, availability
timestamp, evidenceSource).  Production path refuses
`evidenceSource === "mock-stripe"`.

**Why it holds:** contract tests in `signup-2-m4-phase-2f.*`
(Phase 2F baseline sha-cccb190, Fly v893) prove that the activation
gate rejects mock evidence in production, and that
`validateActivationAuthorisation` (used by Phase 2G) requires the
same record.  M4-triggering + M4-settlement + M4-retries + M4-
renewal + M4-cancellation do NOT bypass this gate at any point.

## Safeguard 5 — Refunds, returns, disputes, and reversals preserve financial history and trigger appropriate exception handling

**Code sites:**

- Refunds / returns: `handleChargeRefunded`
  + `BillingExceptionCase` row with category `REFUND` or
  `RETURNED_DEBIT`, severity set, `autoRecordedPayloadJson` captured.
- Disputes: `handleChargeDisputeCreated/Closed/FundsWithdrawn/FundsReinstated`
  + `BillingExceptionCase` rows with `requiresOperatorAction: true`.
- Cancellation reversals: `reverseCancellation` enqueues a
  `SUBSCRIPTION_RESUME` BillingCommand with its own idempotency
  key; preserves the `BillingCancellationRequest` row + sets state
  to `REVERSED` (does not delete).

**Why it holds:** no delete call on `BillingExceptionCase`,
`BillingInvoicePaymentAttempt`, `BillingCommand`,
`BillingCancellationRequest`, `BillingCycle`, invoice, payment, or
mandate rows.  Verified in M4-cancellation contract tests (code-
only scan refuses `prisma.*.delete` on any accounting table).
Correction #9 (M4-schema design) encoded "no hardcoded dispute
windows; records the actual balance_transaction availability +
supports later reversals" in `BillingExceptionCase`.

## Safeguard 6 — Duplicate commands, webhooks, and retries cannot cause duplicate collection

**Code sites + mechanisms:**

- `BillingCommand.stripeIdempotencyKey` has `@unique`; every command
  site builds a deterministic key (per-site v1 format).  Duplicate
  create attempts hit the uniqueness violation + replay returns the
  existing command.
- `BillingInvoicePaymentAttempt` carries `originatingAttemptId`
  (self-FK) + `@@unique([stripeInvoiceId, attemptNumber])` — same
  invoice id across retries; no new invoice is created on retry
  (correction #6).
- `BillingRenewalPreflight` has `@@unique([billingCycleId, checkpointLabel])`
  — duplicate scheduler invocations don't produce duplicate rows;
  the executor is conditional-updateMany-idempotent on `executedAt`.
- `StripeWebhookEvent.id` is Stripe's own event id; dispatcher
  dedup is upstream.  `processedAt=null` on deferred events +
  `processingResult` on success distinguish durable receipt from
  outcome.
- `BillingCancellationRequest` dedup: open-state query returns an
  existing request if one is already REQUESTED/AUTHORIZED/SCHEDULED
  for the cycle (M4-cancellation).  `scheduledCommandId` is `@unique`
  so the request can't link to two commands.

**Why it holds:** every retry-shaped operation routes through at
least one uniqueness constraint; every state transition writes via
conditional `updateMany` so a second concurrent writer sees count=0
and surfaces `CONCURRENT_*_RACE`.  M1d multi-TX concurrency harness
on isolated Docker Postgres (11/11 scenarios) is the authoritative
evidence that this holds under contention.

## What this document does NOT prove

Documentation + unit/contract tests prove the code shape; they do
not prove the running staging environment behaves this way under
real Stripe traffic.  The §6 OPEN acceptance gates in the audit
register still apply:

- Actual Stripe-originated subscription + settlement verification
  has NEVER been exercised.
- End-to-end renewal / retry execution on staging has NEVER been
  exercised against real webhook deliveries.
- Verified club-facing email delivery through MS 365 has NEVER
  been exercised for a real retry; the M4-INT §5 safe probe
  endpoint is the proximate way to prove the adapter path works
  without triggering a collection.
