# SIGNUP-2 M4-STRIPE-1B — Acceptance report

**Scope:** Stripe test-account configuration remediation only.
**Executed:** 2026-10-29 against staging Fly v985 image `sha-70235661e48a`.
**Flag state:** every payment-initiation + billing-execution flag OFF (unchanged).
**Price:** CAD $38,000 annual (`price_1U***m7A6`, `livemode: false`) unchanged.
**M3 registration path:** unchanged.
**Subscriptions / invoices / PaymentIntents / debits created:** zero.

## §1 Stripe account readiness

### Account-level state
- Account id `acct_1UV***3002` — type `standard`, country `CA`, default_currency `cad`.
- `details_submitted` = `false`; `charges_enabled` = `false`; `payouts_enabled` = `false`.
- `requirements.currently_due` / `.past_due` / `.eventually_due` / `.pending_verification` all **empty**.
- `capabilities` = `{}` (no capability requested yet).

The account itself has no outstanding account-level requirement rows. The blocker is at the **capability** layer.

### `acss_debit_payments` capability — direct inspection

Fetched `GET /v1/accounts/{self}/capabilities/acss_debit_payments`:

```json
{
  "status": "unrequested",
  "requested": false,
  "requested_at": null,
  "requirements": {
    "currently_due": [
      "business_profile.product_description",
      "business_type",
      "tos_acceptance.date",
      "tos_acceptance.ip"
    ],
    "past_due": [ ...same four... ],
    "eventually_due": [ ...same four... ],
    "disabled_reason": "requirements.fields_needed"
  }
}
```

### Test-mode vs live-mode prerequisites — exact distinction

| Requirement | Test-mode | Live-mode |
|---|---|---|
| Account onboarding (`details_submitted` + `charges_enabled`) | Not required to CALL the API, but ACSS Debit capability needs the four fields regardless | Required |
| `business_profile.product_description` | **required for ACSS capability activation (both modes)** | Required |
| `business_type` | **required for ACSS capability activation (both modes)** | Required |
| `tos_acceptance.date` + `tos_acceptance.ip` (ACSS Direct Debit terms) | **required for ACSS capability activation (both modes)** | Required |
| ACSS Debit transaction-amount limit | Not enforced (test-mode accepts any amount once capability is active) | Stripe underwriting-defined; **CAD $38k requires Stripe Support confirmation** |
| Live payout bank account (`external_account`) | Not required | Required |

**Test-mode-only subscription of CAD $38,000 is possible** once the four capability requirements above are satisfied. **No live payout bank account is required for test-mode acceptance.**

### Why I did not request the capability

Per founder M4-STRIPE-1B §1: *"Complete only safe configuration actions that are clearly authorized and do not require business attestations, sensitive identity submissions, or contractual acceptance."*

Three of the four requirements are explicitly excluded by that constraint:
- `business_profile.product_description` — **business attestation**.
- `business_type` — **business attestation**.
- `tos_acceptance.date` + `tos_acceptance.ip` — **contractual acceptance of Stripe's ACSS Direct Debit terms**.

**STOP for founder action.** The exact Dashboard steps are in §6 below.

## §2 Webhook endpoint — UPDATED

### Dispatcher-derived event list (19 types; verbatim from `signup-2e-webhook-dispatch.ts`)

```
payment_intent.processing
payment_intent.succeeded
payment_intent.payment_failed
charge.succeeded
charge.refunded
charge.dispute.created
setup_intent.succeeded
setup_intent.requires_action
setup_intent.setup_failed
setup_intent.canceled
invoice.paid
invoice.payment_failed
invoice.marked_uncollectible
charge.dispute.closed
charge.dispute.funds_withdrawn
charge.dispute.funds_reinstated
customer.subscription.updated
customer.subscription.deleted
mandate.updated
```

### Before (as inspected before the update)

```json
{
  "id": "we_1UVAd***rlPN",
  "url": "https://staging.spectreautomation.com/api/webhooks/stripe",
  "status": "enabled",
  "api_version": "2026-09-30.endive",
  "enabled_events_count": 6,
  "enabled_events": [
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "charge.refunded",
    "charge.dispute.created",
    "payment_intent.processing",
    "charge.succeeded"
  ],
  "has_wildcard": false
}
```

### Update

- Request: `POST /v1/webhook_endpoints/we_1UVAd***rlPN` with `enabled_events[]` set to exactly the 19 types listed above.
- No `url`, `api_version`, or signing-secret parameter sent (preserved).
- `toAdd`: 13 events (the 19 target minus the 6 already present).
- `toRemove`: 0 events (the 6 already present are in the target set).
- `wildcardWillBeDropped`: false (none to drop).

### After (re-read, verbatim)

```json
{
  "id": "we_1UVAd***rlPN",
  "url": "https://staging.spectreautomation.com/api/webhooks/stripe",
  "status": "enabled",
  "api_version": "2026-09-30.endive",
  "enabled_events_count": 19,
  "has_wildcard": false,
  "all_dispatcher_events_present": true,
  "only_dispatcher_events": true
}
```

Response status `200`; `error: null`. URL unchanged. API version unchanged. Signing secret preserved (not rotated).

## §3 ACSS Debit transaction-limit diagnosis

- Reproduction without a subscription / invoice / PaymentIntent / debit: **not possible**. Stripe exposes no API field that returns a numeric per-account ACSS Debit amount ceiling.
- Applies to **live mode only** (ACSS underwriting). Test-mode accepts any amount once the capability is active.
- Numeric confirmation remains a **Stripe Support** matter. Question text + required evidence package already shipped at `docs/signup-2-m4-int-c-stripe-support-question.md`.

Preserved: CAD $38,000 Price. No split. No reduction.

## §4 Acceptance register correction

**M4-INT-C Microsoft 365 email-adapter delivery gate — PASSED and CLOSED.** Founder independently verified Outlook inbox receipt at `cturcato@spectreautomation.com` (subject, label, timestamp, test content) with screenshot evidence. Recorded in memory at `project_signup_2_m4_int_c_accepted.md`.

**Not conflated:** actual retry-notification delivery remains untested and depends on BLOCKER-B (first real Stripe-originated subscription with a failed invoice reaching M4-retries).

## §5 Safety invariants (unchanged)

- `SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION` — unset.
- Every `SPECTRE_SIGNUP_2M4_*_LIVE` flag — unset.
- `SPECTRE_STRIPE_SDK_MODE` = `test`; `sk_live_` unconditionally refused.
- `STRIPE_ACSS_PRICE_ID` digest `53f3d2f00139e274` — unchanged.
- `STRIPE_SECRET_KEY` digest `13da253279ef579e` — unchanged.
- `STRIPE_WEBHOOK_SIGNING_SECRET` digest `be00663289dbbf6a` — unchanged.
- M3 registration + bank-verification routes — untouched.

## §6 Exact founder actions required (STOP + hand-off)

### Required to unblock BLOCKER-B (test-mode subscription creation)

The founder (or an authorised officer of Spectre Automation) is required to request the `acss_debit_payments` capability from the Stripe Dashboard. Spectre code **cannot do this** without submitting a `tos_acceptance.date` + `tos_acceptance.ip` + a business attestation on behalf of Spectre, which the §1 constraint forbids.

**Dashboard steps:**

1. Open Stripe Dashboard. Confirm the test-mode toggle (top-right) is **ON** (so changes land on `acct_1UV***3002` test-mode, not live).
2. Navigate to **Settings → Payments → Payment methods**.
3. Find **Pre-authorized debit payments** (ACSS Direct Debit). Click "Request" / "Activate".
4. Stripe will prompt for:
   - **Business type**: e.g., `Company` (or whichever matches Spectre Automation's registration).
   - **Business profile → product description**: a short description of what Spectre sells to clubs. Suggested text: *"Multi-tenant SaaS operating system for private golf and country clubs; CAD-denominated annual subscription."*
   - **Acceptance of ACSS Direct Debit terms**: on behalf of Spectre Automation. Stripe records the acceptance date + the acceptor's IP.
5. Submit. Capability status should transition `unrequested` → `pending` → `active` within minutes to hours (test-mode is faster than live-mode).
6. Re-run `scripts/m4-stripe-1b-remediate.mjs` to confirm `status: "active"` on the capability.

### Required separately (unchanged)

- Stripe Support confirmation of the CAD $38,000 ACSS Debit live-mode transaction-amount limit. Question text in `docs/signup-2-m4-int-c-stripe-support-question.md`.

### What this slice did and did NOT do

Did:
- Updated the staging webhook endpoint `enabled_events` from 6 to 19 named events (no wildcard, URL + api_version preserved).
- Deep-inspected account + capability requirements, read-only.
- Committed the inspection + update script via DRH-1 for reproducibility.

Did NOT:
- Request the `acss_debit_payments` capability.
- Submit any business attestation.
- Accept any Stripe terms on behalf of Spectre.
- Create any subscription / invoice / PaymentIntent / debit.
- Change the Price, split any amount, or reduce any value.
- Modify any secret or rotate the webhook signing secret.
- Flip any Spectre feature flag.
- Modify M3 registration or bank-verification behaviour.

## Remaining integration blockers

| # | Blocker | Status after M4-STRIPE-1B |
|---|---|---|
| STRIPE-SIDE-1 | ACSS Debit capability activation on test account | **FOUNDER ACTION REQUIRED** (steps in §6 above) |
| STRIPE-SIDE-2 | Webhook endpoint subscribes to the full event set | **CLOSED by this slice** |
| STRIPE-SIDE-3 | Numeric ACSS Debit live-mode transaction-limit confirmation | **Unchanged** (Stripe Support question package ready) |
| SPECTRE-SIDE | Founder authorization for M4-STRIPE-2 (first flag-flip window) | Blocked by STRIPE-SIDE-1 and -3 |

**STOP for founder review before any Stripe subscription creation or payment execution.**
