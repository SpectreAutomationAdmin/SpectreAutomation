# SIGNUP-2 M2 — Acceptance Evidence

**Status.** M2 **AUTONOMOUS SLICE** READY FOR FOUNDER ACCEPTANCE
(STAGING, mode=mock). Live-mode activation gated on founder-provided
Stripe test credentials — see §12.

M2 implements the official Stripe SDK adapter, a fail-closed resolver,
balance-transaction reconciliation, retry/exception handling, enhanced
contract tests, and the smallest set of code changes needed so that
when Stripe TEST MODE credentials land, flipping
`SPECTRE_SIGNUP_2E_STRIPE_MODE=live` is a secret-rotation operation,
not a code change.

**Deployed image.** `registry.fly.io/spectre-staging:sha-52a9e808b0e4`
on Fly release **v941**.
**DRH-1 run.** 40498040561 — conclusion: success.
**Rollback anchor.** M1 image `sha-16e12308` / Fly v936.
**Date.** 2026-10-27.

---

## 1. Scope split: autonomous vs. founder-dependent

Per founder §6 ("Identify which Stripe account configuration, test
credentials, webhook endpoint registration, ACSS capability settings,
and legal approvals genuinely require founder action"), M2 explicitly
separates:

### 1a Autonomous (shipped in this slice)

- **Install official `stripe` npm package.** `stripe@^23.0.1`.
- **Live `StripeAdapter` implementation** against the SDK with:
  - `createCustomer`, `createMandateCheckoutSession`, `retrieveCheckoutSession`, `createSubscription`, `retrieveBalanceTransaction`, `verifyWebhookSignature`.
  - Every result carries `evidenceSource: "live-stripe"`. Never fabricates.
  - Idempotency keys on all mutating methods.
  - Bounded exponential-backoff retry with jitter; retries ONLY on `StripeConnectionError` / `StripeAPIError` / 5xx. Never retries 4xx.
- **Fail-closed resolver**:
  - `SPECTRE_SIGNUP_2E_STRIPE_MODE=live` + missing `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SIGNING_SECRET` → **throws** (no silent fallback to mock).
  - `resolveStripeAdapter({ requireLive: true })` for production-capable call-sites.
  - `resolveAcssPriceId()` throws on `mode=live && !STRIPE_ACSS_PRICE_ID`.
- **Balance-transaction reconciliation service**: polls until
  `status === "available" && availableAt <= now`; bounded 6h wall-clock
  budget; jittered exponential backoff; idempotent (short-circuits on
  existing `PAYMENT_SETTLED` entry); writes `PaymentReconciliationEntry`
  + flips `BillingCycle.subscriptionStatus = "SETTLED"` atomically.
- **Price-id wiring** in `signup-2e-mandate-service.ts`: reads
  `STRIPE_ACSS_PRICE_ID` when live; falls to deterministic mock price
  id when mock.
- **23 contract tests** covering resolver, live adapter, retry, idempotency, mandate wiring, reconciliation.
- **Phase 2E guard tests updated** to exempt the authorised SDK-import
  sites (`live.ts` + `index.ts`); every other Phase 2E file remains
  under the strict grep sweep.

### 1b Founder-dependent (listed in §12 with exact actions)

- Stripe account creation / access delegation.
- Business verification + ACSS PAD capability enablement on the Stripe account.
- Test-mode API keys generation (`sk_test_...`, `pk_test_...`).
- Test-mode Product + Price creation for CAD $38,000 annual (ACSS).
- Webhook endpoint registration pointing at `https://staging.spectreautomation.com/api/webhooks/stripe`.
- Webhook signing secret retrieval (`whsec_...`).
- `flyctl secrets set` to provision the three secrets on staging.
- Legal approval of ACSS mandate wording.

None of 1b can be performed by Claude without founder access to the
Stripe dashboard. All of 1a has been performed.

---

## 2. Official Stripe SDK adapter (founder §2)

File: [src/lib/billing/stripe-adapter/live.ts](src/lib/billing/stripe-adapter/live.ts).

API version pinned: **`2026-09-30.endive`** (Stripe `LatestApiVersion`).

| Method | Stripe SDK call | Idempotent | Retry | Evidence |
|---|---|---|---|---|
| `createCustomer` | `customers.create` with `idempotencyKey` | ✓ | ✓ | `live-stripe` |
| `createMandateCheckoutSession` | `checkout.sessions.create` with ACSS mandate_options + idempotencyKey | ✓ | ✓ | `live-stripe` |
| `retrieveCheckoutSession` | `checkout.sessions.retrieve({expand: [setup_intent, setup_intent.payment_method]})` | n/a | ✓ | `live-stripe` |
| `createSubscription` | `subscriptions.create` with `payment_behavior: "default_incomplete"` + idempotencyKey | ✓ | ✓ | `live-stripe` |
| `retrieveBalanceTransaction` | `balanceTransactions.retrieve` | n/a | ✓ | `live-stripe` |
| `verifyWebhookSignature` | `webhooks.constructEvent` | n/a | n/a (deterministic) | n/a |

**ACSS PAD specifics** on the Checkout Session:
```ts
mode: "setup",
payment_method_options: {
  acss_debit: {
    currency: "cad",
    mandate_options: {
      payment_schedule: "interval",
      interval_description: args.acssMandate.intervalDescription,
      transaction_type: "business",
    },
  },
},
```

The Stripe hosted Checkout page handles the ACSS mandate signing +
micro-deposit verification (test mode skips micro-deposits). On
return, the dispatcher persists `setup_intent.mandate` + the
`payment_method` id.

**Subscription behaviour** `default_incomplete` + `payment_settings.payment_method_types: ["acss_debit"]`:
- Stripe does NOT auto-charge on subscription create.
- The first `invoice.payment_intent` is in `requires_action` → `processing` → `succeeded` lifecycle.
- Webhooks drive `BillingCycle.subscriptionStatus` transitions.
- Activation gate reads the authoritative `balance_transaction` via `retrieveBalanceTransaction`.

---

## 3. Financial activation gate preserved (founder §3)

Phase 2F's 9-gate activation decision + §2E `deriveActivationReadySignal`
remain the authoritative activation path. The M2 reconciliation service
feeds the `PAYMENT_SETTLED` reconciliation entry that the 7-signal
webhook correlator (M1d, founder §6) uses to classify renewals; it does
NOT itself activate tenants.

Verified:
- `retrieveBalanceTransaction` returns `status + available_on` from the
  real Stripe object; the reconciliation service refuses to flip
  `settlementConfirmedAt` until `status === "available" && availableAt <= now`.
- `evidenceSource` is preserved end-to-end. Phase 2F's production path
  rejects `evidenceSource === "mock-stripe"` (unchanged from Phase 2F
  closure).
- Legal approval, signatory authority, organisation verification, and
  provisioning gates remain in Phase 2B, 2C, 2D, 2G respectively —
  M2 does NOT touch any of them.
- Revalidation at authorisation + operational activation is enforced
  by the existing Phase 2F `validateActivationAuthorisation` seam.

---

## 4. Security (founder §4)

- **Test-mode credentials only.** Every secret documented in §12 uses
  `sk_test_...` / `whsec_...` prefixes. Live-mode (`sk_live_...`)
  is NOT authorised.
- **Secrets never exposed.** Claude's codebase, logs, and acceptance
  docs reference secret NAMES only. No actual secret values appear
  anywhere in git history.
- **Staging-only.** The Fly app `spectre-staging` is the only
  deployment target for M2.
- **Least privilege.** `STRIPE_SECRET_KEY` must be the staging-only
  test-mode key with ACSS capability enabled; no live or
  production-tier capabilities should be enabled on the test key.
- **Invalid signatures rejected.** The webhook route returns 400 on
  any `verifyWebhookSignature` failure (including `signature_mismatch`,
  `missing_signature`, `missing_secret`, `parse_error`).
- **Ambiguous correlation rejected.** M1d's 7-signal correlator +
  AMBIGUOUS branch (shipped in `sha-16e12308`) remains the final
  classifier. M2 does not weaken this.
- **Immutable financial audit.** Every state transition is audited
  via `audit()`; the reconciliation ledger (`PaymentReconciliationEntry`)
  is append-only.
- **Caller-supplied test flags cannot bypass.** The resolver fails
  closed, and `resolveStripeAdapter({ requireLive: true })` enforces
  live mode at production-capable sites. The Phase 2F mock-rejection
  guard (`evidenceSource !== "mock-stripe"` on production provisioning)
  remains in place.

---

## 5. Contract tests (founder §5)

File: [tests/signup-2-m2-stripe-adapter.test.ts](tests/signup-2-m2-stripe-adapter.test.ts) — 23 scenarios.

Coverage matrix:

| Area | Scenarios |
|---|---|
| Resolver fail-closed | mock-default, mock-explicit, missing-secret-throw, missing-webhook-throw, requireLive-refuses-mock, all-three-set-returns-live |
| Price-id fail-closed | mock-returns-null, live-missing-throws, live-with-id-returns-id |
| Live adapter evidence | createCustomer, retrieveBalanceTransaction, verifyWebhookSignature (SigErr + success), empty-secret-throws |
| Reconciliation service | idempotency, already-reversed, budget-exhausted, terminal-success-writes |
| Mandate service | priceId() routes by mode, createSubscription uses resolved id |
| Live adapter invariants | no `mock-stripe` fabrication, retry-never-4xx, all-mutators-pass-idempotencyKey |

Scenarios shipped **against mocked SDK** (per founder §5: "Clearly
distinguish actual Stripe test-mode evidence from simulated event
fixtures"). The SDK responses are mocked at the module boundary;
Claude did not fabricate Stripe-generated event objects.

**Scenarios DEFERRED to the founder-credentials window** (acceptance
doc §13):
- Real test-mode ACSS mandate collection via Stripe hosted Checkout.
- Real test-mode payment initiation.
- Real settlement + balance_transaction availability.
- Real reconciliation drill.
- Duplicate / out-of-order real-event replay.
- Real Stripe-generated signature verification.
- Wrong-tenant and wrong-cycle real-event handling.
- Real payment-failure / return / refund / dispute drills.
- Reversal-driven suspension end-to-end with real events.

These scenarios **cannot be executed without founder-provided test
credentials** and are tracked for the M2 live-mode acceptance follow-on.

---

## 6. Founder dependencies (founder §6) — precise actions

See §12 for the exact commands + Stripe dashboard steps.

---

## 7. Deployment + Playwright acceptance (founder §7)

- Deployed via DRH-1 (run 40498040561).
- Staging-only.
- Preserves M1 rollback anchor (`sha-16e12308` / v936).
- `SPECTRE_SIGNUP_2E_STRIPE_MODE` **remains unset (defaults to mock)** on staging post-deploy. No live Stripe calls occur. No webhook signature verification against real Stripe secret occurs.
- Playwright acceptance **reuses M1b/M1c spec**
  (`tests/e2e/signup-2-m1b-posting-race.staging.spec.ts`) — exercises
  the webhook → Phase 2H end-to-end path with the mock adapter still
  in control. The 7-signal correlator + AMBIGUOUS branch (M1d) carries
  the real correlator logic; M2 doesn't change event-handling behaviour,
  only the back-end adapter.

```
$ npx playwright test tests/e2e/signup-2-m1b-posting-race.staging.spec.ts --project=staging-authenticated
  ok 1 [staging-authenticated] › tests\e2e\signup-2-m1b-posting-race.staging.spec.ts (2.4m)
  1 passed (3.2m)
```

| # | Scenario | Observed | Pass |
|---|---|---|---|
| B.renewal | Confirmed renewal payment failure | ACTIVE → UNDER_REVIEW; `trigger=FAILED_RENEWAL` | ✓ |
| A | Suspended tenant posting-guard refuses | gate refuses on `UNDER_REVIEW` | ✓ |
| C | Duplicate webhook delivery | `"replay"`; no additional transition | ✓ |
| D | Legacy tenant protection | No transition against null-status rows | ✓ |
| E | No automatic reinstatement | `payment_intent.succeeded` kept tenant at UNDER_REVIEW | ✓ |
| G | Teardown + flags OFF | `scenariosDestroyed:1` + flags unset at close | ✓ |

The acceptance ran with `SPECTRE_SIGNUP_2E_STRIPE_MODE` unset →
mock adapter. Live-mode acceptance (deferred) requires founder-provided
Stripe test credentials per §12.

---

## 8. Non-authorisations preserved (founder §8)

- `SPECTRE_SIGNUP_2E_STRIPE_MODE` defaults to **mock** on staging. Live mode is NOT activated.
- No live Stripe mode.
- No real debits.
- No real tenant activation.
- No production deploy.
- No existing-tenant modification.
- No gov-ID collection.
- No ACSS mandate wording activated for real signatories.
- No M3-M6 begun.

---

## 9. Image provenance

- **DRH-1 run:** 40498040561 — conclusion: success
- **Branch:** `staging-deploy/web1b1-framer-fidelity`
- **Commit:** `sha-52a9e808b0e4abc1adeb2e96661b36cb402bba26`
- **Image:** `registry.fly.io/spectre-staging:sha-52a9e808b0e4`
- **Digest:** `sha256:d08e0788992dc31db473470346d5bc4da67e9bacd03681e7758b9cb0c3983f38`
- **Fly release:** **v941**
- **Health probe at open + close:** `/api/health` → **200**
- **Rollback anchor:** M1 `sha-16e12308` / Fly v936.

---

## 10. Validation performed

- `npm run typecheck` — clean.
- `npx vitest run tests/signup-2*.test.ts` — **1138/1138 pass + 5 Postgres-only skips** across 51 files.
- `npx vitest run tests/signup-2-m2-stripe-adapter.test.ts` — **23/23 pass**.
- Staging deploy via DRH-1 (see §9).
- Playwright reused from M1b (webhook end-to-end).

---

## 11. Teardown

Current staging state remains in **mock-mode**. No fixtures created
by M2. All existing SIGNUP-2 flags remain OFF. The adapter is drop-in
once founder completes §12 — no further code changes required.

---

## 12. Precise founder-action instructions for live-mode activation

Everything below requires founder access to the Stripe dashboard. Each
step lists the SMALLEST precise action. Once all four secrets are set,
staging will exercise real Stripe TEST MODE on the next webhook /
mandate flow.

### 12.1 Create or access the Stripe account

- Open https://dashboard.stripe.com. Toggle the UI to **"Test mode"** (top-left switch).
- The account must have Canadian business verification + ACSS debit (PAD) capability enabled. In test mode this is instant for most eligible accounts; verify via **Settings → Payment methods → ACSS Debit** showing "Enabled".

### 12.2 Create the CAD $38,000 annual ACSS Price

In the Stripe dashboard (test mode):

- **Product**: Create a Product named `Spectre Automation — Annual Subscription`.
- **Price**: Attach a recurring Price:
  - Billing period: `Yearly`
  - Price: `$38,000.00 CAD`
  - Payment methods: enable **ACSS Debit** on the price.
- Copy the price id (`price_...`). Save it as `STRIPE_ACSS_PRICE_ID`.

### 12.3 Register the staging webhook endpoint

In the Stripe dashboard (test mode) → **Developers → Webhooks → Add endpoint**:

- **Endpoint URL**: `https://staging.spectreautomation.com/api/webhooks/stripe`
- **API version**: `2026-09-30.endive` (the version pinned in `live.ts`).
- **Events to listen for**:
  - `payment_intent.processing`
  - `payment_intent.succeeded`
  - `payment_intent.payment_failed`
  - `charge.succeeded`
  - `charge.refunded`
  - `charge.dispute.created`
- Save the endpoint. Reveal its **Signing secret** (`whsec_...`). Save it as `STRIPE_WEBHOOK_SIGNING_SECRET`.

### 12.4 Retrieve the test-mode API key

In the Stripe dashboard (test mode) → **Developers → API keys**:

- Reveal the **Secret key** (`sk_test_...`). Save it as `STRIPE_SECRET_KEY`.

### 12.5 Provision secrets on staging

From a terminal with `flyctl` authenticated:

```bash
flyctl secrets set --app spectre-staging \
  STRIPE_SECRET_KEY="sk_test_..." \
  STRIPE_WEBHOOK_SIGNING_SECRET="whsec_..." \
  STRIPE_ACSS_PRICE_ID="price_..."
```

Each secret is Fly-encrypted at rest and ONLY available to the running
app's process env. **Never paste these into code, chat, logs, or docs.**

### 12.6 Flip the live-mode flag

```bash
flyctl secrets set --app spectre-staging SPECTRE_SIGNUP_2E_STRIPE_MODE=live
```

The next request that calls `resolveStripeAdapter()` will route through
the live adapter. The resolver validates the three secrets at that
moment; if any are missing it throws rather than silently falling back.

### 12.7 Verify

- `curl https://staging.spectreautomation.com/api/health` → **200**.
- Watch Fly logs for `stripe.adapter.mode mode=live` entries (there won't be any until a request triggers the resolver — this is lazy).
- Fire a real test-mode payment via Stripe's test dashboard; verify the webhook receiver persists the event + the 7-signal correlator classifies correctly.

### 12.8 Return to mock mode

```bash
flyctl secrets unset --app spectre-staging SPECTRE_SIGNUP_2E_STRIPE_MODE
```

The resolver defaults to mock when the mode flag is unset.

---

## 13. Residual blockers

- **ACSS mandate wording legal approval.** Even in test mode, the
  wording that appears on the Stripe Checkout page is tenant-facing.
  Founder legal review required before any real signatory (even for
  internal test purposes) interacts with the hosted Checkout. Not a
  blocker for the autonomous slice; **required before Playwright
  acceptance against real Stripe test-mode**.
- **Business verification + ACSS capability.** If the Stripe test
  account has not had ACSS debit enabled by Stripe, test-mode calls
  that reference ACSS will return `invalid_request` with
  `code=parameter_unknown`. Founder must confirm ACSS capability is
  enabled in the test account's **Settings → Payment methods** before
  attempting live-mode acceptance.
- **Test-mode micro-deposit skip.** Stripe skips the two-penny
  micro-deposit verification in test mode; mandates are considered
  signed immediately. In live mode micro-deposits are required and
  the mandate workflow takes 1-2 business days. This is a Stripe
  behaviour, not a Spectre defect; the live-mode launch plan assumes
  it.

---

## 14. Required final response format

- **Files changed.** `package.json` (+stripe), `package-lock.json`,
  `src/lib/billing/stripe-adapter/live.ts` (new), `src/lib/billing/stripe-adapter/index.ts`,
  `src/lib/billing/signup-2e-mandate-service.ts`,
  `src/lib/billing/signup-2m2-reconciliation-service.ts` (new),
  `tests/signup-2-m2-stripe-adapter.test.ts` (new),
  Phase 2E guard tests updated.
- **Validation performed.** typecheck + 1138/1138 vitest + Playwright reuse. Full details §10.
- **Validation intentionally skipped.** Real-Stripe end-to-end
  (requires §12 credentials). Documented as deferred, not claimed
  complete.
- **Remaining risk.** §13 — legal approval + Stripe account
  configuration are the external blockers.

---

**End of M2 autonomous slice acceptance.** M2 is READY FOR FOUNDER
ACCEPTANCE as the mock-backed staging baseline with a drop-in live
adapter. Live-mode activation requires only the four secrets listed
in §12 — no further code changes.
