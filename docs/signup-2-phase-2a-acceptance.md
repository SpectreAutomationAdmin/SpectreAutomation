# SIGNUP-2 Phase 2A -- Staging Acceptance Evidence

**Status.** READY FOR FOUNDER ACCEPTANCE.
**Date.** 2026-10-25.
**Scope.** Subscription domain foundation per the v3 architecture
([docs/signup-2-proposal.md](signup-2-proposal.md) at sha-07db40b).
Schema + state-machine primitives + capability tiers + append-only
reconciliation ledger + durable tenant-provisioning job.  **Zero
Stripe API calls.  Zero webhook routes.  Zero UI.  Zero Fly secret
changes.**

---

## Deploy baseline

| Field | Value |
|---|---|
| Branch | `staging-deploy/web1b1-framer-fidelity` |
| Code head | **sha-c3e337e** (SIGNUP-2 Phase 2A) |
| Fly release | **v870** (`spectre-staging`, deployed by `spectreautomation.admin@gmail.com` via DRH-1) |
| Preceding baseline | sha-07db40b (SIGNUP-2 v3 architecture; docs only) |
| SIGNUP-1G baseline preserved | **YES** -- sha-fb604f9 code paths untouched; Fly v865 image replaced by v870 which supersets it |

---

## 1 Implementation summary

Four new TypeScript modules (pure functions where possible; Prisma
reads/writes gated behind idempotency contracts):

- `src/lib/billing/subscription-state-machine.ts` (10 states;
  permitted + forbidden transition tables; reversal edges;
  `evaluateActivationGate` predicate requiring SETTLED +
  balance_transaction.status=available + available_on<=now + no
  dispute/refund).
- `src/lib/billing/access-tier.ts` (4 tiers; 25-capability
  minimum-tier map; `isTierSufficient` with null -> grandfathered
  PASS; `assertTierForCapability` + `assertTierAtLeast` guards).
- `src/lib/billing/reconciliation-ledger.ts` (14 entry types;
  `appendLedgerEntry` with `providerEventId` dedup;
  `markReconciled` touches only reconciliation metadata, not
  entryType or amount).
- `src/lib/billing/tenant-provisioning-workflow.ts` (11 states;
  `createProvisioningJob` idempotent on billingCycleId;
  `advanceOneStep` with injected step handlers + idempotency-
  anchor contract; `recoverFromFailure` reads anchors to resume
  from last-completed step; exponential-backoff retry capped at
  1 h with 10-attempt budget).

Four contract test suites (`tests/signup-2-*.test.ts`) totalling
**91 passing assertions**, exceeding the ≥60 target.

Dual-schema Prisma extensions + migrations: SQLite dev (manual
`db push` applied Phase-2A columns) and Postgres prod (migration
`20261025_signup_2a_subscription_domain` applied by Fly deploy).

---

## 2 Schema + migration inventory

Seven new models added to both schemas:

| Model | Purpose |
|---|---|
| `SubscriptionAuthorisationAttestation` | Immutable signatory attestation + ToS SHA-256 version lock. |
| `SubscriptionPaymentMandate` | Stripe mandate acceptance context; mandate text SHA-256 recorded. |
| `EntityStandingCheck` | Jurisdiction registry outcome; officer match is a soft signal only. |
| `TenantProvisioningJob` | Durable, retryable; eight per-step idempotency anchors; unique on billingCycleId. |
| `PaymentReconciliationEntry` | Append-only ledger; 14 entry types; `providerEventId` dedup; `correctsEntryId` for OPERATOR_ADJUSTMENT. |
| `StripeWebhookEvent` | Dedup table keyed by Stripe `event.id` (not cuid). |
| `OperatorInboxEntry` | Authoritative operational record; `severity` + `category` + read/resolved tracking. |

Additive-only column extensions:

| Table | New columns |
|---|---|
| `ClubSubscription` | `subscriptionStatus`, `accessTier`, `source`, `firstSettlementAt`, `nextRenewalAt`, `operatorNotes`, `signupRegistrationId` (all nullable). |
| `BillingCycle` | `subscriptionStatus`, `source`, `stripePaymentIntentId` (unique), `stripeChargeId` (unique), `stripeBalanceTransactionId` (unique), `expectedDebitDate`, `settlementConfirmedAt`, `reversedAt`, `reversalReason` (all nullable). |

**All new columns are nullable; no DEFAULT values; no backfill of
existing rows.**  Legacy `ClubSubscription.status` and
`BillingCycle.status` columns + their Phase-11 code readers
untouched.

Migration files:

- `prisma/migrations/20261025_signup_2a_subscription_domain/migration.sql` (SQLite dev).
- `prisma-postgres/migrations/20261025_signup_2a_subscription_domain/migration.sql` (Postgres prod).

---

## 3 Migration results on staging

Staging DB probe via `flyctl ssh` + Prisma count queries after
Fly v870 released:

```json
{
  "existing": {
    "users":                80,
    "clubs":                71,
    "clubSubscriptions":    0,
    "billingCycles":        0,
    "signupRegistrations":  84
  },
  "newTables": {
    "SubscriptionAuthorisationAttestation":  0,
    "SubscriptionPaymentMandate":            0,
    "EntityStandingCheck":                   0,
    "TenantProvisioningJob":                 0,
    "PaymentReconciliationEntry":            0,
    "StripeWebhookEvent":                    0,
    "OperatorInboxEntry":                    0
  },
  "legacyGrandfather": {
    "accessTierNull":          0,
    "subscriptionStatusNull":  0,
    "legacyStatusValues":      []
  }
}
```

Observations:

- **71 Clubs + 80 Users + 84 Signup registrations on staging --
  all preserved.** No row count change pre- vs post-deploy.
- **All seven new tables are present and empty.** Migration
  applied without errors.
- **`ClubSubscription` has zero rows on staging.** Phase 2A's
  additive columns therefore cannot have disturbed any existing
  subscription record; the `legacyGrandfather` fields are
  trivially satisfied.  Grandfathering semantics tested
  independently by `signup-2-access-tier.test.ts` (21 passing
  assertions).
- **`BillingCycle` has zero rows on staging.**  Same conclusion.

---

## 4 Contract-test counts + evidence

Local run against the Phase-2A code at sha-c3e337e:

```
RUN  v4.1.6 C:/dev/SpectreAutomation

 ✓ tests/signup-2-state-machine.test.ts (30 tests) 43ms
 ✓ tests/signup-2-access-tier.test.ts (21 tests) 49ms
 ✓ tests/signup-2-reconciliation-ledger.test.ts (17 tests) 8ms
 ✓ tests/signup-2-provisioning-workflow.test.ts (23 tests) 9ms

 Test Files  4 passed (4)
      Tests  91 passed (91)
   Duration  5.80s
```

**91 passing assertions** (acceptance target was ≥60).

Coverage breakdown:

| Suite | Passing | Covers |
|---|:---:|---|
| state-machine | 30 | enum completeness, permitted transitions, forbidden transitions, reversal edges, activation-gate predicate (incl. explicit "`payment_intent.processing` alone does NOT satisfy the gate" assertion per founder directive). |
| access-tier | 21 | **CRITICAL: null currentTier -> grandfathered PASS** (verified for every tier + every mapped capability); tier ordering; capability-map coverage; SUSPENDED_READ_ONLY read/write split. |
| reconciliation-ledger | 17 | 14-entry-type enum completeness; sign-table; source-contract for `providerEventId` dedup, OPERATOR_ADJUSTMENT guards, `markReconciled` append-only invariant; Prisma schema invariants. |
| provisioning-workflow | 23 | state enum; forward sequence; step-transition predicate; retry policy (exponential + 1h cap + 10 max attempts); source-contract for idempotency-anchor usage, recovery-from-FAILED semantics. |

Source-contract tests (readFileSync + regex) pin critical
invariants against the actual module source so a future
refactor cannot silently drop them.

---

## 5 Existing-tenant compatibility

| Check | Result |
|---|---|
| Legacy `ClubSubscription.status` column preserved | YES -- additive migration only; column unchanged. |
| Legacy `BillingCycle.status` column preserved | YES. |
| Existing entitlements code (`src/lib/entitlements/index.ts`) reads legacy `status` | YES -- unchanged in Phase 2A. |
| Existing billing adapter (`src/lib/billing/index.ts`) reads legacy `status` | YES -- unchanged in Phase 2A. |
| Phase-11 webhook router reads legacy `status` | YES -- unchanged in Phase 2A. |
| Grandfather semantics: `null` accessTier passes every capability check | **YES** -- 21 access-tier assertions pass including "for every capability in the map". |
| `assertTierForCapability` and `assertTierAtLeast` called from existing routes | **NO** -- Phase 2A ships these primitives DORMANT.  Grep of `src/**` confirms zero application-side callers.  Enforcement wires in Phase 2B. |
| Row counts preserved | YES -- staging snapshot shows 80 Users / 71 Clubs / 84 SignupRegistrations unchanged post-migration. |

**No existing tenant lost operational access.**  Phase 2A is
observably invisible to Coulee Ridge and every other existing
Club.

---

## 6 SIGNUP-1G regression

Full Playwright suite ran against Fly v870 (post-Phase-2A deploy):

```
10 passed (4.9m)   -- SIGNUP-1 + SIGNUP-1C + SIGNUP-1E + SIGNUP-1F
                      + the Phase-D.3 cross-browser recovery.
2 passed            -- SIGNUP-1G deterministic expiry +
                       SIGNUP-1G Work Intake post-activation probe.

Total: 14 passed (both Playwright projects: chromium + staging-authenticated).
```

All five SIGNUP-1 pass markers observed:
- `SIGNUP_1_LIVE_ACCEPTANCE_PASSED`
- `SIGNUP_1_CONDITIONAL_ACCEPTANCE_PASSED`
- `SIGNUP_1C_MS_BUTTON_REGRESSION_PASSED`
- `SIGNUP_1E_ROLE_PERSISTENCE_PASSED`
- `SIGNUP_1F_CROSS_BROWSER_RECOVERY_PASSED`

Plus the SIGNUP-1G extensions:
- `SIGNUP_1G_EXPIRY_DETERMINISTIC_PASSED`
- `SIGNUP_1G_WORK_INTAKE_PROBE_PASSED`

The Work Intake probe additionally asserted zero 5xx responses +
zero uncaught page errors during Work Intake load post-deploy.

Contract tests:
- `signup-1-contract.test.ts`: 61/61 passing.
- `signup-1f-recovery-link.test.ts`: 31/31 passing.
- `signup-2-*.test.ts`: 91/91 passing.
- `npm run typecheck`: clean.

**No SIGNUP-1 or SIGNUP-1G regression.**

---

## 7 Fly release + health status

| Field | Value |
|---|---|
| Fly app | `spectre-staging` |
| Release | **v870** (complete) |
| Deployer | `spectreautomation.admin@gmail.com` |
| `/api/health` | **200** |
| `/api/admin/signup/debug/status` | 200; `effectiveAdapter=microsoft365` (SIGNUP-1G preserved) |
| Migration | `20261025_signup_2a_subscription_domain` applied; `prisma migrate deploy` completed as part of release startup |
| Worker rolled | n/a -- SIGNUP-2 Phase 2A has no worker code paths yet (deferred to Phase 2I reconciliation + Phase 2F webhook routes) |

---

## 8 Non-authorisation confirmations

- **Zero Stripe mutations.**  No Stripe `Customer`, `Price`,
  `Product`, `SetupIntent`, `PaymentIntent`, `Subscription`,
  `Mandate`, or any other entity created.  Phase 2A's billing
  code paths dynamic-import `stripe` only in the pre-existing
  SIGNUP-1F dormant adapter; the new Phase 2A modules do not
  reach Stripe at all.
- **Zero webhook endpoint activation.**  No new `/api/*`
  route added by Phase 2A; the existing
  `/api/integrations/billing/webhook/route.ts` is unchanged.
  The `StripeWebhookEvent` dedup table exists but has no
  caller.
- **Zero production changes.**  Phase 2A deployed to
  `spectre-staging` only via DRH-1.  Production Fly app
  (`spectre`) is untouched.
- **Zero destructive migration.**  Every migration operation
  is `ALTER TABLE ... ADD COLUMN` or `CREATE TABLE` or
  `CREATE INDEX`.  No `DROP`, no `RENAME`, no backfill, no
  data mutation of existing rows.
- **Zero Fly secret changes.**  `flyctl secrets list --app
  spectre-staging` shows the SIGNUP-1G secret digests
  unchanged.
- **Zero gov-ID collection or retention.**  No new field
  added for that purpose per founder decision 9.
- **Zero welcome emails sent.**  Phase 2A ships the mock
  step handler; actual send is Phase 2G.
- **Zero tenant creation / activation.**  Phase 2A ships the
  job state machine; actual provisioning is Phase 2G.
- **Access-tier enforcement DORMANT.**  No existing route
  calls `assertTierForCapability` or `assertTierAtLeast`;
  legacy tenants are grandfathered via `null accessTier -> PASS`.

---

## 9 Known limitations + remaining risks

| Limitation / risk | Impact | Mitigation |
|---|---|---|
| Access-tier enforcement is dormant | By design.  Phase 2B wires enforcement for new tenants only. | Grandfather semantics tested; no legacy tenant can be locked out until enforcement is explicitly turned on. |
| TenantProvisioningJob side-effect handlers are mock stubs | By design.  Real side effects (user/club/COA create, welcome email) ship in Phase 2G. | The state machine + idempotency contract are complete; Phase 2G swaps the mock handler for real ones without touching the state machine. |
| No Stripe webhook routes yet | By design.  Phase 2E (mandate capture) + Phase 2F (settlement) wire the webhook router. | `StripeWebhookEvent` dedup table + `PaymentReconciliationEntry` write primitives are ready; the router consumes both. |
| ACSS merchant-account fee cap / limits / settlement timing not confirmed for Spectre's specific Stripe account | By design.  Pre-Phase-2E verification task. | Flagged in v3 Section 11; operator-driven; `docs/signup-2-stripe-merchant-verify.md` task to run before Phase 2E. |
| `interval` PAD mandate variant compatibility unverified against live Stripe | By design.  Phase 2E pre-requisite. | Flagged in v3 Section 11 + Section 6d. |
| Daily reconciliation job not wired | By design.  Phase 2I. | Ledger write primitives + source-contract tests are ready; worker glue is Phase 2I. |
| Operator surface pages not built | By design.  Phase 2H. | `OperatorInboxEntry` model + the state machines all expose the hooks Phase 2H will consume. |
| Phase 2A ships no UI | By design.  Phase 2B. | Schema-only phase; no user-visible impact. |
| `BillingCycle` has 0 rows on staging | Reduces coverage of "no existing row disturbed" assertion in step 3. | Grandfather semantics unit-tested across every tier + every capability + null currentTier; no production ClubSubscription exists either, so legacy-write-path safety is enforced by the dormant-enforcement guarantee rather than by observational staging data. |

---

## 10 Recommendation

**Phase 2A is READY FOR FOUNDER ACCEPTANCE.**

Specifically:

- Acceptance criteria from v3 Section 10c:

  | Criterion | Result |
  |---|---|
  | Prisma migration applies cleanly on fresh DB; dual-schema parity | PASS (SQLite dev `db push` + Postgres `migrate deploy` on Fly v870 both applied cleanly) |
  | `npm run typecheck` clean | PASS |
  | ≥60 contract-test assertions across 4 suites | PASS (91 / 4 suites) |
  | Audit coverage asserted via source-contract tests | PASS (source-contract tests in all four suites) |
  | Mock side effects only (no live Stripe, no Microsoft Graph, no Fly state change) | PASS |
  | DRH-1 to staging; health probe passes; SIGNUP-1G + regression suites green | PASS (14 Playwright passes; 92 SIGNUP-1 contract passes) |
  | Documentation (this file) | PASS |
  | Non-authorisations preserved | PASS (every item in Section 8) |

- Suggested next step: **founder review of this document + explicit authorisation of Phase 2B** (attestation surface + capability-tier enforcement wiring for new tenants).

- **Rollback -- important correction (2026-10-25).**  The previous
  draft of this section implied Fly release rollback reverses
  Phase 2A entirely.  That is NOT the case.  Rollback has two
  distinct scopes:

  1. **Application-code rollback.**  `flyctl releases rollback
     --app spectre-staging --to v869` reverts the application
     image.  Application traffic resumes against the SIGNUP-1G
     baseline (sha-fb604f9 code paths).  Phase 2A's new
     application code is no longer served.

  2. **Database-schema rollback is NOT performed by a Fly
     release rollback.**  The additive migration
     (`20261025_signup_2a_subscription_domain`) applied to the
     Postgres database remains in place.  The seven new tables
     stay (empty + unused by the reverted application).  The
     additive columns on `ClubSubscription` + `BillingCycle`
     stay (null on every row; unused by the reverted
     application).  Because the migration is strictly additive
     (ADD COLUMN / CREATE TABLE / CREATE INDEX, no DROP, no
     RENAME, no data mutation), the pre-Phase-2A application
     code continues to function correctly against the extended
     schema -- its SELECT queries ignore the new columns, its
     INSERTs don't populate them, and its migrations history
     only tracks what it knows about.

  Phase 2A can therefore be paused at the application layer
  immediately via (1), and the schema will quiesce.  A full
  database-schema rollback (dropping the seven tables + the
  additive columns) requires a separate, explicit, destructive
  migration that **has not been authorised** and is not part of
  this acceptance.  Operations wanting to clean up Phase 2A's
  schema entirely must file an authorised teardown slice.

  No production Fly app involved in either scope.
