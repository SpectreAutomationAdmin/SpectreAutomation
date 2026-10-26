# SIGNUP-2 Phase 2E — Implementation Authorisation Package (DRAFT)

**Status.** PLANNING ONLY, pending founder authorisation.  No
application code; no Prisma migration; no Stripe entity; no
production configuration; no tenant provisioning; no live payment;
no activation of Phase 2F or later.

**Supersedes.** None (Phase 2E first draft).
**Depends on.**
- SIGNUP-2 Architecture Decision Document v3 (`sha-07db40b`).
- SIGNUP-2 Phase 2A accepted baseline `sha-c3e337e / v870`.
- SIGNUP-2 Phase 2B accepted baseline `sha-9c717e1 / v875` (dormant).
- SIGNUP-2 Phase 2C accepted baseline `sha-adfe13c / v877` (dormant).
- SIGNUP-2 Phase 2D accepted baseline `sha-e3eed9e / v880` (dormant).
- Phase-2A pre-flight verification doc
  [docs/signup-2-stripe-merchant-verify.md](signup-2-stripe-merchant-verify.md)
  — Section 11 of the architecture lists four Stripe-merchant
  assumptions that MUST be verified before Phase 2E's first real
  Stripe call.

**Confirmed on filing this document:**
- No production state has changed.
- No Stripe entity exists on Spectre's merchant account.
- No DB migration has been applied.
- No existing-tenant `accessTier` written.
- Phase 2B / 2C / 2D live-mode flags remain OFF.

---

## 1. Phase 2E objectives and boundaries

### 1a Objective

Phase 2E ships the **payment-authorisation, mandate-collection,
and settlement-tracking** layer that:
- Collects the signatory's Pre-Authorised Debit (PAD) mandate for
  the CAD $38,000 annual subscription.
- Creates the Stripe customer + subscription + payment-intent
  entities idempotently.
- Tracks state transitions `AUTHORISED → INITIATED →
  AWAITING_SETTLEMENT → SETTLED → ACTIVATION_READY` per the v3
  architecture state machine (§1d).
- Writes to the Phase-2A `PaymentReconciliationEntry` ledger on
  every state change.
- Dedups Stripe webhooks via the Phase-2A `StripeWebhookEvent` table.
- Writes operator alerts to the Phase-2A `OperatorInboxEntry` table
  on payment failures + dispute signals.
- Does NOT activate the tenant: `ACTIVATION_READY` is the input to
  Phase 2G.

### 1b In-scope for Phase 2E

- **Mandate-collection surface** at `/signup/t/[token]/mandate`,
  gated on `SignupRegistration.verificationVerdict ==
  "PASS_AUTOMATED"` (Phase 2D's AUTHORISED output).
- **Stripe Checkout integration** for ACSS Debit mandate signing.
  Returns to a Spectre callback that persists the signed mandate
  (`SubscriptionPaymentMandate`) + creates the Stripe Customer +
  Subscription + first PaymentIntent, idempotent on
  `signupRegistrationId`.
- **Stripe webhook handler** at `/api/webhooks/stripe` with:
  - Signature verification (`stripe.webhooks.constructEvent`
    + a staging-specific secret).
  - Dedup via `StripeWebhookEvent` (unique on event id).
  - Dispatch to per-event-type handlers:
    `payment_intent.processing` →
    `BillingCycle.subscriptionStatus = AWAITING_SETTLEMENT`.
    `payment_intent.succeeded` + `charge.succeeded` →
    `BillingCycle.subscriptionStatus = SETTLED`.
    `payment_intent.payment_failed` →
    `BillingCycle.subscriptionStatus = PAYMENT_FAILED` + operator
    alert.
    `charge.refunded` / `charge.dispute.created` →
    reversal path (Phase 2F consumes).
- **Reconciliation ledger writer**: every state transition writes
  one `PaymentReconciliationEntry` row with a stable idempotency
  key.
- **Activation-gate reader** (consumed by Phase 2F): a pure function
  `isActivationReady(billingCycleId, now)` that returns true iff:
  - `BillingCycle.subscriptionStatus == SETTLED`.
  - Stripe `BalanceTransaction.status == "available"` for the
    charge's balance transaction (fetched on reconciliation).
  - `BalanceTransaction.available_on <= now()`.
  - No `charge.dispute.created` or `charge.refunded` events for
    the cycle.
- **Secondary card payment path**: an opt-in alternate `method=card`
  branch on the Stripe Checkout session, available only when the
  staging merchant account has card acceptance enabled (confirmation
  item in the pre-flight verify doc).
- **Operator-visible payment status**: a read-only Phase-2E addition
  to the Phase-2D admin diagnostic endpoint
  (`/api/admin/signup-ops/registration/[id]/verification`) returning
  the latest `SubscriptionPaymentMandate` + `BillingCycle` metadata
  for the registration.  No write affordance.
- **Fail-closed feature flag** `SPECTRE_SIGNUP_2E_PAYMENT_LIVE`
  (default OFF; only literal `"1"` passes).  When OFF the mandate-
  collection route returns a 503 "coming soon" response and the
  webhook handler ignores events (but still writes them to
  `StripeWebhookEvent` for forensic audit).
- **Legal-document approval dependency**: Phase 2E's mandate text
  references the **production-approved ToS** (`terms-of-service-v1.md`
  with `Status: APPROVED`).  Phase 2E will NOT persist a signed
  mandate against the dev-fixture ToS -- enforced by the Phase 2B
  gate.

### 1c Out-of-scope for Phase 2E (deferred by phase)

| Area | Deferred to | Why |
|---|---|---|
| ACTIVATION gate firing + Tier 2 unlock | Phase 2F | Phase 2E produces the `ACTIVATION_READY` signal; Phase 2F fires the gate. |
| Tenant provisioning (Club shell creation) | Phase 2G | Phase 2F reads `ACTIVATION_READY`; Phase 2G provisions. |
| Welcome emails + invitation delivery | Phase 2G | Same chain. |
| Operator payment-remediation UI (restart cycle, change mandate, cancel) | Phase 2H | Phase 2E surfaces the signal in the inbox; Phase 2H ships the full operator surface. |
| Reversal / SUSPENDED path | Phase 2F + 2H | Phase 2E writes the webhook events; Phase 2F consumes the state machine; Phase 2H ships the operator remediation. |
| Daily reconciliation worker (sweeping drift) | Phase 2I | Phase 2E's ledger is written on live webhook events; drift detection is a background worker. |
| Renewal-time new-mandate collection | Separate per-renewal slice | Phase 2E ships only the first-cycle mandate. |
| Live production activation | Separate founder decision | Phase 2E ships with the flag OFF on staging and `spectre-staging`-only credentials. |

### 1d Hard non-authorisations

- No live Stripe customers / subscriptions / mandates on Spectre's
  real merchant account (per founder §5).
- No actual payment initiated against a real bank or card (per §5).
- No production configuration change.
- No ToS activation (dev fixture remains until the real ToS is
  approved).
- No existing-tenant access modification.
- No tenant provisioning (deferred to Phase 2G).
- No gov-ID surface, ever, without separate founder decision.
- No Phase 2F or later initiated by this document.

---

## 2. Dependencies on Phases 2A–2D

### 2a Reads from earlier phases

- **Phase 2A schema**:
  - `ClubSubscription` (extended; Phase 2E creates the row at
    mandate-signing time with `accessTier = STAGED`).
  - `BillingCycle` (extended; Phase 2E creates the first cycle row
    at Stripe-customer creation time; webhooks mutate
    `subscriptionStatus`).
  - `SubscriptionPaymentMandate` (immutable except `revokedAt`;
    Phase 2E inserts on mandate signing).
  - `PaymentReconciliationEntry` (append-only; Phase 2E writes on
    every state transition).
  - `StripeWebhookEvent` (dedup table; Phase 2E inserts before
    processing any event).
  - `OperatorInboxEntry` (Phase 2E inserts on payment failures,
    dispute signals, mandate signing confirmations).
- **Phase 2B**:
  - `SubscriptionAuthorisationAttestation` — read-only; Phase 2E
    confirms the attestation exists + matches the ToS version at
    mandate-signing time.
- **Phase 2C**:
  - `SignupRegistration.verificationVerdict` must equal
    `PASS_AUTOMATED` for Phase 2E to proceed; the mandate-
    collection route refuses otherwise.
- **Phase 2D**:
  - The operator-released verdict is the AUTHORISED trigger.
    Phase 2E reads it; does NOT re-run verification.
  - The latest `OperatorVerificationRecord(concept=RELEASE)` row is
    the trust anchor; Phase 2E attaches its id to the first
    `BillingCycle` via a new nullable FK column
    `releasedByOperatorRecordId`.

### 2b Writes

- Writes to `ClubSubscription` (new rows only; one per registration
  at mandate-signing time; `accessTier = STAGED` from day one per
  the staged-access architecture).
- Writes to `BillingCycle` (new rows; webhooks update
  `subscriptionStatus`).
- Writes to `SubscriptionPaymentMandate` (one row at mandate
  signing).
- Writes to `PaymentReconciliationEntry` (append-only).
- Writes to `StripeWebhookEvent` (dedup inserts).
- Writes to `OperatorInboxEntry` (payment events).

### 2c Does NOT write

- Does NOT write to any existing `ClubSubscription` row (every row
  is new).
- Does NOT touch `accessTier` on legacy tenants (`accessTier IS NULL`
  grandfather preserved).
- Does NOT create `Club` or `User` rows (Phase 2G owns tenant
  provisioning).
- Does NOT create `UserClubRole` rows.
- Does NOT alter the Phase-2A `TenantProvisioningJob` row (Phase 2F
  creates it on `ACTIVATION_READY`).

---

## 3. Proposed payment architecture

### 3a High-level sequence

```
Operator releases registration → verificationVerdict = PASS_AUTOMATED
   (Phase 2D)                               |
                                            v
Phase 2E — mandate collection          — Spectre creates Stripe
   /signup/t/[token]/mandate             Customer (idempotent on
   signatory lands here                  signupRegistrationId)
                                          — Stripe Checkout session
                                            (mode=setup, payment_method
                                             _types=["acss_debit"]
                                             or ["acss_debit","card"])
                                          — Signatory signs mandate
                                            in Stripe-hosted UI
                                          — Returns to /return URL
                                            with checkout_session_id
                                            — Spectre fetches session
                                              — persists
                                                SubscriptionPaymentMandate
                                              — creates Stripe
                                                Subscription (price=
                                                $38K/year CAD)
                                              — creates first
                                                PaymentIntent
                                              — writes BillingCycle
                                                (subscriptionStatus=
                                                 AWAITING_SETTLEMENT)
                                              — writes
                                                PaymentReconciliationEntry
                                              — writes OperatorInboxEntry
                                                (MANDATE_SIGNED, routine)
   Webhook: payment_intent.processing      — StripeWebhookEvent insert
   (ACSS Debit standard T+1 to T+4)        — BillingCycle unchanged
                                            (already AWAITING_SETTLEMENT)
   Webhook: payment_intent.succeeded       — StripeWebhookEvent insert
                                          — BillingCycle.subscriptionStatus
                                            = SETTLED
                                          — PaymentReconciliationEntry
                                            insert
   Webhook: charge.succeeded               — StripeWebhookEvent insert
                                          — Fetch BalanceTransaction
                                          — If status == "available"
                                            AND available_on <= now()
                                            → BillingCycle.
                                              subscriptionStatus =
                                              ACTIVATION_READY
                                          — Else: a Phase 2I
                                            reconciliation worker will
                                            re-check later (Phase 2E
                                            baseline accepts whatever
                                            Stripe returns and the
                                            Phase 2I worker fills the
                                            gap).

Phase 2F consumes ACTIVATION_READY — fires activation gate.
Phase 2G consumes activation gate — provisions tenant.
```

### 3b Primary payment method: ACSS Debit

Stripe Checkout session parameters (nominal; final values pinned at
implementation):

```ts
await stripe.checkout.sessions.create({
  mode: "setup",
  payment_method_types: ["acss_debit"],
  payment_method_options: {
    acss_debit: {
      mandate_options: {
        payment_schedule: "interval", // founder decision 4
        transaction_type: "business",
        interval_description: "Annual Spectre subscription",
      },
    },
  },
  customer: /* created server-side first, idempotent */,
  success_url: "https://staging.spectreautomation.com/signup/t/[token]/mandate/return?session_id={CHECKOUT_SESSION_ID}",
  cancel_url: "https://staging.spectreautomation.com/signup/t/[token]/mandate/cancel",
});
```

Per founder decision 4, Phase 2E uses the `interval` mandate variant
(single-amount, annual).  Per Payments Canada Rule H1 Section 20,
Stripe sends the mandate-signed email to the signatory on our behalf
(verified in the pre-flight doc).

### 3c Secondary payment method: card (opt-in, conditional)

Per founder §4, cards are the secondary method, subject to
merchant-account confirmation.  Phase 2E's architecture ADDS
`"card"` to `payment_method_types` ONLY WHEN the staging merchant
account has card acceptance enabled.  The default Phase 2E ship
is ACSS-only.

### 3d Idempotency

Every Stripe write uses an idempotency key derived from the
registration + a stable intent name:

| Intent | Idempotency key template |
|---|---|
| `customers.create` | `signup-2e-customer:<signupRegistrationId>` |
| `checkout.sessions.create` | `signup-2e-checkout:<signupRegistrationId>:<nonce-rotation-count>` |
| `subscriptions.create` | `signup-2e-subscription:<signupRegistrationId>:<first-cycle-id>` |
| webhook dispatch | `signup-2e-event:<stripe.event.id>` (via `StripeWebhookEvent.id` unique index) |

### 3e Webhook security

- Signature verification with `stripe.webhooks.constructEvent`
  using `STRIPE_WEBHOOK_SIGNING_SECRET` (staging-only secret;
  distinct from production).
- Deduplication via `StripeWebhookEvent` unique index on
  `stripeEventId`.
- Allowlist of event types; unknown events are logged + stored but
  not dispatched.
- Rate limit per IP (secondary defence; the signing-key gate is
  primary).

---

## 4. Subscription lifecycle and activation gates

Phase 2E lifecycle (quoted verbatim from v3 architecture §1d, with
Phase 2E ownership marked):

```
AUTHORISED        -- Phase 2D produces (verificationVerdict = PASS_AUTOMATED)
    |
    v
INITIATED         -- Phase 2E creates Stripe Customer + Subscription + first PaymentIntent
    |
    v
AWAITING_SETTLEMENT  -- Phase 2E: payment_intent.processing webhook received
    |  \
    |   \ (payment_intent.payment_failed)
    |    `-> PAYMENT_FAILED (Tier 1 retained; operator inbox alert)
    v
SETTLED           -- Phase 2E: payment_intent.succeeded + charge.succeeded both arrived
    |
    v  Phase 2E: BalanceTransaction.status == available
    |   AND BalanceTransaction.available_on <= now()
    |   AND no dispute/refund on this cycle
    v
ACTIVATION_READY  -- Phase 2E writes the signal; Phase 2F consumes
    |
    v  Phase 2G: durable TenantProvisioningJob runs
    v
ACTIVE            -- Phase 2F unlocks Tier 2
```

**Phase 2E boundary:** Phase 2E produces `AWAITING_SETTLEMENT`,
`SETTLED`, and `ACTIVATION_READY`.  Phase 2E does NOT fire the
activation gate itself (that is Phase 2F's `isActivationReady →
unlock` write).  This separation ensures the gate's four preconditions
are a single auditable Phase 2F check, not scattered across webhook
handlers.

**NEVER-permitted transitions preserved from v3 §1e:**
- `AUTHORISED → ACTIVE` direct (no shortcut).
- `SETTLED → ACTIVE` without `ACTIVATION_READY` (gate is mandatory).
- `ACTIVE → AWAITING_SETTLEMENT` (no cycle restart).
- `ACTIVE / SUSPENDED → AUTHORISED` (no commitment unwinding).

### 4a Phase 2E additive migration (expected)

One nullable FK column on `BillingCycle` referencing the Phase 2D
release record:

```prisma
model BillingCycle {
  // ... existing columns ...
  releasedByOperatorRecordId String?  // Phase 2E; references OperatorVerificationRecord(concept=RELEASE)
  releasedByOperatorRecord   OperatorVerificationRecord? @relation(...)
}
```

Additive + nullable; zero existing-row impact.  Dual-schema (SQLite +
Postgres).

---

## 5. Financial and security controls

### 5a Payment-authorisation distinction (founder §4)

Phase 2E explicitly distinguishes six states:

| State | Owned by | Meaning |
|---|---|---|
| **Payment authorisation** | Phase 2D | Signatory + operators have authorised the Club to be charged; verificationVerdict = PASS_AUTOMATED |
| **Payment initiation** | Phase 2E | Stripe PaymentIntent created; funds request in-flight |
| **Payment processing** | Stripe (ACSS debit network) | Bank clearing; Stripe reports `payment_intent.processing` |
| **Payment settlement** | Stripe | `payment_intent.succeeded` + `charge.succeeded` arrived; funds landed in Spectre's Stripe balance |
| **Funds availability** | Stripe | `BalanceTransaction.status == available` AND `available_on <= now()`; Spectre can use the funds (ACSS: ~T+5) |
| **Tenant activation** | Phase 2F → 2G | `ACTIVATION_READY` signal consumed; Tier 2 unlocked; Club shell provisioned |

**Successful payment initiation DOES NOT grant full operational
access.** Per the v3 architecture activation-gate rule
(§1b), full activation requires:
- Confirmed settlement (`SETTLED`).
- Available Stripe balance (`BalanceTransaction.status == available`).
- `available_on <= now()`.
- No unresolved `charge.dispute.created` or `charge.refunded`.
- Successful durable provisioning (Phase 2G's job completes).

Phase 2E preserves this rule by STOPPING at the signal; Phase 2F
performs the gate check.

### 5b Idempotency + webhook security

- Every Stripe write uses an idempotency key (see §3d).
- Webhooks dedup via the Phase-2A `StripeWebhookEvent` unique index.
- Signature verification on every webhook before any DB write.
- Signing secret is a staging Fly secret, distinct from production.

### 5c Fail-closed feature flag

`SPECTRE_SIGNUP_2E_PAYMENT_LIVE` — default OFF; only literal `"1"`
passes.  OFF behaviour:
- `/signup/t/[token]/mandate` returns a 503 "coming soon" response.
- `/api/webhooks/stripe` responds 200 (so Stripe doesn't disable
  the webhook endpoint) but inserts the event into
  `StripeWebhookEvent` with a `{"droppedByFlag": true}` marker in
  `payloadJson` and does NOT dispatch to the handlers.

### 5d Legal-document approval dependency

The mandate-collection route reads the Phase-2B
`assertAttestationCanProceed()` helper (which refuses dev-fixture
ToS).  Phase 2E will NOT persist a signed mandate while the ToS is
a dev fixture.  Confirms the Phase 2B gate is a shared bottleneck
for every Phase 2E / 2F / 2G activation.

### 5e Operator alerting

Every payment event writes to the Phase-2A `OperatorInboxEntry`
table:

| Event | Severity | Category | Operator action required? |
|---|---|---|---|
| `MANDATE_SIGNED` | ROUTINE | PROVISIONING_SUCCESS | No; informational |
| `PAYMENT_PROCESSING` | ROUTINE | PAYMENT_FLOW | No; informational |
| `PAYMENT_SETTLED` | ROUTINE | PAYMENT_FLOW | No; informational |
| `PAYMENT_FAILED` | IMMEDIATE | PAYMENT_FAILURE | Yes; operator remediation (Phase 2H) |
| `DISPUTE_OPENED` | IMMEDIATE | DISPUTE | Yes; operator action (Phase 2F / 2H) |
| `CHARGE_REFUNDED` | IMMEDIATE | REVERSAL | Yes; cycle reversal (Phase 2F) |

### 5f Renewal + mandate changes (reference only; not Phase 2E's scope)

The v3 architecture §6 defines renewal + mandate change rules
(T-30 notification, new mandate collection for price changes).
Phase 2E ships ONLY the first-cycle mandate; subsequent renewals
are a separately-authorised slice.

---

## 6. Testing and acceptance plan

### 6a Contract tests (vitest; target >= 80 passing assertions)

1. `tests/signup-2-phase-2e-schema.test.ts` — the one new FK column
   on `BillingCycle`; dual-schema parity; cascade semantics.
2. `tests/signup-2-phase-2e-mandate-collection.test.ts` — the
   mandate-collection route: Phase 2D verdict gate (refuses
   non-PASS_AUTOMATED), Phase 2B ToS gate (refuses dev fixture),
   fail-closed flag gate, idempotency on `signupRegistrationId`.
3. `tests/signup-2-phase-2e-webhook-handler.test.ts` — signature
   verification; dedup; dispatch matrix; dropped-by-flag behaviour.
4. `tests/signup-2-phase-2e-state-machine.test.ts` — state
   transitions enforced; never-permitted transitions refused;
   atomic $transaction wrap.
5. `tests/signup-2-phase-2e-ledger.test.ts` — every state transition
   writes exactly one `PaymentReconciliationEntry`; stable
   idempotency keys; no duplicates on webhook replay.
6. `tests/signup-2-phase-2e-no-production-side-effects.test.ts` —
   grep-sweep: no Stripe-live keys, no production env references,
   no gov-ID surface anywhere.

### 6b Playwright staging acceptance

`tests/e2e/signup-2-phase-2e-mandate-acceptance.staging.spec.ts`
scenarios (fixture-driven, flag OFF for baseline + flag ON for
controlled activation):

- **A.** Mandate route gated: non-PASS_AUTOMATED registration →
  mandate route redirects to the authority page.
- **B.** Fail-closed flag: route returns 503 "coming soon".
- **C.** Full happy path (flag ON): Phase 2D-released registration
  → mandate route hands off to Stripe Checkout (verified by the
  session ID returned in the redirect).  Stripe test-mode mandate
  signing → return URL → `SubscriptionPaymentMandate` + first
  `BillingCycle` written.
- **D.** Webhook dedup: identical event id POSTed twice → one
  `StripeWebhookEvent` row + one state transition.
- **E.** Payment-failed branch: `payment_intent.payment_failed`
  → `BillingCycle.subscriptionStatus = PAYMENT_FAILED` +
  `OperatorInboxEntry(severity=IMMEDIATE)`.

All scenarios use **Stripe test-mode credentials** on a dedicated
`spectre-staging` Stripe account — never Spectre's real merchant
account.

### 6c Regression suites

- SIGNUP-1 + 1F + 2A + 2B + 2C + 2D contract regression remains green.
- Posting-guard adjacent remains green.
- No regression allowed in Phase 2D's three-operator release.

### 6d Placeholder scan clean

Phase 2E surfaces must pass `npm run scan:placeholders`.

---

## 7. External dependencies

### 7a Required BEFORE Phase 2E implementation

Per v3 architecture §11 pre-flight verification doc
(`docs/signup-2-stripe-merchant-verify.md`), four Stripe-merchant
assumptions MUST be confirmed before the first real Stripe call:

1. **Stripe ACSS fee cap** (CAD $5 / transaction) applies to
   Spectre's merchant account.
2. **ACSS `interval` mandate variant** supports annual recurring
   without re-signature.
3. **Stripe `BalanceTransaction.available_on`** is a reliable
   funds-availability gate for ACSS debits.
4. **Stripe-sent debit-notification email** (Rule H1 §20) remains
   default-on and unmodified by Spectre's email settings.

### 7b Required AT Phase 2E implementation

- **Stripe test-mode account** for `spectre-staging` with ACSS
  Debit enabled.
- **Stripe webhook endpoint secret** registered in Stripe Dashboard
  for staging; stored as a Fly secret.
- **Stripe API publishable + secret keys** (test mode) stored as
  Fly secrets.
- **Production ToS** (`docs/legal/terms-of-service-v1.md` with
  `Status: APPROVED`) — Phase 2B gate requires this before any
  live attestation can land; Phase 2E's mandate collection
  inherits that gate.

### 7c Required BEFORE first PRODUCTION run (separate authorisation)

- All of §7a and §7b against Spectre's real merchant account.
- Legal review of mandate copy against Payments Canada Rule H1
  Section 20 wording requirements.
- Operator playbook for payment-failure remediation (Phase 2H).

---

## 8. Outstanding founder decisions

1. **Staging Stripe account**: confirm the staging Stripe account
   is distinct from production + has ACSS Debit enabled.
2. **Card-payment opt-in**: confirm whether cards should ship as
   secondary at Phase 2E launch, or deferred.
3. **Webhook endpoint URL**: Phase 2E proposes
   `/api/webhooks/stripe`; confirm the path.
4. **Signing-secret rotation cadence**: Phase 2E proposes manual
   rotation; confirm.
5. **Operator inbox category labels**: Phase 2E proposes
   `PAYMENT_FLOW`, `PAYMENT_FAILURE`, `DISPUTE`, `REVERSAL`,
   `PROVISIONING_SUCCESS`.  Confirm or specify.
6. **Mandate-signing email language**: Stripe sends in English by
   default per account preference.  Confirm or specify French-
   bilingual requirement.
7. **Phase 2F authorisation timing**: Phase 2E ends at
   `ACTIVATION_READY`; confirm the planning gate for Phase 2F.
8. **ToS approval path**: Phase 2E depends on the production ToS
   being `APPROVED`.  Confirm the legal-review path + timing.

Decisions 1 + 2 + 8 are material to Phase 2E's code surface; the
others are configuration + copy choices.

---

## 9. What this document is + is not

**IS:**
- The Phase 2E planning document, awaiting founder authorisation.
- A reconciliation of v3 architecture §1b, §1c, §1d, §4, §5, §6, §9
  with the Phase 2E boundary.
- A specification complete enough that implementation is a direct
  translation.

**IS NOT:**
- Authorisation to implement.
- A code change.
- A deployment.
- A Stripe API call (test or live).
- A commitment to card payments as a day-1 ship.
- A change to the Phase 2A / 2B / 2C / 2D accepted baselines.
- A Phase 2F or later initiation.

**Awaiting founder authorisation of Phase 2E per Section 6.**
