# SIGNUP-2 M4-STRIPE-1 §3 — Settlement vs activation evidence

Documents exactly how the integration test will distinguish each
lifecycle milestone. Every observation has a named signal, a named
code site, and a named database write — no inference, no mock
simulation.

## The seven milestones in order

| # | Milestone | Primary signal | Code site | Database write | Can activate from this alone? |
|---|---|---|---|---|---|
| 1 | **Bank verification** | `setup_intent.succeeded` with ACSS mandate | `signup-2m3-bank-verification-service.ts` → `markBankVerified` | `BillingCycle.subscriptionStatus = "BANK_VERIFIED"` + `SubscriptionPaymentMandate` row written | **NO** — M3 only. Phase 2F `authoriseActivation` is NOT called from this path. |
| 2 | **Subscription creation** | `drainOneBillingCommand` returns `SUCCEEDED` + sets `stripeResourceId` on the `SUBSCRIPTION_CREATE_FIRST` BillingCommand | `signup-2m4-triggering-service.ts` → `drainOneBillingCommand` | `BillingCommand.state = "SUCCEEDED"` + `stripeResourceId = <sub id>`; `BillingCycle.stripeSubscriptionId` set via side-effect of M4-triggering reconciliation | **NO** — subscription exists but no funds have moved. |
| 3 | **Payment initiation** | `payment_intent.processing` webhook | `signup-2e-webhook-dispatch.ts` → `onPaymentIntentProcessing` | `BillingCycle` payment-intent linkage (`stripePaymentIntentId`) | **NO** — ACSS clearing takes 3-5 business days; "processing" means initiated, not settled. |
| 4 | **Payment processing** | `payment_intent.succeeded` OR `payment_intent.payment_failed` | `onPaymentIntentSucceeded` / `onPaymentIntentFailed` | status update on `BillingCycle` | **NO** — Stripe reports success as soon as the payment intent completes, but ACSS funds may still take days to CLEAR. |
| 5 | **Invoice payment** | `invoice.paid` webhook | `signup-2m4-settlement-service.ts` → `handleInvoicePaid` | `BillingInvoicePaymentAttempt.outcome = "SUCCEEDED"` + `attemptSettledAt` set | **NO** — a paid invoice is Stripe's bookkeeping event; it does NOT prove ACSS funds have CLEARED into Spectre's bank account. |
| 6 | **Stripe balance transaction `available`** | `balance_transaction.status = "available"` AND `available_on <= now` | `signup-2m4-settlement-service.ts` → `assertSettlementAuthoritative` | `BillingExceptionCase` (if ambiguous) + the record read by `evaluateActivationGate` | **YES** — this is the authoritative signal that cleared funds exist. |
| 7 | **Tenant activation** | `authoriseActivation` runs ONLY after milestone 6 proves settled funds + Phase 2F `validateActivationAuthorisation` returns `AUTHORISED` | Phase 2F `signup-2-phase-2f-service.ts` → `authoriseActivation` | `TenantProvisioningJob` row created; Phase 2G worker provisions the tenant | — (terminal) |

## The critical boundary — milestone 5 does NOT imply milestone 6

`invoice.paid` and `balance_transaction.status === "available"` are
**two different Stripe signals** that can arrive seconds, hours, or
days apart. ACSS Debit's 3-5 business day settlement window means
Stripe will emit `invoice.paid` long BEFORE funds are actually
cleared and available.

- Stripe's **test-mode** advances `balance_transaction.status` from
  `pending` → `available` on a short, deterministic timeline (minutes
  to hours).
- Stripe's **live-mode** advances on the real ACSS clearing schedule
  (3-5 business days, holidays applied).

**Test-mode `available` does NOT prove the ACSS clearinghouse will
actually settle the funds in live mode.** The founder authorisation
is explicit: *"Do not claim that Stripe test-mode balance availability
proves real bank settlement."*

Spectre's code honours this: `evaluateActivationGate` demands
`balance_transaction.status === "available"` AND
`available_on <= now` AND `evidenceSource === "live-stripe"` on the
balance-transaction record. Mock evidence is unconditionally refused
in the production path (Phase 2F baseline sha-cccb190).

## Why premature activation cannot occur

Three layered guards:

1. **Milestone sequence is enforced in-schema.** `TenantProvisioningJob`
   cannot be created without a passing
   `validateActivationAuthorisation` that reads
   `SubscriptionActivationEvidence` (Phase 2F schema). Milestones
   1–4 do not write this record.

2. **Milestone 5 (`invoice.paid`) does NOT write
   `SubscriptionActivationEvidence`.** M4-settlement records the
   payment outcome but requires the independent reconciliation step
   (milestone 6) before marking funds authoritatively settled.

3. **The reconciliation step is a durably-recoverable state-machine
   step** (M2-Validation refactor). If `balance_transaction` is still
   `pending`, the step requeues itself. No activation path can
   observe `available` without an actual Stripe-reported availability.

The result: in live mode, the EARLIEST possible activation is 3-5
business days after milestone 5 (even if every webhook delivers
instantly). In test mode, the same path flips in minutes to hours,
and the activation gate still reads the same `evidenceSource:
"live-stripe"` record it would in live mode.

## What a successful first subscription-create test proves

Positive proofs the test window can establish:

| Positive proof | Evidence |
|---|---|
| ACSS mandate was captured | SetupIntent + Mandate rows in Stripe test console; `setup_intent.succeeded` with the right mandate id |
| Spectre creates the subscription against the right Price | `BillingCommand.state = "SUCCEEDED"` with `stripeResourceId` pointing at a `sub_` id visible in Stripe dashboard |
| Stripe delivers payment-intent lifecycle webhooks to Spectre | `StripeWebhookEvent` rows for `payment_intent.processing` + `payment_intent.succeeded` with `processedAt` set |
| Invoice resolves to `paid` | `BillingInvoicePaymentAttempt.outcome = "SUCCEEDED"` with `attemptSettledAt` |
| Balance transaction reaches `available` in test-mode | `BillingExceptionCase` NOT raised; activation gate authorised |
| Tenant activation runs | `TenantProvisioningJob` created + Phase 2G worker provisions |

Negative proofs the same window establishes:

| Negative proof | Evidence |
|---|---|
| Milestone-skip is impossible | No `TenantProvisioningJob` row created before milestone 6 observed |
| Mock evidence is refused in production | `evidenceSource` on `SubscriptionActivationEvidence` is `live-stripe`, not `mock-stripe` |
| Duplicate webhooks don't double-provision | Idempotency check via `BillingCommand.stripeIdempotencyKey` + `StripeWebhookEvent.id` uniqueness |

What a successful test window does **NOT** prove:

| Claim it does NOT prove | Why |
|---|---|
| Real ACSS funds will clear in live mode | Test-mode settlement is simulated |
| CAD $38,000 is within the account's live-mode ACSS limit | Live limit is Stripe-Support-dependent |
| Future renewals will not surface pricing drift | Renewal preflight runs in a different window |
| Operator UI is operationally polished | UI acceptance is a different exercise |

## Observation path during the test window

The founder (or operator) watches **three places** during a controlled window:

1. **Stripe dashboard** → `test` toggle → Billing → Subscriptions → see the `sub_` row appear with its first invoice.
2. **Spectre `/app/admin/signup-ops/billing`** → observability counts for Pending commands + Open exceptions move with each webhook.
3. **Spectre `/app/admin/signup-ops/billing/exceptions`** → immediate visibility of any failure, with the Stripe event id captured.

No log scraping required. No DB access required.
