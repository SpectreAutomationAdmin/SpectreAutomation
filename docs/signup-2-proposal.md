# SIGNUP-2 -- Architecture Decision Document (v2)

**Status.** Architecture research + planning only.  **No code; no
Stripe entities; no DB migrations; no production configuration; no
new application deploys.**  v2 supersedes v1 of this document
(2026-10-25) and incorporates the founder's architecture-review
directive of the same date.

**Dependencies accepted:**
- SIGNUP-1G accepted on staging per founder's 2026-10-25 message.
  Baseline frozen at `sha-fb604f9` on
  `staging-deploy/web1b1-framer-fidelity`, Fly `v865`.
- SIGNUP-1G transactional-mail adapter is Spectre's outbound email
  spine; SIGNUP-2 reuses it for welcome + billing notifications.
- Delegated-authority commercial-authority model in
  [docs/signup-2-commercial-authority-verification.md](signup-2-commercial-authority-verification.md).

**Separately-tracked, untested in SIGNUP-1G** (preserved per
founder directive; not re-opened by this document):
- Real Microsoft work-account signup walkthrough (end-to-end UI).
- Outlook -> Spectre delete-sync convergence under real
  mailbox-integration load.

These are tracked in
[docs/signup-1g-outstanding-untested-scopes.md](signup-1g-outstanding-untested-scopes.md).

---

## 1 Founder-approved product direction (as of 2026-10-25)

| # | Decision | Interpreted architecture impact |
|---|---|---|
| 1 | Annual billing at CAD $38,000 | One `BillingCycle` per year per Club; renewal invoice fires on anniversary. |
| 2 | ACSS Debit preferred; card secondary pending feasibility + cost | Section 2 (fees) + Section 11 (feasibility).  Build primary ACSS path; defer card wire-up to a later gated phase. |
| 3 | Initiate first debit after mandate acceptance; distinguish initiation / settlement / activation | Section 3 (five-event lifecycle) + Section 7 (access policy). |
| 4 | Reuse SIGNUP-1G transactional-mail adapter | Welcome + billing + payment-failure emails go through the dedicated `no-reply@` identity. |
| 5 | In-dashboard operator inbox + email notifications | New operator-inbox feature set.  Section 9. |
| 6 | Daily reconciliation + 30-day exception window | Nightly job + 30-day drift surfacing. |
| 7 | Coulee Ridge for staging validation; production pilots require separate approval | Section 15. |
| 8 | Defer additional pricing tiers + discounts | Keep `SubscriptionPlan` model minimal; one plan row at MVP. |
| 9 | **No government-ID collection or retention** until necessity + legal basis established | Remove the gov-ID branch from the elevated-risk path entirely until a dedicated review authorises it.  Section 10. |
| 10 | Version-pinned terms + authorisation evidence | `SubscriptionAuthorisationAttestation.termsVersionSha256` becomes a required column. |

---

## 2 Verified Stripe facts (sourced + current)

Verified against [stripe.com/en-ca/pricing/local-payment-methods](https://stripe.com/en-ca/pricing/local-payment-methods) and [docs.stripe.com/payments/acss-debit](https://docs.stripe.com/payments/acss-debit) on 2026-10-25.

### 2a Fees

| Instrument | Rate | Fixed fee | Cap | $38K annual cost |
|---|---|---|---|---|
| **ACSS Debit (CA PAD)** | 1 % | CAD $0.40 | **CAD $5.00 per transaction** | **~CAD $6/year** (cap + CAD $1 one-time instant-verification). |
| Card (domestic CA) | 2.9 % | CAD $0.30 | n/a | ~CAD $1,102.30/year. |
| Card (international) | +0.8 % on top of 2.9 % | | | ~CAD $1,406/year. |
| Card (manually entered) | +0.5 % on top of 2.9 % | | | ~CAD $1,292/year. |

The **CAD $5 PAD cap** is the architecturally dominant fact: Stripe's
cost for the primary payment path is bounded at ~CAD $6 per Club
per year regardless of ticket size.  Earlier (v1 of this doc)
estimated ~CAD $380 using the uncapped rate; **that was wrong**.
Card remains >~175x more expensive per Club per year.

### 2b Failure fees

| Event | Fee |
|---|---|
| Failed PAD (NSF, invalid account, stop-payment) | CAD $5.00. |
| PAD dispute | CAD $5.00. |

### 2c Transaction limits

| Instrument | Min | Default max | Hard cap |
|---|---|---|---|
| ACSS Debit | CAD $0.50 | **CAD $999,999.99** per transaction | CAD $9,999,999.99 with Stripe-approved increased limits. |
| Card | varies by issuer | Issuer-controlled | Commercial-card single-authorisation caps commonly $25K-$50K; may require 3DS or issuer pre-approval at $38K. |

**For $38K annual single-debit:** ACSS well within default max; card
is subject to issuer-side ceilings and may require either an issuer
pre-approval call or splitting into quarterly $9,500 debits.

### 2d Settlement timing

| Instrument | Payment success | Funds available | Cutoff |
|---|---|---|---|
| ACSS Debit (standard) | T+4 at 21:00 UTC | T+5 at 00:00 UTC | 17:00 US/Eastern |
| Card | T+2 nominal | T+2 nominal | per Stripe payout schedule |

### 2e Dispute windows

| Account type | Window | Contestable? |
|---|---|---|
| Business bank account disputing a PAD | **10 business days** | **No** -- "no-questions-asked" per Stripe; Stripe's decision is final. |
| Personal bank account disputing a PAD | 90 calendar days | No. |
| Card chargeback | 120 days typical | Yes -- evidence submission allowed. |

### 2f Refund windows

- PAD refunds submitted within 180 days of original payment; processed in ~3 business days.
- Refunds are separate credits, not reversals; statement descriptor references original but is not labelled "refund".

### 2g Automatic retries

Stripe Smart Retries (opt-in per account) retries a failed PAD
**once, within 30 days** of the original attempt.  No retry fee for
Smart-Retry attempts.

### 2h Compliance

- Stripe-hosted mandate collection + Stripe-sent mandate-confirmation email + Stripe-sent debit-notification email collectively satisfy **CPA Rule H1 Sections 19-21** on Spectre's behalf when using Stripe Checkout `mode: "setup"`.
- Stripe is PCI DSS Level 1 certified; Spectre never handles raw bank account numbers for the PAD path.

---

## 3 Lifecycle: five distinct events

The founder's directive explicitly separates these; v2 architects
each as its own observable state transition with its own trigger,
its own invariants, and its own rollback semantics.

| Event | Trigger (Stripe or Spectre) | Observable | Invariants | What CANNOT happen before |
|---|---|---|---|---|
| **1 Authorisation** | Spectre: signatory accepts attestation + accepts Stripe mandate | `SetupIntent.succeeded`; `SubscriptionAuthorisationAttestation` row; `SubscriptionPaymentMandate` row (ISSUED). | No funds move.  Mandate stored.  Attestation SHA-256 locked. | Any debit, any provisioning. |
| **2 Payment initiation** | Spectre: calls `stripe.subscriptions.create(...)` which creates a Subscription + its first invoice; a PaymentIntent is created against the saved PaymentMethod with `idempotency_key = BillingCycle.id` | `BillingCycle` created with status `INITIATED`.  Stripe PaymentIntent exists in state `requires_action` or `processing` (for PAD, directly to `processing`). | PaymentIntent id persists; BillingCycle.stripePaymentIntentId set. | Settlement, activation, revenue recognition. |
| **3 Processing** | Stripe: `payment_intent.processing` webhook (ACSS: Stripe submitted the debit to ACSS network) | `BillingCycle.status = AWAITING_SETTLEMENT`; `charge.pending` emitted; Spectre records `expectedDebitDate`. | Stripe sends debit-notification email (Rule H1 Section 20). | Settlement, activation. |
| **4 Settlement** | Stripe: `payment_intent.succeeded` **AND** `charge.succeeded` for the same PaymentIntent | `BillingCycle.status = SETTLED`.  `BillingCycle.settlementConfirmedAt` set.  Audit emitted. | Spectre records `providerSettlementId` = charge id. | Activation (durable workflow starts here; see Section 6). |
| **5 Activation** | Spectre: durable `TenantProvisioningJob` reaches terminal success | `ClubSubscription.status = ACTIVE`.  Tenant resources exist (`User`, `Club`, `UserClubRole`, seed rows).  Welcome email sent via SIGNUP-1G adapter. | Audit emitted on each step; job rows preserved for post-mortem. | n/a (terminal). |

**Reversible transitions** that break the forward progression are
enumerated in Section 4.

---

## 4 Subscription state machine (defensible; covers failure, return, dispute, reversal)

```
                                 (signatory accepts attestation + mandate)
                   ------------------------------------------------>  AUTHORISED
                                                                             |
                                                            (Spectre creates Subscription + PaymentIntent)
                                                                             v
                                                                        INITIATED
                                                                             |
                                                      (ACSS: payment_intent.processing)
                                                                             v
                                                                 AWAITING_SETTLEMENT
                                                     ______________________|_______________________
                                                    |                                                |
                           (payment_intent.succeeded + charge.succeeded)                 (payment_intent.payment_failed)
                                                    v                                                v
                                                 SETTLED                                        PAYMENT_FAILED
                                                    |                                                |
                                                    v                                                |
                                      (TenantProvisioningJob runs)                                   |
                                                    v                                                |
                                              /--> ACTIVE                                            |
                                            (ok)                                                     |
                                              \__________________________________________           |
                                                                                         \          |
                                                                                          v         v
                                                                           (dispute win./lose,                   (operator contacts Club:
                                                                            NSF reversal within 10bd,            new mandate OR give up)
                                                                            or operator-initiated suspend)                 |
                                                                                                                            v
                                                                           charge.dispute.created                        AT_RISK
                                                                                   |                                        |
                                                                                   v                            ___________|___________
                                                                             DISPUTE_OPEN                      |                       |
                                                                                   |                   (Smart Retry succeeds)   (operator abandons)
                                                                                   v                           |                       |
                                                                   (charge.dispute.closed, non-contestable)    v                       v
                                                                                   |                       SETTLED                CANCELLED
                                                                                   v                       (retry only)
                                                                             REVERSED
                                                                                   |
                                                                                   v
                                                                               SUSPENDED (operator contacts Club)
                                                                                   |
                                                                      _____________|_____________
                                                                     |                           |
                                                              (new mandate accepted +     (Club does not renew)
                                                               fresh BillingCycle paid)          |
                                                                     |                           v
                                                                     v                       CANCELLED
                                                                  ACTIVE
```

**All transitions emit an `audit()` call** with before + after +
actor (user id for operator action, "system/webhook" for
Stripe-triggered) + IP + user agent (where available) + Stripe
event id (where applicable).

**Terminal states:** `ACTIVE`, `CANCELLED`.  All others are
transitional.

**Reversible-from-ACTIVE invariants** (the ones most often missed):

- **PAD NSF reversal after reported settlement.**  Stripe docs
  state: "In rare situations, Stripe receives a PAD failure after
  a PaymentIntent transitions to succeeded.  Stripe then creates
  a dispute with reason `insufficient_funds`."  Our handler for
  `charge.dispute.created` with that reason must transition
  `ACTIVE` -> `REVERSED` -> `SUSPENDED` and preserve tenant data
  (do not teardown).
- **Business-account PAD dispute (10 bd window).**  Same transition.
- **Operator-initiated suspension** (abuse flag, missing document,
  etc.).  `ACTIVE` -> `SUSPENDED` by operator action; audit
  records reason + operator identity.

**Transitions NEVER permitted:**
- `ACTIVE` -> `AUTHORISED` (cannot un-pay).
- `ACTIVE` -> `INITIATED` (cannot restart a cycle; cancel + fresh
  cycle instead).
- `REVERSED` -> `SETTLED` (cannot un-reverse; must create a new
  BillingCycle on a fresh mandate).
- Direct `INITIATED` -> `ACTIVE` without passing through
  `AWAITING_SETTLEMENT` + `SETTLED`.

---

## 5 Webhook ordering, dedup, reconciliation, idempotency

### 5a Reality of Stripe webhook delivery

Three facts drive the design:

1. **At-least-once delivery.**  Stripe retries failed webhook
   deliveries for up to 3 days.  Spectre MUST deduplicate by
   `event.id`.
2. **Out-of-order delivery.**  Stripe does NOT guarantee event
   ordering.  Our handlers must not assume event A arrives before
   event B even if A logically precedes B.
3. **Chargeable events can arrive out-of-sequence with lifecycle
   events.**  `charge.dispute.created` can arrive while
   `payment_intent.succeeded` is still in flight (rare but
   documented).

### 5b Deduplication

```prisma
model StripeWebhookEvent {
  id            String   @id          // Stripe event.id
  eventType     String
  receivedAt    DateTime @default(now())
  processedAt   DateTime?
  processingResult String?            // "success" | "noop" | "failed"
  payloadJson   String                // the raw Stripe payload for audit/replay
  @@index([eventType, receivedAt])
}
```

The webhook route's first act is `prisma.stripeWebhookEvent.create({...}, {skipDuplicates: true})`.  If `event.id` is already present, the handler returns 200 immediately -- it is a replay.

### 5c Ordering tolerance

Each handler is **state-transition idempotent**.  The handler for
`payment_intent.succeeded` reads the current `BillingCycle.status`
and either:
- Advances to `SETTLED` if currently `AWAITING_SETTLEMENT` or
  `INITIATED` (forward transitions).
- Logs a noop + audit if currently `SETTLED` (duplicate).
- Logs a warning + audit if currently `PAYMENT_FAILED` or beyond
  (out-of-order; investigate).

The handler for `charge.dispute.created` tolerates `BillingCycle.status`
being anything from `INITIATED` upward.

**Explicit state preconditions for each event type** live in a
single table-driven service (`src/lib/billing/stripe-webhook-router.ts`
in the SIGNUP-2 implementation), so the ordering rules are reviewable
in one place rather than scattered across handler files.

### 5d Idempotency keys outbound

- `stripe.paymentIntents.create` -- idempotency_key = `BillingCycle.id`.
- `stripe.subscriptions.create` -- idempotency_key = `clubId + "subscription-create"`.
- `stripe.customers.create` -- idempotency_key = `clubId + "customer-create"`.
- `stripe.refunds.create` -- idempotency_key = `BillingCycle.id + "refund"`.

Retrying any outbound Spectre -> Stripe call returns the original
Stripe entity, not a duplicate.

### 5e Daily reconciliation

Scheduled worker job: once per 24h, for every `BillingCycle` where
`status IN ('INITIATED', 'AWAITING_SETTLEMENT', 'DISPUTE_OPEN')`
AND `createdAt > now() - 30 days`:

1. Fetch the Stripe PaymentIntent + Charge state.
2. If Stripe says `succeeded` but Spectre says `AWAITING_SETTLEMENT`:
   emit `spectre.billing.reconciliation.missed_settlement` audit
   event + attempt to replay the `payment_intent.succeeded`
   webhook handler.
3. If Stripe says disputed but Spectre has no `DISPUTE_OPEN`:
   emit `spectre.billing.reconciliation.missed_dispute` + queue
   operator notification.
4. If Stripe says `canceled` but Spectre says `AWAITING_SETTLEMENT`:
   emit `spectre.billing.reconciliation.stale_initiated` +
   transition to `PAYMENT_FAILED`.

30-day window matches the founder-approved exception-review
framework.  Older `BillingCycle` rows go through a monthly
longitudinal audit instead.

---

## 6 Durable tenant provisioning workflow

**Correction from v1:** v1 claimed tenant provisioning + `ClubSubscription.ACTIVE`
transition could run inside the same DB transaction as the
`payment_intent.succeeded` webhook handler.  **That's wrong.**  Reasons:

- Stripe webhook delivery is at-least-once; the handler may fire
  multiple times.
- Tenant provisioning has effects OUTSIDE the DB transaction
  boundary: welcome-email send through the SIGNUP-1G adapter,
  seed-data loader, media + storage initialisation, future
  integration hooks (Microsoft 365, Google Workspace, etc.).
- An external-call failure mid-transaction cannot be rolled back.

**v2 design: a durable, retryable workflow row.**

```prisma
model TenantProvisioningJob {
  id                    String   @id @default(cuid())
  billingCycleId        String   @unique                     // trigger key
  billingCycle          BillingCycle @relation(fields: [billingCycleId], references: [id])
  signupRegistrationId  String                               // where to find the identity + attestation
  state                 String                               // CREATED | USER_CREATED | CLUB_CREATED | ROLES_ASSIGNED | SEED_DONE | EMAILED | COMPLETED | FAILED
  attempts              Int      @default(0)
  nextAttemptAt         DateTime?
  lastError             String?
  completedAt           DateTime?
  // Each step records its own idempotency keys:
  provisionedUserId     String?
  provisionedClubId     String?
  seedBatchSha256       String?
  welcomeEmailProviderMessageId String?

  @@index([state, nextAttemptAt])
}
```

- Row created when `payment_intent.succeeded` fires AND
  `BillingCycle` transitions to `SETTLED`.  Creation is idempotent
  via `billingCycleId` uniqueness.
- A worker loop picks up rows with `state != COMPLETED` and
  `nextAttemptAt <= now()`, advances the state machine one step
  at a time, and records progress.  Each step is idempotent
  (uses deterministic keys like `clubId = signupRegistrationId`-derived).
- On `FAILED` with retriable error: `nextAttemptAt = now() + backoff`
  (exponential, max 1 h).
- On `FAILED` with non-retriable error: operator notification; row
  stays `FAILED` until operator intervenes.
- `COMPLETED` transition emits the `ClubSubscription.ACTIVE`
  update + welcome email + audit.

**This is the ONLY code path that moves `ClubSubscription` to
`ACTIVE`.**  Webhook handlers never do; API routes never do;
operator shortcuts route through the same job service.

---

## 7 Policy recommendation: access relative to settlement

Three options.  The founder's directive (item 3) requires an
explicit recommendation.

| Policy | Access gates on | Pros | Cons | NSF/dispute exposure |
|---|---|---|---|---|
| **Strict** | `charge.succeeded` only | No wrong-granted access; cleanest book-keeping. | ~5 business-day wait from authorisation to access.  Poor onboarding UX. | Zero. |
| **Provisional** | `payment_intent.processing` + mandate accepted | T+0 access.  Matches Club expectations ("I signed up today, I expect to use it today"). | NSF at T+4 means revoking access on an active Club. | ~10 bd (business dispute window) + ~1% NSF rate on first debits per Stripe industry data. |
| **Staged** | Dashboard + read-only on mandate acceptance; full write on `charge.succeeded` | T+0 limited access; strict safety on provisioning. | More UI state to maintain; Club gets a confusing partial experience for 5 days. | Low; limited write-paths available during provisional phase. |

**Recommendation: Provisional access with mandatory revocation guarantee.**

- Access provisioned at `payment_intent.processing`.
- `ClubSubscription.status = AWAITING_SETTLEMENT` is visible to
  Club in a dismissible banner ("Your first payment is in flight.
  Expected to clear by <date>.").
- If `payment_intent.payment_failed` arrives (NSF, invalid account),
  the `TenantProvisioningJob` state advances to `SUSPENDED`;
  dashboard writes are frozen; dashboard reads remain for 7 days
  while operator contacts Club.
- If a dispute arrives post-`ACTIVE` within the 10 bd window: same
  `SUSPENDED` transition.
- After operator remediation (new mandate + fresh BillingCycle
  settled), access is restored by the normal `ACTIVE` transition.
- After 7 days in `SUSPENDED` with no remediation: `CANCELLED`;
  tenant data retained per CPA + Spectre retention policy; access
  closed.

Reasoning: The $38K annual commitment + delegated-authority
attestation + CPA Rule H1 mandate collectively make hard-fraud
scenarios rare; the adapter interface + state machine already
support clean revocation; and T+0 access is table stakes for a
B2B SaaS onboarding experience.  The Spectre operator inbox
(decision 5) gives Spectre an immediate signal when the
exceptional case arises.

The founder may elect "Strict" if the operations team wants zero
retroactive-revocation risk; "Staged" if a middle ground is
desired.  Flag this as an **open decision requiring an explicit
call before Phase 2A implementation.**

---

## 8 Canadian PAD mandate obligations

### 8a CPA Rule H1 (the governing payment-system rule)

- **Section 19 -- Mandate requirements.**  Mandate must capture
  payor name, payee name, payor bank + branch + account, debit
  amount or variable-amount cap, frequency, authorisation date,
  payor's cancellation rights.  **Stripe-hosted Checkout satisfies
  all of these**; Spectre persists only the acceptance context.
- **Section 20 -- Pre-notification.**  Payor must be notified
  before each debit.  Stripe sends debit-notification emails
  automatically.  **Spectre must NOT disable Stripe emails** on
  the account.
- **Section 21 -- Cancellation.**  Payor can cancel the mandate at
  any time.  Spectre operator surface implements the cancellation
  path.

### 8b PIPEDA + provincial privacy laws

- Signatory personal information in attestation + mandate records
  is "commercial" information under PIPEDA (not personal health,
  not minor); standard Spectre privacy posture suffices.
- Bank account numbers: Stripe stores (encrypted at rest, PCI DSS
  Level 1); **Spectre never stores raw bank account numbers**.
  Spectre stores only Stripe PaymentMethod id + Mandate id.
- Signatory email + IP + user agent: retained in attestation record
  for 7 years post-mandate end (regulatory retention) under
  Spectre's existing retention schedule.

### 8c Identity verification

Per the founder's decision 9: **no government-ID collection or
retention in SIGNUP-2**.  The delegated-authority model relies on:
- Microsoft-verified work-account identity (SIGNUP-1).
- Club affiliation signal (website domain OR tenant domain OR
  prior Spectre record).
- Self-declared role + contractual-authority attestation (SHA-256
  locked).
- Entity standing (ACTIVE / IN GOOD STANDING at authorisation).

If a specific risk signal later demands stronger identity proofing,
a dedicated review (and SIGNUP-2.1 slice, not inside SIGNUP-2) will
authorise it under a clear legal basis.

### 8d Record retention

| Record | Retention | Trigger |
|---|---|---|
| `SubscriptionAuthorisationAttestation` | 7 years after `ClubSubscription.CANCELLED` | Rule H1 + Spectre contract retention. |
| `SubscriptionPaymentMandate` | 7 years after `revokedAt` | Rule H1 Section 23. |
| `BillingCycle` + webhook events | 7 years after cycle end | Spectre contract retention. |
| `TenantProvisioningJob` | 2 years after `COMPLETED` or `FAILED` | Audit retention; shorter because the subscription record owns the authoritative state. |

---

## 9 Operator surface (founder decision 5)

Spectre's in-dashboard operator inbox plus email notifications.

Minimum SpectreAdmin screens needed for SIGNUP-2 launch:

- **Signatory review.**  List of registrations where classifier
  returned `NEEDS_MANUAL_REVIEW` or `ESCALATED`.  Reviewer sees
  evidence packet + can release / reject.
- **Mandate review.**  List of `SubscriptionPaymentMandate` rows
  with `revokedAt=null`; operator can revoke on abuse signal.
- **Reconciliation drift board.**  Rows from Section 5e's audit
  events; operator triages + resolves.
- **Tenant-provisioning job board.**  Rows from Section 6; operator
  retries, intervenes, or marks `FAILED` permanently.
- **Manual-invoice workflow.**  Operator records cleared funds +
  authorises tenant provisioning off the Stripe path.
- **At-risk / suspended Clubs board.**  Rows from the state machine
  Section 4; operator contacts Club.

Each screen gates on an operator-level RBAC permission (TBD during
Phase 2H).

Email notifications go to a configurable Spectre operator
distribution list via the SIGNUP-1G adapter (decision 4).

---

## 10 Data model (updated from v1)

### 10a `SubscriptionAuthorisationAttestation`

```prisma
model SubscriptionAuthorisationAttestation {
  id                       String   @id @default(cuid())
  signupRegistrationId     String   @unique
  clubId                   String?                        // backfilled on provisioning
  signatoryFullName        String
  signatoryTitle           String
  clubLegalName            String
  attestationTextHash      String                          // SHA-256 of exact clicked text
  attestationTextLength    Int
  termsVersionSha256       String                          // founder decision 10: version-pin ToS
  termsVersionLabel        String                          // e.g. "ToS-v3-2026-10-25"
  acceptedAt               DateTime
  acceptedIp               String?
  acceptedUserAgent        String?
  acceptedByMicrosoftOid   String?
  acceptedByMicrosoftTid   String?
}
```

Immutable; append-only.

### 10b `SubscriptionPaymentMandate` -- unchanged shape from v1

(See prior architecture note.)

### 10c `EntityStandingCheck`

Captures standing (`ACTIVE | NOT_ACTIVE | NOT_FOUND`) + fetched
registry payload.  Signatory-vs-officer match recorded as a soft
signal.

### 10d `BillingCycle` -- extended

- `status`: enum covering every state in Section 4.
- `source`: `STRIPE_ACSS | STRIPE_CARD | MANUAL_INVOICE`.
- `stripePaymentIntentId`, `stripeChargeId`.
- `expectedDebitDate`, `settlementConfirmedAt`,
  `reversedAt`, `reversalReason`.
- `periodLabel` already unique per Club.

### 10e `ClubSubscription` -- extended

- `status`: `AUTHORISED | INITIATED | AWAITING_SETTLEMENT | ACTIVE | SUSPENDED | AT_RISK | REVERSED | CANCELLED | MANUAL_INVOICE`.
- `firstSettlementAt`, `nextRenewalAt`.
- `source` mirrors `BillingCycle.source`.
- `operatorNotes` for suspension/cancellation reason.

### 10f `TenantProvisioningJob`

See Section 6.

### 10g `StripeWebhookEvent`

See Section 5b.

---

## 11 Stripe vs alternatives (long-term architecture question)

The founder's directive asks: **Is Stripe the best long-term
architecture for Spectre's internally controlled payments
experience?**

### 11a What makes Stripe the current recommendation

- **Already integrated.** Adapter at [src/lib/billing/index.ts](../src/lib/billing/index.ts)
  compiles today.
- **ACSS cost cap at CAD $5/transaction** means fee advantage over
  Rotessa/Plooto is nominal at Spectre's scale.
- **Dispute + mandate tooling** is substantially more mature than
  Rotessa / Plooto.
- **Developer experience** (SDK, test clock, docs, webhook
  reliability) is excellent.
- **Compliance posture.** PCI DSS Level 1; Rule H1 handled by
  Stripe for us.
- **Spectre's engineering throughput.** Building against Rotessa
  or Plooto would cost ~2-3 engineering weeks of mandate +
  reconciliation code that Stripe gives us for free.

### 11b Credible alternatives (summarised; detailed comparisons below)

| Provider | Fee at $38K annual | API maturity | PAD coverage | Dispute tooling | Build cost to swap |
|---|---|---|---|---|---|
| **Stripe (current)** | ~CAD $6 | Excellent | CA + US | Excellent | 0 |
| **Rotessa** | ~CAD $0.50-$1.49 per debit | Good; dev-first | CA + US only | Fair | ~2-3 weeks |
| **Plooto** | ~CAD $0.50 per debit | Fair; B2B-focused | CA + US only | Fair | ~3-4 weeks |
| **Direct bank integration** (RBC / BMO / etc.) | ~CAD $0.00-$0.25 | Poor; FIX / batch files | CA | Poor | ~6-12 weeks + compliance review |
| **Chargify / Maxio** (billing layer over Stripe) | +Chargify subscription fee + Stripe underneath | Good; subscription-first | CA + US | Good (via Stripe) | ~1 week |

### 11c Total cost analysis

Assume Spectre scales to **100 Clubs** at $38K/year.  Total
annual revenue: $3.8M.

| Provider | Annual fee cost | Fee as % of revenue |
|---|---|---|
| Stripe ACSS Debit | $600 | 0.016% |
| Rotessa | ~$150 | 0.004% |
| Plooto | ~$50 | 0.001% |
| Direct bank | ~$25 (bank fees) | 0.001% |

At 100 Clubs, the fee delta between Stripe and the cheapest
alternative is ~$575/year.  **Engineering cost to switch** (one-time
~$30-50K in staff time + ~$10K/year ongoing in dispute-handling
operator time) **dominates the fee delta until Spectre reaches
roughly 10,000 Clubs**.

### 11d Recommendation

**Stay on Stripe for the foreseeable future.**  Spectre's adapter
interface in [src/lib/billing/index.ts](../src/lib/billing/index.ts)
is already provider-agnostic; a future swap to Rotessa or Plooto
is cheap when the business case justifies it.  Revisit at:
- 1,000 Clubs (would still be <$10K/year fee advantage; probably not).
- 10,000 Clubs (fee advantage becomes material; dispute workload
  may justify Rotessa's manual-ops cost structure).
- Any point where Stripe's dispute policy (10 bd, non-contestable)
  becomes an operational bottleneck.

**Interim mitigation:** every architectural choice SIGNUP-2 makes
is written through the `BillingProvider` adapter interface so
provider swap stays tractable.

---

## 12 Risks + mitigations (updated)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| First-debit NSF | Industry baseline ~1-2% for new PADs | Operator time + 5-10 bd re-attempt | Smart Retries once; `SUSPENDED` state preserves tenant; operator contacts Club. |
| Business-account dispute 10 bd window | Rare at B2B scale | Full reversal + CAD $5 fee | Dispute handler flips to `REVERSED` -> `SUSPENDED`; tenant preserved. |
| Signatory impersonation | Low | Legal exposure; charge reversal | Attestation records SHA-256 of clicked text + Microsoft `oid`; dispute defence relies on this record. |
| Webhook out-of-order delivery | Possible | Incorrect state transition | Per-handler state preconditions; reconciliation job catches drift within 24 h. |
| Webhook replay | Routine (Stripe retry) | Duplicate side effects | `StripeWebhookEvent.id` dedup table + skipDuplicates insert. |
| Tenant provisioning side effect fails after `SETTLED` | Realistic (email, seed) | Club paid but no tenant | Durable `TenantProvisioningJob` with per-step idempotency; operator retry. |
| Stripe secret rotation drops webhooks | Possible | Up to 1 h of missed events | Reuse SIGNUP-1G credential-rotation runbook; staging verification required; reconciliation catches drift. |
| Fly deploy of Stripe secret duplicates SIGNUP-1G BOM injection | Avoided | n/a | Reuse `scripts/signup-1g-fly-secrets-activate.ps1` (already proven; UTF-8-no-BOM transport fix in place). |
| Reconciliation drift silently diverges | Possible on webhook infra failure | Missed revenue or missed revocation | Nightly reconciliation + 30-day exception window; operator inbox surface. |
| Access revoked wrongly on false-positive dispute | Rare | Club disruption | 7-day `SUSPENDED` window with read access + operator-initiated restore. |
| Secret or mandate text leaks | Low | Regulatory + reputational | Reuse SIGNUP-1G Fly log scan; audit coverage; private-key material lives only in Stripe + Fly. |
| ToS version drift | Low | Legal uncertainty | `termsVersionSha256` locked in attestation record. |

---

## 13 Implementation phases (revised)

| Phase | Scope | Acceptance gate | Can begin without further decision? |
|---|---|---|---|
| **2A** Schema + state machine (no Stripe calls) | Models in Sections 5b, 6, 10; state-machine service with contract tests; Prisma migrations (dual schema) | Contract tests green; audit coverage asserted; typecheck + regression | Yes (schema-only). |
| **2B** Attestation surface | `/signup/t/<token>/authority` UI; attestation write path with text-SHA-256 lock; audit | Playwright: full attestation walk; attestation record immutable | Yes. |
| **2C** Entity standing check | Jurisdiction registry adapter (ON + BC day one); EntityStandingCheck row | Registry round-trip end-to-end for one adapter | Needs registry API decision per province. |
| **2D** Stripe adapter extensions | `BillingProvider` interface widened; stripe npm dynamic-import stays dormant until `SPECTRE_BILLING_PROVIDER=stripe`; mock-provider parity | Adapter contract tests; mock deterministic | Yes. |
| **2E** Mandate capture | `/signup/t/<token>/mandate` page launches Stripe Checkout `setup` mode; return handler persists `SubscriptionPaymentMandate` | Stripe TEST mode walk; mandate text SHA-256 recorded | Yes (needs Stripe TEST key configured). |
| **2F** Payment initiation + processing + settlement | Webhook router + idempotent handlers for 7 event types; Stripe test clock advances T+4 | Playwright + contract tests; reconciliation job runs | Yes. |
| **2G** Durable tenant provisioning | `TenantProvisioningJob` + worker loop; welcome email via SIGNUP-1G | Full acceptance walk end-to-end on Coulee Ridge staging | Yes. |
| **2H** Operator surface | SpectreAdmin screens from Section 9 | Operator walkthrough + RBAC enforcement verified | Yes. |
| **2I** Reconciliation + alerting | Nightly reconciliation; audit emission; operator inbox + email notification | Induced drift surfaces within 24 h | Yes. |
| **2J** Production readiness | Stripe LIVE account; PAD capability review; Fly production secrets; first pilot Club | Founder approves pilot list | Blocked on founder approval + production authorisation. |

**Milestones:**
- Internal engineering estimate: 2A-2I ≈ 4-6 engineering weeks for a focused slice; 2J + pilot runway adds 2-4 weeks of real-time dependencies (Stripe LIVE provisioning timeline, bank verification by first Club).
- Each phase ships through DRH-1 to staging; each has its own
  acceptance evidence doc.

---

## 14 Remaining founder decisions (reduced from v1's list)

The founder's 10 decisions on 2026-10-25 settled most of v1's open
items.  Remaining:

1. **Access policy at settlement** (Section 7): Provisional
   (recommended), Strict, or Staged?
2. **Dispute rate monitoring threshold** (Section 12): at what
   per-100-cycle dispute rate does Spectre escalate from
   PAD-primary onboarding to card-only or manual-review-only?
   (Recommend >= 2 disputes per 100 cycles over any trailing 90
   days triggers review.)
3. **Operator notification channel implementation** (Section 9):
   in-dashboard inbox + email was approved; is email per-event
   OR daily digest acceptable for routine events?  (Recommend
   per-event for `SUSPENDED` / `AT_RISK` / `FAILED`; daily
   digest for `AUTHORISED` / `SETTLED` activity.)
4. **PAD mandate variant** (Section 2 of the architecture doc):
   Stripe supports `interval`, `sporadic`, `combined`.  Recommend
   `interval` for the one annual debit (simplest Rule H1
   compliance; renewal auto-charges on anniversary).
5. **First-renewal lead time for signatory notification.**
   Annual renewal: 30 days ahead? 14 days? 7 days?  Current
   Stripe Billing default is 7 days before invoice fires.
   Recommend 30 days ahead per founder preference pattern on
   invoicing.
6. **Terms-of-service document location and versioning.**
   Where in the repo does the signed-at-authorisation terms
   document live?  Must be versioned so `termsVersionSha256`
   is reproducible.

Each is a product decision.  None blocks Phases 2A-2E (schema +
attestation + mandate capture); they're required by 2F-2I.

---

## 15 Staging strategy (Coulee Ridge)

Per founder decision 7:

- **Coulee Ridge is the staging validation tenant.**  Every
  SIGNUP-2 Playwright spec provisions a scratch registration
  that eventually attaches to Coulee Ridge's existing tenant for
  convenience, OR to a dedicated SIGNUP-2 scratch tenant.
- **Hard invariant: no SIGNUP-2 test writes to Coulee Ridge's
  real production accounting / COA / payroll data.**  Dedicated
  scratch records; cleanup after each spec; snapshot/restore
  pattern analogous to signup-1-conditional-acceptance.
- **Production pilot clubs: separate approval.**  Phase 2J gates
  on founder-named pilot list + explicit production rollout
  authorisation.

---

## 16 What SIGNUP-2 does NOT touch (preserved from v1)

- SIGNUP-1G frozen code paths per
  [memory/project_signup_1g_accepted.md](../memory/project_signup_1g_accepted.md).
- Delegated OAuth app (client-id prefix `b7f855a6`) scopes +
  redirect URIs.
- Spectre's existing accounting / GL / AP / AR / payroll modules.
- Production tenants until explicit Phase 2J authorisation.
- Member-portal + white-label branding.
- Government-ID collection or retention (per founder decision 9).

---

## 17 Authorisation requested

**This document is authorisation for architecture research +
planning only.  It is NOT authorisation to implement.**

Before Phase 2A begins:
- Founder confirms this revised architecture (or requests further
  revisions).
- Founder answers the six remaining decisions in Section 14 (or
  accepts the recommended defaults).

No code written, no Stripe entities created, no DB migration run,
no production configuration changed, no new app code deployed
until that explicit approval.
