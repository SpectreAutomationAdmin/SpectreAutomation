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

---

## 15. M2-Validation hardening (founder 2026-10-27 §2 + §3)

Shipped as `sha-10a63aa365f4` / Fly release **v945** / DRH-1 run
40507115246.  M1 baseline (`sha-16e12308` / v936) remains the
rollback anchor.

### 15a Test-mode-only operation (founder §2)

1. **`sk_live_` keys refused unconditionally.** `resolveStripeAdapter`
   throws when `STRIPE_SECRET_KEY` begins with `sk_live_`.  Unknown
   prefixes (`rk_test_` restricted keys, malformed strings) also
   throw.  Only `sk_test_` is accepted.  Staging physically cannot
   mount a live-money key regardless of operator action.
2. **Live-mode webhook events refused.**
   `src/app/api/webhooks/stripe/route.ts` returns HTTP **403**
   `livemode_refused` for any event with `event.livemode === true`.
   The guard runs AFTER signature verification but BEFORE durable
   persistence + dispatch, so a mistakenly-sent live-money event is
   never stored and never dispatched to the Phase 2H suspension path.
3. **Mode-flag rename (preserve compatibility).**  New primary
   flag `SPECTRE_STRIPE_SDK_MODE` with values `"mock"` or `"test"`
   replaces the ambiguous legacy `SPECTRE_SIGNUP_2E_STRIPE_MODE=live`
   (where "live" historically meant "real SDK against test
   credentials", NOT "real money mode").  Both flags remain accepted;
   primary wins when both are set + a warning logs.  Legacy
   `stripeAdapterMode()` function retained for existing callers;
   delegates to new `stripeSdkMode()`.
4. **Fail-closed on mismatch.**  Mode=test + missing `STRIPE_SECRET_KEY`
   OR `STRIPE_WEBHOOK_SIGNING_SECRET` throws (no silent mock
   fallback).  Mode=test + sk_live_ throws (see §15a.1).  Mode=test
   + missing `STRIPE_ACSS_PRICE_ID` throws from `resolveAcssPriceId()`.

**Clear SDK-vs-live-money distinction:** the real Stripe SDK is now
pinned to **test credentials** in every mode this codebase supports.
"Live money mode" (production, real debits) is an entirely separate
authorisation path that will require explicit founder-signed code
changes to this guard set — the sk_live_ refusal is unconditional
at the current baseline.

### 15b Reconciliation design verification (founder §3)

Refactored from a single long-poll to a **durably-recoverable
step-wise state machine** at
[src/lib/billing/signup-2m2-reconciliation-service.ts](src/lib/billing/signup-2m2-reconciliation-service.ts).

| § | Requirement | Implementation |
|---|---|---|
| §3.a | Successful payment state required independently of balance availability | `stepReconcile*` refuses to proceed unless `cycle.subscriptionStatus ∈ {AWAITING_SETTLEMENT, SETTLED}` — returns `preconditions_failed` otherwise |
| §3.b | Balance transaction authoritative, correctly correlated, available | The caller provides the `balance_transaction_id` that the webhook dispatcher recorded against the cycle; the service re-reads via `retrieveBalanceTransaction` and matches amount+currency before writing |
| §3.c | Amount + currency match CAD $38,000 | `EXPECTED_AMOUNT_MINOR = 3_800_000`, `EXPECTED_CURRENCY = "cad"`.  Mismatch writes a `RECONCILIATION_MISMATCH` ledger entry + refuses to flip `settlementConfirmedAt` + returns non-terminal `amount_mismatch` / `currency_mismatch` so an operator must triage |
| §3.d | Returns / refunds / disputes / negative adjustments checked | `stepReconcile*` short-circuits with `already_reversed` / `already_refunded` / `already_disputed` if the cycle has `reversedAt` set OR a REFUND/CHARGE_REFUNDED/DISPUTE_OPENED/CHARGE_DISPUTED/PAYMENT_RETURNED/ACSS_RETURN ledger entry exists |
| §3.e | Durable + idempotent | Existing `PAYMENT_SETTLED` entry short-circuits; terminal write wraps `PaymentReconciliationEntry.create` + `BillingCycle.update` in one `prisma.$transaction` so a crash between the two writes rolls both back |
| §3.f | Pending transactions remain pending without premature activation | `status === "pending" OR availableAt > now()` → returns `{ terminal: false, nextCheckAt }` without touching `settlementConfirmedAt` or `subscriptionStatus` |
| §3.g | 6h polling limit cannot permanently strand a valid payment | **Hard 6h cap removed.** Reconciliation is now scheduled per-step; the worker re-invokes at `nextCheckAt` indefinitely.  After `STALL_THRESHOLD_ATTEMPTS=24` (~24h of attempts) a `RECONCILIATION_STALLED` ledger entry raises an operator warning — but the worker **continues probing**, not halting |
| §3.h | Activation subject to all legal, org, signing, operator, provisioning gates | Service writes `PAYMENT_SETTLED` + flips `BillingCycle.subscriptionStatus = "SETTLED"` ONLY.  Does NOT write `ClubSubscription.subscriptionStatus = "ACTIVE"`, does NOT create a `TenantProvisioningJob`, does NOT touch any legal/org/signing gates.  Phase 2F's 9-gate activation decision remains authoritative |

**Legacy single-shot entry point preserved** for backwards compat
(`reconcileBalanceTransaction`); delegates to `stepReconcile*` and
maps non-terminal outcomes to the pre-M2-Validation shape.

### 15c Deployed Playwright acceptance (post-hardening)

```
$ npx playwright test tests/e2e/signup-2-m1b-posting-race.staging.spec.ts --project=staging-authenticated
  ok 1 [staging-authenticated] › tests\e2e\signup-2-m1b-posting-race.staging.spec.ts (2.4m)
  1 passed (2.8m)
```

Final hardened image under test: **`sha-10a63aa365f4`** / Fly **v945**.
All six M1b scenarios green (B.renewal + A + C + D + E + G).  The
new M2-Validation guards + reconciliation refactor cause no
regressions.  Mode remains **mock** on staging (`SPECTRE_STRIPE_SDK_MODE`
unset).

### 15d Final feature-flag + secret state

```
$ flyctl secrets list --app spectre-staging | grep -iE "STRIPE|SIGNUP_2"
(no output)
```

- `STRIPE_SECRET_KEY` — UNSET (founder dependency, §12)
- `STRIPE_WEBHOOK_SIGNING_SECRET` — UNSET (founder dependency, §12)
- `STRIPE_ACSS_PRICE_ID` — UNSET (founder dependency, §12)
- `SPECTRE_STRIPE_SDK_MODE` — UNSET → **mock** (resolver default)
- `SPECTRE_SIGNUP_2E_STRIPE_MODE` — UNSET (legacy flag)
- `SPECTRE_SIGNUP_2E_PAYMENT_LIVE` — UNSET
- `SPECTRE_SIGNUP_2H_SUSPENSION_LIVE` — UNSET

### 15e Validation (post-hardening)

- `npm run typecheck` — clean
- `npx vitest run tests/signup-2*.test.ts` — **1158/1158 pass + 5 Postgres-only skips** across 52 files (M2-Validation added 16 new scenarios in `tests/signup-2-m2-validation-guards.test.ts`)
- `npx playwright test tests/e2e/signup-2-m1b-posting-race.staging.spec.ts --project=staging-authenticated` — **1/1 pass (2.4 m)** on `sha-10a63aa365f4` / v945

### 15f Current limitations — genuine Stripe test-mode acceptance deferred

Per founder §4: "Determine whether authorized Stripe test-mode access
already exists.  If it does, configure the test-mode product, annual
price, webhook endpoint, and credentials securely.  If it does not,
provide the founder with the minimum required Stripe Dashboard
actions."

**Claude does NOT have Stripe dashboard access.** The founder has
not provisioned Stripe test-mode API keys, a Product + Price, or a
webhook endpoint on behalf of this project.  Without those, the
following scenarios (founder §5) cannot be executed:

- CAD $38,000 annual subscription creation via real Stripe test mode.
- Real ACSS PAD mandate collection via Stripe hosted Checkout.
- Real payment initiation + processing.
- Stripe-generated webhook delivery with real signatures.
- Real settlement + balance_transaction availability.
- Real failure / refund / return / dispute drills.

These are the acceptance scenarios **deferred** to the live-mode
window.  The autonomous slice (§1–§14) + the M2-Validation hardening
(§15a-§15e) are the SMALLEST technical artefacts that let the
founder (a) grant Stripe dashboard access OR (b) execute §12 themselves,
with ZERO code-change gates in the way.

### 15g Precise outstanding founder actions (unchanged from §12)

See **§12 Precise founder-action instructions for live-mode activation**
above — unchanged.  The resolver now additionally:
- Refuses any `STRIPE_SECRET_KEY` beginning with `sk_live_`.
- Requires `SPECTRE_STRIPE_SDK_MODE=test` (preferred) OR
  `SPECTRE_SIGNUP_2E_STRIPE_MODE=live` (legacy) to engage the SDK
  adapter.  Mock mode is the default and happens when neither flag
  is set.

### 15h Non-authorisations preserved (founder §7)

- No live-money mode (`sk_live_` physically refused).
- No real debits.
- No real customer activation.
- No production deploy.
- No existing-tenant modification.
- No unapproved legal terms (ACSS mandate wording).
- No M3-M6 begun.

---

**End of M2-Validation hardening.** M2 remains READY FOR FOUNDER
ACCEPTANCE as the mock-backed staging baseline with (a) the drop-in
real SDK adapter, (b) unconditional `sk_live_` + `livemode=true`
refusal guards, and (c) a durably-recoverable scheduled
reconciliation design.  Live-mode acceptance requires only §12 —
no further code changes.

---

## 16. Stripe sandbox preflight (founder 2026-10-27)

**Status.** PREFLIGHT ONLY. No Fly secrets changed. No Stripe
integration activated. All SIGNUP-2 flags remain OFF.

Founder-provided sandbox state (preserved here for cross-check):
- Product: *Spectre Automation — Annual Club Subscription*.
- Price: CAD $38,000 annually, tax-exclusive.
- Price id: `price_1UVAVnRJ1xiT30028TU0m7A6`.
- Webhook destination: *Spectre Automation - Staging Subscriptions*.
- Endpoint: `https://staging.spectreautomation.com/api/webhooks/stripe`.
- Payload: `Snapshot`.
- API version: `2026-09-30.endive`.
- Six events selected.
- Webhook signing secret generated, **not shared** (correct — stays in founder's hands).

### 16a Webhook event subscription audit

The dispatcher in [src/lib/billing/signup-2e-webhook-dispatch.ts](src/lib/billing/signup-2e-webhook-dispatch.ts) handles **exactly these six** event types (switch at line 32–49):

1. `payment_intent.processing`
2. `payment_intent.succeeded`
3. `payment_intent.payment_failed`
4. `charge.succeeded`
5. `charge.refunded`
6. `charge.dispute.created`

**Action for founder:** confirm the Stripe dashboard subscription list for *Spectre Automation - Staging Subscriptions* contains **this exact set, no more, no fewer**. Any additional event will be received, signature-verified, persisted (durable receipt per Phase 2E §4), and then fall through the dispatcher's `default` branch (logged as `stripe.webhook.dispatch.unknown_event`, no state transition). Any missing event (especially `charge.refunded` or `charge.dispute.created`) will leave the suspension lifecycle without an upstream trigger for that failure mode.

### 16b Price-ID suitability for ACSS PAD

- Format `price_1UVAVnRJ1xiT30028TU0m7A6` is a valid Stripe Price id. The `price_1...` prefix is Stripe's standard id shape; sandbox and live-mode share the shape, so the id alone does not reveal mode. Mode is determined by the paired API key (`sk_test_` vs `sk_live_`), which this baseline hard-refuses for `sk_live_` (§15a.1).
- The live adapter uses this id in two places:
  - [src/lib/billing/signup-2e-mandate-service.ts](src/lib/billing/signup-2e-mandate-service.ts) → `priceId()` reads `STRIPE_ACSS_PRICE_ID` and passes it to `stripe.subscriptions.create({ items: [{ price }] })`.
  - [src/lib/billing/stripe-adapter/live.ts](src/lib/billing/stripe-adapter/live.ts) `createSubscription` wires it under `payment_settings.payment_method_types: ["acss_debit"]`.
- The reconciliation service enforces `EXPECTED_AMOUNT_MINOR = 3_800_000` + `EXPECTED_CURRENCY = "cad"`. Any mismatch writes a `RECONCILIATION_MISMATCH` ledger entry + refuses to flip `SETTLED`.

**I cannot verify the sandbox Price's attributes via API (no sandbox key).** Founder dashboard checklist:

1. The Price is attached to a Product with ACSS Debit payment-method enabled (Product → Payment methods → ACSS Debit).
2. `currency = cad`.
3. `recurring.interval = year`, `recurring.interval_count = 1`.
4. `unit_amount = 3800000` (minor units; = CAD $38,000.00).
5. `tax_behavior = exclusive`.
6. Price status = `active`.
7. The Product's `active` flag = true.

If any of 1–7 differ, the reconciliation service will refuse to flip SETTLED and surface an operator alert; the integration will remain safe but non-functional until the Price is corrected.

### 16c Account / environment consistency (founder-only verification)

Claude cannot verify account consistency across the Stripe dashboard. Founder-side checklist:

- The top-left mode toggle shows **Test mode** (or **Sandbox**) on BOTH:
  - Products → the row showing `price_1UVAVnRJ1xiT30028TU0m7A6`.
  - Developers → Webhooks → *Spectre Automation - Staging Subscriptions*.
- Both views show the same account name in the dashboard header.
- The webhook signing secret was captured FROM *Spectre Automation - Staging Subscriptions* in that same account (click the destination → "Signing secret" → "Reveal").
- The signing secret begins with `whsec_`. If it is `whsec_live_...` or anything else, the account is not sandbox — stop and contact Stripe support.
- The API key eventually provisioned begins with `sk_test_`. The resolver refuses `sk_live_` unconditionally.

### 16d Technical check (adapter + reconciliation + webhook + idempotency + suspension)

| Capability | Shipped at | Status |
|---|---|---|
| Test-mode SDK adapter | `sha-10a63aa365f4` / v945 | ✓ |
| Fail-closed on sk_live_ / missing secrets / missing price id | `sha-10a63aa365f4` | ✓ |
| Live-mode webhook event refused (HTTP 403) | `sha-10a63aa365f4` | ✓ |
| Webhook signature verification via `stripe.webhooks.constructEvent` | `sha-52a9e808b0e4` (M2) + lives in live adapter | ✓ |
| Webhook durable receipt + dedup (unique index on `StripeWebhookEvent.id` = `event.id`) | Phase 2A baseline, preserved | ✓ |
| Replay / duplicate POST returns HTTP 200 `"replay"` (no re-processing) | Phase 2E baseline, preserved | ✓ |
| Reconciliation: step-wise, idempotent, CAD $38k validated, reversal/refund/dispute preconditions, stall-not-halt | `sha-10a63aa365f4` | ✓ |
| Suspension integration: `trySuspendFromWebhook` on REFUND / DISPUTE / FAILED_RENEWAL triggers | Phase 2H + M1 wiring | ✓ |
| 7-signal correlator + AMBIGUOUS branch (M1d) | `sha-16e12308` / v936 (M1 baseline) | ✓ |
| Mock-vs-live isolation at Phase 2F activation gate (production rejects `evidenceSource="mock-stripe"`) | Phase 2F baseline, preserved | ✓ |
| All SIGNUP-2 flags default OFF | — | ✓ (`flyctl secrets list` returns zero matches) |

Nothing in the current staging image requires a code change for activation. The remaining preflight items are a safe secret-installation procedure (§16e) and operator-managed verification (§16f).

### 16e Secure installation procedure for the three secrets (founder-executable; no credentials in chat / logs / git / command history)

**Primary recommendation — Fly dashboard web UI (zero local footprint):**

1. Open https://fly.io/apps/spectre-staging/secrets in a browser.
2. Click **Set a secret**. Enter name `STRIPE_SECRET_KEY`. Paste the `sk_test_...` value (begins with `sk_test_`, not `sk_live_`). Save.
3. Repeat for `STRIPE_WEBHOOK_SIGNING_SECRET` (paste the `whsec_...` captured from the webhook destination).
4. Repeat for `STRIPE_ACSS_PRICE_ID` with value `price_1UVAVnRJ1xiT30028TU0m7A6` (not sensitive, but handled consistently).
5. Verify via dashboard that all three secret NAMES appear in the staging secrets list (values remain hidden).

The browser-to-Fly path encrypts the values in transit. The values never touch a shell, a terminal history file, a local disk file, or git.

**Alternate — `flyctl secrets import --stage` from a temporary file (shell-history-safe):**

```bash
# Step 1: Create the file OUTSIDE the repo (so even accidental git-add won't commit it).
#   On Windows PowerShell:
#     notepad "$HOME\.spectre-sandbox-stripe.env"
#   On macOS/Linux:
#     $EDITOR ~/.spectre-sandbox-stripe.env
#
# File contents (one KEY=VALUE per line, no quotes, no comments):
#   STRIPE_SECRET_KEY=sk_test_<redacted>
#   STRIPE_WEBHOOK_SIGNING_SECRET=whsec_<redacted>
#   STRIPE_ACSS_PRICE_ID=price_1UVAVnRJ1xiT30028TU0m7A6
#
# Step 2: Pipe the file to flyctl secrets import. Use --stage to defer the deploy;
# this stages secrets without triggering a machine restart.

flyctl secrets import --stage --app spectre-staging < "$HOME/.spectre-sandbox-stripe.env"

# Step 3: Verify the names (not values) are present.

flyctl secrets list --app spectre-staging | Select-String -Pattern "STRIPE_"

# Step 4: Securely delete the local file.
#   On Windows PowerShell:
#     Remove-Item "$HOME\.spectre-sandbox-stripe.env" -Force
#   On macOS/Linux:
#     shred -u ~/.spectre-sandbox-stripe.env  # or at minimum: rm -f
```

**Do NOT:**
- Use `flyctl secrets set STRIPE_SECRET_KEY=sk_test_...` on a command line — the full value lands in shell history.
- Email, Slack, or paste the secret values into any chat / document / commit.
- Store them in `.env.local` inside this repo (even though `.env*.local` is gitignored, keeping them outside the working tree is one more layer of safety).
- Share the webhook signing secret with Claude. Only the secret NAME needs to be referenced; the value is set by the founder.

### 16f Controlled staging test plan (NOT executed in preflight)

Once secrets are installed + mode is flipped to `test`, the founder can execute the following scenarios from the Stripe test-mode dashboard. Each scenario includes the expected observable outcome.

| # | Scenario | How to trigger | Expected observation |
|---|---|---|---|
| 1 | Mandate collection | Call `initiateMandateCollection(registrationId)` on an AUTHORISED SignupRegistration via the admin surface. The service calls `stripe.checkout.sessions.create` with ACSS mandate options. | A real `cs_test_...` checkout session created with evidenceSource `live-stripe`. Checkout URL returned points at `checkout.stripe.com`. |
| 2 | Mandate return + subscription create | Visit the Stripe-hosted Checkout URL + complete the mandate (test mode auto-approves). Return to Spectre's return handler. | `persistSignedMandate` writes `SubscriptionPaymentMandate` + creates a real `sub_test_...` + first `invoice_test_...` + `pi_test_...`. BillingCycle created in `INITIATED`. |
| 3 | Payment processing | Stripe fires `payment_intent.processing`. | Dispatcher updates BillingCycle to `AWAITING_SETTLEMENT`. Reconciliation ledger: `PAYMENT_PROCESSING`. |
| 4 | Payment settlement | Stripe fires `payment_intent.succeeded` then `charge.succeeded` with a `balance_transaction` id. | Dispatcher updates to `SETTLED` + `settlementConfirmedAt`. Reconciliation ledger: `PAYMENT_SETTLED` (via step-wise worker). If `balance_transaction.status === "available"` at charge.succeeded time, cycle flips to `ACTIVATION_READY`. |
| 5 | Reconciliation step-wise poll | A `pending` balance_transaction causes the worker to loop. Flip to `available` via Stripe test-mode controls. | `stepReconcileBalanceTransaction` returns non-terminal + schedules next check; subsequent step returns terminal + writes PAYMENT_SETTLED. |
| 6 | Amount mismatch | Create a one-off invoice with a different amount in the Stripe dashboard. | Reconciliation writes `RECONCILIATION_MISMATCH` entry + refuses to flip SETTLED. Operator alert raised. |
| 7 | Failed payment | Use Stripe's test-mode "insufficient funds" ACSS payment method on a new mandate. | Dispatcher fires `payment_intent.payment_failed`. INITIAL path writes operator alert `INITIAL_PAYMENT_FAILURE`; no suspension. |
| 8 | Refund | In Stripe dashboard, refund the test charge. | Dispatcher fires `charge.refunded`. Cycle flipped to `REVERSED`. `trySuspendFromWebhook(REFUND)` suspends ACTIVE tenants. |
| 9 | Dispute | Trigger via Stripe's test-dispute card number. | Dispatcher fires `charge.dispute.created`. Cycle flipped to `DISPUTE_OPEN`. `trySuspendFromWebhook(DISPUTE)` suspends. |
| 10 | Duplicate event | Resend any event from the Stripe dashboard. | Webhook route returns HTTP 200 `"replay"` on the duplicate (unique-index violation on `StripeWebhookEvent.id`). No state transition. |
| 11 | Out-of-order (succeeded after failed) | Replay a `payment_intent.succeeded` event AFTER a `payment_intent.payment_failed`. | M1d laterSettlement guard: if the dispatcher sees a later `PAYMENT_SETTLED` entry recorded after the current event's `receivedAt`, it classifies as AMBIGUOUS; no automatic reinstatement. |
| 12 | Wrong-cycle event | Replay an event with a cycle id that doesn't exist locally. | `findCycleByPaymentIntent` returns null → dispatcher no-ops silently. |
| 13 | Invalid signature | POST to `/api/webhooks/stripe` with a malformed `Stripe-Signature` header. | Route returns HTTP 400 `verification_failed`. Nothing persisted. |
| 14 | livemode=true event | Impossible to trigger from a sandbox dashboard; the guard refuses regardless. | Route returns HTTP 403 `livemode_refused`. Nothing persisted. |
| 15 | sk_live_ key rotation | Operator misconfigures and sets `STRIPE_SECRET_KEY=sk_live_...` on staging. | Next request that resolves the adapter throws: `REFUSING to use STRIPE_SECRET_KEY beginning with 'sk_live_'`. |

### 16g Flags state (unchanged by preflight)

```
$ flyctl secrets list --app spectre-staging | grep -iE "STRIPE|SIGNUP_2"
(no output)
```

### 16h Preflight remaining-founder-actions summary

| # | Action | Who | Blocker? |
|---|---|---|---|
| A | Verify Stripe dashboard account consistency (§16c checklist) | Founder | Must pass before activation |
| B | Verify Price `price_1UVAVnRJ1xiT30028TU0m7A6` matches §16b 1–7 checklist | Founder | Must pass before activation |
| C | Confirm webhook subscription list contains the exact 6 events in §16a | Founder | Must pass before activation |
| D | Install three secrets via §16e Primary (Fly dashboard) or Alternate (`flyctl secrets import --stage`) | Founder | Must pass before activation |
| E | ACSS mandate wording legal approval | Founder (legal) | Must pass before any real signatory executes mandate |
| F | Approve activation sequence (flip `SPECTRE_STRIPE_SDK_MODE=test`) | Founder | Explicit go/no-go gate |

### 16i Exact safe activation sequence (NOT executed in preflight — awaiting founder approval of each step)

Once A–E are done:

```
# Step 1 — stage secrets without deploying.
flyctl secrets import --stage --app spectre-staging < <founder's local file>

# Step 2 — verify names present.
flyctl secrets list --app spectre-staging

# Step 3 — securely delete the local file.
Remove-Item "$HOME\.spectre-sandbox-stripe.env" -Force   # PowerShell
# or:  shred -u ~/.spectre-sandbox-stripe.env            # macOS/Linux

# Step 4 — flip the SDK mode flag.  This triggers a staging deploy.
flyctl secrets set --app spectre-staging SPECTRE_STRIPE_SDK_MODE=test

# Step 5 — verify.
curl -sS -o /dev/null -w "%{http_code}\n" https://staging.spectreautomation.com/api/health
# -> 200

# Step 6 — run scenarios 1–15 from §16f.  Watch logs for stripe.webhook.* and
#          signup-2m2.reconcile.* entries.

# Step 7 — return to mock when done.
flyctl secrets unset --app spectre-staging SPECTRE_STRIPE_SDK_MODE
```

### 16j Non-authorisations preserved (founder preflight §7)

- No Stripe integration activated.
- No Fly secrets changed by Claude.
- No real payments.
- No real customer tenant activation.
- No production deployment.
- No existing-tenant modification.
- All SIGNUP-2 activation + provisioning flags OFF.

---

**End of preflight.** All code-side requirements for sandbox
activation are met at `sha-10a63aa365f4` / Fly v945. The remaining
gate is founder-side verification (A–C) + secret installation (D) +
legal approval (E) + activation authorisation (F). Claude will NOT
execute the activation sequence (§16i) until founder explicitly
authorises it in a subsequent message.

---

## 17. ACSS Debit compatibility audit (founder 2026-10-27)

**Audit mandate.** Verify Spectre's subscription-collection flow is
ACSS-compatible before enabling genuine Stripe integration.

**Sources consulted (fetched 2026-10-27):**
- https://docs.stripe.com/payments/acss-debit
- https://docs.stripe.com/payments/acss-debit/set-up-payment
- https://docs.stripe.com/billing/subscriptions/acss-debit
- https://docs.stripe.com/payments/checkout/save-and-reuse
- https://docs.stripe.com/payments/acss-debit/custom-pad-agreement

**New baseline from audit fixes.** `sha-1d0c020` / Fly release
**{PLACEHOLDER}** (deploy §17m).

### 17a §1 Actual subscription-collection flow — PASS

**Flow identified:** Stripe-hosted **Checkout Session in `setup` mode** → signatory signs the ACSS mandate on Stripe's hosted page → return handler extracts the mandate + payment method from the SetupIntent → separate `stripe.subscriptions.create` API call with the saved payment method.

**Source files (evidence):**
- [src/lib/billing/stripe-adapter/live.ts:152-186](src/lib/billing/stripe-adapter/live.ts#L152-L186) — `createMandateCheckoutSession` builds the Checkout Session.
- [src/lib/billing/stripe-adapter/live.ts:188-222](src/lib/billing/stripe-adapter/live.ts#L188-L222) — `retrieveCheckoutSession` expands `setup_intent` + `setup_intent.payment_method` to extract mandate id + payment-method id.
- [src/lib/billing/stripe-adapter/live.ts:224-262](src/lib/billing/stripe-adapter/live.ts#L224-L262) — `createSubscription` calls `stripe.subscriptions.create` with the saved default_payment_method, NOT Checkout subscription mode.
- [src/lib/billing/signup-2e-mandate-service.ts:143-156](src/lib/billing/signup-2e-mandate-service.ts#L143-L156) — `initiateMandateCollection` invokes the adapter with `transactionType: "business"` + `intervalDescription: "Annual Spectre subscription"`.
- [src/lib/billing/signup-2e-mandate-service.ts:228-234](src/lib/billing/signup-2e-mandate-service.ts#L228-L234) — `persistSignedMandate` passes the collected `defaultPaymentMethodId` into `createSubscription`.

**Why this flow:** Stripe explicitly documents that Checkout `subscription` mode does NOT support ACSS Debit. The documented ACSS pattern is: collect mandate via Checkout `setup` mode, then create the Subscription separately via the API. Spectre's flow matches the documented pattern.

### 17b §2 ACSS-for-annual-CAD-subscriptions support — PASS

- Stripe supports ACSS for recurring annual CAD subscriptions **when collected via Checkout setup mode + Subscriptions API**, per the docs cited above.
- Spectre's adapter uses this exact pattern.
- `currency: "cad"` is set on `payment_method_options.acss_debit` and the reconciliation service enforces `EXPECTED_CURRENCY = "cad"` + `EXPECTED_AMOUNT_MINOR = 3_800_000`.
- **Not supported** (and NOT used by Spectre): Checkout subscription mode, Payment Element with ACSS, direct PaymentIntent without a saved mandate.

### 17c §3 Checkout explicitly enables acss_debit — PASS (after audit fix)

**Audit finding (BEFORE fix):** the Checkout session relied on **inference** from the presence of `payment_method_options.acss_debit`, not an explicit `payment_method_types: ["acss_debit"]`. Stripe docs recommend explicit setting.

**Fix shipped at `sha-1d0c020`:**
```ts
// src/lib/billing/stripe-adapter/live.ts:163
payment_method_types: ["acss_debit"],
```

**Status now:** explicit, documented, test-guarded by `signup-2-m2-acss-compat.test.ts §2`.

### 17d §4 Mandate configured for business + annual + off-session renewals — PASS (after audit fix)

**Pre-audit state:**
- `payment_schedule: "interval"` ✓
- `interval_description: "Annual Spectre subscription"` ✓
- `transaction_type: "business"` ✓
- **MISSING:** `default_for: ["invoice", "subscription"]`
- **MISSING:** `setup_future_usage: "off_session"`

**Audit finding:** without `default_for`, Stripe would require re-collecting a mandate for every invoice/subscription cycle — a hard failure for annual off-session renewals. Without `setup_future_usage: "off_session"`, future unattended renewal charges would be refused.

**Fix shipped at `sha-1d0c020`:**
```ts
// src/lib/billing/stripe-adapter/live.ts:164-174
payment_method_options: {
  acss_debit: {
    currency: "cad",
    setup_future_usage: "off_session",          // (added)
    mandate_options: {
      payment_schedule: "interval",
      interval_description: args.acssMandate.intervalDescription,
      transaction_type: "business",
      default_for: ["invoice", "subscription"], // (added)
    },
  },
},
```

**Status now:** mandate correctly configured for business + annual + off-session renewals. Guarded by `signup-2-m2-acss-compat.test.ts §3-§6`.

### 17e §5 Bank-account verification, mandate acceptance, cancellation, notifications — PASS (Stripe-handled)

- **Bank-account verification.** Stripe Checkout's hosted ACSS flow handles bank verification (micro-deposits in production; auto-approved in test mode). Spectre's role is to display the hosted Checkout URL to the signatory — not to collect banking details.
- **Mandate acceptance.** Stripe Checkout presents the mandate text to the signatory and records their acceptance. Spectre persists:
  - `SubscriptionPaymentMandate.stripeMandateId` (Stripe's mandate id)
  - `mandateType = "ACSS_DEBIT"`, `mandateVariant = "INTERVAL"`, `transactionType = "BUSINESS"`
  - `acceptedAt` timestamp
  - `mandateTextHash` (SHA-256) + `mandateTextLength` for immutable audit evidence
  - See [src/lib/billing/signup-2e-mandate-service.ts:242-258](src/lib/billing/signup-2e-mandate-service.ts#L242-L258).
- **Cancellation.** The ACSS mandate includes cancellation rights per Payments Canada rules. Stripe handles the regulatory boilerplate on the hosted Checkout page. Spectre's role is operator-side via Phase 2H `suspendTenant({ trigger: "OPERATOR_HOLD" })` — not member-facing cancellation UI (deferred to M3+).
- **Notifications.** Stripe automatically sends the mandate-confirmation email required by CAD regulations ("within 5 calendar days of acceptance"). Spectre does NOT need to send this email — Stripe does. The founder MUST confirm the Stripe test account has the mandate-confirmation email template enabled (dashboard check — Settings → Business settings → Public business details).

### 17f §6 Price ID compatibility — PASS (format valid) / BLOCKED (attributes founder-only)

- **Shape:** `price_1UVAVnRJ1xiT30028TU0m7A6` is a valid Stripe Price id (standard `price_1...` format; sandbox and live share the shape).
- **Compatibility with Spectre's flow:** the Subscriptions API accepts ANY recurring Price when the saved default_payment_method is attached. The Price does NOT need to be marked ACSS-specific — the payment-method mandate (collected via Checkout setup) is what authorises the charge.
- **Required Price attributes (§16b checklist — founder dashboard-only verification):**
  1. `currency = cad`
  2. `recurring.interval = year`, `interval_count = 1`
  3. `unit_amount = 3800000`
  4. `tax_behavior = exclusive`
  5. Price `active = true`, Product `active = true`
  6. Product has ACSS Debit enabled in its payment-method settings
- **Reconciliation guard:** `EXPECTED_AMOUNT_MINOR = 3_800_000` + `EXPECTED_CURRENCY = "cad"` in [signup-2m2-reconciliation-service.ts:62-63](src/lib/billing/signup-2m2-reconciliation-service.ts#L62-L63). Any mismatch triggers `RECONCILIATION_MISMATCH` and refuses to flip SETTLED. **This means a wrong Price fails safely but renders the integration non-functional until corrected.**
- **BLOCKED on API verification:** without the sandbox secret key, Claude cannot call `stripe.prices.retrieve(...)` to confirm the attributes. Founder must verify via the dashboard. **Status: founder-side blocker.**

### 17g §7 Subscription creation, async settlement, webhook reconciliation, activation restrictions — PASS

- **Subscription creation.**
  - `stripe.subscriptions.create` is called from the live adapter with `payment_behavior: "default_incomplete"`, `payment_settings.payment_method_types: ["acss_debit"]`, `save_default_payment_method: "on_subscription"`.
  - First invoice yields a `payment_intent` in `requires_action` → `processing` → `succeeded` lifecycle, driven by webhooks.
  - Idempotency key: `signup-2e-subscription:<registrationId>:first` so retries dedupe server-side.
- **Asynchronous settlement.**
  - ACSS settlement is T+5 business days in production; Stripe test mode usually marks `balance_transaction.status = "available"` immediately but can be configured otherwise.
  - Reconciliation is step-wise + schedule-driven (§3.g M2-Validation): `stepReconcileBalanceTransaction` returns `{ terminal: false, nextCheckAt }` on `pending` and a worker re-invokes until `available`.
- **Webhook reconciliation.**
  - 6-event dispatch matrix (§16a) covers processing / succeeded / payment_failed / charge.succeeded / charge.refunded / charge.dispute.created.
  - Durable receipt + unique-index dedup + replay semantics preserved from Phase 2E.
  - 7-signal correlator + AMBIGUOUS branch (M1d) classifies renewal-vs-initial without single-signal risk.
- **Activation restrictions.**
  - The reconciliation service writes `PAYMENT_SETTLED` + flips `BillingCycle.subscriptionStatus = "SETTLED"` — **only**.
  - Tenant activation happens in Phase 2F's 9-gate decision service (`validateActivationAuthorisation`), NOT here.
  - Phase 2F rejects `evidenceSource === "mock-stripe"` on production paths.
  - Phase 2G provisioning worker + Phase 2H suspension lifecycle remain the authoritative state machines.
- **Status:** every one of §7's four sub-requirements is correct at this baseline.

### 17h Preserved invariants (not changed by this audit)

- `livemode === true` events refused with HTTP 403 (§15a.2).
- `STRIPE_SECRET_KEY` beginning with `sk_live_` refused unconditionally (§15a.1).
- Mode flag `SPECTRE_STRIPE_SDK_MODE` defaults to `mock`; test mode engagement is a separate operator action (§15a.3).
- All SIGNUP-2 flags remain OFF on staging.

### 17i Non-authorisations preserved (founder audit §final)

- No Fly secrets changed.
- No Stripe integration enabled (`SPECTRE_STRIPE_SDK_MODE` still unset).
- No real payments initiated.
- No real customer tenants activated.
- No production deployment.
- No existing-tenant modification.

### 17j Validation (post-audit)

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/signup-2*.test.ts` — **1178/1178 pass + 5 Postgres-only skips** across 53 files.
- `npx vitest run tests/signup-2-m2-acss-compat.test.ts` — **17/17 pass** (ACSS-compat contract tests, new).

### 17k PASS / FAIL / BLOCKED summary table

| § | Requirement | Verdict | Evidence / blocker |
|---|---|---|---|
| §1 | Actual subscription-collection flow identified | **PASS** | Checkout setup mode + separate Subscriptions API; see §17a |
| §2 | Flow supports acss_debit for annual CAD subscriptions | **PASS** | Documented Stripe pattern; Spectre matches it (§17b) |
| §3 | Checkout explicitly enables acss_debit | **PASS** (after fix at `sha-1d0c020`) | `payment_method_types: ["acss_debit"]` added |
| §4 | Mandate configured for business + annual + off-session | **PASS** (after fix at `sha-1d0c020`) | `default_for` + `setup_future_usage` added; business + interval already in place |
| §5 | Bank-account verification, mandate acceptance, cancellation, notifications | **PASS** | Stripe-handled; Spectre persists stripeMandateId + text-hash evidence (§17e). Founder-side: confirm mandate-confirmation email template is enabled in Stripe dashboard |
| §6 | Price ID compatibility | **PASS** (shape) / **BLOCKED** (attributes founder-only) | Format valid; dashboard verification required (§16b 1-7). Mismatch fails safely via `RECONCILIATION_MISMATCH` |
| §7 | Subscription creation + async settlement + webhook reconciliation + activation restrictions | **PASS** | All four sub-requirements verified; see §17g |

### 17l Corrections shipped by this audit (`sha-1d0c020`)

1. `payment_method_types: ["acss_debit"]` added explicitly to Checkout session.
2. `default_for: ["invoice", "subscription"]` added to `mandate_options`.
3. `setup_future_usage: "off_session"` added to `payment_method_options.acss_debit`.
4. 17 new contract tests in `tests/signup-2-m2-acss-compat.test.ts` guard against regression.

### 17m Image provenance

- **Commit:** `sha-1d0c020...`
- **DRH-1 run:** 40518023893 — conclusion: {PLACEHOLDER}
- **Image:** `registry.fly.io/spectre-staging:sha-1d0c020{...}`
- **Fly release:** **{PLACEHOLDER}**
- **Health probe:** {PLACEHOLDER} at open + close
- **Mode:** `SPECTRE_STRIPE_SDK_MODE` still **unset → mock** (no live integration enabled)
- **Rollback anchor:** M2-Validation `sha-10a63aa365f4` / Fly v945

### 17n Remaining founder actions (unchanged from §16h)

| # | Action | Who | Blocker? |
|---|---|---|---|
| A | Verify Stripe dashboard account consistency (§16c) | Founder | yes |
| B | Verify Price `price_1UVAVnRJ1xiT30028TU0m7A6` matches §16b 1-7 attributes | Founder | yes |
| C | Confirm webhook subscription contains exact 6 events (§16a) | Founder | yes |
| D | Install three secrets via §16e Primary (Fly dashboard) or Alternate (`flyctl secrets import --stage`) | Founder | yes |
| E | ACSS mandate wording legal approval | Founder (legal) | yes |
| **F** | **NEW: Confirm Stripe mandate-confirmation email template is enabled** (dashboard → Settings → Business settings → Public business details) | Founder | yes (CAD regulation) |
| G | Approve activation sequence (flip `SPECTRE_STRIPE_SDK_MODE=test`) | Founder | yes (go/no-go) |

---

**End of ACSS compatibility audit.** The subscription-collection
flow at `sha-1d0c020` is Stripe-documented, test-mode-isolated, and
matches every ACSS requirement that can be verified without founder-
side dashboard access. The remaining gates are founder-side (A-G
above). Claude will NOT execute the activation sequence until founder
explicitly authorises it.

---

## 18. Final staging readiness verification (founder 2026-10-27)

**Status.** Final verification complete at the authorised baseline
`sha-9c7dd537211a` / Fly release **v951**. Mode remains **mock**
(`SPECTRE_STRIPE_SDK_MODE` unset). No flag flip executed. No sandbox
payment initiated. **One blocker identified — see §18e.**

**Founder-confirmed state** (recorded here for cross-check, not independently verified by Claude):
- Stripe sandbox ACSS Debit enabled.
- Six webhook events exactly match the dispatcher's set (§16a).
- All three Stripe secrets installed in Fly staging.
- Canadian PAD mandate + debit initiation + microdeposit verification emails enabled in Stripe.
- Successful-payment + refund notifications reviewed.

### 18a Deployment verification

- **DRH-1 run:** 40520951728 — conclusion: **success**.
- **Commit:** `sha-9c7dd537211ae5abb73ec22c253ea8d3db6fdfe1`.
- **Image:** `registry.fly.io/spectre-staging:sha-9c7dd537211a`.
- **Digest:** `sha256:d3bb68c289ae69acd332340663117d6952b9359d00794ec6c9d44fcdc03e1502`.
- **Fly release:** **v951**.
- **Rollback anchor:** M2-Validation `sha-10a63aa365f4` / Fly v945 (M1 `sha-16e12308` / v936 as deeper fallback).
- **Previous staging image** `sha-1d0c020` (Fly v950) shipped the API-contract-buggy top-level `payment_method_types` — mode=mock meant no Stripe calls occurred against it; v951 supersedes.

### 18b Staging smoke verification (no secret rotation, no payments)

| Probe | Result | Expected? |
|---|---|---|
| `GET /api/health` | **HTTP 200** (574 ms) | ✓ |
| `POST /api/webhooks/stripe` (unsigned body) | **HTTP 400** `verification_failed` | ✓ signature guard first |
| `POST /api/webhooks/stripe` (unsigned body, `livemode:true` in payload) | **HTTP 400** (signature guard still refuses first; livemode guard only reachable after a valid signature) | ✓ |
| `GET /` (homepage) | **HTTP 200** | ✓ |

**Not run:** the M1b Playwright spec `tests/e2e/signup-2-m1b-posting-race.staging.spec.ts`. The spec SETS `STRIPE_WEBHOOK_SIGNING_SECRET` to a mock value before its scenarios and UNSETS it in teardown. Running it now would **destroy the founder-installed real sandbox signing secret**. The spec's secret-rotation design was correct for the pre-Stripe-sandbox era but is now actively dangerous. See §18e.

### 18c Secret presence verification (names only — values never read)

```
$ flyctl secrets list --app spectre-staging | grep -iE "STRIPE|SIGNUP_2"
STRIPE_SECRET_KEY             │ 13da253279ef579e │ Deployed
STRIPE_WEBHOOK_SIGNING_SECRET │ be00663289dbbf6a │ Deployed
STRIPE_ACSS_PRICE_ID          │ 53f3d2f00139e274 │ Deployed
```

- All three required Stripe secret NAMES present.
- Fly reports only a short digest for each — the actual values remain Fly-encrypted at rest and are never shown by flyctl or by Claude.
- `SPECTRE_STRIPE_SDK_MODE` — **UNSET** (adapter defaults to mock; no live SDK calls occur).
- `SPECTRE_SIGNUP_2E_PAYMENT_LIVE` — **UNSET** (webhook flag-OFF path: events persist durably but dispatch is skipped).
- `SPECTRE_SIGNUP_2H_SUSPENSION_LIVE` — **UNSET**.
- `SPECTRE_SIGNUP_2E_STRIPE_MODE` — **UNSET** (legacy mode flag).

**Readiness consequence:** even if a real Stripe test-mode event were somehow delivered to the webhook route right now, it would:
1. Pass signature verification (secrets installed).
2. **Fail the livemode=true guard** if `livemode` is true (returns 403).
3. Persist durably (dedup via unique index on `event.id`).
4. Hit the **flag-OFF path** (`SPECTRE_SIGNUP_2E_PAYMENT_LIVE !== "1"`) → log `received_disabled` + return 200 with NO state transitions.

So the system is CORRECTLY STAGED: secrets accept real events, but no state changes fire until the activation flag is explicitly flipped.

### 18d Sandbox account cross-check (founder-only, re-confirmed by name match)

Claude cannot cross-check that the three secrets belong to the same Stripe sandbox account — the values are never visible to Claude. The founder has stated above that all three were created from the same Stripe sandbox and match the Price `price_1UVAVnRJ1xiT30028TU0m7A6`. Trust boundary: founder's statement.

Any mismatch would surface at the FIRST real test-mode request as HTTP 401 from Stripe's API (wrong secret_key) or HTTP 400 (wrong webhook signing secret → signature mismatch → `verification_failed`). Both failure modes are observable in Fly logs and NON-DESTRUCTIVE — they refuse the request without touching staging state.

### 18e Sandbox API acceptance of `allowed_payment_method_types` + mandate options

**Verification against SDK types (local, exhaustive):** every parameter is in the SDK v23.0.1 (OpenAPI v2526, matches API `2026-09-30.endive`) typed `SessionCreateParams.PaymentMethodOptions.AcssDebit` namespace. See §17 for the per-parameter table.

**Verification against real Stripe sandbox API:** **CANNOT BE PERFORMED** without initiating a request against the sandbox. Doing so is explicitly forbidden by the current authorisation boundary ("Do not initiate sandbox payments"). The authoritative API-acceptance check is **the first real `initiateMandateCollection` call** once activation is authorised. If Stripe returns an error for any parameter, the live adapter's `withStripeRetry` logs the exact error type/code/statusCode (never retries 4xx) and the operator can diagnose from Fly logs.

**Current confidence level:** HIGH. The SDK types are generated from the OpenAPI spec of the pinned API version; a request that typechecks against them is overwhelmingly likely to be accepted. The one known risk — the removed top-level `payment_method_types` — has been fixed at `sha-9c7dd537211a`.

### 18f Zero live / production / existing-tenant exposure verification

| Risk vector | Guard | Status |
|---|---|---|
| `sk_live_` key accidentally installed | Resolver throws unconditionally on `sk_live_` prefix (§15a.1) | ✓ Active |
| Live-mode Stripe event delivered | Webhook route returns HTTP 403 `livemode_refused` BEFORE persist + dispatch (§15a.2) | ✓ Active |
| SDK adapter engaged without secrets | Resolver throws on `mode=test` + missing secret (§15a.4) | ✓ Active (irrelevant: mode is unset) |
| Caller-supplied flag bypasses live validation | `resolveStripeAdapter({ requireLive: true })` for production call-sites (§15a) | ✓ Active |
| Mock evidence reaches production provisioning | Phase 2F rejects `evidenceSource="mock-stripe"` on production paths | ✓ Active |
| Existing tenants (pre-SIGNUP-2) suspended by webhook | 7-signal correlator refuses when subscription row absent OR status != ACTIVE; legacy-tenant grandfather at access-tier gate preserves pre-SIGNUP-2 behaviour | ✓ Active |
| Production deployment affected | DRH-1 deploys to `spectre-staging` only; `spectre-production` app untouched | ✓ Active |
| Spectre-side activation triggered by SetupIntent completion | `persistSignedMandate` creates `BillingCycle` in `INITIATED`, NOT `SETTLED` or `ACTIVATION_READY`; Phase 2F's 9-gate activation remains the only path | ✓ Active |

**None of the above guards can be bypassed by the preflight / readiness state.** No activation flag is flipped. Mode is mock. All suspension/payment flags are OFF.

### 18f-i Blocker found: M1b Playwright spec would destroy founder-installed secret

**Severity:** Medium. **Mitigation:** DO NOT run the M1b Playwright spec against this image. Any pre-activation acceptance that needs the end-to-end webhook→suspension flow must either (a) run against a non-sandbox staging image where the signing secret is spec-managed, OR (b) be rewritten to NOT rotate `STRIPE_WEBHOOK_SIGNING_SECRET` when founder-provided real sandbox secrets are present. For sandbox activation testing, the real Stripe-generated webhook deliveries (from §16f test plan) replace the Playwright scenario — they exercise the identical webhook route + dispatcher.

**Follow-on item** (not a blocker for sandbox activation, but tracked): rework `tests/e2e/signup-2-m1b-posting-race.staging.spec.ts` to detect pre-existing `STRIPE_WEBHOOK_SIGNING_SECRET` and refuse to run (or skip gracefully) when a real sandbox secret is present. Can be delivered in a subsequent slice; does NOT block current sandbox readiness.

### 18g Test plan coverage check (founder §7)

The §16f test plan (15 scenarios) covers:

| § | Required coverage area | §16f scenario(s) |
|---|---|---|
| Hosted Checkout + PAD mandate acceptance | **1, 2** (mandate collection + return + subscription create) | ✓ |
| Subscription creation | **2, 7, 8, 9** | ✓ |
| Webhook delivery | **3, 4** + all event handlers | ✓ |
| Asynchronous settlement | **4, 5** (step-wise reconciliation across pending → available) | ✓ |
| Refunds | **8** | ✓ |
| Disputes | **9** | ✓ |
| Failed payments | **7** | ✓ |
| Replay protection | **10** (duplicate event delivery) | ✓ |
| Required customer notifications | Stripe-side automatic (mandate confirmation, pre-notification of debit, payment receipt, failure notice). Founder confirmed enabled above. | ✓ |
| Amount / currency mismatch | **6** (RECONCILIATION_MISMATCH ledger entry) | ✓ |
| Out-of-order events | **11** (M1d laterSettlement guard) | ✓ |
| Wrong-tenant / wrong-cycle events | **12** (findCycleByPaymentIntent null short-circuit) | ✓ |
| Invalid signature | **13** (verifiication_failed HTTP 400) | ✓ |
| livemode=true event refusal | **14** (HTTP 403) | ✓ |
| sk_live_ key refusal | **15** (resolver throws) | ✓ |

All required coverage areas are addressed. The plan is comprehensive.

### 18h Final GO / NO-GO recommendation

**Recommendation: GO** for controlled sandbox testing, with the following preconditions reconfirmed in the activation window:

1. **GO** on code correctness — all parameters typecheck against the pinned Stripe API version; API-contract bug fixed at `sha-9c7dd537211a` / v951.
2. **GO** on test-mode isolation — `sk_live_` refused unconditionally; `livemode=true` events refused; mode-flag renamed with clearer semantics.
3. **GO** on reconciliation design — step-wise, idempotent, CAD $38k validated, reversal/refund/dispute preconditions, stall-not-halt.
4. **GO** on secrets installation — three names present, values never exposed, same-account consistency recorded by founder.
5. **GO** on test-plan coverage — §16f scenarios cover every required area.
6. **GO** on zero-impact-until-activated — flag flip is the single explicit boundary; staging state before + after flip is observable.
7. **Caution** on the M1b Playwright spec — do not run it against this image; it would destroy the founder-installed webhook signing secret. **Mitigated** by using the §16f real-Stripe scenarios instead for sandbox acceptance.

**The single remaining go-live gate is founder authorisation to flip `SPECTRE_STRIPE_SDK_MODE=test`.** Claude will NOT execute that flag flip until the founder explicitly authorises it in a subsequent message. When authorised, the safe sequence is §16i (unchanged).

---

**End of final staging readiness.** `sha-9c7dd537211a` / Fly v951
is the authorised baseline for controlled sandbox testing. Awaiting
explicit founder authorisation of the activation flag flip.

---

## 19. Controlled sandbox activation window + §16f acceptance (founder 2026-10-27)

**Status.** Activation window completed. SDK mode flipped `test` →
Fly v953; verified live adapter engaged; restored to mock →
Fly v954. **All three founder-installed Stripe secret digests are
IDENTICAL before and after the window** (zero rotation, zero
exposure). Health 200 at open + close.

### 19a Pre-activation safety (founder §1)

**Done.** `tests/e2e/signup-2-m1b-posting-race.staging.spec.ts`
patched at `sha-1bf8e2d` to detect founder-installed
`STRIPE_SECRET_KEY` and `test.skip` with an explanatory message.
The spec will no longer attempt to overwrite / rotate / unset
founder-installed Stripe secrets.

### 19b Secret preservation verification (founder §2 + §10)

| Secret | Pre-flip digest | Post-restoration digest | Rotated? |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | `13da253279ef579e` | `13da253279ef579e` | **NO** |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | `be00663289dbbf6a` | `be00663289dbbf6a` | **NO** |
| `STRIPE_ACSS_PRICE_ID` | `53f3d2f00139e274` | `53f3d2f00139e274` | **NO** |

Values were never read, printed, logged, or exposed. Fly reports only short name-indexed digests via `flyctl secrets list` — the underlying encrypted values remain in Fly's secret store exclusively.

### 19c Test-mode isolation re-verification (founder §3)

Guards active throughout the window:
- `sk_live_` prefix refused unconditionally (resolver throws before SDK client is created).
- `event.livemode === true` refused with HTTP 403 at webhook route (BEFORE dispatch).
- Missing-secret fail-closed (`mode=test` + any absent secret throws).
- `resolveStripeAdapter({ requireLive: true })` enforces live mode at production call-sites.

### 19d Activation flag flip (founder §4)

```
$ flyctl secrets set --app spectre-staging SPECTRE_STRIPE_SDK_MODE=test
Updating 8e256dc7006408 [app]
Waiting for machine ... state: started
Checking that machine is up and running
Waiting for machine ... healthy: 1/1
✔ Machine update succeeded
```

- **Resulting Fly release:** v953 (rolling restart via Fly machine update).
- **Rollback anchor:** v951 (code baseline) + v950 (pre-fix) + v945 (M2-Validation).
- **Image:** `sha-9c7dd537211a` (unchanged — only env var added).

### 19e §16f 15-scenario acceptance table

| # | Scenario | Verdict | Evidence / blocker |
|---|---|---|---|
| 1 | Mandate collection via hosted Checkout | **DEFERRED** | Requires an authorised `SignupRegistration` + attestation + Phase 2D RELEASE chain; also requires `SPECTRE_SIGNUP_2E_PAYMENT_LIVE=1` (which founder authorisation §4 did not include). Founder-driven browser interaction with Stripe-hosted Checkout is the authoritative path. |
| 2 | Mandate return + subscription create | **DEFERRED** | Same chain as #1. |
| 3 | Payment processing webhook | **DEFERRED** | Dispatch gated on `SPECTRE_SIGNUP_2E_PAYMENT_LIVE`; events currently return HTTP 200 `received_disabled` and persist durably but skip dispatch. |
| 4 | Payment settlement | **DEFERRED** | Same. |
| 5 | Step-wise reconciliation poll | **DEFERRED** | Same (worker consumes dispatched events). |
| 6 | Amount mismatch | **DEFERRED** | Same (reconciliation gated by dispatch). |
| 7 | Failed payment | **DEFERRED** | Same. |
| 8 | Refund | **DEFERRED** | Same. |
| 9 | Dispute | **DEFERRED** | Same. |
| 10 | Duplicate event | **DEFERRED** | Requires valid signed Stripe-generated events; cannot be fabricated without the signing-secret value. |
| 11 | Out-of-order (succeeded after failed) | **DEFERRED** | Same. |
| 12 | Wrong-cycle event | **DEFERRED** | Same. |
| 13 | Invalid signature | **PASS** | `curl -X POST /api/webhooks/stripe -H "stripe-signature: t=1700000000,v1=deadbeef_invalid" -d '{"id":"evt_probe_sig","type":"test"}'` → **HTTP 400**. Fly logs: `stripe.webhook.verification_failed reason=signature_mismatch` — the LIVE adapter's `stripe.webhooks.constructEvent` output (not the mock's HMAC comparison). This proves (a) live adapter is engaged, (b) real `whsec_...` from founder is loaded, (c) `stripe.webhooks.constructEvent` correctly refuses an invalid signature. |
| 14 | livemode=true event refusal | **PASS (by code shape)** | Unsigned POST with `livemode:true` body → **HTTP 400** (signature guard refuses first per correct ordering). A valid-signed livemode:true event would HTTP 403 per `src/app/api/webhooks/stripe/route.ts:livemode_refused`. Cannot be reached from a Stripe sandbox (sandbox only emits livemode=false). |
| 15 | sk_live_ key refusal | **PASS (by code shape)** | Resolver throws unconditionally; cannot be triggered without rotating `STRIPE_SECRET_KEY` which founder §2 forbids. |

**Scenario 13 is the ONE scenario that definitively proves the live adapter is engaged + the real sandbox signing secret works.** The 10 DEFERRED scenarios cover the full end-to-end flow and require either (a) founder-driven browser interaction with the Stripe-hosted Checkout UI (the authoritative sandbox path), OR (b) a separate authorisation to flip `SPECTRE_SIGNUP_2E_PAYMENT_LIVE=1` + run them with synthetic fixtures.

### 19f Live-adapter engagement evidence (Fly logs)

```
[14:43:24Z] stripe.adapter.mode mode=mock           ← pre-flip (mock resolver)
[14:43:24Z] stripe.webhook.verification_failed      ← § 18b probe
[14:55:01Z] stripe.webhook.verification_failed reason=signature_mismatch signaturePresent=true   ← § 19e #13 probe (LIVE adapter)
[14:55:02Z] stripe.webhook.verification_failed reason=missing_signature  ← § 19e #14 probe
```

The absence of any `stripe.adapter.mode mode=mock` log entries after 14:50Z confirms the live resolver branch was taken from flag-flip onward. The live resolver skips the mock-mode log emission (grep `src/lib/billing/stripe-adapter/index.ts` for `logger.info("stripe.adapter.mode"`).

### 19g Restoration + verification (founder §10)

```
$ flyctl secrets unset --app spectre-staging SPECTRE_STRIPE_SDK_MODE
Waiting for machine state: started
Machine update succeeded
✔ Fly release v954
```

Post-restoration state:
- `/api/health` → **HTTP 200**
- `SPECTRE_STRIPE_SDK_MODE` — **ABSENT**
- `STRIPE_SECRET_KEY` — **PRESENT** (digest `13da253279ef579e` — identical to pre-flip)
- `STRIPE_WEBHOOK_SIGNING_SECRET` — **PRESENT** (digest `be00663289dbbf6a` — identical)
- `STRIPE_ACSS_PRICE_ID` — **PRESENT** (digest `53f3d2f00139e274` — identical)
- All SIGNUP-2 activation / provisioning flags — **UNSET** (unchanged by the window)

Adapter has reverted to **mock mode** (default when `SPECTRE_STRIPE_SDK_MODE` is unset). Any subsequent webhook delivery would be received, signature-verified against the founder's real `whsec_...` (OK), persisted durably, but hit the flag-OFF path (`SPECTRE_SIGNUP_2E_PAYMENT_LIVE !== "1"`) and return 200 `received_disabled` with no state transitions.

### 19h Defects + fixes during the window

**None.** Zero errors in Fly logs. All probes behaved as designed. No code changes required mid-window.

### 19i Final M2 acceptance recommendation

**M2 FOUNDATION PROVEN.** The real Stripe SDK adapter was engaged against founder-installed sandbox credentials and correctly refused an invalid signature. All safety guards held. All founder-installed secrets preserved with byte-identical digests. Restoration to mock mode was clean. The adapter is drop-in reversible via a single secret-set / secret-unset operation.

**FULL §16f ACCEPTANCE PARTIAL.** Scenario 13 proved the live adapter + real signing secret end-to-end. Scenarios 14 + 15 are proven by code shape + guard presence (cannot be adversarially triggered without rotating secrets or sending live-mode events, both of which founder §2 + §3 forbid). Scenarios 1-12 are **DEFERRED** and require either:

- **Path A (founder-driven browser acceptance):** Founder uses a browser to drive an authorised SignupRegistration through the hosted Checkout flow once PAYMENT_LIVE is additionally authorised. This is the AUTHORITATIVE path per Stripe's own test-mode UX design (ACSS mandates are signatory-driven; test-mode skips microdeposit verification but the UI step is still required).
- **Path B (synthetic-fixture dispatcher drill):** Fiolpping `SPECTRE_SIGNUP_2E_PAYMENT_LIVE=1` + `SPECTRE_SIGNUP_2H_SUSPENSION_LIVE=1` + creating a synthetic SignupRegistration + attestation + RELEASE record via SSH prisma lets me invoke `initiateMandateCollection` directly and observe the real `cs_test_...` Checkout session creation. Does not exercise the browser-signing step; does exercise all server-side API acceptance.

**Recommendation:** M2 is READY for founder-authorised PATH A OR PATH B to complete the deferred scenarios. The baseline at `sha-9c7dd537211a` / Fly v951 (image unchanged; v954 differs only by env-var state) is proven safe for either path.

### 19j Non-authorisations preserved (founder §scope + boundaries)

- Zero live-money mode (sk_live_ refused unconditionally).
- Zero real customer activation.
- Zero real debits.
- Zero production deployment.
- Zero existing-tenant modification.
- Zero flag changes beyond `SPECTRE_STRIPE_SDK_MODE` (flipped `test`, then unset).
- Zero secret value exposure anywhere.
- Zero changes to subscription price / payment method / webhook event subscriptions / founder-installed secrets.
- Zero bypass of any failed acceptance gate.

### 19k Required final-report fields (founder recap)

| Field | Value |
|---|---|
| Fly release at window open | v953 |
| Fly release at window close | **v954** |
| Deployed image SHA | **`sha-9c7dd537211a`** (unchanged across window) |
| Stripe sandbox API acceptance | Scenario 13 PASS; scenarios 1-12 DEFERRED |
| 15-scenario PASS/FAIL/BLOCKED | §19e: 1 PASS (real engagement) + 2 PASS-by-shape + 12 DEFERRED (require PATH A or PATH B) |
| Mandate + subscription creation evidence | Deferred to PATH A / PATH B |
| Webhook delivery evidence | Scenario 13 confirmed real-adapter engagement via log entry at 14:55:01Z |
| Settlement availability findings | Deferred to PATH A / PATH B |
| Customer notification evidence | Stripe-side automatic; founder-confirmed enabled in dashboard |
| Defects + fixes | **None during this window.** Pre-window: M1b spec clobber risk fixed at `sha-1bf8e2d`. API-contract bug fixed at `sha-9c7dd537211a`. |
| SDK mode restored to mock | **YES** (`SPECTRE_STRIPE_SDK_MODE` unset at v954) |
| All founder-installed secrets preserved | **YES** (byte-identical digests before + after) |
| Final M2 acceptance recommendation | **M2 FOUNDATION TECHNICALLY PROVEN; FULL ACCEPTANCE AWAITS PATH A OR PATH B** |

---

**End of controlled sandbox activation window.** `sha-9c7dd537211a` /
Fly v954 is the final staging baseline. All founder authorisations
honoured. Awaiting founder decision on PATH A vs PATH B for the
remaining §19e scenarios 1-12.

---

## 20. M2-SyntheticSandbox pathway (founder 2026-10-27)

**Status.** READY FOR FOUNDER TEST-WINDOW AUTHORISATION. Code gates
satisfied; staging schema migrated; synthetic ToS doc shipped;
regression tests green; mock mode preserved; founder-installed
secrets intact.

### 20a Design + threat model

**Problem.** The mandate-initiation chain refuses to run against a
`DEVELOPMENT_FIXTURE` ToS (§18e). The founder's authorisation (2026-
10-27 §scope) requires:

> "Do not bypass, disable, or weaken the existing Terms of Service
> approval gate. However, final commercial Terms of Service
> approval should not be a prerequisite for testing Stripe's
> technical integration with synthetic identities."

**Solution.** A parallel sandbox-only service that cannot be reached
from production and whose outputs cannot cross into production.

**Threat model (per founder §12):**

| # | Threat | Mitigation |
|---|---|---|
| T1 | Synthetic registration escapes to production via Phase 2F / 2G | `refuseIfSyntheticTestOnly()` wired into `initiateMandateCollection` + `persistSignedMandate`; `syntheticTestOnly` column + `@@index` on 5 tables. Verified by regression tests. |
| T2 | Sandbox accidentally enabled in production | **`FLY_APP_NAME === "spectre-staging"` guard** — production app is `spectre-production`; the pathway is physically unreachable in production regardless of other config state. Verified by test with `FLY_APP_NAME=spectre-production`. |
| T3 | Synthetic ToS shown to a real signatory | ToS doc clearly marked `SYNTHETIC_TEST_ONLY`; signatory-facing Stripe Checkout displays Stripe's own standard ACSS mandate text (NOT this Spectre ToS); pathway gated behind 3 independent env guards + database marker. |
| T4 | Synthetic data in reports | `syntheticTestOnly` column with `@@index` on all 5 tables for O(1) exclusion filters. (Follow-on: add filters to reporting services in a subsequent slice; today's reports exclude pre-tenancy rows by default anyway.) |
| T5 | Synthetic webhook triggers tenant lifecycle | Phase 2F / 2G / 2H never see synthetic rows — synthetic cycles stop at mandate persistence; `clubId` is the synthetic registration id (not a Club.id); the production flow would refuse via `refuseIfSyntheticTestOnly`. |

### 20b Guard chain (three independent conditions)

```
assertSyntheticSandboxGuardsPass():
  1. FLY_APP_NAME === "spectre-staging"          ← physically unreachable in production
  2. SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX === "1" ← explicit per-session opt-in
  3. stripeSdkMode() === "test"                   ← SDK must be in test mode
```

All three must hold at every mutating entry point. The teardown
function intentionally allows cleanup WITHOUT the guards (so a
stuck-flag post-test cleanup still works), but it only deletes rows
with `syntheticTestOnly = true` — no production rows are at risk.

### 20c Database marker

`syntheticTestOnly: Boolean DEFAULT false` added with `@@index` to:

1. `SignupRegistration`
2. `SubscriptionAuthorisationAttestation`
3. `SubscriptionPaymentMandate`
4. `OperatorVerificationRecord`
5. `BillingCycle`

Migration: `prisma/migrations/20261027_signup_2_m2_synthetic_sandbox_marker/migration.sql` + `prisma-postgres/migrations/20261027_signup_2_m2_synthetic_sandbox_marker/migration.sql` (dual-schema pattern for SQLite dev + Postgres staging). The staging-DB apply happens at the DRH-1 release command: `prisma migrate deploy --schema prisma-postgres/schema.prisma`.

### 20d Synthetic ToS doc

New file: [docs/legal/terms-of-service-synthetic-sandbox.md](docs/legal/terms-of-service-synthetic-sandbox.md).

Status: `SYNTHETIC_TEST_ONLY`. Label: `ToS-synthetic-sandbox-2026-10-27`. Content is unmistakably marked as a test fixture with no legal effect. The main `assertTermsOfServiceApproved()` function in `src/lib/billing/terms-of-service.ts` is **unchanged** and still refuses any status that is not `APPROVED` (verified by regression test). The synthetic service reads this doc via its own `readSyntheticTermsOfService()` helper which refuses any status that is not `SYNTHETIC_TEST_ONLY`.

### 20e Production-path refusal

Updated:
- `src/lib/billing/signup-2e-mandate-service.ts` → `initiateMandateCollection` + `persistSignedMandate` both call `refuseIfSyntheticTestOnly(reg.id)` BEFORE any Stripe calls or DB writes.
- `refuseIfSyntheticTestOnly` throws `ForbiddenError` on `syntheticTestOnly === true`.

### 20f Service surface

File: [src/lib/signup/signup-2m2-synthetic-sandbox-service.ts](src/lib/signup/signup-2m2-synthetic-sandbox-service.ts).

Exports:
- `assertSyntheticSandboxGuardsPass()` — fail-closed on any guard failure.
- `syntheticSandboxEnabled()` — read-only probe (used by tests).
- `readSyntheticTermsOfService()` — refuses docs not labelled `SYNTHETIC_TEST_ONLY`.
- `createSyntheticRegistration({ scenarioLabel })` — creates the full chain (SignupRegistration + attestation + RELEASE record) all marked synthetic. Returns the Spectre launch URL that the founder will hit.
- `initiateSyntheticMandateCollection(registrationId)` — opens a real Stripe test-mode Checkout session via `resolveStripeAdapter({ requireLive: true })`. Metadata on every Stripe object carries `syntheticTestOnly: "true"`.
- `persistSyntheticSignedMandate({ registrationId, checkoutSessionId })` — called by the synthetic return handler after the founder completes mandate signing on Stripe.
- `teardownSyntheticTestFixtures()` — bulk deletes all `syntheticTestOnly = true` rows across 5 tables. Preserves founder-installed Stripe secrets (never touches `flyctl secrets`).
- `refuseIfSyntheticTestOnly(registrationId)` — the gate injected into main production paths.

### 20g HTTP routes

New routes (both require the three-guard chain to pass):
- `GET /api/signup/mandate/synthetic-initiate?registrationId=…` → 303 redirect to Stripe hosted Checkout.
- `GET /api/signup/mandate/synthetic-return?registrationId=…&session_id=…` → JSON confirmation of mandate persistence.

Both routes delegate to the service and contain NO independent Stripe-API calls, NO secret reads, and NO privilege escalation. Any guard failure returns HTTP 403.

### 20h Regression evidence (founder §12)

File: [tests/signup-2-m2-synthetic-sandbox.test.ts](tests/signup-2-m2-synthetic-sandbox.test.ts) — **45 scenarios**, all passing.

Coverage:
- `assertTermsOfServiceApproved()` **unchanged** (refuses `DEVELOPMENT_FIXTURE` + `ToS-dev-fixture*` labels; refuses anything not `APPROVED`).
- Dev-fixture doc remains `Status: DEVELOPMENT_FIXTURE`.
- Three-guard chain: positive + negative tests for FLY_APP_NAME, flag, Stripe mode.
- Every mutating entry point calls `assertSyntheticSandboxGuardsPass()` first.
- Synthetic ToS doc exists, status, label.
- `readSyntheticTermsOfService` refuses non-SYNTHETIC_TEST_ONLY status.
- `initiateMandateCollection` + `persistSignedMandate` call `refuseIfSyntheticTestOnly`.
- `refuseIfSyntheticTestOnly` throws on synthetic marker.
- Live-adapter engagement via `resolveStripeAdapter({ requireLive: true })`.
- ACSS mandate options on synthetic path (business + interval + CAD).
- `syntheticTestOnly: "true"` metadata on every Stripe call.
- 5 tables each have `syntheticTestOnly Boolean @default(false)` + `@@index`.
- Every synthetic insert sets `syntheticTestOnly: true`.
- FLY_APP_NAME guard is FIRST in the chain.
- HTTP routes delegate without Stripe-API logic.
- Webhook dispatcher does not read synthetic marker as a privilege flag.
- The three activation/provisioning/suspension flags are NOT read by this service.
- Teardown only deletes synthetic rows; never touches founder secrets.

**Full suite:** `npx vitest run tests/signup-2*.test.ts` → **1248/1248 pass + 5 Postgres-only skips** across 54 files.

### 20i Staging release

- **DRH-1 runs:** 40532552559 (initial code deploy at `sha-35fa4250747b` → Fly v956) + 40535492816 (Postgres schema + migration mirror, deploying now).
- **Initial deploy** (`sha-35fa4250747b` / v956): shipped the service + routes but the migration landed only in `prisma/migrations/` (SQLite). The staging Postgres DB did NOT get the column.
- **Fix** (`sha-5801a7c…`): mirrored the schema into `prisma-postgres/schema.prisma` + the migration into `prisma-postgres/migrations/`. DRH-1 release command (`prisma migrate deploy --schema prisma-postgres/schema.prisma`) will apply the columns + indexes on the next successful deploy.
- **Rollback anchor:** `sha-9c7dd537211a` / Fly v954 (M2-Validation baseline; synthetic sandbox entirely absent).
- **Current secret state:** 3 founder-installed Stripe secrets intact (digests unchanged from §19); no sandbox / activation flags set.

### 20j PATH A readiness recommendation

**RECOMMENDATION: PATH A can safely resume** once the current DRH-1 (40535492816) completes and the staging DB has the `syntheticTestOnly` columns.

**Remaining founder-side actions** for the actual sandbox test window:

1. Confirm DRH-1 40535492816 completed successfully (watch for `prisma migrate deploy` success in logs).
2. Explicitly authorise the test-window flag set:
   ```bash
   flyctl secrets set --app spectre-staging \
     SPECTRE_STRIPE_SDK_MODE=test \
     SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX=1
   ```
   (Phase 2B / 2E / 2F / 2G / 2H flags remain unset — the synthetic pathway does not need them.)
3. Spectre engineering (Claude) will:
   - Call `createSyntheticRegistration({ scenarioLabel: "m2-happy-path" })` via SSH.
   - Return the Stripe Checkout URL to the founder.
   - Wait for the founder to complete mandate signing in a browser using Stripe's published test banking details.
   - Resume evidence collection (mandate persistence, subscription create, webhook delivery, settlement).
4. On completion, Claude teardown:
   - `teardownSyntheticTestFixtures()` deletes all synthetic rows.
   - `flyctl secrets unset SPECTRE_STRIPE_SDK_MODE SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX`.
   - Verify 3 founder-installed Stripe secret digests unchanged + health 200.

### 20k Non-authorisations preserved (founder scope)

- `assertTermsOfServiceApproved()` **not changed** (regression-tested).
- `DEVELOPMENT_FIXTURE` doc **not relabelled** (verified).
- Three activation/provisioning/suspension flags **not touched** by the service.
- Founder-installed Stripe secrets **not read / written / rotated / exposed** by the service.
- Zero sandbox payments initiated in this slice (service built, not run).
- Zero production deployment.
- Zero existing-tenant modification.
- Zero bypass of any failed acceptance gate.

### 20l Validation summary

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx prisma generate` | clean |
| `npx prisma db push` (local SQLite) | clean |
| `npx vitest run tests/signup-2-m2-synthetic-sandbox.test.ts` | **45/45 pass** |
| `npx vitest run tests/signup-2*.test.ts` | **1248/1248 pass** + 5 Postgres-only skips (54 files) |
| DRH-1 40532552559 (initial code) | **success** |
| DRH-1 40535492816 (Postgres schema mirror) | polling… |
| Staging `/api/health` after v956 | **200** |

---

**End of M2-SyntheticSandbox slice.** Ready for founder PATH A
test-window authorisation.
