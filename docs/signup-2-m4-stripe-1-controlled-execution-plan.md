# SIGNUP-2 M4-STRIPE-1 §4 — Controlled execution plan

Deterministic + auditable plan for ONE synthetic staging subscription-
create test window. **This plan is not executed by this slice.** No
flag flip, no Stripe mutation, no Spectre code change is performed
by M4-STRIPE-1 itself. The founder authorises the window as a
separate slice (likely M4-STRIPE-2).

## Pre-flight (close before any flag flip)

| # | Dependency | Status | Owner |
|---|---|---|---|
| P1 | Stripe test account onboarding complete (`details_submitted=true`, `charges_enabled=true`, `capabilities.acss_debit_payments=active`) | **OPEN** | founder, in Stripe dashboard |
| P2 | Stripe webhook endpoint `we_1UVAd***rlPN` carries the full event list (either `enabled_events: ["*"]` or the 15 named events) | **OPEN** | founder, in Stripe dashboard |
| P3 | Stripe Support confirmation of ACSS Debit transaction-amount limit for CAD $38,000 | **OPEN** | founder, via `docs/signup-2-m4-int-c-stripe-support-question.md` |
| P4 | Two synthetic SUPER_ADMIN operators (A + B) provisioned via `scripts/m4-int-c-provision-super-admins.mjs` | ready-on-demand | operator, immediately before window |
| P5 | Synthetic staging registration record in `BANK_VERIFIED` state with contract execution + pricing + payment-method rows | **NOT YET PRODUCED** | separate fixture; precedent exists in `scripts/signup-2-phase-2b-staging-fixture.mjs` |
| P6 | Rollback anchor confirmed: Fly v984 / image `sha-36d79236be9d` (M4-STRIPE-1 baseline) | confirmed | — |

## The window (expected duration: ~60-90 minutes wall-clock)

### Phase 0 — Operator provisioning (minute 0)

Operator (founder or delegate) runs:

```
# Provision two synthetic SUPER_ADMINs with 2-hour TTL marker.
flyctl ssh console --app spectre-staging \
  --command "node /app/scripts/m4-int-c-provision-super-admins.mjs"
# Transport credentials to .env.playwright.local (same mechanism as M4-INT-C).
```

Window start timestamp captured in `User.name` as "- expires <ISO>".

### Phase 1 — Flag flip (minute 1)

**EXACT COMMAND (not executed by this slice):**

```
flyctl secrets set \
  SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION=1 \
  SPECTRE_SIGNUP_2M4_TRIGGER_LIVE=1 \
  --app spectre-staging
```

Triggers one DRH-1 redeploy. Observe:
- GitHub Actions run completes success.
- `/api/health` returns 200.
- Container-side env shows both flags = `1`.

### Phase 2 — Commercial authorization + payment release (minutes ~5-10)

Operator A navigates to `/app/admin/signup-ops/billing/triggering`, selects the synthetic candidate, clicks "Record commercial authorization". System writes `ClubPaymentAuthorisation`.

Operator B navigates to the same page, same candidate, clicks "Record payment release". System writes `ClubBillingRelease` + enqueues `BillingCommand(SUBSCRIPTION_CREATE_FIRST)` atomically. SoD enforced in-service: `releaseApprovedByUserId !== commercialApprovedByUserId`.

**Watch:** `BillingCommand.state = "PENDING"` row appears via the hub's "Pending billing commands" counter.

### Phase 3 — Worker drain (minutes ~10-15)

Operator A invokes the drain for the one specific command id:

```
POST /api/admin/billing/triggering  { action: "drain", commandId: "<id>" }
```

System calls `stripe.subscriptions.create` with the authorised Price. Record SUCCEEDS → `BillingCommand.stripeResourceId = sub_...` + `BillingCycle.stripeSubscriptionId` set.

**Verify in Stripe dashboard (test toggle on):** the new `sub_` row appears with its first `inv_` row attached.

### Phase 4 — Webhook settlement (minutes ~15-45)

Stripe test-mode delivers in sequence (times approximate):

- `payment_intent.processing` — recorded immediately
- `payment_intent.succeeded` — recorded within seconds
- `invoice.paid` — recorded within seconds
- `balance_transaction` records `pending` → polled by `assertSettlementAuthoritative` → eventually `available` (minutes in test-mode)
- `customer.subscription.updated` with `status: "active"`

**Watch:** Spectre's hub observability counters move. If any webhook fails to arrive, M4-settlement raises a `BillingExceptionCase` with `requiresOperatorAction=true`. The exceptions page is where any failure surfaces.

**Note:** M4-settlement live flag is OFF in this window, so the handlers refuse writes and the dispatcher leaves events `processedAt=null` for later replay. This is INTENTIONAL — Phase 4 proves the subscription + Stripe-side delivery; a follow-up window flips the settlement flag + replays the deferred events.

### Phase 5 — Flag restoration (minute ~45)

Operator unsets the flags:

```
flyctl secrets unset \
  SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION \
  SPECTRE_SIGNUP_2M4_TRIGGER_LIVE \
  --app spectre-staging
```

Triggers one DRH-1 redeploy. Dormant state restored.

### Phase 6 — Operator teardown (minute ~55)

```
flyctl ssh console --app spectre-staging \
  --command "node /app/scripts/m4-int-c-teardown-super-admins.mjs"
```

Removes the two synthetic SUPER_ADMINs + their role rows. Re-enumerates to confirm zero platform SUPER_ADMINs remain. Local `.env.playwright.local` M4_INTC_* lines stripped.

### Phase 7 — Evidence report (minute ~60)

Operator captures:

- Fly release numbers before + after both flag flips.
- Playwright authorized E2E results against both deployed images (pre + post flag flip).
- Stripe dashboard screenshot: subscription + first invoice + mandate.
- Audit log excerpt for every write: commercial auth, release, BillingCommand creation, BillingCommand drain outcome.
- `BillingCycle.subscriptionStatus` progression trace.
- `BillingExceptionCase` rows raised (if any).
- Final flag + Stripe digest snapshot showing restoration.
- Final enumeration showing zero SUPER_ADMINs remain.

## Failure recovery

Each phase has an explicit rollback:

| Phase | Failure | Recovery |
|---|---|---|
| 1 | Deploy fails | Rollback to v984 / sha-`36d79236be9d`. Flags remain unset. No window-side state. |
| 2 | Operator A error (preflight refuses) | Service writes nothing. Operator reads refusal reason + fixes upstream data. No Stripe call fired. |
| 3 | Worker throws | `BillingCommand.state = "UNCERTAIN"` or `"FAILED"`. Stripe `stripe.subscriptions.retrieve` by the deterministic idempotency key establishes whether a subscription was created. |
| 4 | Webhook never arrives | `BillingCommand` stays SUCCEEDED (sub created in Stripe) but reconciliation hangs. `BillingExceptionCase` surfaces at the hub. Operator can decide to cancel the sub manually in Stripe + record a `BillingExceptionCase.operatorResolution = SCHEDULE_CANCELLATION`. |
| 5 | Flag unset fails | Manual Fly dashboard unset. Verify flags OFF via container env probe. |
| 6 | Teardown script fails | Re-run; script is idempotent. Verify via `scripts/m4-int-c-list-super-admins.mjs`. |

## Hard safety invariants (unchanged through the window)

- No `sk_live_` key is ever accepted (`assertSecretKeyIsTestMode` throws).
- No webhook with `livemode=true` is processed (dispatcher-level refusal).
- No code path creates a Club row without a passing `validateActivationAuthorisation`.
- CAD $38,000 Price unchanged; no split; no reduction.
- Zero existing Spectre user is modified.
- The founder's CLUB_ADMIN permission on the real staging club is unaffected.

## What this slice ships

Documentation only:
- `docs/signup-2-m4-stripe-1-readiness.md`
- `docs/signup-2-m4-stripe-1-adapter-deltas.md`
- `docs/signup-2-m4-stripe-1-settlement-vs-activation.md`
- `docs/signup-2-m4-stripe-1-controlled-execution-plan.md` (this doc)
- `scripts/m4-stripe-1-inspect.mjs` (read-only; produced the readiness findings)

No feature flag flipped. No subscription created. No Spectre code behaviour changed.
