# SIGNUP-2 M4-INT §3 — Stripe readiness

Prepared for founder review before the comprehensive end-to-end
acceptance test.  Scope: verify where the Stripe integration is
ready vs where it is NOT ready to execute real payment flow.

## ACSS Debit transaction-limit escalation

**Not confirmed in Spectre.**  The CAD $38,000 annual Price is set
and its digest `53f3d2f00139e274` is unchanged across every SIGNUP-2
baseline since M2-Validation (2026-10-27).  Spectre has NEVER
attempted a real $38,000 ACSS Debit; the only live Stripe traffic
observed on staging is two real sandbox *mandate Checkouts* (M3
close baseline), which do not themselves exercise the collection
limit.

Per founder §3: *"Do not attempt a CAD $38,000 subscription until
the limit has been confirmed as sufficient. Do not change the
contracted Price or split the transaction to bypass the limit."*

Spectre satisfies the second clause (price + splitting) in code:

- The authorised Price is captured on `ClubBillingPricing.amountMinorUnits`
  at signup and read-only after authorization.  The M4-cancellation
  slice's contract tests (and the preceding slices') assert the
  cancellation / renewal / retry services never call
  `prisma.clubBillingPricing.{create,update,upsert,delete}` or
  `stripe.prices.{create,update,delete}`.
- There is no code path that splits a billing cycle's amount into
  multiple commands.  The `SUBSCRIPTION_CREATE_FIRST` BillingCommand
  carries a single `pricingAmountMinorUnits` field; the worker
  issues one `stripe.subscriptions.create` with one `price_id`.

The first clause (do not attempt until limit confirmed) is an
operational gate OUTSIDE Spectre: the founder must receive explicit
confirmation from Stripe that the account's ACSS Debit transaction
limit permits CAD $38,000 before `SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION`
is flipped to `1`.  Spectre's `drainOneBillingCommand` will issue
the real subscription create as soon as both this flag and
`SPECTRE_SIGNUP_2M4_TRIGGER_LIVE` are on.

## Stripe adapter audit

| Component | File | Status |
|---|---|---|
| Interface declaration (what Spectre expects) | `src/lib/billing/stripe-adapter/types.ts` | SHIPPED |
| Mock adapter (deterministic test-mode shape) | `src/lib/billing/stripe-adapter/mock.ts` | SHIPPED; **currently active on staging** |
| Live adapter (official `stripe@^23.0.1`) | `src/lib/billing/stripe-adapter/live.ts` | SHIPPED; fail-closed if `sk_live_` key supplied (test-mode isolation hardening, M2-Validation) |
| Mode flag | `SPECTRE_STRIPE_SDK_MODE` | staging value `test` (test-mode only, live keys refused) |
| Resolver | `src/lib/billing/stripe-adapter/index.ts` → `resolveStripeAdapter` | SHIPPED; selects mock when live credentials absent OR mode=mock |

Methods on the interface, each implemented by both adapters:

- `createCustomer`
- `createMandateCheckoutSession`
- `retrieveCheckoutSession`
- `createSubscription`
- `retrieveBalanceTransaction`
- `verifyWebhookSignature`
- `retrieveSetupIntent` (added M3)
- `scheduleSubscriptionCancellation` (added M4-cancellation)
- `resumeSubscription` (added M4-cancellation; reversal path)

## Webhook destination subscriptions

| Event | Dispatcher case | Handler |
|---|---|---|
| `payment_intent.processing` | existing | `onPaymentIntentProcessing` |
| `payment_intent.succeeded` | existing | `onPaymentIntentSucceeded` |
| `payment_intent.payment_failed` | existing | `onPaymentIntentFailed` |
| `charge.succeeded` | existing | `onChargeSucceeded` |
| `charge.refunded` | existing | `onChargeRefunded` |
| `charge.dispute.created` | existing | `onChargeDisputeCreated` |
| `setup_intent.*` (4 cases) | M3 | `onSetupIntentEvent` (bank verification tier) |
| `invoice.paid` | M4-settlement | `handleInvoicePaid` |
| `invoice.payment_failed` | M4-settlement | `handleInvoicePaymentFailed` (also drives M4-retries scheduling) |
| `invoice.marked_uncollectible` | M4-settlement | `handleInvoiceMarkedUncollectible` |
| `charge.dispute.closed` | M4-settlement | `handleChargeDisputeClosed` |
| `charge.dispute.funds_withdrawn` | M4-settlement | `handleChargeDisputeFundsWithdrawn` |
| `charge.dispute.funds_reinstated` | M4-settlement | `handleChargeDisputeFundsReinstated` |
| `customer.subscription.updated` | M4-renewal + M4-cancellation | `handleCustomerSubscriptionUpdated` (renewal) THEN `reconcileSubscriptionUpdatedForCancellation` (cancellation; independent state) |
| `customer.subscription.deleted` | M4-renewal + M4-cancellation | `handleCustomerSubscriptionDeleted` (renewal) THEN `reconcileSubscriptionDeletedForCancellation` (cancellation) |
| `mandate.updated` | M4-renewal only | `handleMandateUpdated` |

Every handler is dual-flag-gated behind its slice's live flag plus
the dispatcher-level dispatch flag.  Flag OFF → service throws
`ForbiddenError` → dispatcher catches it, logs a `deferred_flag_off`
event, and leaves `StripeWebhookEvent.processedAt = null` so the
raw event stays persisted (durable receipt) and can be replayed
once the flags flip.

## Payment-initiation controls

Three independent gates must all be ON for a real Stripe mutation
to fire from Spectre:

1. **`SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION`** — global sub-create
   block.  Enforced inside every mutation path.  **Currently OFF on
   staging.**
2. **The relevant slice flag** (e.g. `SPECTRE_SIGNUP_2M4_TRIGGER_LIVE`
   for first-time subscription creation; `SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE`
   for scheduling a cancellation).  **All six slice flags OFF.**
3. **The StripeAdapter resolving to the live adapter**
   (`SPECTRE_STRIPE_SDK_MODE=test` + valid test-mode Stripe
   credentials + `requireLive` opts).  **Currently resolving to mock
   on staging.**

## Billing worker execution

`drainOneBillingCommand` (M4-triggering) + `drainOneInvoiceRetryCommand`
(M4-retries) + `drainOneCancellationCommand` (M4-cancellation) are
each individually dual-flag-gated with their slice flag + the M3
payment-initiation flag.  There is no scheduled background runner
currently invoking any of them on staging; invocation is
operator-triggered.  A later slice (P2 in the gap register) will
add a scheduled worker that drains the queue; until then, operator-
initiated invocation + the webhook-driven reconcilers are the only
sites that advance BillingCommand state.

## Safe integration-test matrix

Per founder §6: "Document which integration tests can be performed
safely without creating an actual subscription."

| Test category | Safe without flag flip? | Evidence it produces |
|---|---|---|
| Unit tests + contract tests | ✅ Yes | Service shape, state-machine wiring, idempotency key shapes, scope boundaries, schema shape, dispatcher routing |
| DB-backed integration tests (SQLite via vitest) | ✅ Yes | Prisma transactions, concurrent-race detection via conditional `updateMany`, FK integrity |
| DB-backed integration tests (Postgres via Docker, pg-validate harness) | ✅ Yes | Same shape as SQLite + Postgres-specific transactional semantics (M1d harness) |
| Signed-webhook fixture injection | ✅ Yes, flags OFF | Dispatcher routing + flag-off deferral path (events persist with `processedAt=null`); does NOT verify handler state writes while flags OFF |
| Signed-webhook fixture injection with flags ON (controlled window) | ⚠️ Requires founder-authorised time-boxed flag flip | State transitions in cancellation / renewal request rows; `BillingExceptionCase` writes; adapter-level mock evidence source `"mock-stripe"` |
| Real Stripe test-mode subscription create | ❌ Not safe without §3 limit confirmation + founder authorisation | End-to-end M4-triggering, settlement, retries, renewal, cancellation against real Stripe webhooks |
| Real settlement + funds availability | ❌ Not safe without §3 limit confirmation + founder authorisation | Only this proves the balance-transaction `status === "available"` AND `available_on <= now` gate works end-to-end |

The staging email-adapter probe (`POST /api/admin/billing/email-adapter-probe`)
is in the SAFE column: it exercises the exact Microsoft Graph
`selectPlatformEmailAdapter` path, writes an audit trail, and
contains no sensitive data.

The renewal-preflight probe GET + the POST dry-run branch are also
in the SAFE column.  The POST live-sweep branch is a no-op when the
renewal flag is OFF (returns `dry_run_flag_off`).

**Nothing in this slice enables payment execution.**  All production-
billing flags remain OFF per §7.
