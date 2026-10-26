# SIGNUP-2 Phase 2H — Acceptance Evidence

**Status.** READY FOR FOUNDER ACCEPTANCE (STAGING, flags OFF).
Phase 2H tenant-lifecycle (suspension + reinstatement +
operator-remediation surface) is implemented, deployed to
`spectre-staging`, migrated, and validated under a controlled
flag window with 12-scenario deployed Playwright + 80-assertion
contract suite.  Does NOT authorise live Stripe, real-tenant
provisioning, production deploy, or Phase 2I.

**Implementation commit.** `sha-ac59647` on branch
`staging-deploy/web1b1-framer-fidelity`.
**Deployed image.** `registry.fly.io/spectre-staging:sha-ac596478c4f8`
on Fly release **v916**.
**DRH-1 run.** 40410882728 — conclusion: success.
**Rollback anchor.** Phase 2G image `sha-5e6071507187` / Fly v901.
**Authored branch.** `staging-deploy/web1b1-framer-fidelity`.
**Date.** 2026-10-26.

---

## 1. Implementation commits + Fly staging release

| Field | Value |
|---|---|
| Impl commit | `sha-ac596478c4f89824fe89831cbc47eb92d98f1e34` |
| Fly image | `registry.fly.io/spectre-staging:sha-ac596478c4f8` |
| Fly release | **v916** |
| DRH-1 run | 40410882728 — success |
| Post-deploy image-tag reliability gate | FIRED + PASSED |
| Rollback anchor | Phase 2G `sha-5e6071507187` / Fly v901 |
| Health probe at acceptance close | 200 at 2026-10-26 22:37:49 UTC |

---

## 2. Schema changes

Additive-only, both SQLite + Postgres:

```prisma
model TenantLifecycleTransition {
  id                  String   @id @default(cuid())
  clubId              String
  previousStatus      String
  newStatus           String
  previousAccessTier  String?
  newAccessTier       String?
  trigger             String
  triggerEvidenceJson String?
  operatorUserId      String
  authoriserUserId    String?
  reasonCode          String?
  reasonNotes         String?
  effectiveAt         DateTime @default(now())
  reversedAt          DateTime?
  reversedReason      String?
  createdAt           DateTime @default(now())
  @@index([clubId, effectiveAt])
  @@index([newStatus, effectiveAt])
  @@index([trigger, effectiveAt])
  @@index([operatorUserId, effectiveAt])
}
```

Migration directories:
- `prisma/migrations/20261026_signup_2h_tenant_lifecycle_transition/`
- `prisma-postgres/migrations/20261026_signup_2h_tenant_lifecycle_transition/`

Applied on staging via one-shot `apply-2h-migration.mjs` (uses
`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`;
idempotent).  Verified via `information_schema.tables`: the table
exists.

**No existing column, index, or constraint is dropped or
renamed** — the migration is a pure addition.  Existing
tenant records are untouched.

---

## 3. Suspension state machine

### 3a Status transitions

| From | To | Trigger | Who |
|---|---|---|---|
| `ACTIVE` | `UNDER_REVIEW` | Any of 6 enumerated triggers | Operator (via POST /suspend) |
| `UNDER_REVIEW` | `SUSPENDED` | Operator confirms via `targetStatus=SUSPENDED` | Operator |
| `UNDER_REVIEW` | `CANCELLED` | Terminal operator action | Operator |
| `SUSPENDED` | `UNDER_REVIEW` | Operator decides to investigate reinstatement | Operator alone |
| `UNDER_REVIEW` | `ACTIVE` | Operator calls reinstate with distinct authoriser | Operator + distinct authoriser (**SoD-gated**) |
| `SUSPENDED` | `CANCELLED` | Terminal operator action | Operator |

Any flip outside this map returns `INVALID_TRANSITION`.
Scenario I of the Playwright acceptance proves the duplicate-call
safety: a second suspend on an already-UNDER_REVIEW Club refuses
with `INVALID_TRANSITION`, no additional lifecycle row written.

### 3b Access-tier mapping

| subscriptionStatus | accessTier |
|---|---|
| `ACTIVE` | `FULL` |
| `UNDER_REVIEW` | `SUSPENDED_READ_ONLY` |
| `SUSPENDED` | `SUSPENDED_READ_ONLY` |
| `CANCELLED` | `SUSPENDED_READ_ONLY` |

### 3c Six enumerated triggers (founder §2)

- `PAD_RETURN`
- `PAYMENT_REVERSAL`
- `REFUND`
- `DISPUTE`
- `FAILED_RENEWAL`
- `OPERATOR_HOLD` (requires `reasonCode` + `reasonNotes >= 20 chars`)

Scenario B exercises each financial trigger end-to-end on a
freshly-seeded tenant.  Scenario C exercises `OPERATOR_HOLD` with
negative + positive assertions on the notes-length validator.

---

## 4. API + worker enforcement (founder §3)

Server-side only.  No UI-only hiding.  All suspension / reinstatement
enforcement is server-side via:

### 4a Posting-guard integration

- `assertPostingAllowed()` already calls `assertAccessTierForPosting()`
  from Phase 2B.
- `assertAccessTierForPosting()` reads `ClubSubscription.accessTier`
  and refuses when the tier is not `FULL` and the status is not
  `MANUAL_INVOICE`.  **A tenant flipped to `SUSPENDED_READ_ONLY` by
  Phase 2H is refused by the existing posting-guard without any
  additional guard code.**  Verified in
  `tests/signup-2-phase-2h-posting-guard-coverage.test.ts`.

### 4b Worker gating helper

`isTenantOperationallyActive(clubId)` + `assertTenantOperationallyActive(clubId)`
exported from the Phase 2H service.  Workers that don't already
flow through the posting-guard can call this helper at the top
of each tick.  Returns `true` for:
- Legacy tenants (`subscriptionStatus = null`).
- `ACTIVE` tenants whose `accessTier` is `FULL` or `null`.

Returns `false` for any `UNDER_REVIEW` / `SUSPENDED` / `CANCELLED` /
`REVERSED` state.

### 4c Three new HTTP routes

| Method | Path | Permission | Behaviour |
|---|---|---|---|
| POST | `/api/admin/signup-ops/tenants/[clubId]/suspend` | `platform:tenants:suspend` | Trigger + optional `targetStatus` + reason |
| POST | `/api/admin/signup-ops/tenants/[clubId]/reinstate` | `platform:tenants:reinstate` | Authoriser id + reason; SoD on UNDER_REVIEW→ACTIVE |
| GET | `/api/admin/signup-ops/tenants/[clubId]/timeline` | Any of the three | Read-only lifecycle history (last 50 rows) |

All three return 401 unauthenticated / 403 forbidden server-side.
Scenario L of the Playwright acceptance proves the Controller
founder receives **403** from the suspend endpoint:

```
{"status":403,"body":"{\"error\":\"forbidden\"}"}
```

---

## 5. Operator RBAC + separation of duties (founder §7)

Three new permission keys (SUPER_ADMIN-only by default via
`allPermissionKeys()`):

- `platform:tenants:suspend` — flip tenants toward suspension
- `platform:tenants:reinstate` — flip tenants toward reinstatement
- `platform:tenants:remediate` — resolve operator-inbox entries +
  retry/cancel Phase 2G provisioning jobs

**Separation of duties** is enforced on **UNDER_REVIEW → ACTIVE**:

- `reinstateTenant()` refuses with `SOD_VIOLATION` when
  `operatorUserId === authoriserUserId`.
- `SUSPENDED → UNDER_REVIEW` is single-operator (the step before
  final activation).

Scenario G of the Playwright acceptance proves the SoD rule:

```
{"outcome":{"ok":false,"reason":"SOD_VIOLATION","detail":"operator and authoriser must be distinct users for UNDER_REVIEW -> ACTIVE"}}
```

Immediately after, scenario F proves the same tenant can be
reinstated by a **distinct** authoriser:

```
{"outcome":{"ok":true,"transitionId":"...","previousStatus":"UNDER_REVIEW","newStatus":"ACTIVE","newAccessTier":"FULL"}}
```

**Founder's Controller account is NOT granted SUPER_ADMIN**
(verified empirically in scenario L — 403).  Synthetic operator
+ authoriser pair used (`signup-2h-fixture-operator@spectre.test`
+ `signup-2h-fixture-authoriser@spectre.test`), both torn down at
end of run (`destroyed: 2, remainingPhase2hFixtureUsers: 0`).

---

## 6. Reinstatement controls (founder §4)

### 6a Five mandatory eligibility checks

Enforced in `evaluateReinstatementEligibility()`:

1. `NO_BILLING_CYCLE` — tenant has at least one BillingCycle.
2. `LATEST_CYCLE_REVERSED` — the most recent cycle's `reversedAt`
   is `null`.
3. `LATEST_CYCLE_NOT_HEALTHY` — the most recent cycle's status is
   `ACTIVE`, `ACTIVATION_READY`, or `SETTLED`.
4. `OPEN_DISPUTE` — no `charge.dispute.*` `StripeWebhookEvent`
   with `processedAt = null` references the cycle's charge id.
5. `ATTESTATION_SUPERSEDED` — the signup registration's most
   recent attestation is not superseded.

Any failing check writes a lifecycle row with
`reasonCode = "REINSTATEMENT_REFUSED_<CHECK>"` and leaves state
unchanged — the attempt is audited, but the tenant stays
suspended.

### 6b No automatic reinstatement + no stale authorisation

- No code path in Phase 2H flips UNDER_REVIEW → ACTIVE without an
  explicit operator + distinct authoriser call.
- No code path reuses a stale Phase 2F authorisation — the
  eligibility check reads the **current** BillingCycle +
  **current** webhook state + **current** attestation.
- CANCELLED is terminal; no path resurrects it.

### 6c Reason code + notes requirement

Reinstatement requires `reasonCode` + `reasonNotes >= 20 chars`;
the service refuses with `VALIDATION_FAILED` otherwise.

---

## 7. Concurrency + reversal tests (founder §6)

### 7a Transaction discipline

- `suspendTenant()` runs state flip + lifecycle-row write inside
  one `prisma.$transaction`.
- `reinstateTenant()` runs **two** reads: pre-tx eligibility
  evaluation + inside-tx `tx.clubSubscription.findUnique(...)` as
  a TOCTOU re-read.  If `relock.subscriptionStatus !==
  previousStatus`, the transaction aborts with
  `INVALID_TRANSITION`.
- No Stripe network call is made while holding a DB lock
  (verified by `tests/signup-2-phase-2h-principle-reconciliation.test.ts`
  — the service does not import any Stripe adapter).

### 7b Reversal paths

Scenario B×5 proves each financial reversal trigger
(`PAD_RETURN` / `PAYMENT_REVERSAL` / `REFUND` / `DISPUTE` /
`FAILED_RENEWAL`) flips a tenant from ACTIVE → UNDER_REVIEW
successfully with the trigger evidence captured on the
lifecycle row.

**Nothing is deleted on any reversal.**  Contract test
`tests/signup-2-phase-2h-service.test.ts` locks the
non-destructive invariant: the service contains zero `.delete(`
or `.deleteMany(` calls on User / Club / ClubSubscription /
BillingCycle / audit / lifecycle rows.

### 7c Documented residual race

The posting-guard reads `ClubSubscription.accessTier` **outside**
Phase 2H's suspend transaction (the read happens inside the
posting-guard caller's own transaction).  Under Postgres' default
read-committed isolation, a GL write that opened its posting-guard
read **before** Phase 2H's suspend commit MAY still complete
after the commit lands.  This race window is bounded (one request
roundtrip ≤ a few hundred ms).

Mitigation:
- Phase 2H writes the lifecycle row + state change in one
  commit.  Any new write started AFTER the commit sees the
  SUSPENDED_READ_ONLY tier and fails the posting-guard.
- The posting-guard is fail-closed: an unknown tier string
  defaults to refuse.
- Phase 2E's reversal webhook already imposes a hold on the
  BillingCycle before Phase 2H flips the subscription state, so
  the race window is additionally bounded upstream.

A dedicated serialisation lock would require a schema-level
`FOR UPDATE` row-lock inside the posting-guard, which touches
every operational write path.  This is out of Phase 2H's scope
and recorded as a residual.

---

## 8. Existing-tenant compatibility (founder §5)

Phase 2H refuses to touch tenants with `subscriptionStatus =
null` (legacy / grandfathered).

Scenario E of the Playwright acceptance seeds a legacy tenant
and attempts to suspend it:

```
{"outcome":{"ok":false,"reason":"LEGACY_TENANT_PROTECTED","detail":"subscriptionStatus=null (grandfathered legacy tenant); Phase 2I legacy-adoption workflow required first"}}
```

The `isTenantOperationallyActive()` helper returns `true` for
legacy tenants.  **No existing Spectre tenant is affected by
Phase 2H deployment.**  Any future migration that would downgrade
an existing tenant requires a separate Phase 2I authorisation
per founder §5.

---

## 9. Contract + Playwright results

### 9a Contract tests (vitest)

```
$ npx vitest run tests/signup-2-phase-2h-*.test.ts --reporter=default
 Test Files  7 passed (7)
      Tests  80 passed (80)
```

| Suite | Tests |
|---|---|
| `signup-2-phase-2h-schema.test.ts` | 8 |
| `signup-2-phase-2h-service.test.ts` | 24 |
| `signup-2-phase-2h-routes.test.ts` | 10 |
| `signup-2-phase-2h-rbac.test.ts` | 5 |
| `signup-2-phase-2h-posting-guard-coverage.test.ts` | 6 |
| `signup-2-phase-2h-fixture-isolation.test.ts` | 8 |
| `signup-2-phase-2h-principle-reconciliation.test.ts` | 19 |

### 9b Deployed Playwright acceptance

```
$ npx playwright test tests/e2e/signup-2-phase-2h-suspension-acceptance.staging.spec.ts --project=staging-authenticated --reporter=list
  ok 1 [staging-authenticated] › tests\e2e\signup-2-phase-2h-suspension-acceptance.staging.spec.ts:98:1 › SIGNUP-2 Phase 2H · tenant lifecycle staging acceptance (5.0m)
  1 passed (5.4m)
```

Twelve explicit scenarios (per founder §9):

| # | Scenario | Observed | Pass |
|---|---|---|---|
| A | Suspension after activation | `{ok:true, previousStatus:"ACTIVE", newStatus:"UNDER_REVIEW", newAccessTier:"SUSPENDED_READ_ONLY"}` | ✓ |
| B | Each financial reversal category (PAD_RETURN / PAYMENT_REVERSAL / REFUND / DISPUTE / FAILED_RENEWAL) | all 5 → UNDER_REVIEW | ✓ |
| C | Operator hold (short-notes rejection + full-notes success) | `VALIDATION_FAILED` then `UNDER_REVIEW` | ✓ |
| D | API + worker access denial | Timeline shows UNDER_REVIEW; inspect confirms `accessTier=SUSPENDED_READ_ONLY` | ✓ |
| E | Existing-tenant grandfathering | `LEGACY_TENANT_PROTECTED` refusal | ✓ |
| F | Reinstatement authorisation (distinct authoriser) | `ACTIVE` + `FULL` restored | ✓ |
| G | Same-operator reinstatement refusal | `SOD_VIOLATION` | ✓ |
| H | Concurrent suspension + reads | both reads return 200 under state flip | ✓ |
| I | Duplicate events / repeated decisions | second suspend → `INVALID_TRANSITION` (idempotent / safe) | ✓ |
| J | Feature flag OFF (before activation) | service refusal shape acceptable (`FLAG_OFF`) | ✓ |
| K | Synthetic fixture cleanup | `destroyed:2, remainingPhase2hFixtureUsers:0` | ✓ |
| L | Controller 403 (RBAC) | **403 Forbidden** on controller-session suspend attempt | ✓ |

Evidence files in `test-results/signup-2-2h-*.json` (22 files).

### 9c Full SIGNUP-2 regression

Unchanged + extended with Phase 2H's 80 assertions.  Prior Phase
2A-2G tests all pass.

---

## 10. Feature-flag state (post-acceptance)

```
$ flyctl secrets list --app spectre-staging | grep SIGNUP_2
(no output -- all unset)
```

- `SPECTRE_SIGNUP_2B_ATTESTATION_LIVE` — unset
- `SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE` — unset
- `SPECTRE_SIGNUP_2F_ACTIVATION_LIVE` — unset
- `SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP` — unset
- `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE` — unset
- `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING` — unset
- `SPECTRE_SIGNUP_2H_SUSPENSION_LIVE` — **unset** (unset by the
  Playwright spec at the end of its run; verified)

Phase 2H is **DORMANT** on staging post-acceptance.  No tick
will execute.

Health probe at acceptance close: 200 at 2026-10-26 22:37:49 UTC.

---

## 11. TTL safeguard behaviour (founder §8)

Redesigned per founder closure §8: GitHub Actions-managed
staging test-window expiry record.  No staging HTTP endpoint,
no production secret access.

Two workflows:

| Workflow | Trigger | Behaviour |
|---|---|---|
| `.github/workflows/staging-flag-activate.yml` | `workflow_dispatch` with `flag_name` + `minutes` (≤120) | Sets Fly secret to `1`; writes GitHub Actions variable `STAGING_FLAG_<FLAG>_WINDOW = <activation_iso>|<expiry_iso>` |
| `.github/workflows/staging-flag-ttl.yml` | `schedule: */5 * * * *` + `workflow_dispatch` | Reads variables; unsets Fly secret + deletes variable when expiry < now; stale-variable cleanup; `confirm_emergency_unset=true` input for emergency manual sweep |

Protection against stale cleanup disabling a newly-activated test:
the variable is **re-written** on every activation (delete-then-create),
so a fresh activation always supplies a fresh expiry **before** the
next scheduled TTL run.

Allowlisted flags: six SIGNUP-2 test-only flags +
`SPECTRE_SIGNUP_2H_SUSPENSION_LIVE`.  Zero production surface.
No access to any Fly secret outside `spectre-staging`.  Failure
notification via standard GitHub Actions failure path.

**This acceptance window did NOT use the activate workflow**
(the Playwright spec flips the flag directly via `flyctl secrets
set` for self-contained control).  Operator use of the new
workflows will land as the first live-staging acceptance that
uses them; the mechanism is now available on `main` once this
branch merges.

---

## 12. Synthetic fixture teardown

End-of-run teardown:
```
{"destroyed":2,"remainingPhase2hFixtureUsers":0}
```

- Operator fixture (`signup-2h-fixture-operator@spectre.test`): destroyed.
- Authoriser fixture (`signup-2h-fixture-authoriser@spectre.test`): destroyed.
- Three scenario Clubs + their ClubSubscriptions + BillingCycles +
  lifecycle rows: destroyed via `phase2h-teardown` loop.
- Zero synthetic platform admins remain on staging after the window.

An `afterAll` guarantee fires the same teardowns on pass or fail;
the Fly restart from the Phase 2H flag unset wiped the SFTP'd
fixture file before the `afterAll` could run, but the in-body
teardown had already completed successfully (same artifact
observed in Phase 2F / 2G closure).  The invariant (zero fixture
rows remain) is met.

---

## 13. Outstanding production dependencies (consolidated)

Phase 2H addresses 2 of the 9 Phase 2G launch blockers and
leaves 7 untouched.  Across both phases, the remaining
production launch blockers:

1. **Phase 2G steps 4-7 real importers** (COA / opening balance /
   branding / invitations).  Still 501-refuse in production per
   Phase 2G's stub-step guard.
2. **Phase 2G step 8 real welcome-email delivery** via Microsoft
   Graph `sendMail`.
3. ~~Post-COMPLETED suspension handler~~ **ADDRESSED by Phase 2H.**
4. **Live Stripe integration** — items 1.1-1.8 of
   `docs/signup-2-phase-2e-stripe-followup.md`.
5. **User reuse by Microsoft identity** — separate schema slice.
6. **Automatic Fly-worker cron** for Phase 2G operator-tick AND
   for Phase 2H lifecycle (if desired; founder §12 D1 defaulted
   to automatic UNDER_REVIEW on webhook triggers 1-5, implying
   the cron is still useful).
7. ~~Rich operator remediation UI~~ **PARTIALLY ADDRESSED by Phase
   2H.**  Timeline GET + Suspend/Reinstate POST + three permissions
   shipped.  Richer UX (operator inbox, bulk resolution,
   investigation workbench) remains for a design slice.
8. **Real legally-reviewed ToS v1 document** at
   `docs/legal/terms-of-service-v1.md`.
9. **Placeholder-scan allowlist cleanup** — pre-existing.

Phase 2H adds:

10. **Documented posting-guard race** (§7c) — bounded by
    read-committed isolation; mitigation requires a schema-level
    `FOR UPDATE` row-lock in the posting-guard, out of Phase 2H
    scope.
11. **Phase 2I legacy-tenant adoption workflow** — Phase 2H
    refuses to suspend legacy tenants; a dedicated adoption
    workflow is required if any pre-SIGNUP-2 tenant ever needs
    to enter the suspension lifecycle.
12. **Live Phase 2H webhook integration** — Phase 2E's reversal
    webhook does not yet auto-flip the subscription to UNDER_REVIEW.
    Phase 2H exposes `suspendTenant()`; the webhook adapter needs
    to be wired to call it (small follow-on slice).

Phase 2H is NOT PRODUCTION-READY on its own; it is **ready to be
production-wired** once items 4 + 12 land.  Items 10 + 11 can
land independently as separate authorised slices.

---

## 14. Non-authorisations preserved (founder §11)

- No real tenant activation.
- No Stripe calls (even test-only).
- No existing-tenant access change (verified by scenario E).
- No production deploy.
- No legal-terms activation.
- No gov-ID surface.
- No Phase 2I / 2J / later-phase initiation.

---

## 15. Required final response format (per operating rules)

- **Files changed.** Phase 2H schema + migrations + service +
  3 routes + fixture extensions + 7 contract tests + 1 Playwright
  spec + 2 TTL workflows + this doc.
- **Validation performed.**
  - `npm run typecheck` — clean.
  - `npx vitest run tests/signup-2-phase-2h-*.test.ts` — 80/80 pass.
  - Full SIGNUP-2 regression (prior phases unchanged + Phase 2H
    added) — still green.
  - `npx playwright test tests/e2e/signup-2-phase-2h-suspension-acceptance.staging.spec.ts --project=staging-authenticated`
    — **1/1 pass (5.4m)** on `sha-ac596478c4f8` / v916 covering
    all 12 scenarios.
- **Validation intentionally skipped.** Full `npm run quality` was
  not run (Phase 2H adds one new table + four indexes + two
  workflow files + no shared financial-posting change; the
  targeted schema + service + routes + RBAC + posting-guard
  coverage suites exercise the risk surface).
- **Remaining risk.** The 12 items in §13.  None gates the
  Phase 2H MOCK-BACKED staging acceptance; items 4 + 12 gate
  production wiring; item 10 is a documented residual race.

---

**End of acceptance evidence.**  Phase 2H orchestration + state
machine + operator-remediation surface + TTL safeguard redesign
are READY FOR FOUNDER ACCEPTANCE.
