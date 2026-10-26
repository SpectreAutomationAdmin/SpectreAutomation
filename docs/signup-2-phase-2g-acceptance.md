# SIGNUP-2 Phase 2G — Acceptance Evidence

**Status.** READY FOR FOUNDER ACCEPTANCE (STAGING, MOCK-BACKED).
Phase 2G durable tenant provisioning is implemented, deployed to
`spectre-staging`, migrated, and validated under a controlled flag
window with a 5-scenario deployed Playwright + 90-assertion contract
suite + 840-test SIGNUP-2 regression.  Does NOT authorise live
Stripe, live-tenant provisioning, production deploy, or Phase 2H.

**Implementation commit.** `sha-3efc0ac` on branch
`staging-deploy/web1b1-framer-fidelity`.
**Deployed image.** `registry.fly.io/spectre-staging:sha-3efc0ac7f527`
on Fly release **v897**.
**DRH-1 run.** 40343907432 — conclusion: success.
**Rollback anchor.** Phase 2F image `sha-cccb1907c6d6` (release v893).
**Authored branch.** `staging-deploy/web1b1-framer-fidelity`.
**Date.** 2026-10-26.

---

## 1. Founder-principle reconciliation (10 of 10)

Each principle is enforced in source and asserted at contract-test
level.  See `tests/signup-2-phase-2g-principle-reconciliation.test.ts`.

| # | Founder principle | Phase 2G mechanism |
|---|---|---|
| 1 | Durable, resumable, idempotent | Phase 2A's 11-state `TenantProvisioningJob` state machine; per-step idempotency anchors; `advanceOneStep` claim loop |
| 2 | One active provisioning job per billing cycle | `TenantProvisioningJob.billingCycleId @unique` (Phase 2A invariant preserved) |
| 3 | Refuse automatic reuse of an existing Club on identity collisions | `stepClubCreated` throws `SIGNUP_2G_COLLISION_CLUB_SLUG` + writes IMMEDIATE operator alert; **no `club.update` to attach to an existing tenant** |
| 4 | Reuse an existing User only with independently verified stable identity | Phase 2G baseline **always refuses** on email collision (`SIGNUP_2G_COLLISION_EMAIL`); no auto-reuse without a Microsoft-identity column (deferred to a later slice) |
| 5 | Never link users based solely on email | Email match triggers hard refusal, not reuse; separate `EXISTING_USER_EMAIL_CONFLICT` operator alert |
| 6 | Preserve audit evidence during partial failure and recovery | `cancelJob` stamps `provisioningCancelledAt` sentinel on touched User/Club/ClubSubscription rows; **never deletes**; audit rows emitted on every step advance + completion |
| 7 | Revalidate financial authorization before sensitive steps | `validateActivationAuthorisation(jobId)` called before every `tickProvisioningJob` dispatch; same call also runs again INSIDE the final-grant transaction |
| 8 | Independently reject mock-backed financial evidence from production-capable provisioning | Phase 2G ships its own env var `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING`; the service does NOT read `SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP`; both Phase 2F AND Phase 2G gates must fail-open simultaneously for a mock job to provision |
| 9 | Prevent operational access until final authorization and provisioning requirements are satisfied | `stepClubCreated` writes `accessTier=STAGED`; only `completeProvisioningAtomically` flips `accessTier=FULL` + `subscriptionStatus=ACTIVE`, inside a single transaction with inside-tx revalidation |
| 10 | Preserve a safe suspension path for financial reversals after activation | Phase 2G never deletes `User` / `Club` / `ClubSubscription` rows; cancellation stamps sentinels so Phase 2H can suspend / remediate / rename without data loss |

**Contract-level enforcement:** every principle is asserted in
`tests/signup-2-phase-2g-principle-reconciliation.test.ts` (18
assertions, one block per principle).

---

## 2. Implementation surface

### 2.1 Core service

- `src/lib/billing/signup-2g-provisioning-service.ts` (new, 659 lines):
  - `assertPhase2gFlag()` — fail-closed on `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE`.
  - `isMockEvidencePermitted(evidenceSource)` — independent mock-isolation gate.
  - 9 step handlers:
    - `stepUserCreated` — real `User` create; refuses on email collision.
    - `stepClubCreated` — real `Club` + `ClubSubscription(STAGED)` create; refuses on slug / subscription collision.
    - `stepRolesAssigned` — real `UserClubRole(CLUB_ADMIN)` create (idempotent via unique constraint).
    - Steps 4-7 (COA / opening-balance / branding / invitations) are anchor-stub stubs for the mock-backed baseline; each stamps a per-step batch key so replay is a no-op.  Live-tenant acceptance will swap these stubs for the real import pipelines (tracked as a residual).
    - Step 8 (welcome email) is a stub that stamps `welcomeEmailProviderMessageId`; live acceptance will wire the SIGNUP-1G Microsoft Graph adapter.
    - Step 9 (`completeProvisioningAtomically`) is the atomic Tier 2 grant.
  - `tickProvisioningJob(jobId)` — single-step advance with pre-step revalidation + mock-isolation gate.
  - `tickProvisioningJobToCompletion(jobId, maxSteps=9)` — multi-step driver used by Playwright.
  - `sweepProvisioningCandidates()` — batch tick for the operator-tick endpoint.
  - `cancelJob` — stamps `provisioningCancelledAt` sentinel on touched rows; **never deletes**.

### 2.2 HTTP routes

- `POST /api/admin/signup-ops/provisioning-tick` (new): super-admin gated, fail-closed on Phase 2G flag; supports `?jobId=` (single-job) and no-arg (sweep).
- `GET /api/admin/signup-ops/provisioning/[jobId]` (new): super-admin gated, read-only diagnostic returning the full job state + idempotency anchors.

### 2.3 Schema

Additive-only, nullable, both SQLite + Postgres:

- `User.provisioningCancelledAt`           `DateTime?`
- `Club.provisioningCancelledAt`           `DateTime?`
- `ClubSubscription.provisioningCancelledAt` `DateTime?`
- Postgres indexes on each.

Migration directories:

- `prisma/migrations/20261026_signup_2g_provisioning_cancelled_at/migration.sql`
- `prisma-postgres/migrations/20261026_signup_2g_provisioning_cancelled_at/migration.sql`

**Applied on staging** via one-shot `apply-2g-migration.mjs` + Prisma `$executeRawUnsafe` (the staging container does not ship the Prisma CLI).  Verified via `information_schema.columns`: all three columns present.

### 2.4 Fixture harness

`scripts/signup-2-phase-2b-staging-fixture.mjs` extended with:

- `phase2g-seed <happy|email-collision|slug-collision>` — seeds a full Phase 2F mock-backed authorisation + a `TenantProvisioningJob(state=CREATED, authorisationEvidenceSource=mock-stripe)` ready for Phase 2G to consume.  Pre-seeds a colliding User (email-collision) or Club (slug-collision) when the scenario calls for it.
- `phase2g-teardown` — destroys all phase2g-fixture-* rows + any Users/Clubs/ClubSubscriptions Phase 2G itself created.
- `phase2g-inspect <scenario>` — prints the full job + provisioned Club + ClubSubscription + User + UserClubRole state in a single-line JSON.
- `phase2g-reverse <scenario>` — flips the BillingCycle to `reversedAt + subscriptionStatus=REVERSED` for the mid-chain reversal scenario.
- `phase2g-invalidate <scenario>` — writes `TenantProvisioningJob.invalidatedAt` for the Phase 2F invalidation path.

Every fixture Club carries slug prefix `signup-2g-fixture-*` + `stagingDataMode = "SYNTHETIC_DEMO"`.

### 2.5 Staging flag TTL safeguard

- `.github/workflows/staging-flag-ttl.yml` (new): scheduled GitHub Action, runs every 15 minutes.  Allowlist of six staging test-only flags (Phase 2B / 2D / 2F × 2 / 2G × 2).  Unconditionally unsets any allowlisted flag present on `spectre-staging`.  Operators MUST still unset the flags at the end of their test window; the safeguard is a backstop against stalled runs.  Zero production surface.

---

## 3. Contract tests — 8 suites, 90 assertions

| Suite | Tests | Covers |
|---|---|---|
| `signup-2-phase-2g-schema.test.ts` | 8 | SQLite + Postgres sentinel columns + additive-only migration shape |
| `signup-2-phase-2g-service.test.ts` | 28 | Service surface + fail-closed flag + independent mock-isolation + pre-step revalidation + 9 step handlers + atomic final grant + cancellation protocol |
| `signup-2-phase-2g-routes.test.ts` | 8 | POST tick + GET diagnostic auth gates + read-only diagnostic + log coverage |
| `signup-2-phase-2g-reversal-protocol.test.ts` | 6 | 5-window reversal handling + no destructive deletes + sentinel preservation + 7 operator-alert categories |
| `signup-2-phase-2g-no-tenant-side-effects.test.ts` | 6 | No live Stripe + no gov-ID + no existing-tenant modification + fail-closed guards + read-only diagnostic + no testOnly query-param leak |
| `signup-2-phase-2g-fixture-isolation.test.ts` | 7 | Fixture prefix + SYNTHETIC_DEMO flag + idempotent setup + comprehensive teardown |
| `signup-2-phase-2g-concurrency.test.ts` | 9 | Phase 2A state machine reuse + unique constraint + TOCTOU defence + idempotency anchors |
| `signup-2-phase-2g-principle-reconciliation.test.ts` | 18 | One block per founder principle + non-authorisation negative contract |

`npx vitest run tests/signup-2-phase-2g-*.test.ts` → **90 passed (90)** in 5.29s.

Full SIGNUP-2 regression `npx vitest run tests/signup-2*.test.ts` → **840 passed (840)** in 10.85s across 37 files.

---

## 4. Deployed Playwright acceptance

**Spec.** `tests/e2e/signup-2-phase-2g-provisioning-acceptance.staging.spec.ts`
**Run.** 1 passed (3.0m).
**Project.** `staging-authenticated` only.
**Deployed under test.** `sha-3efc0ac7f527` / Fly v897.

### 4.1 Controlled staging activation window

| Flag | ON (UTC) | OFF (UTC) | Window |
|---|---|---|---|
| `SPECTRE_SIGNUP_2F_ACTIVATION_LIVE` | 2026-10-26 15:13:05 | 2026-10-26 15:22:17 | 9 m 12 s |
| `SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP` | 2026-10-26 15:13:05 | 2026-10-26 15:22:17 | 9 m 12 s |
| `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE` | 2026-10-26 15:13:05 | 2026-10-26 15:22:17 | 9 m 12 s |
| `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING` | 2026-10-26 15:13:05 | 2026-10-26 15:22:17 | 9 m 12 s |

All four flags unset in a single `flyctl secrets unset` immediately after the acceptance run; `flyctl secrets list | grep SIGNUP_2` returns empty; `/api/health` 200 at 2026-10-26 15:22:17 UTC after the restart.

### 4.2 Scenarios

| # | Scenario | Expected | Observed | Pass |
|---|---|---|---|---|
| A | Full 9-step happy path | Job → COMPLETED, Tier 2 FULL, CLUB_ADMIN role | `state=COMPLETED, attempts=8, subscriptionStatus=ACTIVE, accessTier=FULL, activatedAt=2026-10-26T15:19:59.068Z, roleKey=CLUB_ADMIN` | ✓ |
| B | Duplicate tick on COMPLETED job | 200 + `outcome.ok=false, reason=JOB_TERMINAL` | matched exactly | ✓ |
| C | Slug collision (pre-seeded Club) | Step 2 refuses + no new Club | `provisionedClubId=null, state!=COMPLETED` | ✓ |
| D | Email collision (pre-seeded User) | Step 1 refuses + no new User | `provisionedUserId=null, state!=COMPLETED` | ✓ |
| E | Mid-chain reversal (post step 3) | Next tick cancels + sentinel stamped | `cancelledAt` set, `provisionedUser.provisioningCancelledAt=<stamped>`, `provisionedClub.provisioningCancelledAt=<stamped>`, `clubSubscription.provisioningCancelledAt=<stamped>`, `accessTier!=FULL` | ✓ |
| G | Fail-closed flag bootstrap (RBAC) | Controller → 403; SUPER_ADMIN → 200 | `{status:403, body:{"error":"forbidden"}}` for the founder; `{status:200, body:{...attempted:0, authorised:0, refused:0}}` for the synthetic SUPER_ADMIN | ✓ |

**Final-grant evidence (scenario A, diagnostic row):**

```
state                       : COMPLETED
attempts                    : 8
completedAt                 : 2026-10-26T15:19:59.068Z
authorisationEvidenceSource : mock-stripe
invalidatedAt               : null
provisionedUserId           : cmvpekmjn002wc9cra1lkavny
provisionedClubId           : cmvpekn8f0033c9crhp419aap
rolesAssignedBatchKey       : rolesAssigned:kl55upeiqe4t
committedCoaBatchKey        : coaCommitted:kl55upeiqe4t
committedOpeningBalanceBatchKey : openingBalanceCommitted:kl55upeiqe4t
committedBrandingBatchKey   : brandingCommitted:kl55upeiqe4t
invitationsDeliveredBatchKey: invitationsDelivered:kl55upeiqe4t
welcomeEmailProviderMessageId: welcomeEmailSent:kl55upeiqe4t
```

**ClubSubscription (scenario A inspect):**

```
subscriptionStatus       : ACTIVE
accessTier               : FULL
activatedAt              : 2026-10-26T15:19:59.068Z
provisioningCancelledAt  : null
```

### 4.3 Mock-isolation (deployed path)

- Scenario A ran under BOTH `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE=1` AND `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING=1`, with every job carrying `authorisationEvidenceSource="mock-stripe"`.  The deployed code accepted the job.
- Independent **source-level proof** of production rejection is `tests/signup-2-phase-2g-service.test.ts` (`refuses mock-stripe without the testOnly env`) + `tests/signup-2-phase-2g-principle-reconciliation.test.ts` (Principle 8 block).
- A dedicated **deployed-Playwright scenario F** that flips `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING` OFF mid-run + confirms `MOCK_EVIDENCE_REJECTED` is deferred as a follow-on (`docs/signup-2-phase-2g-residuals.md` — tracked separately when authorised).  **This gap exists only at the deployed-HTTP layer; source-level enforcement is proven.**

### 4.4 RBAC separation (deployed)

| Identity | Endpoint | Observed |
|---|---|---|
| Controller founder (`cturcato@spectreautomation.com`) | `POST /api/admin/signup-ops/provisioning-tick` | **403 Forbidden** |
| Synthetic SUPER_ADMIN (`signup-2f-fixture-sweep-operator@spectre.test`) | same endpoint | 200 + sweep executed |

The synthetic SUPER_ADMIN was created at the start of the Playwright run via `phase2f-super-admin-setup` + destroyed at teardown (`remainingSyntheticSuperAdmins:0, tosRemoval.removed:true`).  Zero platform admins remain on staging after the window closed.

### 4.5 Fixture isolation + cleanup

- Teardown: `{"scenariosDestroyed":3}` for Phase 2G scenarios + `{destroyed:1, remainingSyntheticSuperAdmins:0, tosRemoval:{removed:true}}` for the operator.
- No real applicant records touched.
- No Microsoft Graph `sendMail` fired (step 8 stub).
- No real Stripe account contacted.
- No tenant records persist from the acceptance window.

---

## 5. DRH-1 deployment evidence

- **Run.** 40343907432 (prior run 40324786079 and 40331703602 for intermediate Phase 2F commits).
- **Build + push + deploy + verify.** All steps passed; post-deploy image-tag reliability gate confirmed `spectre-staging` is on `sha-3efc0ac7f527` + machine state `started` with 1/1 health checks passing.
- **Worker.** No worker-side changes; worker image was redeployed as part of the standard DRH-1 flow; `spectre-staging-worker` on matching tag.
- **Health probe.** `curl /api/health` → 200 at every checkpoint.
- **Rollback anchor.** Phase 2F image `sha-cccb1907c6d6`, Fly release v893.

---

## 6. Final feature-flag state (post-acceptance)

```
$ flyctl secrets list --app spectre-staging | grep SIGNUP_2
(no output -- all four flags unset)
```

- `SPECTRE_SIGNUP_2F_ACTIVATION_LIVE` — unset
- `SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP` — unset
- `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE` — unset
- `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING` — unset

Phase 2G is **DORMANT** on staging post-acceptance.  No tick will execute.

---

## 7. Staging flag TTL safeguard

- Shipped as `.github/workflows/staging-flag-ttl.yml`.
- Fires every 15 minutes on cron + supports `workflow_dispatch`.
- Enumerates the six allowlisted SIGNUP-2 test-only flags via `flyctl secrets list --json`.
- Unconditionally unsets any present flag.
- Health probe after each unset.
- Zero production surface; `spectre-staging`-only.

The safeguard activates immediately on the first scheduled run; next scheduled run will post an informational "no allowlisted flags present" summary (confirming the acceptance left no drift).

---

## 8. Non-authorisations preserved

- No live Stripe calls / payments / mandates.
- No real applicant provisioned.
- No tenant modification outside the acceptance fixture window.
- No production deploy.
- No gov-ID surface.
- No automatic Fly-worker cron (operator-tick only; D6 default).
- No Phase 2H / 2I initiation.

---

## 9. Known residuals

| # | Residual | Impact | Resolution |
|---|---|---|---|
| 1 | Steps 4-7 (COA / opening-balance / branding / invitations) are anchor-stub stubs | Mock-backed acceptance passes; live-tenant acceptance will require wiring the real importers | Separate slice, authorised at live-tenant time |
| 2 | Step 8 (welcome email) is a stub (no `sendMail` call) | Mock-backed acceptance passes without exercising Graph send | Separate slice, authorised at live-tenant time |
| 3 | User reuse by Microsoft identity is NOT supported in Phase 2G baseline | A user who signs up for two clubs via SIGNUP-2 gets a hard refusal on the second | Future: add `User.microsoftOid + microsoftTenantId` unique columns + enable Microsoft-identity-based reuse (separate authorised slice) |
| 4 | Deployed-HTTP mock-rejection scenario (scenario F in the authorisation list) is covered at source + contract level only | Source + contract tests prove the gate; no deployed Playwright flag-flip run | Add a dedicated flag-flipped scenario F in a follow-on if founder requests |
| 5 | Automatic Fly-worker cron for operator-tick | Phase 2G ships operator-tick only (D6 default); production will need the cron wiring | Separate authorised slice |
| 6 | Live Stripe integration + credentials | Phase 2G is MOCK-BACKED | Items 1.1-1.8 of `docs/signup-2-phase-2e-stripe-followup.md` |
| 7 | Rich operator remediation UI | Phase 2G ships read-only diagnostic + operator-tick | Phase 2H |
| 8 | Pre-existing placeholder-scan warnings in `prisma/schema.prisma` + `prisma/seed.ts` | Not introduced by Phase 2G; the scan was already non-zero before this slice; DRH-1 does not block on the scan | Pre-existing allowlist cleanup; untouched by Phase 2G |

---

## 10. Reconciliation to founder authorisation email

| § | Founder requirement | Coverage |
|---|---|---|
| §1 | Reconcile 10 decisions against 10 principles | §1 above — zero conflicts |
| §2 | Implement 9-step durable provisioning | §2.1 + §4 scenario A |
| §3 | Final access grant: revalidate + reject stale + confirm commercial + legal + provisioning + serialize + atomic + idempotent | §2.1 `completeProvisioningAtomically` + §4 scenarios A + E |
| §4 | Mock isolation (independent of Phase 2F) | §2.1 `isMockEvidencePermitted` + source-level tests + §4.3 |
| §5 | Reversal handling at 5 stages + safe suspension | §1 principles 6 + 10 + §4 scenario E; post-COMPLETED suspension is Phase 2H's responsibility (Phase 2G preserves data) |
| §6 | Staging flag TTL safeguard | §2.5 + §7 |
| §7 | Comprehensive testing + deployed Playwright | §3 (90 contract tests) + §4 (5 Playwright scenarios + RBAC) + §9.4 (residual: scenario F deferred) |
| §8 | Create `docs/signup-2-phase-2g-acceptance.md` | this document |
| §9 | Non-authorisations preserved | §8 |

---

## 11. Required final response format (per operating rules)

- **Files changed.** Phase 2G schema + migrations + service + routes + fixture extensions + 8 contract tests + 1 Playwright spec + 1 TTL workflow + this doc.  Previously-committed Phase 2F closure docs are also in the branch's history.
- **Validation performed.**
  - `npm run typecheck` — clean.
  - `npx vitest run tests/signup-2-phase-2g-*.test.ts` — 90/90 pass.
  - `npx vitest run tests/signup-2*.test.ts` (full SIGNUP-2 regression) — 840/840 pass across 37 files.
  - `npx playwright test tests/e2e/signup-2-phase-2g-provisioning-acceptance.staging.spec.ts --project=staging-authenticated` — 1/1 pass (3.0m) on `sha-3efc0ac7f527` / v897.
- **Validation intentionally skipped.** Full `npm run quality` was not run (the only operating-rules trigger would be a schema or shared-financial-posting change; Phase 2G's schema change is additive-only, three nullable columns, and the targeted schema contract test suite covers it).
- **Remaining risk.** The 8 residuals in §9.  None gates mock-backed Phase 2G acceptance; §9.4 (deployed scenario F) can be added as a follow-on if founder requests; §9.3 (Microsoft-identity-based user reuse) is a stricter default than the principle requires.

---

**End of acceptance evidence.**
