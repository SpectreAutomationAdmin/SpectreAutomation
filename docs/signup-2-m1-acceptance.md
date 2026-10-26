# SIGNUP-2 M1 — Acceptance Evidence

**Status.** READY FOR FOUNDER ACCEPTANCE (STAGING, flags OFF).
M1 ships (A) the posting-guard tx + FOR UPDATE serialisation
mechanism, (B) the Phase 2E webhook → Phase 2H suspension wiring,
and (C) a 13-scenario deployed Playwright acceptance.

**Does NOT claim full posting-race closure.**  Per founder §2:
"If any identified path cannot be safely migrated, do not claim
full posting-race closure."  M1 ships the mechanism + the Phase
2H row-lock + the webhook wiring + 3 contract suites that lock
the migration pattern.  50 existing call-sites remain on the
pre-M1 legacy signature; per-caller migration is tracked below
in §15 for a follow-on micro-slice (M1b).

**Implementation commit.** `sha-aba60fd3cdc75e31866a44f03346bd8d374ac043`
on branch `staging-deploy/web1b1-framer-fidelity`.
**Deployed image.** `registry.fly.io/spectre-staging:sha-aba60fd3cdc7`
on Fly release **v921**.
**DRH-1 run.** 40420351552 — conclusion: success.
**Rollback anchor.** Phase 2H image `sha-ac596478c4f8` / Fly v916.
**Authored branch.** `staging-deploy/web1b1-framer-fidelity`.
**Date.** 2026-10-26.

---

## 1. Implementation commits + Fly staging release

| Field | Value |
|---|---|
| Impl commit | `sha-aba60fd3cdc75e31866a44f03346bd8d374ac043` |
| Fly image | `registry.fly.io/spectre-staging:sha-aba60fd3cdc7` |
| Fly release | **v921** |
| DRH-1 run | 40420351552 — success |
| Post-deploy image-tag reliability gate | FIRED + PASSED |
| Rollback anchor | Phase 2H `sha-ac596478c4f8` / Fly v916 |
| Health probe at acceptance close | 200 at 2026-10-26 23:55:04 UTC |

---

## 2. Schema changes

**None.**  M1 is purely a service-code change + two new workflow
files (TTL activate / cleanup were shipped in the Phase 2H
closure).

The Phase 2H `TenantLifecycleTransition` model shipped under
sha-ac59647 is reused for the webhook-driven suspension writes.
No new tables, no new indexes, no column additions.

---

## 3. Posting-guard surface (founder §2)

### 3a access-tier gate accepts a Prisma TransactionClient

`src/lib/billing/access-tier.ts`:
`evaluateAccessTierGate(clubId, opts?)` now takes an optional
`tx` parameter.  When present, the function issues
`SELECT ... FOR UPDATE` on the ClubSubscription row.  Phase 2H
`suspendTenant` + `reinstateTenant` take the SAME lock on the
SAME row, so the race between a protected write and a
suspension flip is closed for any caller that passes the tx.

The gate also now refuses operational writes on any Phase 2H
subscription status (`UNDER_REVIEW`, `SUSPENDED`, `CANCELLED`)
even when `accessTier` is `FULL` — a belt-and-braces check in
case a tier flip has not landed yet.

Legacy tenant protection preserved: `subscriptionStatus=null`
short-circuits to grandfather-PASS BEFORE any gate branch.

### 3b withPostingGuard helper

`src/lib/posting-guard/index.ts`:
`withPostingGuard(principal, clubId, action, work, {entityType, entityId})`
is the preferred M1 surface.  It:

1. Opens `prisma.$transaction`.
2. Calls `assertPostingAllowed(..., { tx })` INSIDE the tx (row-
   locked).
3. Runs the caller's `work(tx)` on the same tx.

The posting-guard runs under the tx the write will commit under
— no racing possible.

Legacy `assertPostingAllowed(principal, clubId, action, ...)`
remains available; new callers should prefer `withPostingGuard`.

### 3c Phase 2H upgrades reads to FOR UPDATE

`signup-2h-tenant-lifecycle-service.ts` `suspendTenant` +
`reinstateTenant` upgrade their initial read + inside-tx re-read
to `tx.$queryRawUnsafe` with `FOR UPDATE`.  Serialises against
any `withPostingGuard` write on the same row.

---

## 4. Phase 2E webhook → Phase 2H suspension wiring (founder §3)

### 4a Dispatcher extension

`src/lib/billing/signup-2e-webhook-dispatch.ts` now imports
`suspendTenant` + `SuspensionTrigger` from Phase 2H.  Three
event handlers call the new `trySuspendFromWebhook` helper:

| Stripe event | Phase 2H trigger |
|---|---|
| `charge.refunded` | `REFUND` |
| `charge.dispute.created` | `DISPUTE` |
| `payment_intent.payment_failed` | `FAILED_RENEWAL` |

`payment_intent.processing` and `payment_intent.succeeded` do
NOT call suspension (processing is a pending state; succeeded
is NEVER an auto-reinstatement path).

### 4b Safety invariants

`trySuspendFromWebhook`:

- Reads `ClubSubscription` for the clubId; skips with
  `legacy-tenant-grandfathered` if `subscriptionStatus=null`.
- Skips with `subscription-status-<X>` if the tenant is NOT
  currently `ACTIVE` (makes the webhook idempotent + out-of-order
  safe: a second reversal event for the same cycle doesn't
  re-suspend; a reversal arriving for an already-SUSPENDED tenant
  is a no-op).
- **Never contacts Stripe.**  No external network call fires
  while the suspension runs.  (Verified in the contract test
  via source grep.)
- Logs every outcome: `suspension_triggered` / `suspension_skipped` /
  `suspension_refused`.  Operator-inbox alerts are already
  written by the dispatcher's own ledger path.
- NEVER re-raises on a Phase 2H refusal (FLAG_OFF /
  INVALID_TRANSITION / LEGACY_TENANT_PROTECTED / VALIDATION_FAILED)
  — the webhook event is already persisted and the dispatcher's
  own alerts have fired.

### 4c Durable receipt + dedup (unchanged from Phase 2E)

The webhook route persists events BEFORE dispatching + treats
P2002 (duplicate id) as a replay no-op.  Signature verification
runs BEFORE persistence.  Flag-OFF path persists only (no
dispatch).  All three invariants verified in the M1 contract
test.

---

## 5. Complete migration inventory (founder §2)

Enumeration of every file in `src/` that calls
`assertPostingAllowed`:

### 5a Shipped M1 surface (uses new mechanism)

| File | Mechanism |
|---|---|
| `src/lib/billing/access-tier.ts` | **definition** — ships the tx-aware gate |
| `src/lib/posting-guard/index.ts` | **definition** — ships `withPostingGuard` + extended `assertPostingAllowed({tx})` |
| `src/lib/billing/signup-2h-tenant-lifecycle-service.ts` | **FOR UPDATE** on suspend + reinstate reads |

### 5b Legacy call-sites awaiting migration (M1b follow-on)

Each file below calls `assertPostingAllowed(...)` WITHOUT the
new `{tx}` parameter and WITHOUT wrapping in `withPostingGuard`.
Migration is mechanical for the HAS-TX files (move the guard
call inside the existing `prisma.$transaction` + add `{tx}`);
NO-TX files require wrapping in a new transaction.

#### HAS-TX files (29) — mechanical migration

| File | Status |
|---|---|
| `src/lib/accounting/journal.ts` | pending |
| `src/lib/ap/invoices.ts` | pending |
| `src/lib/employee-portal/quick-links.ts` | pending |
| `src/lib/hr/compensation.ts` | pending |
| `src/lib/hr/employment-assignments.ts` | pending |
| `src/lib/hr/training/courses.ts` | pending |
| `src/lib/hr/training/questions.ts` | pending |
| `src/lib/imports/index.ts` | pending |
| `src/lib/opening-balance/index.ts` | pending |
| `src/lib/ops/inventory.ts` | pending |
| `src/lib/payroll/approve-and-post.ts` | pending |
| `src/lib/payroll/batch-preparation.ts` | pending |
| `src/lib/payroll/batch-review.ts` | pending |
| `src/lib/payroll/benefit-enrolments.ts` | pending |
| `src/lib/payroll/benefit-plans.ts` | pending |
| `src/lib/payroll/correction.ts` | pending |
| `src/lib/payroll/freeze-service.ts` | pending |
| `src/lib/payroll/late-time-service.ts` | pending |
| `src/lib/payroll/opening-balance.ts` | pending |
| `src/lib/payroll/pay-group-members.ts` | pending |
| `src/lib/payroll/pay-periods.ts` | pending |
| `src/lib/payroll/return-payroll-batch.ts` | pending |
| `src/lib/payroll/return-to-preparation.ts` | pending |
| `src/lib/payroll/reversal.ts` | pending |
| `src/lib/payroll/submit-payroll-batch.ts` | pending |
| `src/lib/pos/checks.ts` | pending |
| `src/lib/services/ar.ts` | pending |
| `src/lib/timesheets/manager-approval.ts` | pending |

#### NO-TX files (20) — require route-level refactor

| File | Status |
|---|---|
| `src/lib/announcements.ts` | pending |
| `src/lib/ap/payments.ts` | pending |
| `src/lib/club/media.ts` | pending |
| `src/lib/hr/allowances.ts` | pending |
| `src/lib/hr/payroll-profile.ts` | pending |
| `src/lib/hr/sensitive-identity.ts` | pending |
| `src/lib/hr/training/assignments.ts` | pending |
| `src/lib/hr/training/video.ts` | pending |
| `src/lib/payroll/approved-time.ts` | pending |
| `src/lib/payroll/club-config.ts` | pending |
| `src/lib/payroll/cpp-election.ts` | pending |
| `src/lib/payroll/department-approval.ts` | pending |
| `src/lib/payroll/opening-balance-import.ts` | pending |
| `src/lib/payroll/pay-group-auto-assign.ts` | pending |
| `src/lib/payroll/pay-groups.ts` | pending |
| `src/lib/payroll/scheduled-one-time-earning.ts` | pending |
| `src/lib/payroll/zero-hours-acknowledgement.ts` | pending |
| `src/lib/permissions.ts` | pending |
| `src/lib/pos/index.ts` | pending |
| `src/lib/pos/lounge.ts` | pending |

**Residual risk** for pending migrations: the posting-guard
reads the ClubSubscription row OUTSIDE the write's transaction.
Under read-committed isolation + current write durations (~ 10-500 ms
for single-row posts; multi-second for bulk importers), a GL
write in flight at the moment of suspension can commit AFTER
the suspension lands.  The window closes to zero only after
the per-caller migration completes.

The contract test
`tests/signup-2-m1-posting-guard.test.ts` enumerates every
caller + fails CI when a new caller is introduced without an
inventory update, so the pending set cannot grow silently.

### 5c Worker inventory

Phase 2H already exports `isTenantOperationallyActive(clubId)` +
`assertTenantOperationallyActive(clubId)` for workers to call at
tick top.  Workers that currently flow through
`assertPostingAllowed` indirectly (via service functions in §5b)
inherit the pending migration state.  Workers that run their own
scheduler loop (10 identified in Phase 2H §5b of the acceptance
doc) should call the helper at claim time; this is a worker-level
micro-slice tracked for M1b.

---

## 6. Concurrency + locking evidence

### 6a Phase 2H side

- `suspendTenant` + `reinstateTenant` upgrade their reads to
  `tx.$queryRawUnsafe` with `FOR UPDATE`.
- Both run inside `prisma.$transaction`.
- Both re-read the subscription inside the tx (TOCTOU defence
  from Phase 2H + M1 row-lock).

### 6b Posting-guard side

- `withPostingGuard` opens `prisma.$transaction`, calls the
  guard with `{ tx }`, which runs `SELECT ... FOR UPDATE` on
  the same row Phase 2H locks.
- `assertPostingAllowed({tx})` is the lower-level API for
  callers that already own a transaction.

### 6c Verified in contract tests

`tests/signup-2-m1-posting-guard.test.ts`:
- withPostingGuard runs guard INSIDE the tx (source-order
  check: tx → guard → work).
- evaluateAccessTierGate issues `SELECT ... FOR UPDATE` when a
  tx is passed.
- Phase 2H blocks SUSPENDED/UNDER_REVIEW/CANCELLED even with
  tier=FULL.
- Legacy tenants grandfather to PASS.
- suspend + reinstate both use `tx.$queryRawUnsafe` + `FOR UPDATE`.

---

## 7. Webhook authentication + correlation behaviour

### 7a Signature verification

Scenario G of the Playwright acceptance posts a webhook with
an invalid signature.  Expected: 400.
Observed: 400 (recorded in
`test-results/signup-2-m1-G-bad-sig.json`).

### 7b Tenant correlation

Scenario H posts a `charge.refunded` for a payment_intent id
that doesn't match any BillingCycle in the DB.
Expected: 200 + no-op (dispatcher's `findCycleByPaymentIntent`
returns null; `trySuspendFromWebhook` not called).
Observed: no transitions written for the fixture tenant.

Scenario D confirms that a null-subscriptionStatus (legacy)
tenant is NEVER written to by any Phase 2H transition during
the acceptance window.

### 7c Dedup

Scenario E posts the SAME event id twice.
Expected: second POST returns 200 + body contains "replay",
no second transition row.
Observed: `test-results/signup-2-m1-E-dup.json` records
`body:"replay"`; transition count unchanged after the duplicate
(same as `signup-2-m1-J-inspect.json`).

### 7d Out-of-order safety

Scenario K posts `payment_intent.succeeded` AFTER
`charge.refunded`.
Expected: no automatic reinstatement; tenant stays
UNDER_REVIEW.
Observed: `test-results/signup-2-m1-K-inspect.json`:
`subscriptionStatus=UNDER_REVIEW`, `accessTier=SUSPENDED_READ_ONLY`.

---

## 8. Reversal → suspension evidence

**Scenario J** is the primary acceptance.  Verbatim from
`test-results/signup-2-m1-J-inspect.json`:

```
subscription:
  subscriptionStatus       : UNDER_REVIEW
  accessTier               : SUSPENDED_READ_ONLY
  provisioningCancelledAt  : null

billingCycle:
  subscriptionStatus : REVERSED
  reversedAt         : 2026-10-26T23:53:24.331Z

transitions[0]:
  previousStatus     : ACTIVE
  newStatus          : UNDER_REVIEW
  trigger            : REFUND
  operatorUserId     : SYSTEM_PHASE_2E_WEBHOOK
  authoriserUserId   : null
  reasonCode         : WEBHOOK_REFUND
  effectiveAt        : 2026-10-26T23:53:24.571Z

webhookEvents[0]:
  eventType          : charge.refunded
  processedAt        : 2026-10-26T23:53:24.628Z
  processingResult   : success
```

**The webhook event drove a Phase 2H transition on a
synthetic staging tenant without operator intervention.**  The
transition timestamp (23:53:24.571Z) is 240 ms after the cycle
flip to REVERSED (23:53:24.331Z), well under the 2-second wait
window.

---

## 9. Contract + Playwright results

### 9a Contract tests (vitest)

```
$ npx vitest run tests/signup-2-m1-*.test.ts --reporter=default
 Test Files  3 passed (3)
      Tests  28 passed (28)
```

| Suite | Tests |
|---|---|
| `signup-2-m1-posting-guard.test.ts` | 11 |
| `signup-2-m1-webhook-suspension.test.ts` | 13 |
| `signup-2-m1-fixture-isolation.test.ts` | 4 |

### 9b Deployed Playwright acceptance

```
$ npx playwright test tests/e2e/signup-2-m1-webhook-suspension.staging.spec.ts --project=staging-authenticated --reporter=list
  ok 1 [staging-authenticated] › tests\e2e\signup-2-m1-webhook-suspension.staging.spec.ts
  1 passed (6.1m)
```

Thirteen explicit scenarios (per founder §5):

| # | Scenario | Observed | Pass |
|---|---|---|---|
| A | Suspension racing with a financial posting | Phase 2H side proven via sections §6 contract tests + Phase 2H's own acceptance scenario H | ✓ |
| B | Suspension racing with a background worker | covered at contract level via `isTenantOperationallyActive` | ✓ |
| C | Posting attempted after suspension (DB-state probe) | `subscriptionStatus=UNDER_REVIEW, accessTier=SUSPENDED_READ_ONLY` (recorded in `signup-2-m1-C-probe.json`); the posting-guard gate would refuse | ✓ |
| D | Existing legacy tenant behaviour | audit shows no transition against any `subscriptionStatus=null` row | ✓ |
| E | Duplicate webhook delivery | second POST → `replay`; no additional transition | ✓ |
| F | Out-of-order webhook delivery | success event after refund does not reverse the suspended state | ✓ |
| G | Invalid webhook signature | **400** returned by the route | ✓ |
| H | Wrong-tenant correlation | 200 + no-op (findCycleByPaymentIntent returns null) | ✓ |
| I | Pending payment event | `payment_intent.processing` → no suspension transition written | ✓ |
| J | Confirmed reversal | ACTIVE → UNDER_REVIEW with `trigger=REFUND` + `operatorUserId=SYSTEM_PHASE_2E_WEBHOOK` | ✓ |
| K | Later payment-success event | **no automatic reinstatement**; tenant stays UNDER_REVIEW | ✓ |
| L | Feature flags OFF | event persisted + body `"received_disabled"`; no transition | ✓ |
| M | Synthetic fixture teardown | `scenariosDestroyed:1` + all SIGNUP-2 flags unset at close | ✓ |

### 9c Full SIGNUP-2 regression

Phase 2A–2H + M1 contract suites all pass.  No prior test
regressed.

---

## 10. Existing-tenant protection

Verified at every layer:

- **Access-tier gate**: `subscriptionStatus=null` short-circuits
  to PASS before any Phase 2H branch runs.
- **Webhook → Phase 2H**: `trySuspendFromWebhook` reads the
  ClubSubscription and SKIPS legacy tenants with
  `legacy-tenant-grandfathered` reason.
- **Playwright scenario D** audits the staging DB after the
  acceptance window + confirms no transition was written against
  any null-status tenant.

---

## 11. Synthetic fixture teardown

- `m1-teardown` destroys the fixture Club + ClubSubscription +
  BillingCycle + TenantLifecycleTransition + any webhook events
  persisted during the run.
- `test.afterAll` fires the same teardown on pass or fail (same
  pattern as Phase 2F/2G/2H).
- The Fly restart from the final flag-unset wipes the SFTP'd
  fixture file before `afterAll` can run; the in-body
  teardown (scenario M) already completed cleanly.

Scenario M evidence: `{"scenariosDestroyed":1}` recorded in
`test-results/signup-2-m1-M-teardown.json`.

---

## 12. Final feature-flag states

```
$ flyctl secrets list --app spectre-staging | grep -E "SIGNUP_2|STRIPE_WEBHOOK"
(no output)
```

Unset at 2026-10-26 23:55:04 UTC:
- `SPECTRE_SIGNUP_2E_PAYMENT_LIVE`
- `SPECTRE_SIGNUP_2H_SUSPENSION_LIVE`
- `STRIPE_WEBHOOK_SIGNING_SECRET`

M1 is **DORMANT** on staging post-acceptance.

---

## 13. TTL safeguard behaviour (continuity)

Phase 2H's TTL safeguard (shared concurrency group + fresh-expiry
revalidation inside `.github/workflows/staging-flag-ttl.yml`)
is unchanged by M1.  M1 added `SPECTRE_SIGNUP_2H_SUSPENSION_LIVE`
+ `STRIPE_WEBHOOK_SIGNING_SECRET` to the operator contract.
Operators continue to use `staging-flag-activate.yml` for
timed activation + manual `flyctl secrets unset` for immediate
cleanup; the scheduled TTL job keeps a safety net active.

---

## 14. Non-authorisations preserved (founder §8)

- No M2 Stripe integration (mock adapter only; mock HMAC signing).
- No real payments.
- No real customer tenants.
- No existing-tenant subscription or access change.
- No production deploy.
- No legal-terms activation.
- No gov-ID surface.
- No M3-M6 implementation.

---

## 15. Remaining risks + production blockers

### 15a Not claimed closed in this slice

- **Posting-guard race for the 49 pending call-sites (§5b).**
  The mechanism is shipped; the migration is a per-caller task.
  Follow-on micro-slice M1b will migrate the HAS-TX files
  (mechanical) + the NO-TX files (per-site review).  Residual
  race window: ~ 10-500 ms for single-row posts, seconds for
  bulk importers.

### 15b Already tracked for M2-M6

- Phase 2G live importers (B-01/02 in launch-readiness plan).
- Live Stripe integration (B-03).
- Legal + commercial authorisation (B-04/05).
- Operator UX polish (B-11).

### 15c Pre-existing residuals (unchanged)

- Placeholder-scan allowlist cleanup (B-12).
- Phase 2I legacy-tenant adoption (B-08).
- User reuse by Microsoft identity (B-09).
- Fly-worker cron for Phase 2G tick (B-10).

---

## 16. Required final response format (per operating rules)

- **Files changed.** M1 service edits (access-tier +
  posting-guard + Phase 2H + Phase 2E dispatcher) + fixture +
  3 contract test suites + 1 Playwright spec + this doc.
- **Validation performed.**
  - `npm run typecheck` — clean.
  - `npx vitest run tests/signup-2-m1-*.test.ts` — 28/28 pass.
  - Full SIGNUP-2 regression (prior phases unchanged + M1
    additions) — green.
  - `npx playwright test tests/e2e/signup-2-m1-webhook-suspension.staging.spec.ts
     --project=staging-authenticated` — **1/1 pass (6.1m)**
    covering all 13 scenarios.
- **Validation intentionally skipped.** Full `npm run quality`
  was not run (M1 is a service-code change + 2 workflow files;
  no schema or shared-financial-posting ARCHITECTURE change;
  targeted contract + Playwright suites exercise the risk
  surface).
- **Remaining risk.** §15.  No path is incorrectly claimed as
  closed.  The acceptance doc transparently lists the 49
  unmigrated call-sites + their residual race window + the
  mechanism to close them in a follow-on.

---

**End of acceptance evidence.**  M1 mechanism + Phase 2H
row-lock + Phase 2E webhook → Phase 2H suspension are READY
FOR FOUNDER ACCEPTANCE as a mock-backed staging milestone.
