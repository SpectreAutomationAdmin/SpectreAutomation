# SIGNUP-2 · Payment Architecture Assessment

**Status.** Documentation only.  Assesses Spectre's existing
Stripe integration and the Canadian business bank-debit landscape
for the $38,000 CAD annual subscription that SIGNUP-2 will
authorise.  **No code is modified by this document.**  No live
payment authorisation is created.  Fulfils item (4) of the
SIGNUP-1F adjustment directive.

**Instrument scope.** The payment conversation covers two
instrument classes:

- **Card** — commercial corporate / debit cards.  Stripe-native.
- **Bank debit** — Canadian Pre-Authorized Debit (PAD).  Stripe-
  native via **Stripe ACSS Debit** (Automated Clearing Settlement
  System — the CPA Rule H1 PAD mechanism that applies to all
  Canadian direct debits from a Canadian bank account).

The two are not mutually exclusive — Stripe can carry both on
the same `Customer` and `Subscription`.

---

## 1 · Existing Spectre Stripe integration

### 1.1 · What is already in the codebase

[src/lib/billing/index.ts](../src/lib/billing/index.ts) exposes
an adapter interface + two implementations:

- `mockBillingProvider` — default; deterministic; used in all
  tests.
- `stripeBillingProvider({apiKey, webhookSecret})` — dynamic-
  imports `stripe`.  Supports: `createCustomer`,
  `createCheckoutSession` (`mode: "subscription"`),
  `verifyWebhook` (standard `webhooks.constructEvent` signature
  check).
- `selectProvider(clubId?)` picks the provider from
  `SPECTRE_BILLING_PROVIDER` + `STRIPE_API_KEY` +
  `STRIPE_WEBHOOK_SECRET` env or per-club secrets.
- Webhook handling at
  [src/app/api/integrations/billing/webhook/route.ts](../src/app/api/integrations/billing/webhook/route.ts).

Schema side ([prisma/schema.prisma#L8425](../prisma/schema.prisma#L8425)):

- `ClubSubscription` — status (`PILOT | ACTIVE | ...`), planId,
  activatedAt, cancelledAt.
- `BillingCustomer` — external customer id + provider name per
  club.
- `BillingCycle` — periodic billing bucket (`OPEN | INVOICED |
  PAID | VOIDED`).
- `SubscriptionPlan` + `UsageMetric` — plan catalogue + usage.
- Phase 11B webhook-secret-rotation infrastructure.

### 1.2 · What it does NOT cover today

- No Canadian ACSS PAD (bank-debit) wiring — the adapter uses
  Stripe Checkout in `subscription` mode without an explicit
  `payment_method_types` restriction, which defaults to card
  only.
- No mandate persistence model.  Stripe stores the mandate; a
  Spectre-side `PaymentMandate` row (mandate id + accepted-at
  timestamp + signatory oid) is not yet present and will be
  needed for CA regulatory compliance.
- No returned-payment / NSF reconciliation path.  The webhook
  switchboard handles `invoice.paid` / `invoice.payment_failed`
  conceptually; the specific accounting-side downstream actions
  are not yet implemented.
- No renewal lifecycle tests at the $38K-CAD annual boundary.
- The $38K-CAD-per-year `Price` object does not exist in Stripe
  yet.  SIGNUP-2 will need to create it before any club can be
  authorised against it.

---

## 2 · Payment-instrument assessment for the $38,000 CAD annual commitment

### 2.1 · Card (Stripe `card`)

| Dimension | Finding |
|---|---|
| Technical fit | Supported directly through the existing adapter. |
| Transaction limits | No Stripe hard cap at $38K CAD.  Individual commercial-card issuers set per-transaction authorisation ceilings that may apply (common commercial cards: $25K–$50K default, higher on request). |
| Authorisation mandate | SCA-equivalent at the card issuer; mandate is implicit in checkout. |
| Settlement delay | T+2 business days (Canadian corridor; USD-equivalent T+2 also). |
| Returned payments | Chargeback window is 120 days from transaction (card-brand standard).  Chargeback fee ~CAD $20 at Stripe. |
| Renewal | Native Stripe recurring billing on the subscription.  Automatic card re-authorisation at each renewal. |
| Reconciliation | `invoice.paid` webhook → Spectre `BillingCycle.PAID`.  Already covered by the adapter contract; needs explicit downstream wiring to GL. |
| Risks specific to $38K | Issuer may reject the single authorisation on principal-card policy.  Mitigation: break into quarterly instalments (would need a plan-side change) OR default to bank debit. |

### 2.2 · Canadian bank debit (Stripe ACSS Debit — PAD)

| Dimension | Finding |
|---|---|
| Technical fit | Stripe-native via `payment_method_types: ["acss_debit"]` on Checkout Session / PaymentIntent / SetupIntent + `mandate_options` on the ACSS Debit payment method. |
| Transaction limits | No Stripe hard cap on PAD; CPA Rule H1 governs; practical issuer-side limits apply (clubs' banks often set daily / monthly cap ~CAD $100K unless adjusted). |
| Authorisation mandate | Required per CPA Rule H1: Spectre must capture a Pre-Authorized Debit mandate signed by an authorised signatory of the Club, holding:  payor name + payee (Spectre Automation) + payor bank account + debit amount or variable-amount cap + frequency + authorisation date + payor's right to cancel.  Stripe generates the mandate text + delivers an email copy to the payor on acceptance (satisfies H1 §19).  Mandate id persists on the Stripe PaymentMethod. |
| Settlement delay | 5 business days nominal + probation effect: first debit from a new mandate is held up to 10 business days by Stripe's own risk hold; subsequent debits revert to 5 business days.  Material: Spectre's first ACSS debit for a new Club will typically clear ~2 weeks after authorisation. |
| Returned payments | NSF / stop-payment / closed-account returns possible up to 90 days after settlement (CPA Rule H1 §21).  Return event appears as `charge.failed` + `payment_intent.payment_failed` on the webhook stream.  Standard return fee at Stripe + the Club's bank. |
| Renewal | Native Stripe recurring billing; the mandate is a stored PaymentMethod and auto-charges at each annual cycle.  Variable-amount PAD mandates permit renewal-time pricing changes without a new signature IF the Club has agreed to a variable-amount mandate; otherwise a new signed mandate is needed on any amount change. |
| Reconciliation | Dual-event: webhook on debit initiation (`payment_intent.processing`) + webhook on settlement (`payment_intent.succeeded`).  Spectre needs to NOT mark `BillingCycle.PAID` on `processing` — only on `succeeded`.  This is a reconciliation-logic detail SIGNUP-2 must implement correctly. |
| Risks specific to $38K | Issuer-side bank limits are the main risk; most commercial accounts handle $38K annual without pre-arrangement.  Return-rate exposure is highest at renewal if the Club's banking details have drifted. |

### 2.3 · Chosen instrument strategy

**Recommend ACSS Debit as the primary instrument** for CA
club subscriptions, with **commercial card as the operator-
elected alternative** for Clubs that prefer card:

- Lower fees at scale (CAD $0.68 flat + 1% Stripe fee on ACSS
  Debit vs 2.9% + CAD $0.30 on card).
- Fits private-club back-office posture (clubs pay suppliers
  via EFT / PAD routinely; card-per-transaction is an
  outlier).
- Aligns with the delegated-authority model in
  [docs/signup-2-commercial-authority-verification.md](signup-2-commercial-authority-verification.md):
  the Controller / GM / Treasurer who authorises the
  subscription is the same principal who authorises PAD on
  the Club's bank account.

Card remains supported for Clubs whose Controller prefers it
(or whose bank has not been set up for PAD).  Both routes
share the same `BillingCustomer` / `BillingCycle` plumbing.

---

## 3 · Mandate persistence model (planned — DO NOT implement in SIGNUP-1F)

To satisfy CPA Rule H1 record-keeping and give Spectre an
auditable trail of the PAD authorisation:

```prisma
model SubscriptionPaymentMandate {
  id                       String   @id @default(cuid())
  clubId                   String
  club                     Club     @relation(fields: [clubId], references: [id])
  signupRegistrationId     String?
  // Stripe PaymentMethod id (e.g. "pm_1Ox...") carrying the
  // ACSS Debit mandate.
  stripePaymentMethodId    String   @unique
  // Stripe Mandate id (e.g. "mandate_...").
  stripeMandateId          String   @unique
  mandateType              String   // "ACSS_DEBIT" | "CARD"
  mandateVariant           String   // "SINGLE_AMOUNT" | "VARIABLE_AMOUNT" (ACSS only)
  acceptedAt               DateTime
  acceptedByUserId         String?
  acceptedByMicrosoftOid   String?
  acceptedIp               String?
  acceptedUserAgent        String?
  // Snapshot of the mandate text at acceptance time (SHA-256
  // digest + length; Stripe stores the body).
  mandateTextHash          String
  mandateTextLength        Int
  // Expiry / revocation.
  revokedAt                DateTime?
  revokeReason             String?

  @@index([clubId, acceptedAt])
}
```

Why not rely solely on Stripe's record: an auditor dispute or
reconciliation incident can escalate faster when Spectre has
its own authoritative record of who accepted the mandate from
which identity + IP.

---

## 4 · Webhook handling for SIGNUP-2 payment lifecycle

The adapter contract already covers `verifyWebhook`.  SIGNUP-2
must handle (at minimum) these event types:

| Event | SIGNUP-2 behaviour |
|---|---|
| `setup_intent.succeeded` | Mandate captured; store `SubscriptionPaymentMandate`; move `ClubSubscription` from `PENDING_AUTHORISATION` → `ACTIVE_PENDING_FIRST_DEBIT`. |
| `payment_intent.processing` | First debit initiated.  Do NOT mark `BillingCycle.PAID`; mark `AWAITING_SETTLEMENT`. |
| `payment_intent.succeeded` | Settlement confirmed.  Mark `BillingCycle.PAID`. Audit; emit internal event for GL posting. |
| `payment_intent.payment_failed` | NSF / return.  Mark `BillingCycle` as `FAILED`; schedule retry per Stripe Smart Retries OR notify Spectre operator for direct Club contact. |
| `invoice.paid` (card) | Annual card charge succeeded.  Mark `BillingCycle.PAID`. |
| `invoice.payment_failed` (card) | Card declined.  Trigger retry schedule; notify operator. |
| `customer.subscription.updated` | Status / cancellation / renewal — reconcile `ClubSubscription`. |
| `customer.subscription.deleted` | Mark `ClubSubscription.CANCELLED` + archive. |
| `charge.refunded` | Reconciliation only — rare in SaaS subscription context but must be handled gracefully. |

Each handler is a thin pure function; the switchboard is
already in
[src/app/api/integrations/billing/webhook/route.ts](../src/app/api/integrations/billing/webhook/route.ts).
SIGNUP-2 adds the specific case branches.

---

## 5 · Alternatives considered (and set aside for SIGNUP-2 launch)

- **Rotessa / Plooto / Interac eTransfer / direct EFT.**  All
  viable Canadian PAD providers.  Rotessa and Plooto both have
  smaller fee stacks than Stripe at CA scale.  Rejected for
  SIGNUP-2 launch because:
  1. Spectre already carries the Stripe integration surface
     (adapter + webhook + schema).
  2. Stripe's reconciliation API, mandate storage, and dispute
     tooling are substantially more mature than Rotessa /
     Plooto for a SaaS-subscription use case.
  3. Switching provider later is cheap at the Spectre layer
     (the `BillingProvider` interface is adapter-based) if the
     fee stack starts hurting at larger club counts.
- **Manual invoiced wire / cheque.**  Supported as a human-
  operated fallback for a specific Club that cannot
  authorise PAD or card.  SIGNUP-2 reserves a
  `MANUAL_INVOICE` option on the `ClubSubscription` flow for
  this edge case; it exists outside the Stripe pipeline and
  requires a Spectre operator to mark the cycle paid on
  receipt of cleared funds.

---

## 6 · Compliance notes for CA private clubs

- **CPA Rule H1 (PAD).**  Mandate requirements, return window
  (90 days), payor-cancellation rights.  Stripe ACSS Debit
  implements the user-facing side; Spectre persists the
  mandate record (see §3) + exposes the cancellation action.
- **Consumer Protection Act (ON, BC, …).**  Does not apply —
  the Club is a business principal, not a consumer.
- **PIPEDA / provincial privacy acts.**  Mandate records
  include personal information (signatory name + email + IP).
  Standard retention (7 years after mandate end + contract
  retention) with Spectre's existing privacy posture.
- **FINTRAC.**  Spectre is not a reporting entity under
  FINTRAC for subscription-only revenue.  No MSB registration
  implied by this flow.

---

## 7 · Open items deferred to SIGNUP-2 kickoff

1. **Pricing object creation.**  Stripe `Price` + `Product`
   for `$38,000 CAD annual recurring`; whether to carry
   quarterly billing variants on day one.
2. **First-year proration policy.**  Mid-year signups:
   calendar-aligned renewal with a prorated first invoice vs
   anniversary billing from authorisation date.
3. **Operator surface.**  SpectreAdmin screen for a Spectre
   employee to view mandate state, trigger a manual
   reconciliation, mark a `MANUAL_INVOICE` paid.
4. **Soft-rate retry schedule for NSF.**  Reuse Stripe Smart
   Retries vs implement a Spectre-side schedule aware of
   Club-specific history.
5. **Payment-method rotation.**  Flow for a Club whose
   Controller leaves — a new signatory accepts a fresh
   mandate, old mandate is revoked, both are retained for
   audit.

All implementation lands in SIGNUP-2.  Nothing in this
assessment authorises an actual payment or creates a live
Stripe entity.
