# SIGNUP-2 M4-STRIPE-1 — Stripe test-mode readiness report

**Status:** read-only inspection complete; staging **not yet ready** for a
real test-mode subscription attempt.  Three Stripe-account-side
remediations required BEFORE any flag flip.  No subscription has been
created.  No code change deployed.

**Inspection source:** `scripts/m4-stripe-1-inspect.mjs` (raw HTTPS to
`api.stripe.com`, no SDK dependency, no credentials in output), run
via SSH on `spectre-staging` v984 (image `sha-36d79236be9d`),
2026-10-29.

## 1. Stripe configuration and limits — findings

### 1.1 Mode + credential surface (READY)

| Setting | Value | Interpretation |
|---|---|---|
| `SPECTRE_STRIPE_SDK_MODE` | `test` | Live adapter selected; mock no longer in use for callers that reach `resolveStripeAdapter()`. |
| `SPECTRE_SIGNUP_2E_STRIPE_MODE` (legacy) | unset | No conflict. |
| `STRIPE_SECRET_KEY` prefix | `sk_test_` (107 chars) | Test-mode key correctly provisioned. Live-mode refusal is unconditional in `assertSecretKeyIsTestMode`. |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | present (38 chars) | Shape matches Stripe's `whsec_` format. |
| `STRIPE_ACSS_PRICE_ID` | `price_1U***m7A6` | Resolved. |

### 1.2 Price (READY, matches contract)

| Field | Value |
|---|---|
| `active` | `true` |
| `livemode` | `false` (test-mode, correct) |
| `currency` | `cad` |
| `type` | `recurring` |
| `recurring.interval` | `year` |
| `recurring.interval_count` | `1` |
| `unit_amount` | `3,800,000` cents → **CAD $38,000.00** |
| Product id | `prod_VWC***UwtD` |

The Price exactly matches the authorised contract. Not touched by this slice.

### 1.3 Stripe account (BLOCKED, 3 remediations required)

| Field | Value | Status |
|---|---|---|
| Account id | `acct_1UV***3002` | — |
| Type | `standard` | — |
| Country | `CA` | correct for ACSS Debit |
| `default_currency` | `cad` | correct |
| `details_submitted` | **`false`** | 🔴 **BLOCKER** |
| `charges_enabled` | **`false`** | 🔴 **BLOCKER** |
| `payouts_enabled` | **`false`** | 🔴 **BLOCKER** |
| `capabilities.acss_debit_payments` | **`null`** | 🔴 **BLOCKER** |
| `requirements.currently_due` count | 0 | — |

The staging test account has **not completed Stripe onboarding**.
Even in test mode, Stripe refuses to create a subscription that
attempts a charge until `details_submitted=true` AND
`charges_enabled=true` AND the required capability is **active**
on the account.

### 1.4 Webhook endpoint subscriptions (BLOCKED, event-list incomplete)

| Field | Value |
|---|---|
| Endpoints total | 1 |
| Endpoint id | `we_1UVAd***rlPN` |
| URL | matches `staging.spectreautomation.com/api/webhooks/stripe` ✅ |
| Status | `enabled` ✅ |
| API version | `2026-09-30.endive` ✅ (matches live adapter) |
| `enabled_events` count | **6** (no wildcard) |

**Events confirmed present on the endpoint:** `payment_intent.processing`.

**Events the dispatcher expects but could not be confirmed on the endpoint:**

| Event | Spectre handler |
|---|---|
| `setup_intent.succeeded` | M3 bank-verification |
| `setup_intent.requires_action` | M3 bank-verification |
| `setup_intent.setup_failed` | M3 bank-verification |
| `setup_intent.canceled` | M3 bank-verification |
| `payment_intent.succeeded` | existing pre-M4 handler |
| `payment_intent.payment_failed` | existing pre-M4 handler |
| `charge.succeeded` | existing pre-M4 handler |
| `charge.refunded` | existing pre-M4 handler |
| `charge.dispute.created` | existing pre-M4 handler |
| `invoice.paid` | M4-settlement |
| `invoice.payment_failed` | M4-settlement + M4-retries |
| `invoice.marked_uncollectible` | M4-settlement |
| `charge.dispute.closed / funds_withdrawn / funds_reinstated` | M4-settlement |
| `customer.subscription.updated` | M4-renewal + M4-cancellation |
| `customer.subscription.deleted` | M4-renewal + M4-cancellation |
| `mandate.updated` | M4-renewal |

**At most 6 events are enabled** vs the ~17 the dispatcher routes. Without the full set, M3 bank-verification would never fire, M4-settlement would never see `invoice.paid`, and M4-cancellation would never see `customer.subscription.deleted`.

### 1.5 Runtime bundle (OK)

The `stripe` npm package is not laid out at `/app/node_modules/stripe`
(ad-hoc scripts cannot `require` it), but it IS webpack-bundled into
Next.js server chunks that back the live adapter — confirmed via
`/app/.next/server/chunks/21623.js` + `.../94406.js`. The deployed
application paths that call `resolveStripeAdapter()` do resolve the
SDK correctly.

## 2. ACSS Debit transaction-limit (unchanged from M4-INT-B)

Stripe does **not** expose per-account ACSS Debit transaction-amount
limits via API. The question + evidence package to send to Stripe
Support is in `docs/signup-2-m4-int-c-stripe-support-question.md`
(now also captured as `signup-2-m4-int-c-stripe-support-question.md`
on this commit). Numeric limit confirmation remains Stripe-Support-
dependent. Does not apply differently to test-mode vs live-mode in
Spectre's refusal path (Spectre refuses live until BLOCKER-A closes
regardless of what the test account would accept).

## 3. Required remediations BEFORE any flag flip

1. **Complete Stripe test-account onboarding** on `acct_1UV***3002`:
   - Submit account details (business profile, bank account for payouts, etc. — all test-mode).
   - Confirm `charges_enabled=true` after onboarding.
   - Request + verify `capabilities.acss_debit_payments` becomes `active`.
2. **Add the full event list to the staging webhook endpoint** at `we_1UVAd***rlPN`. Options:
   - Easiest: switch to `enabled_events: ["*"]` (receives everything; dispatcher ignores unrouted types).
   - Explicit: add exactly the 15 events listed in §1.4.
3. **Resolve the ACSS Debit numeric limit** with Stripe Support (BLOCKER-A).

All three are Stripe-dashboard / Stripe-Support actions. Spectre code changes are NOT required.

## 4. What this slice did NOT do

- No subscription created.
- No charge initiated.
- No Price change / split / amount reduction.
- No live-mode credential introduced.
- No flag flipped (`SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION` + all M4 flags remain OFF).
- No code deployed (inspection script committed but not required by runtime).
