# SIGNUP-2 M4-INT-B §6 — Stripe ACSS limit readiness (update)

**Status:** not resolved in Spectre.  Documents the outstanding
question + the exact evidence the founder needs from Stripe Support
to close BLOCKER-A from the M4-INT acceptance report.

Supersedes the "ACSS Debit transaction-limit escalation" section of
`docs/signup-2-m4-int-stripe-readiness.md` only in so far as this
file carries the newer, Stripe-Support-focused framing.

## Test-mode vs live-mode: the distinction that matters

A **test-mode** Stripe payment does NOT prove live bank settlement.
Stripe's test-mode:

- Issues `payment_intent.succeeded`, `invoice.paid`, and
  `balance_transaction` events that look identical to live events.
- Advances `balance_transaction.status` from `pending` to `available`
  on a deterministic timeline (test clocks or short defaults).
- Does NOT move real funds between banks.
- Does NOT exercise the ACSS Debit transaction-amount limit that a
  live-mode ACSS payment is subject to.

What a successful test-mode ACSS Debit confirms:

| Confirmed | Why |
|---|---|
| Spectre's webhook pipeline accepts the real Stripe signature. | Signature path is identical across modes. |
| Spectre's reconciliation reads the `balance_transaction` fields correctly. | Same API shape as live. |
| Spectre's state machine advances from `BANK_VERIFIED` → `PAYMENT_INITIATED` → `ACTIVATION_READY`. | Same code path. |
| The `evidenceSource: "live-stripe"` label is applied correctly. | Live adapter sets it. |

What a successful test-mode ACSS Debit does **NOT** confirm:

| Not confirmed | Why |
|---|---|
| That Stripe will accept a live-mode CAD $38,000 ACSS Debit. | Live-mode limits are enforced by Stripe's underwriting + the Spectre account's ACSS entitlement. |
| That the real receiving bank will clear the transaction. | Test-mode funds never leave Stripe's own account. |
| That the ACSS 10-business-day settlement + reversal window operates as expected. | Test-mode uses shortened clocks. |
| That a live mandate signed in Stripe Checkout meets the counterparty's banking policy. | Test-mode mandates are not legally enforceable. |

## Live-mode limit: outstanding question for Stripe Support

Status: **not yet asked.**  The question + the evidence to request:

> *"We operate a CAD-denominated ACSS Debit subscription product
> ($38,000 CAD annually per club) in test mode on account
> `acct_...`.  Before enabling live-mode payment collection, we
> need to confirm:*
>
> *(1) The current ACSS Debit transaction-amount limit on this
> account (per-transaction + 24-hour aggregate).*
>
> *(2) Whether a CAD $38,000 annual ACSS Debit is within that
> limit, and if not, the escalation path to raise it.*
>
> *(3) Whether successful test-mode charges at this amount imply
> any particular treatment in live mode (we understand they
> likely do not).*
>
> *(4) Any additional underwriting / documentation required
> before a live-mode CAD $38,000 debit is attempted."*

Evidence to attach when asking:

- The Price id (digest on file: `53f3d2f00139e274`; actual id is CAD
  $38,000 annual, do NOT share digest, share the real id with Stripe).
- The subscription object schema Spectre uses (the type-mode subscription-
  create call shape in `src/lib/billing/stripe-adapter/live.ts`).
- The staging environment summary (image `sha-73027277c646`; webhook
  destination `https://staging.spectreautomation.com/api/webhooks/stripe`).

## What this slice does NOT do

- Does NOT create a live-mode subscription.
- Does NOT change the CAD $38,000 annual Price.
- Does NOT split transactions.  No code path divides the amount
  across multiple commands.  M4-cancellation + M4-renewal + M4-retries
  all operate on the single invoice / amount set at authorization time.
- Does NOT assume that a test-mode payment proves settlement.  The
  dormant `evaluateActivationGate` predicate requires
  `balance_transaction.status === "available"` AND `available_on <= now`
  on a real balance transaction with `evidenceSource === "live-stripe"`;
  mock evidence is refused in the production path.

## Recommended ordering (for the founder review sequence)

1. Ask Stripe Support the outstanding question above.
2. Receive confirmation of ACSS limit sufficiency OR complete the
   escalation path they describe.
3. Only then flip `SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION=1` under a
   time-boxed controlled window.
4. Follow the "Recommended acceptance sequence" from the M4-INT
   consolidated report (steps 2–6).

Nothing in M4-INT or M4-INT-B skips step 1.
