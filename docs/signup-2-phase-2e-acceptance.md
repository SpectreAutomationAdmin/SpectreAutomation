# SIGNUP-2 Phase 2E — Acceptance Evidence

**Status.** READY FOR FOUNDER ACCEPTANCE.
**Authored branch.** `staging-deploy/web1b1-framer-fidelity`.
**Depends on.** Phase 2A (sha-c3e337e / v870), Phase 2B
(sha-9c717e1 / v875), Phase 2C (sha-adfe13c / v877), Phase 2D
(sha-e3eed9e / v880).
**Date.** 2026-10-26.

---

## 1. Implementation and deployment commits

- **Implementation commit:** `sha-993e5fd` on branch
  `staging-deploy/web1b1-framer-fidelity`.
- **Deployed image:** `registry.fly.io/spectre-staging:sha-993e5fd77ceb`
  + worker image `registry.fly.io/spectre-staging-worker:sha-993e5fd77ceb`.
- **DRH-1 run:** 40262242906 — **conclusion: success**.
- **Rollback anchor:** v880 (`sha-e3eed9e9d045`) — Phase 2D baseline.

## 2. Fly staging release and image verification

- **Phase 2E was the first production exercise of the new DRH-1
  post-deploy image-tag reliability gate** (self-exercised on the
  prior release at run 40259892265, which completed successfully).
  The Phase 2E DRH-1 output confirmed:
  - `::notice::web — 1 machine(s) started on tag sha-993e5fd77ceb;
    every machine on expected tag`
  - `::notice::worker — 1 machine(s) started on tag
    sha-993e5fd77ceb; all machines on expected tag`
- The gate failing on a stuck rollout now stops the workflow rather
  than reporting false green (the exact v880 Phase 2D stall this
  gate was built to prevent).
- `/api/health` post-deploy: HTTP **200**, DB ok (32 ms), queue ok,
  captured 2026-10-26 03:18 UTC.
- `POST /api/webhooks/stripe` smoke: HTTP **400** (fail-closed
  signature-rejection branch; no `STRIPE_WEBHOOK_SIGNING_SECRET`
  configured on staging — expected).
- `GET /signup/t/<bogus>/mandate`: HTTP **404** (notFound on an
  invalid token — expected).
- Migration applied: `20261026_signup_2e_billing_cycle_release_fk`
  — additive-only (one new nullable FK column + one index on
  `BillingCycle`; one `ALTER COLUMN ... DROP NOT NULL` on
  `SubscriptionPaymentMandate.clubId` per the Phase 2A pattern
  mirror).

## 3. Stripe test-mode integration evidence (or blockers)

**Not shipped in Phase 2E baseline.** Per founder §1, Stripe test-
mode credentials + the pre-flight verify doc are NOT available on
staging.  Phase 2E ships provider-independent components + mocked
contracts.

Blockers to live-adapter procurement (all out-of-scope for Phase 2E
and tracked for a separately-authorised Phase 2E-Follow-On slice):
- No Stripe test-mode account provisioned on staging.
- No `STRIPE_API_KEY` / `STRIPE_WEBHOOK_SIGNING_SECRET` configured
  as Fly secrets.
- No `docs/signup-2-stripe-merchant-verify.md` exists yet.
- Stripe ACSS fee cap, ACSS `interval` mandate variant, Stripe
  `BalanceTransaction.available_on` reliability, and Stripe-sent
  debit-notification email (Rule H1 §20) remain unverified against
  Spectre's real merchant account.

The mock adapter writes `evidenceSource = "mock-stripe"` on every
return value — Phase 2E does NOT fabricate `"live-stripe"` evidence
anywhere.  A contract test enforces this invariant.

## 4. ACSS mandate behavior

- Mandate variant: `interval` (single-amount, annual) per
  founder decision 4 of the v3 architecture.
- Payment schedule: `interval`.
- Transaction type: `business`.
- Mandate text SHA-256 is persisted in
  `SubscriptionPaymentMandate.mandateTextHash` so a textual
  revision cannot retroactively alter prior consents.
- Mandate is attached to Phase 2D's RELEASE record via
  `BillingCycle.releasedByOperatorRecordId` so the full operator
  provenance chain is reachable from the cycle.
- The applicant-facing /signup/t/[token]/mandate page shows a
  flag-OFF "coming soon" banner by default (fail-closed).

## 5. Commercial and legal authorization controls

- `assertPhase2ePaymentFlag()` is the entry gate on every write
  service entry point.  OFF (unset / `0` / `true` / etc.) → throws
  `ForbiddenError`; only literal `"1"` passes.
- `assertAttestationCanProceed()` (Phase 2B helper) is called in
  `initiateMandateCollection` — the dev-fixture ToS is rejected
  before any Stripe call.
- Attestation ToS SHA-256 must match the currently-approved ToS;
  mismatched signatories are forced to re-attest.
- `assertAuthorised()` accepts EITHER `MANUAL_RELEASE` (Phase 2D
  three-operator release path) OR `PASS_AUTOMATED` (future
  automated-corroborator path).  Any other verdict → refusal.
- No gov-ID surface anywhere (contract-asserted).

## 6. Webhook security and deduplication

- Reads raw request body before any JSON parse.
- `verifyWebhookSignature(rawBody, signatureHeader, signingSecret)`
  on the adapter (mock implements an HMAC-SHA-256 scheme that
  mirrors Stripe's shape; live adapter will use
  `stripe.webhooks.constructEvent`).
- `StripeWebhookEvent` unique index on `id` dedupes replays:
  P2002 collision → return 200 "replay" without re-dispatching.
- Flag-OFF path per founder §4: event IS persisted (durable
  receipt) but dispatch is skipped.  Operators can replay once
  the flag is on.  No financial events are lost.
- Signature failure → 400 (no persistence, no dispatch).

## 7. Reconciliation ledger evidence

- Every state transition writes a `PaymentReconciliationEntry`
  row with `providerEventId` set to the Stripe event id and
  `providerPaymentIntentId` / `providerChargeId` where applicable.
- The ledger is append-only (no updates / deletes).
- Entry types written by Phase 2E:
  `SUBSCRIPTION_INITIATED`, `PAYMENT_PROCESSING`,
  `PAYMENT_SETTLED`, `PAYMENT_FAILED`, `CHARGE_SETTLED`,
  `ACTIVATION_READY`, `REFUNDED`, `DISPUTE_OPENED`.

## 8. Financial state-machine and reversal tests

Lifecycle verified by `tests/signup-2-phase-2e-webhook-handler.test.ts`:

```
INITIATED
  ├─ payment_intent.processing       → AWAITING_SETTLEMENT
  ├─ payment_intent.succeeded         → SETTLED
  ├─ payment_intent.payment_failed    → PAYMENT_FAILED + IMMEDIATE operator alert
  └─ charge.succeeded                 → ACTIVATION_READY (if balance available)
                                        + records stripeChargeId + BalanceTransactionId
SETTLED / AWAITING_SETTLEMENT
  ├─ charge.refunded                  → REVERSED (revokes activation per §5) +
                                        reversedAt + IMMEDIATE operator alert
  └─ charge.dispute.created           → DISPUTE_OPEN (revokes activation per §5) +
                                        reversedAt + IMMEDIATE operator alert
```

- Conditional `updateMany` defeats out-of-order webhook races.
- Idempotent-replay on the webhook endpoint (unique `id` index).
- `isActivationReady()` is REVOCABLE: any `reversedAt` set returns
  false; the signal re-reads BalanceTransaction state so a late
  `available_on` flip is picked up.

## 9. Contract and Playwright test results

**Contract tests (vitest):** 175 Phase 2E assertions / 175 pass across 6 files.

| File | Assertions |
|---|---|
| `tests/signup-2-phase-2e-schema.test.ts` | 11 |
| `tests/signup-2-phase-2e-authorization-model.test.ts` | 7 |
| `tests/signup-2-phase-2e-mandate-service.test.ts` | 15 |
| `tests/signup-2-phase-2e-stripe-adapter.test.ts` | 19 |
| `tests/signup-2-phase-2e-webhook-handler.test.ts` | 18 |
| `tests/signup-2-phase-2e-no-production-side-effects.test.ts` | 105 (grep sweep across 10 files × 11 patterns) |

**Full SIGNUP regression:** **734 / 734** (SIGNUP-1 + 1F + 2A + 2B
+ 2C + 2D + 2E).  Typecheck clean.  Placeholder scan clean on all
Phase 2E surfaces.

**Playwright staging acceptance:** Phase 2E ships with the feature
flag OFF; the controlled-activation Playwright run against staging
is deferred until a separately-authorised flag flip (same cadence
as Phase 2B / 2C / 2D).  The baseline deploy will exercise the
fail-closed path through the smoke check (`/api/health` + webhook
signature-reject path).

## 10. Feature-flag state

- `SPECTRE_SIGNUP_2E_PAYMENT_LIVE` on staging: **OFF (unset)**.
- `SPECTRE_SIGNUP_2E_STRIPE_MODE` on staging: **unset** (defaults
  to `mock`).  No live adapter module ships regardless of this
  env value in Phase 2E baseline.
- `STRIPE_WEBHOOK_SIGNING_SECRET` on staging: **unset** (webhook
  signature verification will fail-closed with "missing_secret"
  for any incoming event; `StripeWebhookEvent` row still persists
  via the receipt path).
- Phase 2B / 2C / 2D flags: all OFF (unchanged by Phase 2E).

The Phase 2E flag is intentionally OFF per founder §7 — any
applicant-facing payment activation requires a separately
approved legal document (production ToS at `Status: APPROVED`)
PLUS an explicit founder activation decision.

## 11. Existing-tenant compatibility

- Zero `ClubSubscription` writes against any existing tenant.
- Zero `accessTier` writes anywhere.
- Zero `Club` / `User` / `UserClubRole` writes.
- Zero `TenantProvisioningJob` writes (Phase 2F boundary preserved).
- Legacy tenants (`accessTier IS NULL`) retain the Phase 2B
  grandfather pass.
- The `SubscriptionPaymentMandate.clubId` NULLABLE relaxation
  does not affect any existing row (staging has zero rows in that
  table today; Phase 2G will backfill the column when a Club shell
  is provisioned).
- The `BillingCycle.releasedByOperatorRecordId` column is nullable
  and defaults to null; legacy BillingCycle rows (none exist on
  staging today, by design) remain unaffected.

Grep-sweep contract test
`tests/signup-2-phase-2e-no-production-side-effects.test.ts`
asserts every forbidden-pattern invariant across all 10 Phase 2E
source files.

## 12. Zero production and live-payment activity

- **No live Stripe entities created.** The mock adapter is the
  only shipped adapter; `isLive === false` is contract-asserted.
- **No real payment initiated.** Mandate collection is dormant
  (flag OFF); the mock adapter does no outbound HTTP; no outbound
  Stripe SDK is imported anywhere.
- **No production deploy.** DRH-1 target is `spectre-staging` only.
- **No production configuration change.**
- **No ToS activation.** The dev fixture remains the resolved ToS;
  the gate refuses to persist a mandate against it even if the
  Phase 2E flag were flipped on.
- **No gov-ID surface anywhere.**
- **Phase 2B / 2C flags NOT activated to bypass this gate.**

## 13. Outstanding dependencies and risks

### 13a Dependencies (external)

- Stripe test-mode account on staging + Fly secrets:
  `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SIGNING_SECRET`.  Required
  before any live-adapter slice.
- Production ToS at `Status: APPROVED` with a non-dev-fixture
  label.  Required before mandate collection can succeed even
  on staging.
- `docs/signup-2-stripe-merchant-verify.md` filled with evidence
  for the four v3 §11 Stripe-merchant assumptions.

### 13b Risks

- **No live-adapter acceptance yet.** The mock adapter proves the
  internal state machine + webhook handling; it does NOT prove
  Stripe's own behaviour (fee cap, ACSS settlement timing,
  `available_on` reliability).  A later slice must exercise real
  Stripe test-mode calls before Phase 2F can safely consume
  `ACTIVATION_READY`.
- **Webhook signing secret is unset on staging.** Any real webhook
  POST (if a staging URL were registered in Stripe) would fail
  verification with "missing_secret" and persist a receipt only.
  This is the fail-closed baseline; no state transitions fire.
- **No background retry worker.** A Stripe event that fails
  dispatch is marked `processingResult = null` on
  `StripeWebhookEvent` and sits waiting for operator replay.
  The dedicated retry worker is Phase 2I's responsibility.

### 13c Not Phase 2E's scope — reserved for later authorisation

- Phase 2F: activation gate firing + Tier 2 unlock.
- Phase 2G: tenant provisioning + Club shell creation + Phase
  2E's clubId backfill on `SubscriptionPaymentMandate` and
  `BillingCycle`.
- Phase 2H: operator remediation UI + retention worker.
- Phase 2I: daily reconciliation worker + Stripe fetch drift
  detection.
- Renewal cycles (T-30 notification, new-mandate flow).
- Card-payment secondary method.
- Live-adapter implementation + Stripe test-mode acceptance.

---

## Acceptance recommendation

**Recommended for founder acceptance.**

Phase 2E delivers the authorised scope within the amended boundaries:
- §1 preflight honoured — mock-adapter baseline shipped; no live
  Stripe calls; no fabricated evidence.
- §2 authorization-model corrected — `MANUAL_RELEASE` verdict
  distinct from `PASS_AUTOMATED`; six-concept separation preserved.
- §3 ACSS primary + cards deferred + dev-fixture ToS rejection
  inherited from Phase 2B.
- §4 webhook controls complete — raw-body signature verification,
  durable receipt, dedup, dispatch matrix, operator alerts, flag-
  OFF processing-disabled, no financial events lost.
- §5 activation boundary preserved — `ACTIVATION_READY` is a
  revocable signal; Phase 2F consumes.
- §6 testing explicit coverage shipped (175 contract assertions +
  Playwright acceptance plan).
- §7 deployment: DRH-1 only, staging only, flag OFF.

**Phase 2F remains unauthorized.**  Phase 2E's `ACTIVATION_READY`
signal is produced + persisted + revocable; Phase 2F reads it +
atomically re-evaluates every activation condition before granting
operational access.
