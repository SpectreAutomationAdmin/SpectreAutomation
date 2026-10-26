# SIGNUP-2 Phase 2E — Stripe Integration Follow-up Tracker

**Status.** OPEN.  Tracks the dependencies required before the
mock-backed Phase 2E payment architecture can be considered
financially ready.  Created on 2026-10-26 as part of the Phase
2E technical-acceptance checkpoint.

**NOT an implementation plan.**  Per founder §2 of the Phase 2F
authorisation email, the live Stripe adapter MUST NOT be built or
activated under this document.  This file identifies the
prerequisites and classifies each as (a) requiring founder
involvement or (b) resolvable by Claude without new founder
authorisation.

---

## 1. Prerequisites requiring founder involvement

| # | Dependency | Why founder-only |
|---|---|---|
| 1.1 | **Open a Spectre Stripe account for the staging environment** (test-mode credentials: publishable + secret) | Account ownership + billing information + banking details are founder-controlled identity artefacts |
| 1.2 | **Enable ACSS Debit on the staging Stripe account** | Payment-method enablement is a merchant-account control |
| 1.3 | **Register the staging webhook endpoint** at `https://staging.spectreautomation.com/api/webhooks/stripe` on the Stripe Dashboard + capture the signing secret | Webhook endpoint registration is a Stripe-dashboard action tied to the merchant account |
| 1.4 | **Confirm ACSS fee cap** (CAD $5 per transaction) applies to Spectre's actual merchant account | Fee schedule is contract-level merchant-account information |
| 1.5 | **Confirm ACSS `interval` mandate variant** supports annual recurring without re-signature | Merchant-account workflow decision; may depend on Spectre's underwriting outcome |
| 1.6 | **Confirm Stripe's Rule-H1-§20 debit-notification email** remains default-on + unmodified | Rule-H1 compliance decision |
| 1.7 | **Legal review + approval of mandate wording + the Terms of Service** (`docs/legal/terms-of-service-v1.md` must land with `Status: APPROVED` and a non-`ToS-dev-fixture` label) | Legal counsel approval; §3 of the Phase 2E authorisation inherited this from Phase 2B |
| 1.8 | **Authorise the live-adapter slice** as a separate per-change founder decision after 1.1–1.7 complete | Phase 2F-adjacent authorisation needed before any live Stripe call |

**Operational handoff shape:** founder passes items 1.1–1.6 to
Claude as a set of Fly secrets (`STRIPE_API_KEY`,
`STRIPE_WEBHOOK_SIGNING_SECRET`) + a filled-in verify doc
(`docs/signup-2-stripe-merchant-verify.md`).  Item 1.7 lands as a
new approved ToS file in `docs/legal/`.  Item 1.8 is the written
authorisation to flip `SPECTRE_SIGNUP_2E_STRIPE_MODE=live`.

---

## 2. Prerequisites Claude can resolve independently

Items in this section can be built against the mock adapter + the
Phase 2A `StripeWebhookEvent` + `PaymentReconciliationEntry`
tables without any new founder authorisation.  They will be ready
to deploy as soon as items 1.1–1.8 arrive.

| # | Dependency | Claude's path |
|---|---|---|
| 2.1 | **Live StripeAdapter module** (`src/lib/billing/stripe-adapter/live.ts`) | Implement the six port methods against the official `stripe` npm SDK.  Mirror the mock adapter's shape; set `isLive: true` + `evidenceSource: "live-stripe"`.  Keep the adapter CRASH-OR-RETURN; no silent fallbacks. |
| 2.2 | **Factory wiring** | Change `resolveStripeAdapter()` to require `SPECTRE_SIGNUP_2E_STRIPE_MODE === "live"` AND the Fly secrets being set before returning the live adapter.  Mode mismatch logs loudly + returns the mock (preserves fail-safe). |
| 2.3 | **Live-adapter contract tests** | Mirror the mock-adapter test suite but hit the live Stripe test-mode account.  Tests fail-closed when `STRIPE_API_KEY` is unset.  Verify: customer idempotency, Checkout session creation, webhook signature verification against a real Stripe-signed payload, BalanceTransaction retrieval shape. |
| 2.4 | **Verify-doc population** | Fill `docs/signup-2-stripe-merchant-verify.md` with observed values (fee cap, ACSS interval support, available_on reliability, debit-notification email policy) once founder provides staging merchant-account credentials. |
| 2.5 | **Playwright acceptance against staging + live-mode flag ON** | Three-scenario acceptance: full mandate signing → first-cycle initiation → webhook arrival → ACTIVATION_READY flip.  Payment-failed branch.  Dispute-created revocation. |
| 2.6 | **Stripe-side webhook replay harness** | Fixture script that triggers Stripe test-mode webhook replays so operators can exercise + document the dedup + revocation paths without manual Stripe-dashboard clicks. |
| 2.7 | **Operator inbox dashboard surface** (read-only payment status) | Extends the Phase 2D admin diagnostic with a Phase-2E payment-events + mandate-status panel.  Super-admin gated; audited. |
| 2.8 | **Reconciliation worker (Phase 2I-adjacent)** | Daily sweep that fetches `BalanceTransaction.status` for every `SETTLED` cycle and advances to `ACTIVATION_READY` on late availability flips.  Out-of-scope for Phase 2F; tracked here for completeness. |

---

## 3. Explicit prohibitions until founder authorises items 1.1–1.8

- No `stripe` npm SDK import anywhere in the codebase.
- No `src/lib/billing/stripe-adapter/live.ts` file created.
- No `STRIPE_API_KEY` / `STRIPE_WEBHOOK_SIGNING_SECRET` Fly
  secrets set.
- No activation of `SPECTRE_SIGNUP_2E_PAYMENT_LIVE` on staging
  (would still fail-closed on dev-fixture ToS, but the signal of
  intent to activate is itself gated).
- No activation of `SPECTRE_SIGNUP_2E_STRIPE_MODE=live`.
- No real Stripe test-mode call from staging or local dev.

---

## 4. When Phase 2F may run against the mock

Phase 2F is authorised to be PLANNED (not implemented) immediately.
Phase 2F IMPLEMENTATION, if authorised, may build against the mock
adapter — but Phase 2F MUST NOT treat the mock-generated
`ACTIVATION_READY` as equivalent to independently verified Stripe
financial eligibility.  Phase 2F's re-verification step calls the
same adapter the webhook called; a mock-adapter re-fetch returns
the deterministic mock outcome, not real Stripe state.

This is adequate for exercising the Phase 2F state machine +
atomic transition + concurrency controls, but ANY live-tenant
activation requires items 1.1–1.8 landed first.

---

## 5. Review cadence

- Section 1 reviewed any time an item lands; the item moves to the
  "complete" column + a dated note added.
- Section 2 reviewed when founder authorises the live-adapter
  slice; items implemented in dependency order.
- Section 3 remains in force until founder documents an explicit
  change.

**Document owner:** Spectre operations / Claude.  Last reviewed
2026-10-26.
