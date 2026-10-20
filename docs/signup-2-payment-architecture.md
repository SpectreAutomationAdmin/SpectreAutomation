# SIGNUP-2 · Payment Architecture — Stripe ACSS Debit Implementation Plan (v2)

**Status.** Documentation only.  Updated with authoritative facts
from Stripe's current public documentation at
[docs.stripe.com/payments/acss-debit](https://docs.stripe.com/payments/acss-debit).
Supersedes v1 of this document.  **No code modified.  No live
Stripe entities created.  No debits initiated.**  Fulfils item (4)
of the SIGNUP-1G directive.

**Material correction over v1.** v1 recommended "Stripe Checkout
in subscription mode" for ACSS Debit annual recurring billing.
That is **wrong** per Stripe's current docs:

> *"Subscription mode in Checkout isn't yet supported.  Checkout
> supports PADs in payment and setup modes.  Checkout subscription
> mode doesn't support PADs."*
> — [docs.stripe.com/payments/acss-debit](https://docs.stripe.com/payments/acss-debit#product-limitations)

The viable integration pattern is:

```
Checkout Session (mode: "setup") → SetupIntent captures the PAD mandate
                                 → PaymentMethod attached to Customer
                                     with default_for: ['invoice', 'subscription']
                                 → Subscriptions API creates the recurring plan
                                     against the Customer, which auto-invoices
                                     + auto-debits via the saved PAD method.
```

This is Stripe's documented pattern for recurring PAD on their
**Subscriptions / Billing** products, which DO support ACSS Debit
(the ✓ in Stripe's product-support table).  Only the Checkout
`subscription` mode specifically is unsupported; the underlying
Subscriptions API is fine.

Spectre's existing adapter contract at
[src/lib/billing/index.ts](../src/lib/billing/index.ts#L60) currently
uses `mode: "subscription"` for Checkout and will need to be
replaced for ACSS Debit — see §4 "Required code changes" below.

---

## 1 · Current state inventory

### 1.1 · Shipped code

- Adapter contract — `BillingProvider` interface in
  [src/lib/billing/index.ts](../src/lib/billing/index.ts).
  Implementations: `mockBillingProvider` (default) and
  `stripeBillingProvider` (dynamic-import).
- Current `stripeBillingProvider.createCheckoutSession` uses
  `mode: "subscription"` + `line_items: [{price, quantity: 1}]`.
  Works for cards; **does not work for ACSS Debit**.
- Webhook handling — `verifyWebhook` + the switchboard at
  [src/app/api/integrations/billing/webhook/route.ts](../src/app/api/integrations/billing/webhook/route.ts).
  Signature verification via `stripe.webhooks.constructEvent`.
- Schema — `ClubSubscription` + `BillingCustomer` + `BillingCycle`
  + `SubscriptionPlan` + `UsageMetric` + Phase 11B webhook-secret
  rotation.
- Provider selection — `selectProvider(clubId?)` driven by
  `SPECTRE_BILLING_PROVIDER=stripe` + `STRIPE_API_KEY` +
  `STRIPE_WEBHOOK_SECRET` env or per-club secrets.

### 1.2 · Gaps

1. ACSS Debit path not wired (current Checkout mode is incompatible).
2. No `SubscriptionPaymentMandate` persistence model.
3. No returned-payment / dispute reconciliation.
4. No `$38,000 CAD/year` `Price` object in Stripe (SIGNUP-2 will
   create one, but not until founder authorises).
5. No ACSS-specific webhook handlers (`payment_intent.processing`,
   `charge.pending`, `charge.dispute.created`).

---

## 2 · Stripe account eligibility — what the founder must confirm

Spectre's existing Stripe account must satisfy ALL of:

| Requirement | How to verify |
|---|---|
| **Account business country = CA or US.** | Dashboard → Settings → Account details → Country.  Both are supported for CA PAD acceptance per Stripe. |
| **Account activated** (not a sandbox-only account). | Dashboard → the big "Activate your account" banner is absent on the top-level dashboard page. |
| **PAD capability enabled** on the account. | Dashboard → Settings → Payments → Payment methods → **"Canadian pre-authorized debit (CAD)"** is in the Active list.  If it reads "Request access" or is in Review, enable it there. |
| **PAD capability post-activation review complete.** | Stripe may review PAD after activation.  Dashboard sidebar shows no outstanding capability-review banner. |
| **Statement descriptor set.** | Dashboard → Settings → Account details → Public business info → `Statement descriptor` — set to `SPECTRE` or a 15-char equivalent.  PAD descriptors are truncated to 15 alphanumeric chars. |
| **Business website meets Stripe activation requirements.** | spectreautomation.com (the marketing site) satisfies the public-page requirement. |
| **$38,000 CAD annual within Stripe risk limits.** | Default PAD max (no large-charge increase) is **999,999.99**.  $38,000 is well within; no limit-increase request needed. |
| **Chosen settlement timing.** | Dashboard → Settings → Payouts.  Default Standard Settlement for ACSS: payment success T+4 at 21:00 UTC; funds in Stripe balance T+5 at 00:00 UTC. |

**The founder (or an operator with Stripe admin) must perform the
PAD-enablement step before SIGNUP-2 code lands.**  This cannot be
done by Spectre code; it's a one-time account-side click-through.

---

## 3 · Integration pattern — SetupIntent → Subscription

Stripe's recommended ACSS recurring pattern:

### 3.1 · Collect the PAD mandate via a SetupIntent

```ts
// Pseudocode — real implementation lands in SIGNUP-2.
const customer = await stripe.customers.create({
  name: club.legalName,
  email: adminEmail,
  metadata: { signupRegistrationId: reg.id },
});

const session = await stripe.checkout.sessions.create({
  mode: "setup",                      // NOT "subscription"
  customer: customer.id,
  payment_method_types: ["acss_debit"],
  payment_method_options: {
    acss_debit: {
      currency: "cad",
      mandate_options: {
        payment_schedule: "interval",
        transaction_type: "business",
        interval_description: "Annually on the subscription anniversary",
        default_for: ["invoice", "subscription"],
      },
    },
  },
  success_url: `${APP_URL}/signup/t/${token}/payment/complete`,
  cancel_url:  `${APP_URL}/signup/t/${token}/payment/cancel`,
});
```

Stripe hosts the mandate acceptance screen, collects
institution + transit + account, verifies the account (instant
verification or microdeposit fallback), and binds the resulting
`PaymentMethod` to the `Customer` with
`default_for: ["invoice", "subscription"]` so future invoices
auto-pay from this method.

The mandate text Stripe presents satisfies Payments Canada
Rule H1 §19 (payor name, payee, bank, amount or variable-amount
cap, frequency, authorisation date, cancellation rights) — no
Spectre-custom wording required when using Stripe-hosted
Checkout.

### 3.2 · Create the Subscription against the saved PaymentMethod

```ts
// After checkout.session.completed webhook fires with setup success:
const subscription = await stripe.subscriptions.create({
  customer: customer.id,
  items: [{ price: SPECTRE_38K_CAD_PRICE_ID }],
  payment_behavior: "default_incomplete",
  payment_settings: {
    payment_method_types: ["acss_debit"],
    save_default_payment_method: "on_subscription",
  },
  expand: ["latest_invoice.payment_intent"],
});
```

The first invoice fires immediately.  Stripe debits the PAD
account and emits `payment_intent.processing` → (3–5 bus. days)
→ `payment_intent.succeeded`.  Annual renewals follow the same
flow without re-prompting the applicant.

### 3.3 · Mandate + debit notification emails

Rule H1 requires two customer-facing emails:
- **Mandate confirmation** within 5 calendar days of acceptance.
- **Debit notification** before each debit.

Stripe sends both by default.  **Keep Stripe emails ON for
SIGNUP-2 launch** (Dashboard → Settings → Emails) — Spectre
does not need to send its own PAD-compliance emails on day one.
A later improvement may replace them with Spectre-branded ones;
that's a scope item, not a launch blocker.

---

## 4 · Required code changes (planned, not implemented)

### 4.1 · Adapter contract extension

[src/lib/billing/index.ts](../src/lib/billing/index.ts)
`BillingProvider` interface gains:

```ts
interface BillingProvider {
  // existing — card path, kept
  createCustomer, createCheckoutSession (card subscription), verifyWebhook

  // SIGNUP-2 additions:
  createPadMandateSetupSession(args: {
    customerExternalId: string;
    adminEmail: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionId: string }>;

  createPadSubscription(args: {
    customerExternalId: string;
    priceExternalId: string;
    paymentMethodId: string;
  }): Promise<{ subscriptionId: string; firstInvoiceId: string }>;

  retrieveMandate(args: {
    paymentMethodId: string;
  }): Promise<{ mandateId: string; text: string; status: string }>;
}
```

`mockBillingProvider` ships deterministic stubs for all three.
`stripeBillingProvider` wires the pseudocode in §3 above.

### 4.2 · New Prisma model `SubscriptionPaymentMandate`

```prisma
model SubscriptionPaymentMandate {
  id                       String   @id @default(cuid())
  clubId                   String
  club                     Club     @relation(fields: [clubId], references: [id])
  signupRegistrationId     String?
  stripePaymentMethodId    String   @unique
  stripeMandateId          String   @unique
  mandateType              String   // "ACSS_DEBIT" | "CARD"
  mandateVariant           String   // "INTERVAL" | "SPORADIC" | "COMBINED"
  transactionType          String   // "BUSINESS" | "PERSONAL" — PAD only; expect "BUSINESS"
  acceptedAt               DateTime
  acceptedByUserId         String?
  acceptedByMicrosoftOid   String?
  acceptedIp               String?
  acceptedUserAgent        String?
  mandateTextHash          String   // SHA-256 of the Stripe-rendered mandate text
  mandateTextLength        Int
  revokedAt                DateTime?
  revokeReason             String?

  @@index([clubId, acceptedAt])
}
```

### 4.3 · Webhook switchboard extensions

Add handlers in
[src/app/api/integrations/billing/webhook/route.ts](../src/app/api/integrations/billing/webhook/route.ts):

| Event | Behaviour |
|---|---|
| `checkout.session.completed` (mode=setup) | Persist `SubscriptionPaymentMandate`; mark `ClubSubscription` → `MANDATE_CAPTURED`.  Trigger `createPadSubscription`. |
| `payment_intent.processing` | First / recurring debit submitted.  Mark `BillingCycle.AWAITING_SETTLEMENT`. |
| `payment_intent.succeeded` | Settlement confirmed.  Mark `BillingCycle.PAID`.  Emit GL-posting event. |
| `payment_intent.payment_failed` | Return / NSF.  Mark `BillingCycle.FAILED`.  Stripe will auto-retry once (within 30 days) if Direct Debit retries enabled; otherwise notify operator. |
| `charge.pending` | PAD debit emitted but not yet confirmed.  Informational only — do not mark PAID. |
| `charge.dispute.created` | Customer disputed a debit.  Immediate operator notification; funds already clawed back by Stripe. |
| `charge.dispute.closed` | Dispute concluded.  Reconciliation record. |
| `refund.updated` / `refund.failed` | Refund outcome.  Reconciliation. |
| `invoice.paid` / `invoice.payment_failed` | Card-path renewals (fallback). |
| `customer.subscription.updated` | Status / cancellation reconciliation. |
| `customer.subscription.deleted` | Mark `ClubSubscription.CANCELLED` + archive. |

### 4.4 · `ClubSubscription.status` lifecycle

```
      authorise           SetupIntent        charge pending      charge success
PILOT ────────▶ PENDING_MANDATE ──────▶ MANDATE_CAPTURED ───▶ AWAITING_FIRST_SETTLEMENT ───▶ ACTIVE
                                                                                              │
                                                                                              │ renewal
                                                                                              ▼
                                                                                            ACTIVE (annually)
                                                                                              │
                                                                                              │ dispute / NSF /
                                                                                              │ operator cancel
                                                                                              ▼
                                                                             AT_RISK → CANCELLED
```

The founder may elect to simplify this to fewer statuses at
scoping time; the current `PILOT | ACTIVE` set is insufficient
for ACSS lifecycle visibility.

---

## 5 · Timing + money facts (verified against Stripe 2026-10-20)

| Concern | Figure |
|---|---|
| Per-transaction cap (default) | 999,999.99 CAD |
| Minimum | 0.50 CAD |
| First-debit submission | Immediately after mandate acceptance |
| Settlement — standard | T+4 at 21:00 UTC payment success; T+5 at 00:00 UTC funds available |
| Dispute window — personal account | 90 calendar days from debit |
| Dispute window — business account | 10 business days from debit |
| Dispute winnability | None.  PAD disputes are no-questions-asked; cannot be countered. |
| Refund window | 180 days |
| Refund processing | ~3 business days |
| Automatic retry on NSF | 1 attempt within 30 days (if Direct Debit retries enabled) |
| Stripe fees — ACSS Debit | Spectre's standard rate.  Confirm current rate on Dashboard → Settings → Pricing → Local payment methods → "Pre-authorised debits in Canada". |
| Stripe fees — card | Standard CAD rates per Spectre's Stripe plan. |

**Dispute window change vs v1 of this doc:** v1 said business
disputes are 10 bd and personal are 90 days — this is now
confirmed against Stripe's own doc.  v1 said "returned payments
can be submitted up to 90 days after settlement" generically —
clarified above as separate windows.

**First-debit delay change vs v1:** v1 said "first debit is
held up to 10 business days by Stripe's own risk hold."  That
is NOT what Stripe's doc says — Stripe initiates the first debit
immediately after mandate acceptance.  Risk-review holds exist
but are not universal.  Standard settlement timing applies.

---

## 6 · CPA Rule H1 compliance posture

Stripe-hosted mandate collection + Stripe-sent mandate-confirmation
+ Stripe-sent debit-notification satisfy Rule H1 §19–§21 on
Spectre's behalf.  Spectre's additional obligations:

- **Record retention.**  `SubscriptionPaymentMandate` keeps the
  acceptance context (who, when, from where) for ≥ 7 years after
  mandate end.  This supplements Stripe's own retention of the
  mandate text.
- **Cancellation path.**  Spectre must honour a Club's
  cancellation request; the operator-facing surface in
  SIGNUP-2 wires `Set-Mandate` on the Stripe side + sets
  `ClubSubscription.CANCELLED`.
- **Dispute handling.**  Non-contestable per Stripe.  Spectre's
  only recourse is to contact the Club directly and request a
  new PAD if the Club agrees to continue service.

No MSB / FINTRAC registration is implied by this flow —
subscription receipt from a non-consumer business principal is
outside FINTRAC's reporting scope.

---

## 7 · Alternatives — considered + set aside

| Provider | Why not SIGNUP-2 launch |
|---|---|
| Rotessa / Plooto | Smaller fee stack, but no existing adapter + Stripe's mandate / dispute tooling is more mature; adapter is swappable later. |
| Interac eTransfer | Fine for one-off payments; no mandate / recurring. |
| Direct wire / EFT | Manual-ops only; retained as the `MANUAL_INVOICE` fallback for edge cases. |

Spectre's `BillingProvider` interface keeps provider swap cheap
if the fee stack starts hurting at larger Club counts.

---

## 8 · Open items for SIGNUP-2 kickoff

1. Create the `$38,000 CAD annual recurring` Stripe `Price` + `Product`.
2. Decide proration policy for mid-year signups (calendar-anniversary vs authorisation-anniversary).
3. SpectreAdmin operator surface for mandate state + manual reconciliation + `MANUAL_INVOICE` paths.
4. Direct Debit retry schedule — rely on Stripe Smart Retries vs a Spectre-side schedule aware of Club history.
5. Payment-method rotation flow for Clubs whose authorised Controller leaves.
6. Mandate renewal UX for subscription-amount changes (variable-amount vs single-amount mandate).

---

## 9 · What SIGNUP-1G does NOT authorise

- Creating any Stripe `Customer`, `Price`, `Product`,
  `SetupIntent`, `PaymentIntent`, `Subscription`, or
  `Mandate` entity in a live Stripe account.
- Writing any code to `src/lib/billing/*` beyond this
  documentation.
- Enabling the PAD capability on Spectre's live Stripe account.
- Setting `SPECTRE_BILLING_PROVIDER=stripe` on any Fly app.
- Initiating any debit, test or real.

All of the above wait for explicit founder authorisation to
begin SIGNUP-2 implementation.
