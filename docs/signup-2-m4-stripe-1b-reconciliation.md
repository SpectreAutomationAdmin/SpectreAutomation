# SIGNUP-2 M4-STRIPE-1B — Dashboard / API reconciliation

**Context.** The founder reported that the staging Stripe Dashboard shows:
- Canadian pre-authorized debits: **Enabled**.
- Per-transaction cap: CAD $0.50 – $3,000.
- Recurring payments: supported.
- Separate weekly processing limit.

My earlier M4-STRIPE-1B inspection reported `acss_debit_payments` capability `status: "unrequested"` with four currently-due fields. The founder asked to reconcile the two views.

Reconciliation is complete via `scripts/m4-stripe-1b-reconcile.mjs` (read-only, no mutations). Both reports are correct; they describe **different Stripe control surfaces**.

## 1. Why the Dashboard says "Enabled" while the Capabilities API says "unrequested"

| Control surface | Who it applies to | Current state |
|---|---|---|
| **Payment Method Configurations API** (`/v1/payment_method_configurations`) | The account's **own** acceptance of a payment method on itself | `acss_debit.available = true`, `display_preference.value = "on"` → **ENABLED** |
| **Capabilities API** (`/v1/accounts/{self}/capabilities/acss_debit_payments`) | Connect **platform** scope — whether a Connect platform user has requested this capability FOR the account | `status: "unrequested"` → not applicable to Standard-account self-view |

The account's type is `standard`. For Standard accounts, the Payment Method Configurations API is the authoritative surface for the account's own payment-method state. The Capabilities API is primarily a Connect-platform construct (Custom / Express accounts) and the `unrequested` value does not represent a block on Standard-account acceptance.

**Both API responses are correct simultaneously.** No contradiction.

## 2. Payment Method Configuration — verbatim read-only evidence

```json
{
  "section": "payment_method_config",
  "idMasked": "pmc_1UV5***4jjR",
  "name": "Default",
  "active": true,
  "is_default": true,
  "parent": null,
  "acss_debit": {
    "available": true,
    "display_preference": {
      "overridable": null,
      "preference": "on",
      "value": "on"
    }
  }
}
```

`acss_debit.available = true` + `display_preference.value = "on"` matches the founder's Dashboard view.

## 3. Per-transaction limit vs weekly processing limit

### Per-transaction cap (CAD $0.50 – $3,000)

- **Dashboard: VISIBLE + AUTHORITATIVE.**
- **API: NOT EXPOSED.** Stripe's public API returns no numeric per-transaction limit field on the account, capability, or payment-method-configuration objects.
- **Underwriting-defined.** Test-mode ceilings are lower than live-mode by default; both are tier-based.
- **This is the active block for a CAD $38,000 subscription attempt.** A single ACSS debit at $38,000 exceeds the current per-transaction cap. **Founder has already requested the limit increase from Stripe and is awaiting their response.**

### Weekly processing limit

- **Dashboard: VISIBLE.** Separate rolling window; applies to the SUM of ACSS debits processed in a trailing 7-day window.
- **API: NOT EXPOSED.** No field in the API surfaces returns this ceiling numerically.
- **Independent of the per-transaction cap.** Lifting one does not necessarily lift the other.

Spectre's annual billing posture is one $38,000 debit per club per year, so:
- Per-transaction cap must support $38,000 — currently blocks the attempt.
- Weekly processing cap must support $38,000 × (clubs billed in that week) — relevant later when multiple clubs renew in the same week.

## 4. Blocker status — updated

| # | Blocker | Status |
|---|---|---|
| STRIPE-SIDE-1 (prior) | ACSS Debit capability activation on test account | ✅ **RESCINDED** — reconciled; the Dashboard already shows it enabled; the Capabilities API's `unrequested` state does not block Standard-account acceptance. **No founder business-attestation action required.** |
| STRIPE-SIDE-1a (new) | Per-transaction cap lift from CAD $3,000 to ≥ CAD $38,000 on `acct_1UV***3002` | **Founder has requested the limit increase from Stripe; awaiting Stripe's response.** |
| STRIPE-SIDE-1b (new, tracked) | Weekly processing cap sized for Spectre's actual renewal cadence | Not blocking first subscription attempt; tracked for later. |
| STRIPE-SIDE-2 | Webhook endpoint subscribes to the 19 dispatcher-routed events | ✅ **CLOSED** by prior M4-STRIPE-1B remediation. |
| STRIPE-SIDE-3 | Numeric ACSS Debit live-mode limit confirmation | Unchanged (Stripe Support question package shipped). |
| SPECTRE-SIDE | Separate founder authorization for M4-STRIPE-2 (first flag-flip window) | Blocked by STRIPE-SIDE-1a. |

The former STRIPE-SIDE-1 (business attestation / ToS) is removed from the blocker register. Spectre is NOT required to submit anything on the founder's behalf. The actionable blocker is the per-transaction cap, and that request is already with Stripe.

## 5. Safety invariants (unchanged by this reconciliation)

- Zero subscriptions, invoices, PaymentIntents, or debits created.
- No code deployed; no feature flag flipped.
- `STRIPE_ACSS_PRICE_ID` digest `53f3d2f00139e274` — unchanged; price confirmed CAD $38,000 annual, `livemode: false`, `active: true`.
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SIGNING_SECRET` digests unchanged.
- `SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION` + every M4 live flag — **unset**.
- Webhook endpoint `we_1UVAd***rlPN` state preserved from prior M4-STRIPE-1B update: 19 named events, no wildcard, URL + api_version unchanged.
- M3 registration + bank-verification routes untouched.

## 6. What this reconciliation did

- Called `GET /v1/account` (read-only).
- Called `GET /v1/payment_method_configurations?limit=20` (read-only).
- Called `GET /v1/payment_method_configurations/{default}` (read-only).
- Called `GET /v1/accounts/{self}/capabilities/acss_debit_payments` (read-only — re-confirmation only).
- Called `GET /v1/prices/{STRIPE_ACSS_PRICE_ID}` (read-only).

**No `POST` / `PATCH` / `DELETE` calls.** No reactivation attempt. No business attestation. No ToS acceptance. No Price touch.
