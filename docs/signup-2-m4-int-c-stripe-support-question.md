# SIGNUP-2 M4-INT-C §5 — Stripe Support question package

Ready-to-send inquiry to Stripe Support closing BLOCKER-A from the
M4-INT acceptance report.  Addressed to the founder for review +
sending.  No code deployed by this document.

**IMPORTANT:** The founder sends this.  Spectre code does NOT
contact Stripe Support.

## 1. Question (ready-to-send text)

> Subject: ACSS Debit live-mode transaction-amount limit confirmation
>
> Hello,
>
> We operate a CAD-denominated ACSS Debit subscription product
> ($38,000 CAD annually per club) in test mode on account
> `acct_...` [founder: substitute real staging account id here].
> Before enabling live-mode payment collection, we need to confirm:
>
> 1. The current ACSS Debit transaction-amount limit on this
>    account, both per-transaction and in any 24-hour aggregate.
>
> 2. Whether a CAD $38,000 annual ACSS Debit is within that limit,
>    and if not, the exact escalation path to raise it.
>
> 3. Whether successful test-mode charges at this amount imply
>    any specific treatment in live mode (we understand they
>    likely do not, but want this confirmed in writing).
>
> 4. Any additional underwriting or documentation required before
>    a live-mode CAD $38,000 debit is attempted on this account.
>
> We will not attempt a live-mode debit at this amount until we
> receive your written confirmation.
>
> Attachments:
> - Our Stripe Price id for the subscription: `[founder: paste
>   real id here -- NOT a digest]`
> - Subscription-create request shape (included below for
>   reference)
> - Our staging webhook destination:
>   `https://staging.spectreautomation.com/api/webhooks/stripe`
>
> Thank you.

## 2. Attachments

### 2a. Price identification

The staging Fly secret `STRIPE_ACSS_PRICE_ID` carries digest
`53f3d2f00139e274`.  The actual Price id string is NOT included in
Spectre's source and MUST be retrieved by the founder from the Fly
secret surface before sending.  **Do not share the digest with
Stripe Support** — share the real `price_...` id.

### 2b. Subscription-create request shape

Spectre's live-mode adapter at `src/lib/billing/stripe-adapter/live.ts`
calls `stripe.subscriptions.create` with the following shape (abbreviated):

```typescript
{
  customer: args.stripeCustomerId,
  items: [{ price: resolveAcssPriceId() }],
  default_payment_method: args.stripePaymentMethodId,
  payment_behavior: "default_incomplete",
  payment_settings: {
    payment_method_types: ["acss_debit"],
    save_default_payment_method: "on_subscription",
  },
  expand: ["latest_invoice.payment_intent"],
  metadata: {
    signupRegistrationIdTail: args.signupRegistrationId.slice(-6),
    syntheticTestOnly: String(args.syntheticTestOnly),
  },
}
```

### 2c. Webhook destinations configured on the account

Spectre's deployed webhook endpoint on staging:

- `https://staging.spectreautomation.com/api/webhooks/stripe`

Events currently subscribed (dispatched in `src/lib/billing/signup-2e-webhook-dispatch.ts`):

- `payment_intent.processing / .succeeded / .payment_failed`
- `charge.succeeded / .refunded / .dispute.created`
- `setup_intent.succeeded / .requires_action / .setup_failed / .canceled`
- `invoice.paid / .payment_failed / .marked_uncollectible`
- `charge.dispute.closed / .funds_withdrawn / .funds_reinstated`
- `customer.subscription.updated / .deleted`
- `mandate.updated`

## 3. Information required to RESOLVE the question (not just ask)

What the founder should get back from Stripe (and record):

| Field | Expected value shape |
|---|---|
| Confirmed account id | `acct_...` the Stripe reply addresses |
| Per-transaction ACSS limit (CAD) | Numeric amount in CAD, dated |
| 24-hour aggregate ACSS limit (CAD, if separate) | Numeric amount in CAD, dated |
| Suitability for CAD $38,000 annual | Yes / No / Yes-with-conditions |
| Escalation path (if No or conditioned) | Named Stripe process, expected timeframe |
| Underwriting / documentation requirements | Enumerated list |

Once received, the founder authorises flipping
`SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION=1` for the controlled
first-subscription window.

## 4. Distinguishing test-mode and live-mode (restating)

A successful test-mode ACSS Debit DOES prove:

- Spectre's webhook signature verification works.
- Spectre's state machine advances through BANK_VERIFIED → PAYMENT_INITIATED → ACTIVATION_READY on the right events.
- Spectre's `balance_transaction` reconciliation reads the right fields.

A successful test-mode ACSS Debit does NOT prove:

- Stripe will accept a live-mode $38,000 CAD ACSS Debit.
- The receiving bank will clear the transaction.
- The real 10-business-day ACSS settlement + reversal window operates as expected.
- Any live underwriting posture of the account.

**Spectre will not assume the limit has been increased without
confirmation from Stripe Support.**  §5 of the M4-INT-C
authorization is explicit on this.

## 5. What this slice does NOT do

- Does NOT change the CAD $38,000 Price.
- Does NOT split transactions.
- Does NOT reduce the amount.
- Does NOT enable payment initiation.
- Does NOT create any Stripe subscription.
- Does NOT send this message to Stripe Support directly.  The founder sends it.
