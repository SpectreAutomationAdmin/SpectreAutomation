# SIGNUP-2 M4-INT — Integration Audit

**Scope:** Full signup-to-active-tenant journey + the complete billing
lifecycle (renewal / retry / cancellation).  Documents gaps between
"code shipped" and "exercised on staging against real Stripe-originated
events."  Prepared for founder review before the comprehensive
end-to-end acceptance test.

**Baseline:** `spectre-staging` Fly v981, image `sha-c7e2a0b07141`.

**Flag discipline:** every live flag OFF on staging.  Mock
StripeAdapter still powering staging.  M3 §7 global sub-create block
ACTIVE.  CAD $38,000 Price unchanged.

Legend:

- **SHIPPED** — code is deployed on staging and the service module +
  schema + tests exist.
- **DORMANT** — code is shipped but gated behind an OFF flag; the
  path has never fired against a real event on staging.
- **EXERCISED-FIXTURE** — the path has executed on staging via
  signed-webhook fixtures (HMAC-signed Stripe-SHAPED payloads
  injected into the dispatcher); NOT proof of real Stripe-originated
  behaviour.
- **EXERCISED-LIVE** — the path has executed on staging against a
  real Stripe-originated event delivered through Stripe's own
  webhook signing path.
- **GAP** — not shipped at all.

## Lifecycle stage overview

| Stage | Service module | API route | Operator UI | Last confirmed on staging |
|---|---|---|---|---|
| Club registration (self-serve) | `src/lib/signup/*` | `src/app/api/signup/start/route.ts` + Microsoft OAuth routes | Public pages under `/signup` | SHIPPED + EXERCISED-LIVE (2 real sandbox checkouts reached BANK_VERIFIED, M3 close baseline 2026-10-28) |
| Founding admin verification (Microsoft work-account proof) | `src/lib/signup/microsoft-auth.ts` | `src/app/api/signup/microsoft/callback/route.ts` | Public | SHIPPED + EXERCISED-LIVE |
| Resume + recovery | `src/lib/signup/resume.ts`, `recovery.ts` | `src/app/api/signup/resume/request/route.ts`, `src/app/signup/r/[token]/consume/route.ts` | Public (SIGNUP-1G repair baseline) | SHIPPED + EXERCISED-LIVE |
| Executed contract (digital signature) | Phase 2E `ClubContractExecution` writers | — | — | SHIPPED (field present on registration row); NO operator UI yet (**GAP**) |
| Bank authorization (ACSS mandate via Stripe Checkout) | `src/lib/signup/mandate.ts`, StripeAdapter.createMandateCheckoutSession | `src/app/api/signup/mandate/initiate/route.ts`, `mandate/return/route.ts` | Public | SHIPPED + EXERCISED-LIVE (two real sandbox Checkouts reached BANK_VERIFIED) |
| Bank verification (3-state tier via `setup_intent.*`) | `src/lib/billing/signup-2m3-bank-verification-service.ts` | Webhook dispatcher | — | SHIPPED + EXERCISED-FIXTURE (dispatch flag OFF) + EXERCISED-LIVE for the two real sandbox pathways |
| Operator queue (standing + authority + release) | `src/lib/signup/operator-verification.ts` | `src/app/app/admin/signup-ops/*` server-actions | `/app/admin/signup-ops` + `/app/admin/signup-ops/registration/[id]` | SHIPPED + EXERCISED-LIVE (Phase 2D close baseline) |
| Three-operator release path (AUTHORISED unlock) | Phase 2D `releaseRegistration` | server action | `/app/admin/signup-ops/registration/[id]` | SHIPPED + EXERCISED-LIVE (controlled flag flip 2026-10-26) |
| Commercial authorization + payment release (M4-triggering) | `src/lib/billing/signup-2m4-triggering-service.ts` → `authoriseAndReleaseFirstBilling` | — (**GAP**) | — (**GAP**) | SHIPPED, DORMANT.  Two-operator SoD enforced in-service.  Durable idempotent BillingCommand enqueued but no HTTP/UI invocation surface yet. |
| Stripe subscription initiation | `drainOneBillingCommand(SUBSCRIPTION_CREATE_FIRST)` in triggering service | Internal worker | — | SHIPPED, DORMANT.  Gated behind `SPECTRE_SIGNUP_2M4_TRIGGER_LIVE` + `SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION`; mock StripeAdapter.  **Never executed against a real Stripe test subscription.** |
| Payment processing (invoice + settlement) | `src/lib/billing/signup-2m4-settlement-service.ts` | Webhook dispatcher (`onM4SettlementEvent`) | — (**GAP**) | SHIPPED, DORMANT + EXERCISED-FIXTURE.  6 webhook handlers (invoice.paid / payment_failed / marked_uncollectible / dispute.closed / dispute.funds_withdrawn / dispute.funds_reinstated). |
| Settled-funds + funds-availability gate | `assertSettlementAuthoritative` + `evaluateActivationGate` | — | — | SHIPPED, DORMANT.  Verified via contract tests; the available-funds predicate requires `balance_transaction.status === "available"` AND `available_on <= now`. |
| Tenant activation + provisioning job | Phase 2E/2F/2G `authoriseActivation`, `TenantProvisioningJob` worker | — | — (observability GAP) | SHIPPED + EXERCISED-LIVE (mock-backed; Phase 2G-close) |
| Administrator login (first time, post-activation) | `src/lib/auth/*` existing login path | `src/app/api/auth/*` | existing | SHIPPED + EXERCISED-LIVE |
| Renewal readiness (T-45 + T-7 preflight) | `src/lib/billing/signup-2m4-renewal-service.ts` → `scheduleRenewalPreflights` + `executeRenewalPreflight` | — (**GAP**) | — (**GAP**) | SHIPPED, DORMANT.  Preflights persist in `BillingRenewalPreflight`; no scheduler job wires `executeRenewalPreflight` to the clock yet (**GAP**: scheduler integration). |
| Renewal webhook reconciliation | `handleCustomerSubscriptionUpdated/Deleted/MandateUpdated` | Webhook dispatcher | — | SHIPPED, DORMANT + EXERCISED-FIXTURE |
| Failed-payment retry policy (one controlled retry at ≥3 bd) | `src/lib/billing/signup-2m4-retries-service.ts` | Webhook dispatcher (via `invoice.payment_failed`) | — (**GAP**) | SHIPPED, DORMANT + EXERCISED-FIXTURE. §5 corrections #1 + #2 applied; email adapter wired but never fired for a real retry. |
| Cancellation lifecycle (request → authorize → schedule → effective → cancelled) | `src/lib/billing/signup-2m4-cancellation-service.ts` | — (**GAP** — being addressed in this slice) | — (**GAP** — being addressed in this slice) | SHIPPED, DORMANT.  Two-operator SoD + reversal + post-cancellation access evaluator. |

## Gap register (ordered by priority)

### P0 — Blockers for the comprehensive end-to-end acceptance test

| # | Gap | Lifecycle stage | Shape |
|---|---|---|---|
| P0-1 | Real Stripe test subscription has never been created from Spectre | Stripe subscription initiation | Needs founder-authorised, time-boxed flag flip (`SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION` + `SPECTRE_SIGNUP_2M4_TRIGGER_LIVE`) PLUS ACSS Debit transaction-limit confirmed sufficient for CAD $38,000 (per founder §3 "do not attempt a CAD $38,000 subscription until the limit has been confirmed as sufficient"). |
| P0-2 | ACSS Debit limit escalation status not confirmed in Spectre | Stripe adapter config | Platform-level verification outside Spectre.  See §3 in the acceptance report. |
| P0-3 | No operator UI/API for M4-triggering (commercial authorization + payment release) | Commercial authorization + payment release | Addressed in this slice — minimal operator API + hub page. |
| P0-4 | No operator UI/API for M4-cancellation | Cancellation lifecycle | Addressed in this slice — operator API + hub page. |

### P1 — Hardening gaps that do not block acceptance but WILL be reached by the acceptance test

| # | Gap | Shape |
|---|---|---|
| P1-1 | Stat-holiday calendar can under-delay retries silently after 2028 | §5 correction (being addressed in this slice) — replace `logger.warn` with hard refusal (fail-closed) so the retry calendar cannot silently violate the 3-business-day minimum. |
| P1-2 | Club-facing retry email has never been sent through MS 365 adapter on staging | §5 correction (being addressed in this slice) — safe (non-collection) email delivery test endpoint that exercises the exact `selectPlatformEmailAdapter` path to a founder-chosen inbox. |
| P1-3 | Renewal preflight scheduling has no scheduled worker | §5 correction (being addressed in this slice) — observability probe + registration of the recovery sweep.  The actual scheduled-worker integration remains a follow-up slice. |
| P1-4 | Billing exceptions require an operator surface for acknowledgment + resolution | §2 correction — operator API in this slice; UI deferred to a follow-up. |
| P1-5 | No operator surface for renewal review (preflight PRICING_CHANGED / MANDATE_EXPIRED outcomes) | §2 correction — operator API in this slice; UI deferred to a follow-up. |

### P2 — Follow-ups (not required for acceptance but tracked)

| # | Follow-up | Shape |
|---|---|---|
| P2-1 | Stat-holiday calendar extend-reminder scheduled job | A scheduled worker that calls `getStatHolidayCalendarCoverage()` + raises an operator-inbox entry 60 days before the latest-covered year lapses. |
| P2-2 | Full operator UI polish for all four workflows (lists, filters, bulk ops) | Independent slice. |
| P2-3 | Grafana / dashboard integration for billing lifecycle KPIs | Independent slice (reporting, not lifecycle). |
| P2-4 | PDF export of a signed cancellation request (for the finance-committee binder) | Independent slice. |

## Boundary clarifications

- **M3 registration + bank-verification UI/API are not touched by this slice.** The baseline from `project_signup_2_m3_closed.md` is preserved.
- **No new routes are added to the public signup pages.** All M4-INT additions are under `/app/admin/signup-ops/billing/*` and `/api/admin/billing/*`, SUPER_ADMIN-gated.
- **No existing accepted module is redesigned.** Scope-boundary contract tests from earlier M4 slices continue to pass as-is.
- **No real Stripe mutation is ever authorised by this slice.** Every mutation path remains dual-flag gated (service flag + `SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION`).

## Distinguishing categories of evidence

Per founder §6:

| Category | Definition | Where it applies here |
|---|---|---|
| **Unit + contract tests** | File-source scans, in-process predicate assertions, no DB, no HTTP | 1621+ tests across SIGNUP-2 phases 2A..M4-cancellation |
| **DB-backed integration tests** | Real Prisma + real transactions in SQLite (vitest) + Postgres (Docker, pg-validate harness) | M1d multi-TX concurrency harness (11/11 scenarios on Postgres); schema migration smoke |
| **Signed-webhook fixture integration** | HMAC-signed Stripe-SHAPED payloads injected via `/api/webhooks/stripe` on staging | M4-settlement + M4-retries + M4-renewal + M4-cancellation reconcilers exercised this way; **NOT proof of real Stripe-originated behaviour** |
| **Actual Stripe-originated test-mode events** | Real test-mode subscription + real Stripe webhook deliveries | **NEVER exercised for M4-***; M3 bank-verification path has been exercised twice via real sandbox Checkout |
| **Actual settlement + funds-availability verification** | Real `balance_transaction.status === "available"` with `available_on <= now` observed on staging | **NEVER exercised** |

A simulated "settled" webhook does not prove real funds availability.  §6 of this directive makes that explicit; the acceptance report and code comments both reflect it.
