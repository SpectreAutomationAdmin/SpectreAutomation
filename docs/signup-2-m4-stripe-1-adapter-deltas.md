# SIGNUP-2 M4-STRIPE-1 §2 — Stripe adapter mode: exact deltas

**Core finding:** staging is **already in SDK mode `test`**
(`SPECTRE_STRIPE_SDK_MODE=test`). The mock adapter is no longer the
default. The reason no real Stripe calls fire is the SLICE flags, not
the SDK mode flag.

This document enumerates every env var + feature flag + operator
approval required to move from "no Stripe calls fire" to "one
controlled test-mode subscription create fires on an authorised
synthetic registration." No change is applied here.

## Current state (post-M4-INT-C baseline, sha-`36d79236be9d`)

| Flag / env | Value | Role |
|---|---|---|
| `SPECTRE_STRIPE_SDK_MODE` | `test` | Live adapter selected on every `resolveStripeAdapter()` call. |
| `STRIPE_SECRET_KEY` | `sk_test_...` | Unconditionally rejected if `sk_live_`. |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | present | Used by `verifyWebhookSignature`. |
| `STRIPE_ACSS_PRICE_ID` | present | Resolved by `resolveAcssPriceId()`. |
| `SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION` | **unset** | **Global sub-create block.** Checked inside every M4 worker + the M3 §7 pre-flight re-validation. |
| `SPECTRE_SIGNUP_2M4_TRIGGER_LIVE` | **unset** | Gates `authoriseAndReleaseFirstBilling` + `drainOneBillingCommand`. |
| `SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE` | unset | Gates the invoice/charge/dispute webhook handlers. |
| `SPECTRE_SIGNUP_2M4_RETRIES_LIVE` | unset | Gates retry scheduling + worker. |
| `SPECTRE_SIGNUP_2M4_RENEWAL_LIVE` | unset | Gates renewal preflight + renewal webhook reconciliation. |
| `SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE` | unset | Gates cancellation request / authorize / schedule / reverse / webhook reconciliation. |
| `SPECTRE_SIGNUP_2M3_WEBHOOK_DISPATCH` | unset | Legacy dispatch flag; preserved. |
| `SPECTRE_SIGNUP_2E_PAYMENT_LIVE` | unset | Legacy payment flag; preserved. |

The LIVE adapter IS what `resolveStripeAdapter()` returns today. **Nothing else fires live calls because the slice flags gate every real mutation.**

## Deltas required for one subscription-create test-mode window

Dependency ordering is important.

### Pre-flip Stripe-side (BLOCKERS)

Before flipping any flag, close §1.3 + §1.4 from `signup-2-m4-stripe-1-readiness.md`:

1. Stripe test account `acct_1UV***3002`: complete onboarding → `details_submitted=true` + `charges_enabled=true` + `capabilities.acss_debit_payments=active`.
2. Stripe webhook endpoint `we_1UVAd***rlPN`: enable the full event set (either `enabled_events: ["*"]` or the 15 named events).
3. Stripe Support: numeric ACSS Debit transaction-amount confirmation for CAD $38,000.

### Flag flip (requires separate founder authorisation)

| Flag | Current | Target | Rationale |
|---|---|---|---|
| `SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION` | unset | `1` | Lifts the M3 §7 global sub-create block. |
| `SPECTRE_SIGNUP_2M4_TRIGGER_LIVE` | unset | `1` | Lets `authoriseAndReleaseFirstBilling` run + `drainOneBillingCommand` call `stripe.subscriptions.create`. |

**Do NOT flip** `SETTLEMENT_LIVE`, `RETRIES_LIVE`, `RENEWAL_LIVE`, `CANCELLATION_LIVE` in the first subscription-create window. The settlement + reconciliation events will land with the two trigger flags only; the other handlers refuse while their own flag is off (the dispatcher's `SignupM3DeferredEvent` catch leaves the raw event persisted for later replay).

### Flag flip (follow-up windows, if the first succeeds)

| Window | Flag added | Purpose |
|---|---|---|
| B | `SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE=1` | Observe `invoice.paid` + balance-transaction `available` + activation gate flip. |
| C | `SPECTRE_SIGNUP_2M4_RETRIES_LIVE=1` | Observe `invoice.payment_failed` → retry schedule under live. |
| D | `SPECTRE_SIGNUP_2M4_RENEWAL_LIVE=1` + `SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE=1` | Observe `customer.subscription.*` reconciliation under live. |

Each window needs its own founder authorisation. No window is enabled by this slice.

## Safety: live-mode credentials cannot be accidentally used

Enforcement is layered:

1. `assertSecretKeyIsTestMode` in `src/lib/billing/stripe-adapter/index.ts` **unconditionally throws** if `STRIPE_SECRET_KEY` begins with `sk_live_`. Called inside `resolveStripeAdapter()` BEFORE constructing the live adapter.
2. `assertSecretKeyIsTestMode` also throws on any key that does NOT begin with `sk_test_` (unknown prefixes fail closed).
3. The webhook signature dispatcher refuses events with `livemode=true` at the HTTP route layer (M2-Validation hardening).
4. `resolveStripeAdapter({ requireLive: true })` throws if mode is `mock`; call-sites that must have the live SDK cannot be silently reduced to mock.
5. The Price itself carries `livemode: false` (verified in the inspection), so even if an sk_live key were ever introduced, the price lookup would fail across-mode (Stripe refuses cross-mode entity reads).

**No change is required to the safety path.** The staging environment is physically unable to transact live money today.

## Flag restoration (rollback)

After each controlled window, operator **MUST** unset the flags they flipped:

```
flyctl secrets unset SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION SPECTRE_SIGNUP_2M4_TRIGGER_LIVE --app spectre-staging
```

`flyctl secrets unset` triggers a redeploy; the next release will have the flags unset and the dormant state restored. The operator inbox + exception register preserve any mid-window state so a cycle is never left half-provisioned.

If the automated staging-flag TTL scheduler is desired per the §8 pattern memorialised in prior memories (GitHub Actions `staging-flag-activate.yml` + `staging-flag-ttl.yml`), it can be used to time-box the flip to a specific window end. **Not required for a 60-minute first-attempt window**, but documented here for completeness.

## Code: NO changes required by this slice

The dispatcher, adapter, services, UI, and schema are all in the state the acceptance test needs. The only changes required to execute §4's controlled plan are:

- Stripe-dashboard changes (listed above).
- Fly secret `set` for the two flags (listed above).
- Fly secret `unset` to restore (listed above).

Spectre code changes are NOT part of M4-STRIPE-1.
