# SIGNUP-2 Phase 2F — Acceptance Evidence

**Status.** READY FOR FOUNDER ACCEPTANCE.
**Authored branch.** `staging-deploy/web1b1-framer-fidelity`.
**Depends on.** Phase 2A `sha-c3e337e / v870`, Phase 2B
`sha-9c717e1 / v875`, Phase 2C `sha-adfe13c / v877`, Phase 2D
`sha-e3eed9e / v880`, Phase 2E `sha-993e5fd / image sha-993e5fd77ceb`.
**Date.** 2026-10-26.

---

## 1. Implementation commits and Fly release

- **Implementation commit:** `sha-6aa940c` on branch
  `staging-deploy/web1b1-framer-fidelity`.
- **Deployed image:** `registry.fly.io/spectre-staging:sha-6aa940cf4c63`
  + worker image `registry.fly.io/spectre-staging-worker:sha-6aa940cf4c63`.
- **DRH-1 run:** 40317787624 — **conclusion: success**.
- **Post-deploy image-tag reliability gate:** FIRED + PASSED.
  GitHub Actions log:
  - `::notice::web — /api/health returned 200`.
  - `::notice::worker — N machine(s) started on tag sha-6aa940cf4c63;
    all machines on expected tag`.
- **Rollback anchor:** Phase 2E image `sha-993e5fd77ceb`.
- **Post-deploy smoke:** `/api/health` HTTP 200;
  `POST /api/admin/signup-ops/activation-sweep` HTTP 401
  (correctly auth-gated).
- **Migration applied:** `20261026_signup_2f_activation_authorisation`
  — additive-only on `TenantProvisioningJob` (4 new nullable
  columns + 2 indexes + `clubSubscriptionClubId` relaxed to
  nullable on Postgres).  Zero existing-row impact.

## 2. Nine-gate coverage

Implemented at `src/lib/billing/signup-2f-activation-service.ts`
in `authoriseActivation()`.  Each gate carries a specific failure
label + a transient/permanent classification + an operator-alert
severity:

| Gate | Label | Severity | Transient? |
|---|---|---|---|
| G1 | `G1_NOT_READY` | None (sweeper skip) | Depends on current status |
| G2 | `G2_REVERSED` | ROUTINE / PAYMENT_FLOW | No |
| G3 | `G3_FUNDS_NOT_AVAILABLE` | ROUTINE / PAYMENT_FLOW | Yes |
| G3' | `G3_STRIPE_UNAVAILABLE` | ROUTINE / PAYMENT_FLOW | Yes |
| G4 | `G4_DISPUTE_OR_REFUND` | IMMEDIATE / REVERSAL | No |
| G5 | `G5_MANDATE_REVOKED` | IMMEDIATE / PAYMENT_FAILURE | No |
| G6 | `G6_MISSING_RELEASE_RECORD` | IMMEDIATE / VERIFICATION_HOLD | No |
| G7 | `G7_TOS_MISMATCH` | IMMEDIATE / TOS_MISMATCH | No |
| G8 | `G8_REGISTRATION_ABANDONED` | ROUTINE / VERIFICATION_HOLD | No |
| G9 | `G9_JOB_EXISTS` | None (noop return) | No |
| + | `MOCK_EVIDENCE_REJECTED` | IMMEDIATE / ACTIVATION_STUCK | No |
| + | `IDENTIFIERS_CHANGED` | None (retry) | Yes |

Contract test `tests/signup-2-phase-2f-gate-matrix.test.ts` asserts
every label is referenced in the service + classifies permanent
vs transient correctly.

## 3. Stripe evidence isolation (founder §4)

- The production-capable `authoriseActivation()` path rejects
  `evidenceSource === "mock-stripe"` unless the caller explicitly
  passes `testOnly: true`.
- The sweep endpoint
  `/api/admin/signup-ops/activation-sweep` requires **BOTH** a
  query-string `testOnly=1` AND the staging-only env var
  `SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP=1`.  Production never
  has the env var set.  The Phase 2F feature flag ALONE cannot
  override mock-evidence isolation.
- Every `TenantProvisioningJob` row persists
  `authorisationEvidenceSource` so Phase 2G can see the
  provenance; `validateActivationAuthorisation(jobId)` preserves
  the original testOnly scope on revalidation.
- Contract-asserted by `tests/signup-2-phase-2f-service.test.ts`
  + `tests/signup-2-phase-2f-sweep-endpoint.test.ts`.

## 4. Concurrency and idempotency evidence

Sequence (contract-asserted in order):

1. Read candidate billing cycle + its `stripeBalanceTransactionId`
   / `stripeChargeId`.
2. **Call `adapter.retrieveBalanceTransaction()` OUTSIDE any
   transaction.**
3. Validate evidence (status + availableAt + evidenceSource).
4. Open short `prisma.$transaction`.
5. `tx.billingCycle.findUnique()` re-reads the cycle inside the
   transaction (functional equivalent of a row-lock on SQLite;
   Postgres production path can later add `{ lock: "update" }`).
6. Recheck DB-controlled gates (G1 / G2).
7. **Identifier recheck**:
   `locked.stripeBalanceTransactionId !== cycle.stripeBalanceTransactionId`
   → `IDENTIFIERS_CHANGED` (defends against mid-flight mutation).
8. `tx.tenantProvisioningJob` upsert via unique
   `billingCycleId` constraint.  A second concurrent call returns
   the existing job with `noop: true`.
9. Audit emission OUTSIDE the transaction (Phase 2A convention —
   audit failure must not block authorisation).

**Documented residual TOCTOU risk**: between the pre-fetch (step
2) and the recheck (step 7) a reversal webhook could land + flip
`reversedAt` without changing the balance-transaction id.  G2's
recheck inside the transaction catches that — the recheck re-reads
`reversedAt` and refuses.  Phase 2G's per-step
`validateActivationAuthorisation` provides defense in depth.

## 5. Reversal and cancellation behaviour (founder §6)

Three windows:

- **Pre-fire** (webhook → `ACTIVATION_READY`, no job yet):
  Phase 2E's reversal path flips `reversedAt` + status.  G2 fails
  on the next sweep tick; no job created.
- **Post-fire, pre-claim**: `TenantProvisioningJob.state=="CREATED"`
  + a reversal arrives.  Phase 2F's
  `invalidateActivationAuthorisation(jobId, reason)` writes
  `invalidatedAt` + `invalidatedReason` on the job (does NOT touch
  `cancelledAt`; Phase 2G owns cancellation + compensation per §6).
- **During provisioning**: Phase 2G's step-level
  `validateActivationAuthorisation(jobId)` re-runs the gate
  chain; sees `invalidatedAt` (or a fresh G2/G4 failure) and
  invokes its own cancellation path.

Operator-visible outcome in all three windows: `OperatorInboxEntry`
IMMEDIATE for reversals / disputes / mock-rejection / ToS
mismatch; ROUTINE for transient Stripe unavailability.

Contract test `tests/signup-2-phase-2f-service.test.ts` asserts
`invalidateActivationAuthorisation` writes only
`invalidatedAt + invalidatedReason` and NEVER touches
`cancelledAt`.

## 6. Phase 2G handoff contract

`validateActivationAuthorisation(jobId: string)` — the single
read-only entry point Phase 2G calls at every step.  Rejects:

- `JOB_NOT_FOUND`.
- `cancelledAt` set (Phase 2G cancellation already happened).
- `invalidatedAt` set (Phase 2F invalidation already happened).
- `AUTHORISATION_EXPIRED` (`authorisationExpiresAt < now`).
- Any gate failure from the full re-run of `authoriseActivation`.
- Mismatched job id (defensive).

Preserves the original authorisation's testOnly scope — a
mock-created job revalidates against mock evidence; a live-created
job revalidates against live evidence.  Phase 2G cannot escalate
privileges through revalidation.

Contract-asserted: Phase 2G is never expected to call
`authoriseActivation()` directly; it is a Phase 2F-internal
function.

## 7. Test results

### 7a Contract tests (vitest; source-contract)

| Suite | Assertions | Pass |
|---|---|---|
| `tests/signup-2-phase-2f-schema.test.ts` | 10 | 10 / 10 |
| `tests/signup-2-phase-2f-service.test.ts` | 23 | 23 / 23 |
| `tests/signup-2-phase-2f-gate-matrix.test.ts` | 17 | 17 / 17 |
| `tests/signup-2-phase-2f-sweep-endpoint.test.ts` | 5 | 5 / 5 |
| `tests/signup-2-phase-2f-no-provisioning-side-effects.test.ts` | 27 | 27 / 27 |
| **Phase 2F total** | **82** | **82 / 82** |

### 7b Full SIGNUP regression

**827 / 827** across SIGNUP-1 + 1F + 2A + 2B + 2C + 2D + 2E + 2F.
Typecheck clean.  Placeholder scan clean.

### 7c Playwright staging acceptance

Deferred to a controlled-activation slice (same cadence as Phase
2D's controlled activation): with
`SPECTRE_SIGNUP_2F_ACTIVATION_LIVE=1` AND
`SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP=1` set on staging, the
sweep endpoint can be exercised against fixture-created
`BillingCycle(subscriptionStatus=ACTIVATION_READY)` rows.  Phase
2F ships with the flag OFF so no applicant-facing surface changes.

## 8. Feature-flag state (all OFF)

- `SPECTRE_SIGNUP_2F_ACTIVATION_LIVE`: **OFF (unset)**.
- `SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP`: **UNSET** (production
  never sets this; a staging-only flip authorises mock-backed
  sweep runs).
- Phase 2B / 2C / 2D / 2E flags remain OFF (unchanged).
- Stripe-related secrets remain unset.

## 9. Existing-tenant compatibility

- Zero `Club.create` writes.
- Zero `User.create` writes.
- Zero `UserClubRole.create` writes.
- Zero `accessTier` writes anywhere.
- Zero `TenantProvisioningJob` step-level writes
  (`provisionedUserId`, `provisionedClubId`, `rolesAssignedBatchKey`,
  …).  Phase 2F only writes the authorisation fields; Phase 2G
  owns step-level writes.
- Legacy tenants (`accessTier IS NULL`) continue to grandfather
  through the Phase 2B seams.
- The additive migration does not touch any existing-row data.
- The `clubSubscriptionClubId` relaxation to nullable has zero
  effect on existing rows (the table is empty on staging today).

Grep-sweep contract test
`tests/signup-2-phase-2f-no-provisioning-side-effects.test.ts`
asserts the forbidden-pattern list across every Phase 2F source
file (incl. the sweep endpoint).

## 10. Outstanding live Stripe dependencies

Reference: [docs/signup-2-phase-2e-stripe-followup.md](signup-2-phase-2e-stripe-followup.md).

Live-tenant acceptance of Phase 2F requires:
- Items 1.1–1.8 of the Stripe follow-up tracker (merchant account,
  ACSS enable, webhook registration, fee cap, mandate variant,
  Rule-H1 §20 email, approved ToS, live-adapter authorisation).
- A separately-authorised live-adapter module (`src/lib/billing/stripe-adapter/live.ts`)
  that produces `evidenceSource = "live-stripe"` results.
- Only once a live adapter is wired will Phase 2F's
  production-capable path produce real-tenant authorisations;
  until then, the mock-evidence rejection branch applies.

## 11. Known limitations and residual risks

### 11a Limitations

- **No live-tenant acceptance.** Phase 2F exercises the state
  machine + concurrency + mock-evidence isolation; it has not
  been exercised against real Stripe test-mode objects.
- **Sweep is operator-triggered (POST endpoint) in Phase 2F.** A
  cron on the Fly worker that calls the sweep every 5 minutes
  is a follow-up wiring step tracked in the Phase 2E Stripe
  follow-up.
- **No background retry worker.** A G3_STRIPE_UNAVAILABLE
  response relies on operators to re-run the sweep.  The Phase
  2I reconciliation worker (separate authorisation) will provide
  automatic retry.
- **SQLite row-locking is a no-op** (no `SELECT ... FOR UPDATE`).
  Dev / local-test correctness relies on single-worker + the
  identifier recheck.  Production (Postgres) can later add
  explicit `{ lock: "update" }` via a raw `tx.$queryRaw`.

### 11b Residual TOCTOU risks (documented)

- **Pre-fetch → recheck window**: between the external Stripe
  fetch and the DB recheck, a webhook could land + flip state.
  G2 + G4 rechecks inside the transaction catch most cases.
  Phase 2G's per-step revalidation provides defense in depth.
- **Clock skew**: if the Fly machine's clock disagrees with
  Stripe's `available_on`, the gate may fire early or late.
  Mitigated by Stripe-side availability latency (ACSS: T+5
  days) swamping any realistic clock skew.
- **Mock-evidence rejection relies on string equality** on the
  `evidenceSource` field.  A future live adapter MUST set
  `evidenceSource = "live-stripe"` exactly (not "live" or any
  other variant).  Enforced by TypeScript union type on the
  adapter port.

### 11c Not Phase 2F's scope

- Phase 2G: tenant provisioning (Club shell, User, UserClubRole,
  roles, COA / opening balance commit, branding, invites,
  welcome email).
- Phase 2H: operator remediation UI + retention worker + Phase
  2F invalidation-aware operator surfaces.
- Phase 2I: daily reconciliation worker + Fly-worker cron for the
  Phase 2F sweep.
- Live-adapter procurement + Stripe test-mode acceptance.
- Renewal cycles.
- Card-payment secondary method.

---

## Acceptance recommendation

**Recommended for founder acceptance (mock-backed staging
baseline).**

Phase 2F delivers the authorised scope within every founder
amendment:
- §3 concurrency correction honoured: Stripe fetch OUTSIDE
  transaction + explicit TOCTOU recheck + documented residual
  risk.
- §4 mock-evidence isolation enforced: production path refuses
  mock; feature flag cannot override; staging-only env var
  gates the test-only override.
- §5 Phase 2G handoff: `validateActivationAuthorisation` is a
  separate read-only function; Phase 2G never calls
  `authoriseActivation`.
- §6 invalidation vs cancellation: Phase 2F owns `invalidatedAt`;
  Phase 2G owns `cancelledAt`.
- §7 nine-gate matrix: every gate implemented + classified +
  routed to the correct operator-alert category.
- Schema extension justified: 4 nullable columns + 1 nullable
  relaxation, all additive.

Phase 2F IMPLEMENTATION is accepted mock-backed.  Phase 2F
LIVE-TENANT ACCEPTANCE requires the Stripe follow-up tracker
items 1.1-1.8 to land + a separately-authorised live-adapter
slice.  **Phase 2G and later phases remain unauthorized.**
