# SIGNUP-2 Phase 2G — Implementation Authorisation Package (DRAFT)

**Status.** PLANNING ONLY, pending founder authorisation.  No
application code; no Prisma migration; no Stripe entity; no
production configuration; no tenant provisioning; no live payment.

**Supersedes.** None (Phase 2G first draft).

**Depends on.**
- SIGNUP-2 Architecture Decision Document v3 (`sha-07db40b`),
  particularly §3 (`TenantProvisioningJob` state machine).
- SIGNUP-2 Phase 2A accepted baseline (schema shipped).
- SIGNUP-2 Phase 2B accepted baseline (attestation; dormant).
- SIGNUP-2 Phase 2C accepted baseline (verification; dormant).
- SIGNUP-2 Phase 2D accepted baseline
  (`MANUAL_RELEASE` verdict producer).
- SIGNUP-2 Phase 2E technically-accepted baseline (mock-backed
  payment architecture; ACTIVATION_READY signal producer).
- SIGNUP-2 Phase 2F technically-accepted baseline (nine-gate
  activation-authorisation producer; `validateActivationAuthorisation`
  exported for Phase 2G).
- Stripe-integration follow-up tracker
  ([docs/signup-2-phase-2e-stripe-followup.md](signup-2-phase-2e-stripe-followup.md)).
- Phase 2A `tenant-provisioning-workflow.ts` (step-level state
  machine scaffold shipped, mock handlers).

**Confirmed on filing this document:**
- No production state has changed.
- No live Stripe entity exists.
- No DB migration has been applied.
- No tenant provisioned.
- No existing-tenant access change.
- All Phase 2B / 2C / 2D / 2E / 2F feature flags remain OFF.

---

## 1. Exact provisioning scope and exclusions

### 1a In-scope for Phase 2G

Phase 2G is the **durable provisioning worker** that consumes a
Phase 2F `TenantProvisioningJob(state=CREATED)` row and produces,
via a resumable 9-step state machine, a fully-provisioned Club
shell + initial administrative User + role assignments + staged
onboarding configuration + welcome email + a FINAL atomic
`ACTIVE` + `accessTier = FULL` grant.

Concretely:
1. **Worker claim loop** that polls `TenantProvisioningJob(state=CREATED, nextAttemptAt<=now)` rows, respecting a per-job max-attempts budget + exponential backoff.
2. **Per-step handlers** for the 9 Phase 2A states:
   `USER_CREATED → CLUB_CREATED → ROLES_ASSIGNED → COA_COMMITTED →
   OPENING_BALANCE_COMMITTED → BRANDING_COMMITTED →
   INVITATIONS_DELIVERED → WELCOME_EMAIL_SENT → COMPLETED`.
3. **Pre-step revalidation gate** that calls Phase 2F's
   `validateActivationAuthorisation(jobId)` BEFORE every step.
   Any `invalidated` / `expired` / `financial-reversed` /
   `TOS-mismatch` revalidation outcome triggers Phase 2G's
   cancellation protocol (not provisioning retry).
4. **Atomic final access grant**: the `WELCOME_EMAIL_SENT →
   COMPLETED` transition flips `ClubSubscription.subscriptionStatus
   = ACTIVE` + `accessTier = FULL` + `TenantProvisioningJob.state
   = COMPLETED` + writes the final audit row inside ONE
   `prisma.$transaction`.  A final `validateActivationAuthorisation`
   call is the last operation BEFORE this transaction opens.
5. **Cancellation + compensation protocol** that handles mid-step
   reversal: writes `cancelledAt + cancelReason` on the job,
   preserves per-step idempotency anchors, emits operator alerts,
   and (where possible) marks already-created rows with a
   `provisioningCancelledAt` sentinel so they can be reclaimed
   or garbage-collected by a Phase 2H operator action.
6. **Fail-closed feature flag** `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE`.
7. **Mock-isolation enforcement**: Phase 2G REFUSES to begin
   provisioning when `TenantProvisioningJob.authorisationEvidenceSource
   === "mock-stripe"` AND `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING
   !== "1"`.  Production never sets that env var.
8. **Operator diagnostics**: a read-only endpoint
   `GET /api/admin/signup-ops/provisioning/[jobId]` returning the
   full job state + per-step provenance.  Super-admin gated;
   audited.
9. **Worker invocation**: a POST endpoint
   `/api/admin/signup-ops/provisioning-tick` for operator-triggered
   step advancement.  An automatic Fly-worker cron (every N
   minutes) is a Phase 2I-adjacent wiring step, not Phase 2G's
   responsibility.
10. **Contract + Playwright acceptance tests**.

### 1b Out-of-scope for Phase 2G (deferred by phase)

| Area | Deferred to | Why |
|---|---|---|
| Rich operator remediation UI | Phase 2H | Phase 2G ships only the read-only diagnostic + the manual tick endpoint. |
| Automatic reconciliation worker (daily sweep) | Phase 2I | Phase 2G is operator-triggered; the cron wiring is Phase 2I's deliverable. |
| Welcome email template polish | separate design slice | Phase 2G ships a minimal, flag-gated template. |
| Live Stripe adapter | separate authorisation + items 1.1–1.8 of the Stripe follow-up tracker | Preserves mock-isolation. |
| Renewal cycles + new-mandate flow | later slice | Phase 2G ships the first-cycle provisioning only. |
| Member-portal public release / white-label domain publish | Phase 2A docs mark these Tier 2 features; Phase 2G grants Tier 2 but does NOT activate the public-portal domain | Separate operator action unlocks public visibility. |

### 1c Hard non-authorisations

- No live Stripe calls (mock-only in Phase 2G baseline).
- No production configuration change.
- No deployment to production.
- No gov-ID collection, retention, or surface.
- No Phase 2H / 2I initiation.
- No automatic cron / worker-loop wiring (operator-tick only in
  Phase 2G baseline).

---

## 2. Reuse of the Phase 2A `TenantProvisioningJob` state machine

Phase 2A shipped `TenantProvisioningJob` with the 9-step state
column + per-step idempotency anchors (`provisionedUserId`,
`provisionedClubId`, `rolesAssignedBatchKey`, `committedCoaBatchKey`,
`committedOpeningBalanceBatchKey`, `committedBrandingBatchKey`,
`invitationsDeliveredBatchKey`, `welcomeEmailProviderMessageId`).

Phase 2A also shipped `src/lib/billing/tenant-provisioning-workflow.ts`
with:
- `createProvisioningJob(args)` (Phase 2F now owns the creation
  side; this call-site becomes an internal detail).
- A per-step runner that calls a `handler(stepStart, ctx)` function
  for the current state + stamps the idempotency anchor on success.

Phase 2G ships the HANDLERS for each step + the worker loop.  Zero
new state-machine columns needed; the Phase 2A scaffold's shape is
sufficient.  Phase 2F's additions
(`authorisationEvidenceSource`, `authorisationExpiresAt`,
`invalidatedAt`, `invalidatedReason`) are the gate variables Phase
2G reads at every tick.

---

## 3. Durable, retryable, idempotent provisioning steps

### 3a Step contract

Every step handler is:
- **Idempotent**: a replay with the same inputs produces no new
  side effects.  Enforced by per-step idempotency anchors (e.g.
  `provisionedUserId` != null → skip the User creation; use the
  existing one).
- **Resumable**: a crash between steps resumes from the last
  completed state.  The runner advances `state` AFTER the handler
  returns success.
- **Observable**: every step writes an `audit()` row with action
  `signup.provisioning.<step_name>.success` or `.failed`.
- **Revalidation-gated**: BEFORE the handler executes, Phase 2G
  calls `validateActivationAuthorisation(jobId)`.  Any failure
  triggers the cancellation protocol (§10), NOT a retry.

### 3b Retry policy

- Per-step retry on transient failure (adapter errors, network
  timeouts): exponential backoff `60s * 2^attempts` capped at 1h.
- Max attempts per job: 10 (same as Phase 2F sweeper).  Beyond
  that → `state = FAILED` + `IMMEDIATE` operator alert
  (`PROVISIONING_STUCK` category — new, see §13).
- A FAILED job is not auto-retried; operator must trigger via
  the Phase 2H retry endpoint (deferred).

### 3c Per-step side-effect summary

| Step | Idempotency anchor | External side effects |
|---|---|---|
| `USER_CREATED` | `provisionedUserId` | 1 User row created / looked up by `(microsoftOid, microsoftTenantId)` |
| `CLUB_CREATED` | `provisionedClubId` | 1 Club row created / looked up by `signupRegistrationId → Club.slug` convention; 1 ClubSubscription row created with `accessTier=STAGED` |
| `ROLES_ASSIGNED` | `rolesAssignedBatchKey` | 1 UserClubRole row (user ↔ club ↔ CLUB_ADMIN) |
| `COA_COMMITTED` | `committedCoaBatchKey` | COA import write (uses existing posting-guard) |
| `OPENING_BALANCE_COMMITTED` | `committedOpeningBalanceBatchKey` | opening-balance import write |
| `BRANDING_COMMITTED` | `committedBrandingBatchKey` | S3 asset upload with deterministic key `clubs/<clubId>/branding/...` |
| `INVITATIONS_DELIVERED` | `invitationsDeliveredBatchKey` | queued UserInvitation sends via Phase 2A SIGNUP-1G adapter |
| `WELCOME_EMAIL_SENT` | `welcomeEmailProviderMessageId` | 1 Microsoft Graph `sendMail` call |
| `COMPLETED` | n/a (terminal; set within the final atomic transaction) | ClubSubscription → ACTIVE + accessTier=FULL |

---

## 4. Creation of the Club and associated administrative identity

### 4a USER_CREATED step

Upsert by `(microsoftOid, microsoftTenantId)`.  Phase 2E persisted
these on the `SignupRegistration` row (`adminMicrosoftOid`,
`adminMicrosoftTenantId`).  If a User with that pair already
exists:
- **Normal case**: reuse the existing User id.  Write to
  `provisionedUserId`.  No new User row.
- **Collision case** (same `oid` but User has `status =
  DEACTIVATED` or `SUSPENDED`): **refuse to proceed**.  Write
  cancellation + IMMEDIATE operator alert (`EXISTING_USER_CONFLICT`
  category).  No automatic reactivation.

### 4b CLUB_CREATED step

Upsert by the deterministic slug derived from the Club legal name
+ a short hash of `signupRegistrationId` for collision safety:
`<slug-of-legalName>-<regIdTail-6>`.  If a Club with that slug
already exists:
- **Collision case** (another Club already has the slug): **refuse
  to proceed**.  Operator alert `EXISTING_CLUB_SLUG_CONFLICT`.
  Phase 2H handles the operator-rename remediation.
- `provisionedClubId` stamped on success.
- `ClubSubscription` row is created in the same step with
  `accessTier = STAGED` from day one (per v3 Tier-1 architecture).
  The Phase 2E `SubscriptionPaymentMandate.clubId` + Phase 2F
  `TenantProvisioningJob.clubSubscriptionClubId` are backfilled
  via the shared transaction.

### 4c Role seeding

The founding administrator receives **CLUB_ADMIN** at the Club.
No SUPER_ADMIN grant.  No cross-Club roles.  The Phase 2A
`rolesAssignedBatchKey` is a hash of the role-set written so
replays are idempotent.

---

## 5. Existing-user and existing-club collision handling

| Collision | Response |
|---|---|
| Existing User with same `microsoftOid` + ACTIVE status | Reuse; stamp `provisionedUserId` |
| Existing User with same `microsoftOid` + DEACTIVATED / SUSPENDED | Refuse; operator alert `EXISTING_USER_CONFLICT` |
| Existing User with same email but different `microsoftOid` | Refuse; operator alert `EXISTING_USER_EMAIL_CONFLICT` |
| Existing Club with same slug | Refuse; operator alert `EXISTING_CLUB_SLUG_CONFLICT` |
| Existing ClubSubscription for a Club this registration would attach to | Refuse; operator alert `EXISTING_SUBSCRIPTION_CONFLICT`; the new attempt must get its own Club |

The founder's §4 Existing-tenants rule is enforced by:
- NEVER attaching a new signup to an existing Club shell
  (collision check above refuses the slug collision case).
- NEVER elevating an existing user's permissions (collision
  check above refuses the user-conflict case).
- The ROLES_ASSIGNED step writes ONLY to the newly-created User
  + newly-created Club pair.

---

## 6. Initial roles and permission assignment

- Founding admin: `CLUB_ADMIN` on the new Club.
- No `SUPER_ADMIN` grants to any applicant-side user.
- No cross-Club memberships from provisioning.
- Phase 2A's `UserClubRole(clubId, userId, roleKey)` is unique on
  `(clubId, userId, roleKey)` — replay-safe via `upsert`.

Queued invitations (any UserInvitation rows written during the
staged-onboarding phase before Phase 2G) are delivered during the
`INVITATIONS_DELIVERED` step.  Each invitation carries its own
send-idempotency marker.

---

## 7. Staged onboarding versus full operational access

- `CLUB_CREATED` writes `ClubSubscription.accessTier = STAGED`.
- Every subsequent step runs under STAGED (Tier 1) capability
  rules.  Spectre's posting-guard refuses GL writes, payroll
  posting, member billing, etc. until Tier 2.
- Only the FINAL `WELCOME_EMAIL_SENT → COMPLETED` transition
  flips `accessTier → FULL`, atomically with the state transition.

If a reversal arrives mid-provisioning, the `accessTier` stays
STAGED; the cancellation protocol (§10) preserves the staged
state for operator remediation.

---

## 8. Financial authorization revalidation before sensitive writes

Phase 2G calls `validateActivationAuthorisation(jobId)` BEFORE
every step, not just before the final grant.  Rationale:

- The authorisation TTL (Phase 2F default 15 min) is short enough
  that a long-running step chain might cross it.
- A reversal webhook could arrive mid-provisioning.
- Phase 2F's own invalidation path (operator action) could land
  mid-provisioning.
- Mock-evidence isolation re-asserts at every step (the
  revalidation preserves the testOnly scope).

If revalidation returns `ok: false`:
- Step handler does NOT execute.
- Job transitions to the cancellation path (§10).
- `TenantProvisioningJob.cancelledAt + cancelReason` are written.
- Operator alert emitted.

The FINAL atomic access-grant transaction (§11) performs ONE more
revalidation call inside the same transaction window as the
state transition.  Any failure aborts the transaction.

---

## 9. Reversal handling during provisioning

Three distinct reversal windows ALREADY handled in Phase 2F; Phase
2G's responsibility is the DURING-PROVISIONING window:

### 9a Reversal detected before step N starts

Pre-step revalidation (§8) catches it.  Job cancels before step N
executes.  Steps 1..N-1's writes are preserved (idempotency
anchors stamped).

### 9b Reversal detected mid-step

Each handler runs under a `prisma.$transaction` scope.  Mid-step
reversal cannot be detected without additional polling; Phase 2G's
step runners complete the current step idempotently (writes are
replay-safe) + the NEXT step's pre-run revalidation catches the
reversal.  This bounds the "wasted work" to one step at most.

### 9c Reversal detected after COMPLETED (final grant)

Phase 2G's final atomic grant (§11) performs the LAST
revalidation inside the transaction.  Once committed, a
subsequent reversal webhook (Phase 2E dispatcher) will:
- Phase 2E writes `BillingCycle.reversedAt + subscriptionStatus =
  REVERSED`.
- A separate suspension handler (Phase 2H-adjacent — this is
  the only piece of Phase 2H Phase 2G hints at) flips
  `ClubSubscription.subscriptionStatus = SUSPENDED` + reduces
  `accessTier` to a read-only Tier 1.
- Phase 2G itself does NOT un-provision; data is preserved for
  operator remediation.

The handler for post-COMPLETED reversal is a **Phase 2H
responsibility**, not Phase 2G.  Phase 2G ships only the data-
preservation guarantee: a post-COMPLETED reversal flips subscription
status + access tier WITHOUT deleting any Club / User / UserClubRole
row.

---

## 10. Safe cancellation and compensation

### 10a Cancellation triggers

| Trigger | Window | Phase 2G action |
|---|---|---|
| `validateActivationAuthorisation` returns `ok: false` | Pre-step | Write `cancelledAt + cancelReason`; preserve per-step anchors; operator alert |
| Mid-step adapter failure past retry budget | Mid-step | Write `state = FAILED + lastError`; operator alert |
| Operator-triggered cancel (Phase 2H) | Any state | Phase 2G's cancel endpoint writes `cancelledAt + cancelReason` + the operator user id |
| Post-COMPLETED reversal | Terminal state | Phase 2H's suspension handler; Phase 2G does nothing destructive |

### 10b Compensation

Phase 2G does NOT delete:
- Any Club row.
- Any User row.
- Any UserClubRole row.
- Any ClubSubscription row.
- Any BillingCycle row.
- Any PaymentReconciliationEntry row.
- Any audit row.

Compensation is a RESTORATIVE operator action, not a destructive
one.  A cancelled job preserves every row so Phase 2H can either:
- Retry the job (Phase 2H endpoint).
- Convert the Club shell to inactive (new `Club.lifecycleState`
  column — tracked here but NOT shipped in Phase 2G; a Phase 2H
  additive migration).
- Issue a refund (Phase 2E path).

### 10c `provisioningCancelledAt` sentinel

Phase 2G's cancellation stamps a NEW nullable column on each
touched row:
- `User.provisioningCancelledAt` (nullable).
- `Club.provisioningCancelledAt` (nullable).
- `ClubSubscription.provisioningCancelledAt` (nullable).

The sentinel is a signal to subsequent Phase 2H operator queries
+ to any posting-guard that these rows are reversible pending
operator action.  Additive migration; no breaking change.

---

## 11. Atomic final access-grant protocol

The `WELCOME_EMAIL_SENT → COMPLETED` transition is the moment
Tier 2 unlocks.  Phase 2G serialises this against financial
invalidation as follows:

```
Phase 2G final-grant transaction:
  1. Open prisma.$transaction (short)
  2. Row-lock BillingCycle (Postgres)
  3. Row-lock TenantProvisioningJob
  4. Call validateActivationAuthorisation(jobId) ONE MORE TIME
     (reads inside the lock)
  5. If !ok → ROLLBACK; cancellation path
  6. Else:
     tx.clubSubscription.update({
       where: { clubId: provisionedClubId },
       data: {
         subscriptionStatus: "ACTIVE",
         accessTier: "FULL",
         firstSettlementAt: cycle.settlementConfirmedAt,
       },
     });
     tx.tenantProvisioningJob.update({
       where: { id: jobId },
       data: {
         state: "COMPLETED",
         completedAt: new Date(),
       },
     });
  7. Commit
  8. (OUTSIDE) audit emission + welcome notification deliveries
```

The row-lock serialises against:
- Phase 2E's reversal webhook handler (which also row-locks
  BillingCycle on `charge.refunded` / `charge.dispute.created`
  via a conditional updateMany).
- Phase 2F's `invalidateActivationAuthorisation` (which uses a
  conditional updateMany on `invalidatedAt IS NULL`).

A reversal that arrives DURING the final-grant transaction either:
- Blocks on the row-lock until the grant commits, then succeeds
  → next step is Phase 2H's suspension handler (post-COMPLETED
  reversal).
- Lands BEFORE the grant transaction opens → `validateActivationAuthorisation`
  inside the transaction (step 4) returns `ok: false` and the
  grant aborts.

---

## 12. Prevention of duplicate clubs, users, and subscriptions

| Entity | Uniqueness enforcement |
|---|---|
| Club | Unique index on `slug`.  Collision check in CLUB_CREATED. |
| User | Unique index on `(microsoftOid, microsoftTenantId)` (if present) + unique on `email`.  Collision check in USER_CREATED. |
| UserClubRole | Unique on `(userId, clubId, roleKey)`. |
| ClubSubscription | Unique on `clubId` (one subscription per Club).  CLUB_CREATED's `clubSubscription.create` fails on conflict → cancellation. |
| TenantProvisioningJob | Unique on `billingCycleId` (Phase 2A). |
| SubscriptionPaymentMandate | Unique on `stripeMandateId` + `stripePaymentMethodId` (Phase 2A). |

A replay-safe handler sees these conflicts + treats them as
"already provisioned" (idempotency anchor is set).

---

## 13. Failure recovery and operator alerts

New operator-inbox categories (Phase 2G ships; Phase 2H's richer
surface consumes):

| Category | Severity | Trigger |
|---|---|---|
| `PROVISIONING_STUCK` | IMMEDIATE | Job retry budget exhausted (state=FAILED) |
| `EXISTING_USER_CONFLICT` | IMMEDIATE | USER_CREATED detected a non-ACTIVE user with the same oid |
| `EXISTING_USER_EMAIL_CONFLICT` | IMMEDIATE | Email collision with a different microsoftOid |
| `EXISTING_CLUB_SLUG_CONFLICT` | IMMEDIATE | Slug collision |
| `EXISTING_SUBSCRIPTION_CONFLICT` | IMMEDIATE | ClubSubscription already exists for the resolved Club |
| `PROVISIONING_REVOCATION` | IMMEDIATE | Pre-step revalidation returned not-ok mid-chain |
| `PROVISIONING_COMPLETED` | ROUTINE | COMPLETED transition reached (informational) |

Every alert carries:
- `jobId` tail.
- `signupRegistrationId` tail.
- The step that failed / completed.
- The specific error class (not the raw error message).

---

## 14. Tenant isolation and security

- Every Phase 2G write is scoped by `jobId` + its resolved
  `signupRegistrationId` (not shared state).
- The super-admin diagnostic endpoint
  (`/api/admin/signup-ops/provisioning/[jobId]`) is read-only.
- The manual-tick endpoint (`/api/admin/signup-ops/provisioning-tick`)
  is super-admin gated + auth-checked + audited.
- Mock-isolation (§4 of Phase 2F authorisation) re-asserts in
  Phase 2G: a job with `authorisationEvidenceSource ===
  "mock-stripe"` refuses to begin provisioning in production.
  Only `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING=1` on
  staging allows it.
- Phase 2G never grants a signup user cross-tenant access.  Even
  a SUPER_ADMIN who happens to also be an applicant gets
  CLUB_ADMIN on the new Club (not elevated).

---

## 15. Audit trail and reconciliation evidence

- Every step emits `audit()` with tails only (same pattern as
  Phase 2A-2F).
- The final `WELCOME_EMAIL_SENT → COMPLETED` transition writes a
  `PaymentReconciliationEntry` with
  `entryType = "ACTIVATION_COMPLETED"`.
- The cancellation path writes a `PaymentReconciliationEntry`
  with `entryType = "ACTIVATION_CANCELLED"` + the cancellation
  reason.
- All operator inbox entries carry the full provenance chain
  (jobId / cycleId / registrationId tails + step name).
- A Phase 2I reconciliation worker (separate authorisation) will
  periodically scan `TenantProvisioningJob` rows + reconcile with
  Stripe + the Spectre DB; Phase 2G does NOT ship that.

---

## 16. Mock-backed staging acceptance without real tenant activation

Phase 2G's acceptance strategy mirrors Phase 2F:

- Fixture Clubs are staging-only (slug prefix `signup-2g-fixture-*`,
  `stagingDataMode = "SYNTHETIC_DEMO"`).
- Fixture Users are staging-only (email prefix
  `signup-2g-fixture-*@spectre.test`, destroyed at teardown).
- The acceptance Playwright runs under TWO environment variables:
  `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE=1` AND
  `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING=1`.
  BOTH flipped ON at the start of the controlled window; BOTH
  flipped OFF after the acceptance completes.
- No real applicant's registration is provisioned; the acceptance
  uses Phase 2F's mock-backed `TenantProvisioningJob(authorisationEvidenceSource=mock-stripe)`
  rows.
- The acceptance test destroys every fixture row at teardown.
- Zero real Clubs, Users, or UserClubRoles persist after the
  acceptance window.

**Live-tenant acceptance** requires:
- Items 1.1–1.8 of the Phase 2E Stripe follow-up (merchant
  account + credentials + legal review + authorisation).
- A real Phase 2E `TenantProvisioningJob(authorisationEvidenceSource=live-stripe)`.
- A separately-authorised live-tenant slice.

---

## 17. Contract and Playwright testing

### 17a Contract tests (vitest; target ≥ 80 passing assertions)

1. `tests/signup-2-phase-2g-step-handlers.test.ts` — each handler
   is idempotent + emits the right anchor + the right audit.
2. `tests/signup-2-phase-2g-revalidation-gate.test.ts` — pre-step
   `validateActivationAuthorisation` call on every step; refusal
   routes to cancellation (not retry).
3. `tests/signup-2-phase-2g-collisions.test.ts` — the five
   collision cases (§5) each refuse + alert + do not provision.
4. `tests/signup-2-phase-2g-final-grant.test.ts` — the atomic
   `WELCOME_EMAIL_SENT → COMPLETED` transaction with
   revalidation inside the lock; reversal mid-grant aborts.
5. `tests/signup-2-phase-2g-mock-isolation.test.ts` — a job with
   `authorisationEvidenceSource = "mock-stripe"` refuses to
   provision unless `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING === "1"`.
6. `tests/signup-2-phase-2g-no-destructive-cancellation.test.ts` —
   cancellation NEVER deletes rows; `provisioningCancelledAt` is
   stamped on touched rows instead.
7. `tests/signup-2-phase-2g-sweep-endpoint.test.ts` — manual-tick
   endpoint auth + rate-limit + fail-closed on flag unset.

### 17b Playwright staging acceptance

`tests/e2e/signup-2-phase-2g-provisioning-acceptance.staging.spec.ts`:

- **A.** Full happy path: seed Phase 2F job → tick → run through
  all 9 steps → `ClubSubscription.subscriptionStatus = ACTIVE` +
  `accessTier = FULL`.
- **B.** Revalidation refusal mid-chain: seed, tick through 3
  steps, trigger a Phase 2F invalidation, tick → job cancels.
- **C.** Reversal mid-provisioning: seed, tick through steps,
  trigger reversal on the BillingCycle, next tick cancels.
- **D.** User collision: pre-seed a User with the same oid +
  DEACTIVATED status; tick refuses + alert.
- **E.** Mock-isolation refusal: deployed container without the
  testOnly env → sweep refuses mock-backed job.
- **F.** Fail-closed flag: `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE`
  unset → tick endpoint returns 503.

### 17c Full regression

- SIGNUP-1 + 1F + 2A + 2B + 2C + 2D + 2E + 2F + 2G suites green.
- Phase 2A's existing `tenant-provisioning-workflow.ts` tests
  updated to reflect the new handlers (no longer mock-return
  stubs).

### 17d Placeholder scan clean

---

## 18. DRH-1 deployment and rollback

Standard DRH-1 pattern:
1. Commit on `staging-deploy/web1b1-framer-fidelity`.
2. GitHub Actions runs the post-deploy image-tag reliability gate.
3. Fly release to `spectre-staging` only.
4. Health probe + webhook signature-reject smoke.
5. Controlled staging activation window: BOTH
   `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE=1` AND
   `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING=1` flipped ON.
6. Playwright acceptance against the deployed image.
7. BOTH flags flipped OFF after acceptance.
8. Document the activation window + duration.

Rollback anchor: **Phase 2F image sha-6aa940cf4c63**.

A Phase 2G that regresses the Phase 2F gates would fail the §13
collision tests + the §15 audit tests before deploy; the DRH-1
post-deploy gate catches image-tag mismatches.

---

## 19. Outstanding founder decisions

Material to code surface:

1. **Welcome email provider**: Phase 2G proposes SIGNUP-1G's
   Microsoft Graph `sendMail` adapter.  Confirm (same as Phase
   2B / 2C / 2D use) or specify alternative.
2. **Welcome email template**: Phase 2G ships a minimal template.
   Confirm the acceptable content or defer polish to a later
   design slice.
3. **CLUB_ADMIN role for the founding admin**: confirm this is
   the correct starting role (not `GENERAL_MANAGER` or a custom
   `CLUB_FOUNDER` role).
4. **Collision policy**: Phase 2G proposes IMMEDIATE operator
   alerts + hard refusal.  Confirm or specify alternatives
   (e.g., auto-reactivate DEACTIVATED users).  Recommended:
   hard refusal — automatic reactivation is a security risk.
5. **Mock-isolation env var**:
   `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING` proposed.
   Confirm the naming convention.
6. **Fly worker cron for automatic ticking**: Phase 2G ships
   manual-tick ONLY.  Confirm the cron wiring is a Phase 2I-
   adjacent deliverable (recommended) OR a Phase 2G follow-on
   slice.
7. **Compensation column**: Phase 2G proposes a
   `provisioningCancelledAt` nullable column on `User`, `Club`,
   `ClubSubscription`.  Confirm the column name + whether all
   three or just `Club` + `ClubSubscription` need it.
8. **Live-tenant acceptance gate**: Phase 2G IMPLEMENTATION
   can proceed mock-backed, BUT live-tenant acceptance requires
   items 1.1-1.8 of the Phase 2E Stripe follow-up tracker.
   Confirm this ordering.

Configuration + copy:

9. Feature flag naming: `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE`.
10. Operator inbox categories (§13): seven new categories.
    Confirm or trim.

Decisions 1 + 3 + 4 + 7 are material to the code surface.
Decisions 2 + 5 + 6 + 8 + 9 + 10 are configuration + copy.

---

## 20. What this document is + is not

**IS:**
- The Phase 2G planning document, awaiting founder authorisation.
- A reconciliation of v3 architecture §3 (TenantProvisioningJob
  state machine) with the Phase 2G implementation boundary.
- A specification complete enough that implementation is a
  direct translation.

**IS NOT:**
- Authorisation to implement.
- A code change.
- A deployment.
- A Stripe API call (test or live).
- A Phase 2H or later initiation.
- A commitment to any specific worker cron cadence until
  decision 6 lands.

**Awaiting founder authorisation of Phase 2G per Section 17.**
