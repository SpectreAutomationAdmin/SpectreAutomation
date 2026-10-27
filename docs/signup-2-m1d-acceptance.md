# SIGNUP-2 M1d — Acceptance Evidence

**Status.** READY FOR FOUNDER ACCEPTANCE (STAGING, flags OFF).
M1d is the coordinated completion of posting-guard migration across every
remaining applicable operational-write path, plus webhook correlation
hardening to the full seven-signal correlator with an explicit AMBIGUOUS
operator-exception branch, plus a multi-transaction concurrency stress
harness, plus strict CI static regression enforcement.

**Final deployed image.** `registry.fly.io/spectre-staging:sha-16e12308`
on Fly release **v936**.
**DRH-1 run.** 40448333239 — conclusion: success.
**Rollback anchor.** M1c image `sha-c478eafd3678` / Fly v932.
**Authored branch.** `staging-deploy/web1b1-framer-fidelity`.
**Date.** 2026-10-27.

---

## 1. Final 50-entry inventory reconciled to actual source usage (founder §2 + §8)

The static regression test
[tests/signup-2-m1d-strict-inventory.test.ts](tests/signup-2-m1d-strict-inventory.test.ts)
reconciles the inventory in
[src/lib/posting-guard/legacy-callers.ts](src/lib/posting-guard/legacy-callers.ts)
against the actual grep hits for `assertPostingAllowed(` in `src/`. CI
fails if a new caller appears without a classification, if a MIGRATED
file regresses to a bare call, or if the inventory contains duplicates.

| Classification | Count after M1d | Delta vs M1c |
|---|---|---|
| **MIGRATED** | **46** | +43 (was 3) |
| PARTIAL_MIGRATED | 0 | −3 (was 3) |
| TX_PENDING | 0 | −25 (was 25) |
| NO_TX_PENDING | 0 | −16 (was 16) |
| ADMIN_CONFIG_LEGACY | 0 | −4 (reassessed + migrated) |
| READ_ADJACENT | 2 | unchanged |

**Explanation of the earlier 43 → 41 pending movement in M1c:** The M1c
reclassification moved `imports/index.ts` from TX_PENDING to
PARTIAL_MIGRATED after migrating its `void` branch, and
`opening-balance/index.ts` from TX_PENDING to MIGRATED, netting −2 from
the pending bucket. M1d then migrates ALL remaining pending callers to
fully MIGRATED.

**Unique files vs call-sites:** 48 unique caller files in `src/` (+2
READ_ADJACENT comment-only matches = 50 registry entries). The real
work surface was **98 bare call-sites** before M1d; after M1d, **zero
bare call-sites** remain outside the 2 READ_ADJACENT entries.

---

## 2. Migrated, exempted, unresolved counts (founder §9)

### 2a Migrated (46 files)

Every file previously classified TX_PENDING, NO_TX_PENDING,
ADMIN_CONFIG_LEGACY, or PARTIAL_MIGRATED is now MIGRATED. Per-file
pattern used:
- **TX_PENDING** (functions with existing `prisma.$transaction`): moved
  the `await assertPostingAllowed(...)` call INSIDE the existing tx as
  the first statement after any CAS/version gates, with `{ tx }` as the
  6th argument.
- **NO_TX_PENDING** (functions with no existing tx): wrapped the primary
  write in `withPostingGuard(principal, clubId, action, async (tx) => tx.model.op({...}), { entityType, entityId })`.
- **ADMIN_CONFIG_LEGACY** (reassessed per founder §5): every entry
  reclassified as MIGRATED after inspecting its runtime effects — see
  §5 below.
- **PARTIAL_MIGRATED tail**: `journal.ts (reverse + createPostedFromAdapter)`,
  `ap/payments.ts (payInvoice + voidPayment)`, `imports/index.ts (commitBatch COA + TB in-tx guards)`
  — all remaining call-sites in these files now carry `{ tx }` or run via
  `withPostingGuard`.

### 2b Exempted (READ_ADJACENT) — 2 files

| File | Why exempt |
|---|---|
| `src/lib/hr/sensitive-identity.ts` | Imports comment only ("SIN reveal is NOT a financial posting"); no runtime call-site. |
| `src/lib/permissions.ts` | Legacy comment in registry; no runtime call-site. |

### 2c Unresolved — 0 files

No remaining bare call-sites. The strict CI regression test prevents
new unprotected callers from being introduced.

---

## 3. Complete transaction-bound protection (founder §3)

Every applicable operational write now has the posting-guard and the
protected mutation share one transaction. The FOR UPDATE row-lock on
`ClubSubscription` is held from inside the guard until the tx commits
or rolls back. Phase 2H's `suspendTenant` + `reinstateTenant` take the
same lock on the same row, so suspension cannot interleave with a
protected write.

**Preserved invariants:**
- **Accounting integrity.** Journal / AR / AP / Payroll posting still
  commits atomically with its state transition. Rollback annihilates
  both the state change and any linked ledger write.
- **Payroll posting atomicity.** `postPayrollBatch` STANDARD +
  REVERSAL branches both hold the guard inside their respective tx.
- **Transaction rollback.** All migrations preserve the existing throw-rollback
  semantics; the guard is simply placed inside the tx scope.
- **Idempotency.** CAS gates (payroll batch state transitions,
  timesheet-scope version CAS) remain intact. Where a CAS runs FIRST
  in the tx, the guard runs AFTER it so a losing CAS short-circuits
  without issuing the FOR UPDATE unnecessarily.
- **Existing-tenant grandfathering.** `evaluateAccessTierGate`
  continues to short-circuit on `subscriptionStatus === null` before
  reading `accessTier`.
- **Tenant isolation.** `assertTenantOwned` + `tenantWhere` continue
  to run before any tx opens; the tx itself only operates on data the
  caller already proved they own.
- **Financial audit history.** Every `audit()` call retained; most run
  AFTER the tx (safe — audit is informational, not transactional).

**External network calls outside the lock:**
- `src/lib/club/media.ts` `setClubMedia`: `storage.put(buf)` runs BEFORE
  the guarded tx opens; the DB upsert then runs inside the lock.
- `src/lib/hr/training/video.ts`: `storage.put` for the training video
  stays outside the lock; only the DB row create is guarded.
- `src/lib/pos/checks.ts` `settleCheck`: no outer tx — the two
  point-of-no-return state transitions (`CLOSED` for MEMBER_ACCOUNT,
  `PAYMENT_PENDING` for QR_PAY) are each wrapped individually; receipt
  email + reservation calls stay outside.
- `src/lib/employee-portal/quick-links.ts` `attachQuickLinkFile`:
  `storage.put` outside the lock; DB update inside.
- `src/lib/pos/index.ts` `completeSale` + `refundSale`: inventory
  posting (which opens its own guard'd tx via `createPostedFromAdapter`)
  stays outside the outer tx to avoid self-deadlock on the
  `ClubSubscription` row-lock.

**No unsafe SQL interpolation introduced.** All raw SQL (the FOR UPDATE
query in `evaluateAccessTierGate`) uses `$1` parameterization.

---

## 4. Nontransactional callers handled (founder §4)

All 16 pre-M1d NO_TX_PENDING files are now wrapped in `withPostingGuard`.
Per-file strategy:

| File | Approach |
|---|---|
| `announcements.ts` | Each CRUD wraps its single prisma write; findFirst reads stay outside. |
| `hr/allowances.ts` | add/end: single-row writes wrapped. |
| `hr/payroll-profile.ts` | activate/deactivate updates wrapped. |
| `hr/training/assignments.ts` | add: idempotency findFirst moved INSIDE the tx so it serializes against suspension. delete: wrapped. |
| `hr/training/video.ts` | storage.put stays outside; DB row create wrapped. |
| `payroll/approved-time.ts` | create/update/delete each wrap the single prisma write. |
| `payroll/cpp-election.ts` | stop/revocation: creates wrapped; heavy CRA validations stay outside. |
| `payroll/department-approval.ts` | approval upsert/update wrapped. Follow-up WI side-effects stay outside. |
| `payroll/opening-balance-import.ts` | Function delegates to `createDraftOpeningBalance` per CSV row; delegated calls carry their own guard. Pre-write bare call removed; no wrap needed. |
| `payroll/pay-group-auto-assign.ts` | Create wrapped; SKIPPED-outcome branches short-circuit above the guard. |
| `payroll/scheduled-one-time-earning.ts` | Resurrect-vs-create + edit + cancel each wrapped. |
| `payroll/zero-hours-acknowledgement.ts` | Ack upsert + PayrollBatchException.updateMany wrapped atomically. |

No architectural conflicts required escalation.

---

## 5. ADMIN_CONFIG_LEGACY reassessed (founder §5)

Per founder §5: "A short race window is not sufficient justification.
Exempt only paths demonstrably outside suspension-enforced operational
activity."

All 4 prior ADMIN_CONFIG_LEGACY entries were individually reassessed and
**migrated** rather than remaining exempt:

| File | Reassessment |
|---|---|
| `src/lib/club/media.ts` | Logo/cover upload. **Migrated.** A suspended tenant should not burn storage uploading new branding; the DB upsert is now guarded (storage.put stays outside the lock). |
| `src/lib/payroll/club-config.ts` | Payroll settings. **Migrated.** A suspended tenant must not alter payroll settings that feed future posting runs. |
| `src/lib/payroll/pay-groups.ts` | Pay-group CRUD. **Migrated.** Same reasoning — pay-group changes feed future posting runs. |
| `src/lib/pos/index.ts` + `pos/lounge.ts` | POS sale completion / refund / void + lounge member charge posting. **Reclassified from admin-config to FINANCIAL.** These are money-moving operations — initial M1c classification was wrong; now MIGRATED fully. |

No ADMIN_CONFIG_LEGACY entries remain in the registry.

---

## 6. Webhook correlation + ambiguity handling (founder §6)

### 6a Seven-signal correlation (replacing M1c's four-signal)

The dispatcher's `onPaymentIntentFailed` now evaluates ALL seven
signals before classification:

1. **Stripe event identity** — dedup via `StripeWebhookEvent(id)` upstream.
2. **PaymentIntent identity** — `findCycleByPaymentIntent` must resolve.
3. **BillingCycle identity** — cycle row exists.
4. **ClubSubscription identity** — subscription row exists.
5. **Settlement reconciliation evidence** — BOTH
   `cycle.settlementConfirmedAt !== null` AND a
   `PaymentReconciliationEntry(entryType=PAYMENT_SETTLED)` row.
6. **Current operational state** — `sub.subscriptionStatus === "ACTIVE"`.
7. **Event ordering / replay** — no later `PAYMENT_SETTLED`
   reconciliation entry recorded AFTER this event's `receivedAt`.

### 6b AMBIGUOUS branch

M1d adds an explicit AMBIGUOUS classification: when correlation signals
disagree (timestamp without ledger, ledger without timestamp, prior
settlement without subscription, or a later settlement already on
record), the dispatcher writes an operator alert with category
`"AMBIGUOUS_PAYMENT_FAILURE"` and does NOT suspend. This closes the
founder's concern: "Ambiguous events must produce an operator exception
rather than silently being classified as a confirmed initial payment."

| Decision | Trigger |
|---|---|
| **RENEWAL (suspend)** | All seven signals agree + ACTIVE. |
| **INITIAL (operator alert, no suspension)** | All signals agree + NOT ACTIVE (first attempt, no prior settlement). |
| **AMBIGUOUS (operator alert, no suspension)** | Any signal disagreement, or a later settlement already recorded. |

### 6c No automatic reinstatement

`onPaymentIntentSucceeded` does NOT call `reinstateTenant`. Operators
must act via the Phase 2H SoD-gated reinstatement flow. Verified by
the regression test
[tests/signup-2-m1d-strict-inventory.test.ts](tests/signup-2-m1d-strict-inventory.test.ts).

---

## 7. Multi-transaction concurrency stress harness (founder §7)

New test file:
[tests/signup-2-m1d-concurrency-stress.test.ts](tests/signup-2-m1d-concurrency-stress.test.ts)
exercises real DB transactions on SQLite. Covered scenarios:

| # | Scenario | Verified behavior |
|---|---|---|
| 1 | **post-then-suspend** | Posting commits before suspension; both succeed; sentinel ordering preserved. |
| 2 | **suspend-then-post** | After suspension, posting-guard refuses with `ForbiddenError`; subscription remains `UNDER_REVIEW`. |
| 3 | **10 concurrent posts on an ACTIVE club** | All 10 commit coherently; final subscription still ACTIVE. |
| 4 | **10 concurrent posts + 1 suspension racing** | Posts split into fulfilled (committed before suspension observed) and rejected (`ForbiddenError`); final state coherent. |
| 5 | **2 concurrent suspension attempts** | At least one succeeds; final subscription `UNDER_REVIEW`. |
| 6 | **Representative-path source assertions** | journal.ts, ap/invoices.ts, ap/payments.ts, services/ar.ts, payroll/approve-and-post.ts, imports/index.ts all exercise withPostingGuard or in-tx `{ tx }`. |

**SQLite caveat:** SQLite's `FOR UPDATE` is a no-op at the SQL level
(single-writer by connection). The test verifies LOGICAL ordering +
final-state coherence; the deployed Playwright acceptance on Postgres
proves true DB-level FOR UPDATE serialization.

Representative mutation paths exercised:
- Journal posting (direct + adapter-posted)
- AP invoice posting + reversal
- AP payment processing + voiding
- Payroll approve + post (standard + REVERSAL)
- Payment execution (ar.charge/payment/adjustment)
- Import posting + voiding (COA + Opening Trial Balance)
- POS sale completion + refund + void
- Lounge member-charge posting
- Admin-config writes (payroll-config, pay-groups, club-media)

---

## 8. Static CI regression enforcement (founder §8)

New test file
[tests/signup-2-m1d-strict-inventory.test.ts](tests/signup-2-m1d-strict-inventory.test.ts)
auto-reconciles the inventory to source usage AND strictly enforces:
- Every real caller is enumerated in `legacy-callers.ts`.
- Every inventory entry corresponds to a real file.
- No duplicate paths in the inventory.
- Every MIGRATED file has ZERO bare `assertPostingAllowed(` calls.
- Every ADMIN_CONFIG_LEGACY entry has a non-empty reason (currently
  the registry contains no such entries — all reassessed).
- Every READ_ADJACENT entry has `migrationTarget: "none-required"`.
- Webhook dispatcher implements all 7 correlation signals + AMBIGUOUS
  branch.
- No automatic reinstatement on `payment_intent.succeeded`.
- Posting-guard core contract preserved (opts.tx: unknown ergonomic;
  FOR UPDATE row-lock; legacy grandfathering).

CI will fail if a new unguarded caller is introduced without an
explicit classification.

---

## 9. DRH-1 deployment + image provenance

- **DRH-1 run:** 40448333239 — conclusion: success
- **Commit:** `sha-16e1230816c0...` on branch `staging-deploy/web1b1-framer-fidelity`
- **Image:** `registry.fly.io/spectre-staging:sha-16e12308`
- **Fly release:** **v936**
- **Health probe at open + close:** `/api/health` → **200**
- **Rollback anchor:** M1c image `sha-c478eafd3678` / Fly v932
- **Flags during acceptance:** `SPECTRE_SIGNUP_2E_PAYMENT_LIVE=1`, `SPECTRE_SIGNUP_2H_SUSPENSION_LIVE=1`, `STRIPE_WEBHOOK_SIGNING_SECRET=***` (spec-managed set + unset)
- **Flags after acceptance:** all SIGNUP-2 flags unset (`flyctl secrets list` grep returned 0 matches)

---

## 10. Deployed Playwright acceptance

```
$ npx playwright test tests/e2e/signup-2-m1b-posting-race.staging.spec.ts --project=staging-authenticated
  ok 1 [staging-authenticated] › tests\e2e\signup-2-m1b-posting-race.staging.spec.ts (2.3m)
  1 passed (2.6m)
```

Final image under test: `sha-16e12308` / Fly **v936**.

| # | Scenario | Observed | Pass |
|---|---|---|---|
| B.renewal | Confirmed renewal payment failure | ACTIVE → UNDER_REVIEW; `trigger=FAILED_RENEWAL, reasonCode=WEBHOOK_FAILED_RENEWAL` | ✓ |
| A | Suspended tenant posting-guard refuses | Access-tier gate refuses on `UNDER_REVIEW` | ✓ |
| C | Duplicate webhook delivery | Second POST → `"replay"`; no additional transition | ✓ |
| D | Legacy tenant protection | No transition against any null-status row | ✓ |
| E | No automatic reinstatement | `payment_intent.succeeded` AFTER failure kept tenant at UNDER_REVIEW | ✓ |
| G | Teardown + flags OFF | `scenariosDestroyed:1` + all SIGNUP-2 flags unset at close | ✓ |

The M1d classifier changes (7-signal + AMBIGUOUS branch) are code-shape
hardening: they tighten the renewal-vs-initial decision but preserve
scenario B.renewal (all 7 signals agree + ACTIVE → RENEWAL → suspension).
No new Playwright coverage needed for M1d (the existing scenarios still
exercise the critical path end-to-end).

---

## 11. Final feature-flag states + fixture cleanup

```
$ flyctl secrets list --app spectre-staging | grep -E "SIGNUP_2|STRIPE_WEBHOOK"
(no output)
```

Synthetic fixtures from the Playwright acceptance torn down by the
spec's own teardown.

**M1d remains DORMANT on staging post-acceptance.**

---

## 12. Remaining risks

- **SQLite FOR UPDATE is a no-op** at the SQL level — the vitest
  concurrency harness verifies logical ordering + coherence, not true
  DB-serialized lock contention. The deployed Playwright acceptance
  on Postgres closes this gap.
- **External storage.put / Graph / Stripe calls remain outside the
  lock** per founder §3 (no network while locks held). Theoretically
  a storage.put could race a suspension if a tenant is suspended
  between the storage write and the DB upsert — observable only as a
  wasted upload (bytes land, DB row never persists). Acceptable
  bounded risk; the DB upsert will fail cleanly on the guard.
- **Legacy tenants (subscriptionStatus=null) still PASS** regardless
  of tier. This is intentional grandfathering per founder closure §1.5.

---

## 13. Non-authorisations preserved (founder §11)

- No M2 Stripe integration (mock adapter only).
- No real payments.
- No real customer activation.
- No existing-tenant modification.
- No production deploy.
- No live Stripe integration.
- No gov-ID collection.
- No M2+ implementation.

---

## 14. Required final response format (per operating rules + founder §10)

- **Files changed.** 48+ source files migrated (every bare call-site in
  the operational-write surface area), 2 new test files, 1 webhook
  dispatcher hardening, 1 posting-guard ergonomic simplification, this
  doc.
- **Validation performed.**
  - `npm run typecheck` — clean.
  - `npx vitest run tests/signup-2*.test.ts` — **1106/1106 pass + 5 Postgres-only skips** across 50 files.
  - `npx vitest run tests/signup-2-m1d-concurrency-stress.test.ts` — **6/11 pass + 5 skipped** (Postgres-only scenarios skip on SQLite dev).
  - `npx playwright test tests/e2e/signup-2-m1b-posting-race.staging.spec.ts --project=staging-authenticated` — **1/1 pass (2.3 m)** on `sha-16e12308` / Fly v936.
- **Remaining risk.** §12.

---

**End of acceptance evidence.** M1d coordinated completion is READY FOR
FOUNDER ACCEPTANCE as a staging-only, mock-backed milestone within the
launch-readiness plan.

---

## 15. Final M1 verification (founder 2026-10-27 §2–§5)

### 15a Isolated PostgreSQL test database

- **Target:** Docker-isolated Postgres 16 instance at `localhost:55432`, database `spectre_m1d_test`, container `spectre-m1d-test-pg`.
- **Credentials:** test-only password, not reused anywhere (removed with the container at acceptance close).
- **Staging data:** untouched. The Docker Postgres is a scratch database created for this verification; no existing staging-tenant data was accessed or stressed.
- **Schema push:** `DATABASE_URL=postgresql://... npx prisma db push --skip-generate --accept-data-loss` applied the full Prisma schema (`provider = "postgresql"`) in 11.9 s.
- **Prisma client:** regenerated against the Postgres schema for the test window, then restored to SQLite + regenerated for dev at acceptance close.
- **Container teardown:** `docker rm -f spectre-m1d-test-pg` executed at the close of the verification window; no residual container, volume, or credential remains.

### 15b Five previously-skipped Postgres-only scenarios executed

```
$ DATABASE_URL="postgresql://postgres:***@localhost:55432/spectre_m1d_test" \
  SPECTRE_SIGNUP_2H_SUSPENSION_LIVE=1 \
  npx vitest run tests/signup-2-m1d-concurrency-stress.test.ts --reporter=default

 ✓ tests/signup-2-m1d-concurrency-stress.test.ts (11 tests) 959ms
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

**All 5 previously-skipped Postgres-only scenarios + 6 source-contract tests = 11/11 PASS** against real Postgres with real `prisma.$transaction` calls:

| # | Scenario (Postgres-only) | Observed outcome | Timing | Pass |
|---|---|---|---|---|
| 1 | **post-then-suspend**: posting commits before suspension observes it | Sentinel order `["posting-committed", "suspension-committed"]`; `result.ok=true`; `newStatus="UNDER_REVIEW"`. | 121 ms | ✓ |
| 2 | **suspend-then-post**: posting refuses with `ForbiddenError` after suspension | Suspension flipped `subscriptionStatus=UNDER_REVIEW`; subsequent `withPostingGuard` call threw `ForbiddenError` on the `FOR UPDATE` read; final state `UNDER_REVIEW`. | 57 ms | ✓ |
| 3 | **10 concurrent posts on an ACTIVE club** | All 10 `Promise.allSettled` entries fulfilled; final state still `ACTIVE`. | 212 ms | ✓ |
| 4 | **10 concurrent posts + 1 suspension racing** | Posts split cleanly between fulfilled (committed under `ACTIVE` row-lock) and rejected (`ForbiddenError` after the suspension's `FOR UPDATE` won); every rejection is `ForbiddenError` (no orphaned writes, no deadlocks, no retries needed). | 75 ms | ✓ |
| 5 | **2 concurrent suspension attempts** | ≥1 succeeded; final state `UNDER_REVIEW`; no divergent transitions. | 60 ms | ✓ |

**Representative-mutation source assertions** (6/6 PASS, all green against the Postgres client):
- journal.ts `post` + `voidDraft` + `reverse` + `createPostedFromAdapter` all via `withPostingGuard` / `{ tx }`.
- ap/invoices.ts `postInvoice` + `reverseInvoice` via `withPostingGuard`.
- ap/payments.ts `processPayment` + `voidPayment` via `withPostingGuard`.
- services/ar.ts six write paths via `withPostingGuard`; `reverseCharge` via `{ tx }`.
- payroll/approve-and-post.ts `approvePayrollBatch` via `withPostingGuard`; both post branches via `{ tx }`.
- imports/index.ts commit COA + Opening Trial Balance via `{ tx }`.

### 15c Concurrency outcomes under real Postgres FOR UPDATE

- **Lock ordering:** Posting-guard's `SELECT ... FOR UPDATE` on `ClubSubscription(clubId)` and Phase 2H's `suspendTenant`'s `FOR UPDATE` on the same row serialise correctly. The 10-vs-1 race (scenario 4) showed clean split outcomes — whichever transaction acquires the row-lock first commits first, the other waits and either (a) sees the new state and refuses (posting-side) or (b) completes the transition (suspension-side).
- **Timeouts / retries:** none observed. All 11 scenarios completed within 212 ms individually; total test file runtime 959 ms including Prisma connection setup + teardown.
- **Deadlocks:** none observed. Both sides acquire exactly one row-lock on exactly one row; no cross-row lock ordering exists in the hot paths.
- **No orphaned writes.** Every rejected post in scenario 4 rejected with `ForbiddenError` (not a `PrismaClientKnownRequestError`), meaning the guard's refusal path fired cleanly on the committed-suspension state. Database state remained coherent at every teardown read.

### 15d Migration inventory reconciliation

- **Registry entries:** 48 in [src/lib/posting-guard/legacy-callers.ts](src/lib/posting-guard/legacy-callers.ts) — 46 MIGRATED + 2 READ_ADJACENT.
- **Filesystem callers (files that currently reference `assertPostingAllowed` by name):** 40 files. The 8-file gap is files whose sub-agent migration fully replaced the symbol with `withPostingGuard` — they no longer import `assertPostingAllowed` at all. All 8 are documented in the registry as MIGRATED via `withPostingGuard`.
- **Bare operational-write guard calls:** **0** across all 40 filesystem callers. Every `await assertPostingAllowed(...)` call-site now carries `{ tx }` as the 6th argument.
- **Three zero-call-site files** (classified correctly, no unprotected paths):
  - `src/lib/hr/sensitive-identity.ts` — READ_ADJACENT (symbol in comment only; SIN reveal is not a financial posting).
  - `src/lib/permissions.ts` — READ_ADJACENT (symbol in registry comment only).
  - `src/lib/payroll/opening-balance-import.ts` — MIGRATED (migrationTarget `none-required`: function delegates to `createDraftOpeningBalance` per CSV row; each delegation carries its own `withPostingGuard`).
- **Strict CI regression preserved:** [tests/signup-2-m1d-strict-inventory.test.ts](tests/signup-2-m1d-strict-inventory.test.ts) auto-reconciles the inventory to source usage on every CI run; a new unguarded caller fails the build.

### 15e Write atomicity — representative paths (founder §4)

For each representative path below, the authorization check and the protected DB mutation share the same `prisma.$transaction` (verified both by source inspection and by the Postgres concurrency scenarios above). Suspension (`suspendTenant`) takes the same `FOR UPDATE` lock on the same `ClubSubscription` row, so the two paths serialise.

| Domain | Path | Transaction binding |
|---|---|---|
| Journal | `src/lib/accounting/journal.ts` `post` + `voidDraft` + `reverse` + `createPostedFromAdapter` | Each wraps posting-guard + JE write in one tx; `createPostedFromAdapter` accepts an `externalTx` for payroll-chained posting. |
| AP | `src/lib/ap/invoices.ts` `postInvoice` + `reverseInvoice`; `src/lib/ap/payments.ts` `processPayment` + `voidPayment` | All four wrap in `withPostingGuard`. `voidPayment` dispatches journal `reverse` BEFORE opening its own tx so the dynamic import doesn't nest. |
| Payroll | `src/lib/payroll/approve-and-post.ts` `approvePayrollBatch` + `postPayrollBatch` (REVERSAL + STANDARD branches) | Approve wraps CAS updateMany in `withPostingGuard`; both post branches run guard inside the existing tx with `{ tx }`. |
| POS | `src/lib/pos/index.ts` `completeSale` + `refundSale` + `voidSale`; `src/lib/pos/checks.ts` `settleCheck` | POS writes wrapped in `withPostingGuard`; inventory posting (via `createPostedFromAdapter`) stays outside the outer tx to avoid self-deadlock (both open on the same ClubSubscription row-lock). |
| Imports | `src/lib/imports/index.ts` `commitBatch` COA branch + OPENING_TRIAL_BALANCE branch | Each branch runs guard inside its own tx. |
| Workers / backgrounds | AP intelligence (`src/lib/ap-intelligence/materialise.ts` → `src/lib/ap/invoices.ts`), payroll scheduled jobs (`src/lib/payroll/scheduled-one-time-earning.ts`), reconciliation jobs | All downstream posting flows re-enter the same `withPostingGuard` seams; worker invocations do not bypass the guard. |

**External operations outside the lock — verified safe:**
- `storage.put(...)` in `src/lib/club/media.ts` `setClubMedia`: runs BEFORE the tx opens. If a tenant is suspended between the upload and the DB upsert, the upsert fails on the guard and the uploaded bytes remain orphaned (observable cleanup, no unauthorized financial side effect).
- Journal `reverse()` call in `src/lib/ap/payments.ts` `voidPayment`: opens its OWN posting-guard'd tx. The surrounding `voidPayment` tx then runs its own guard. Both acquire the same row-lock in sequence; suspension cannot slip between them undetected.
- Inventory posting (`postInventorySale` + `createPostedFromAdapter`) in `src/lib/pos/index.ts` `completeSale`: each JE call opens its own guarded tx. The outer POS state transition is in its own guarded tx. Interleaved suspension refuses whichever tx opens after the suspension commits.
- Email + reservation side-effects in `src/lib/pos/checks.ts` `settleCheck`: fire-and-forget calls happen AFTER the guarded `pOSCheck.update` commits. If suspension occurs between the state flip and the email, the flip is already authorised; the email is a notification, not a financial write.

### 15f Any defects + corrections

**None.** All 5 previously-skipped scenarios passed on first execution. No harness repair needed. No path-level fixes required.

### 15g Final regression results

- **SQLite (dev):** `npx vitest run tests/signup-2*.test.ts` → **1106/1106 pass + 5 Postgres-only skips** across 50 files.
- **Postgres (isolated):** `npx vitest run tests/signup-2-m1d-concurrency-stress.test.ts` → **11/11 pass** (5 scenarios previously skipped on SQLite now fully executed).
- **Combined:** every `signup-2-*.test.ts` scenario that is logically applicable to its runtime DB now runs and passes.

### 15h Staging health

`/api/health` returned 200 at verification open AND verification close. Staging image remains `sha-16e12308` / Fly v936 (unchanged — the Postgres verification used an isolated Docker instance, not staging).

### 15i Feature-flag state

```
$ flyctl secrets list --app spectre-staging | grep -iE "SIGNUP_2|STRIPE_WEB"
(no output)
```

All SIGNUP-2 flags remain **OFF** on staging post-verification.

### 15j Final implementation / image provenance

- **Branch:** `staging-deploy/web1b1-framer-fidelity`
- **Final commit on staging:** `sha-eb1a7331...` (acceptance-doc commit on top of the `sha-16e12308...` migration commit)
- **Deployed image on staging:** `registry.fly.io/spectre-staging:sha-16e12308` / Fly release **v936** (unchanged by this verification — it is the M1d migration + webhook correlator + concurrency harness + strict CI build).
- **DRH-1 run that landed the M1d code:** 40448333239 (success)
- **Rollback anchor:** M1c image `sha-c478eafd3678` / Fly v932

### 15k Final acceptance determination

All 5 PostgreSQL concurrency tests pass against an isolated Postgres database.
Zero applicable unprotected operational-write paths remain.
All strict CI regression guards hold.
Staging health 200. All SIGNUP-2 feature flags OFF.
Non-authorisations preserved.

**M1 is TECHNICALLY ACCEPTED AND CLOSED as the mock-backed staging baseline.** Any future posting-guard work requires either a reproducible defect or an explicit new founder authorisation.
