# SIGNUP-2 Phase 2D — Acceptance Evidence

**Status.** READY FOR FOUNDER ACCEPTANCE.
**Authored branch.** `staging-deploy/web1b1-framer-fidelity`.
**Depends on.** Phase 2A (sha-c3e337e / v870), Phase 2B
(sha-9c717e1 / v875), Phase 2C (sha-adfe13c / v877).
**Date.** 2026-10-26.

---

## 1. Implementation commits and Fly release

- **Implementation commit:** `sha-e3eed9e` on branch
  `staging-deploy/web1b1-framer-fidelity`.
- **Fly release:** **spectre-staging v880** (image
  `registry.fly.io/spectre-staging:sha-e3eed9e9d045`); the GitHub
  Actions DRH-1 pipeline created the release but the rolling update
  stalled with the machine still on the prior image.  A follow-up
  `flyctl deploy --image … --strategy rolling` from this session's
  local flyctl pushed the Phase 2D image to the web machine; the
  rollout completed cleanly, release checks green.
- **Rollback anchor:** v877 (`sha-adfe13c3e2c6`) — Phase 2C baseline.
- **`/api/health` post-deploy:** HTTP **200**, DB ok, queue ok,
  captured 2026-10-26 02:00 UTC.
- **Log scan post-release:** zero errors / zero warnings on Phase 2D
  paths in the 60-second window after the manual-redeploy succeeded.

### 1a Known rollout gotcha + follow-up

The initial DRH-1 deploy image was built and pushed cleanly (all five
Phase 2D route handlers appeared in the Next.js build output: see
`Collecting page data` section of the GitHub Actions log).  The web
machine's `image_ref` tag, however, remained at the prior
`sha-8fdbcf6f1258` after the GitHub Actions step reported success.
Phase 2C's identical deploy pattern (v877) rolled over normally, so
this is a Fly-side transient rather than a project-side defect.
Follow-up: capture a sanity check in the DRH-1 workflow that verifies
`machines list` shows the newly-built sha on at least one app machine
before reporting success.

## 2. Database migration results

- Migration applied: `20261025_signup_2d_operator_verification`.
- Dual-schema parity: `prisma/migrations/*/migration.sql` +
  `prisma-postgres/migrations/*/migration.sql` are symmetric.
- Shape: ONE new `CREATE TABLE "OperatorVerificationRecord"` + four
  indexes.  Zero `ALTER TABLE` statements; zero existing-column
  alterations.
- Contract-asserted by `tests/signup-2-phase-2d-schema.test.ts` on
  both schemas.
- Verified live on the deployed container: the Phase 2D service
  writes against the new table successfully during the full
  Playwright release path.

## 3. Operator UI and API coverage

### 3a UI

| Path | Audience | Gate |
|---|---|---|
| `/app/admin/signup-ops` | Operator queue list | `platform:signups:release` |
| `/app/admin/signup-ops/registration/[id]` | Per-registration review | `platform:signups:release` |

Queue states exposed (eight distinct, per founder §4):
`AWAITING_STANDING`, `AWAITING_AUTHORITY`, `CONFLICTING_EVIDENCE`,
`INSUFFICIENT_EVIDENCE`, `SUSPECTED_IMPERSONATION`,
`READY_FOR_RELEASE`, `RELEASED`, `REJECTED`.

Review page surfaces: applicant panel, Phase 2B attestation panel,
Phase 2C standing-check panel, per-concept operator-record panels
with evidence source + reference + reason + operator-id tail +
verifiedAt + expiresAt, three forms (standing / authority / release),
reject form, and a self-approval-blocked banner.

### 3b APIs

| Verb | Path | Role | Rate-limit bucket |
|---|---|---|---|
| POST | `/api/admin/signup-ops/registration/[id]/standing-verified` | SUPER_ADMIN (platform:signups:release) | `signup_operator_action` |
| POST | `/api/admin/signup-ops/registration/[id]/authority-verified` | same | same |
| POST | `/api/admin/signup-ops/registration/[id]/release` | same | same |
| POST | `/api/admin/signup-ops/registration/[id]/reject` | same | same |
| GET  | `/api/admin/signup-ops/queue` | same | — |
| GET  | `/api/admin/signup-ops/registration/[id]/verification` *(Phase 2C)* | same | — |

Every POST accepts both JSON (programmatic) and
`application/x-www-form-urlencoded` (HTML form) bodies.
Form POSTs 303-redirect to the review page with a `?result=…` flag;
JSON POSTs get JSON responses.

## 4. Separation-of-duties enforcement evidence

Enforced at the service (`src/lib/signup/operator-verification.ts`),
NOT at the API routes.  Three guards:

1. **Applicant self-approval** — `assertNotApplicant(principal, reg)`
   compares `principal.email` (authenticated session) against
   `reg.adminEmail` (server-read from the registration).  Match
   raises `ForbiddenError`.  Called from every write entry point.
2. **Standing vs authority operator** — before writing a per-concept
   record, the service reads the LATEST row of the OTHER concept
   and refuses if `otherLatest.operatorUserId === principal.id`.
3. **Three-distinct-operators at release** — the release gate reads
   both latest records and refuses if `standingOp === authorityOp`
   OR `principal.id === standingOp` OR `principal.id === authorityOp`.

Playwright-exercised against live staging v880 (flag ON) at
2026-10-26 01:56 UTC:
- A1. Standing operator signs standing → 200.
- B. Same operator attempts authority → **403**.
- A2. Authority operator (second identity) signs authority → 200.
- B2. Standing operator attempts release → **403**.
- A3. Release operator (third identity) releases → 200,
  `verificationVerdict = PASS_AUTOMATED`.
- A4. Replay release → 200, `noop = true`.

**No Microsoft tenant-ID equality check anywhere.** Contract-asserted
by `tests/signup-2-phase-2d-authz.test.ts`: `adminMicrosoftTenantId`
and `tenantId` strings do not appear in the service file.

## 5. Verification evidence and audit integrity

Each `OperatorVerificationRecord` row carries the nine founder-§3B
fields: `concept`, `finding`, `evidenceSource`, `evidenceProvenance`,
`evidenceReference` (<= 500 chars, server-enforced), `reason`
(<= 1000 chars, server-enforced), `operatorUserId`, `verifiedAt`,
`expiresAt` (STANDING defaults to `verifiedAt + 24h`; AUTHORITY has
no default expiry).

Audit emissions:
- `signup.operator.standing_verified` on every per-concept standing POST.
- `signup.operator.authority_verified` on every per-concept authority POST.
- `signup.operator.released` on every release.
- `signup.operator.rejected` on every reject.

Meta carries ONLY tails: `registrationIdTail`, `operatorUserIdTail`,
`recordIdTail`, `evidenceSource` (classification string, not content),
`reasonLength` (int only).  No raw PII, no raw operator id, no raw
evidence content.  Contract-asserted by
`tests/signup-2-phase-2d-service.test.ts`.

Evidence remains retrievable: the FK cascades on
`SignupRegistration` delete only; standalone registration-level
reads keep the full record history.  Retention policy is documented
in the plan (Phase 2H ships the retention worker; Phase 2D persists
every record indefinitely until explicit operator deletion).

## 6. Contract and Playwright test results

### 6a Contract tests (vitest; source-contract)

| Suite | Assertions | Pass |
|---|---|---|
| `tests/signup-2-phase-2d-schema.test.ts` | 24 | 24 / 24 |
| `tests/signup-2-phase-2d-service.test.ts` | 29 | 29 / 29 |
| `tests/signup-2-phase-2d-authz.test.ts` | 24 | 24 / 24 |
| `tests/signup-2-phase-2d-ui-contract.test.ts` | 20 | 20 / 20 |
| `tests/signup-2-phase-2d-no-financial-side-effects.test.ts` | 92 | 92 / 92 |
| **Phase 2D total** | **189** | **189 / 189** |

### 6b Combined SIGNUP regression

| Suite set | Pass | Total |
|---|---|---|
| SIGNUP-1 + 1F + 2A + 2B + 2C + 2D | 544 | 544 |
| Posting-guard-adjacent (phase14, auth2, coa-map-2, HR payroll) | 64 | 64 |
| **Grand total** | **608** | **608** |

Typecheck clean.  Placeholder scan clean on Phase 2D surfaces.

### 6c Playwright staging acceptance

File: `tests/e2e/signup-2-phase-2d-operator-acceptance.staging.spec.ts`.
Project: `staging-authenticated` only (chromium project skipped by
project-name guard).

Two runs against the deployed `sha-e3eed9e9d045` image:

| Run | Flag | Duration | Outcome |
|---|---|---|---|
| Baseline (flag OFF) | OFF | 1 min 7 s | 1 passed / 1 skipped — fail-closed branch (403) exercised |
| Controlled activation (flag ON) | ON | 1 min 32 s | 1 passed / 1 skipped — full three-operator release path PASS |

Scenarios covered by the ON run:
- A. Three-operator happy path to `PASS_AUTOMATED`.
- B. Same-operator (standing + authority) refusal (403).
- B2. Standing operator attempting release refusal (403).
- A4. Idempotent-replay release returns `noop:true` without re-writing.
- E. UI queue page screenshot captured at `test-results/
  signup-2-2d-E-queue.png`.

### 6d Explicit test coverage per founder §5

| Required scenario | Covered by |
|---|---|
| Successful independent verification + release | Playwright A1/A2/A3, service tests |
| Applicant self-approval rejection | Service tests (`assertNotApplicant`) + UI banner test-id |
| Same-operator standing + authority rejection | Playwright B, service tests |
| Unauthorized operator rejection | Service + authz tests (permission check + Playwright API 401/403) |
| Missing evidence | Service tests (`SIGNUP_2D_MISSING_EVIDENCE_SOURCE`, `_REFERENCE`) |
| Stale evidence | Service tests (stale `expiresAt` → `ForbiddenError`) |
| Conflicting evidence | Service tests (`CONFLICTING_EVIDENCE` → `ForbiddenError`) |
| Duplicate / concurrent release | Service tests (conditional `updateMany` guard + idempotent-replay) + Playwright A4 |
| Rejection + prohibited subsequent transitions | Service tests (`SIGNUP_2D_REGISTRATION_REJECTED`, `_AUTHORISED`) |
| Feature-flag OFF behavior | Service + Playwright baseline run (flag OFF, 403 branch) |
| Cross-tenant access prevention | No-financial-side-effects + authz tests (admin-only, super-admin gate) |
| Existing-tenant compatibility | No-financial-side-effects grep sweep (zero ClubSubscription / accessTier / Club / User writes) |
| Complete audit logging | Service tests (per-concept + release + reject audit emissions with tails-only meta) |

## 7. Feature-flag activation and restoration

| Timestamp (UTC) | Action | Flag |
|---|---|---|
| 2026-10-26 01:40:33 | DRH-1 release v880 created; stall on rollout | — |
| 2026-10-26 ~02:00 | `flyctl deploy --image sha-e3eed9e9d045` completed; machine rolled over | OFF (unset) |
| 2026-10-26 ~02:00 | Baseline Playwright PASS (fail-closed branch) | OFF |
| **2026-10-26 01:55:56** | **`flyctl secrets set SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE=1`** | **ON** |
| 2026-10-26 ~01:56 | Full Playwright acceptance PASS (release path) | ON |
| **2026-10-26 01:57:41 → 01:58:09** | **`flyctl secrets unset SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE`** | **OFF** |
| 2026-10-26 ~01:58 | Teardown probe: zero fixture residue, zero platform admins | OFF |

Flag was ON for **approximately 2 minutes 13 seconds** — exactly the
window needed to run the full three-operator Playwright acceptance.
Returned to OFF immediately after per founder §6.

The staging container's `SPECTRE_SIGNUP_2B_ATTESTATION_LIVE` and
`SPECTRE_SIGNUP_2C_VERIFICATION_LIVE` flags were NOT touched during
the Phase 2D acceptance — only Phase 2D's own flag was exercised.

## 8. Existing-tenant compatibility

- Zero `ClubSubscription` writes.
- Zero `Club.create` writes.
- Zero `User.create` writes (except the three synthetic SUPER_ADMIN
  fixtures created + destroyed inside the staging acceptance window).
- Zero `accessTier` writes anywhere.
- Zero `BillingCycle` writes.
- Phase 2B's three enforcement seams (posting-guard +
  sensitive-action + `selectEmailAdapter`) untouched.
- Legacy tenants (`accessTier IS NULL`) continue to pass the
  Phase 2B grandfather check in every seam.
- The additive migration (one new table + four indexes) applied
  cleanly without touching any existing-row data.

Grep-sweep contract test
`tests/signup-2-phase-2d-no-financial-side-effects.test.ts` applies
to every Phase 2D source file (22 files total) and asserts the full
forbidden-pattern list.

## 9. Zero Stripe and production changes

- No Stripe entity created.  Grep-sweep across all 22 Phase 2D files
  finds zero `stripe.*` or `@stripe/stripe-js` references.
- No `payment_intent`, `charge`, `mandate`, `customer`, `price`,
  `product`, `subscription`, or `setup_intent` created in Stripe.
- No tenant provisioned.
- No production deploy; DRH-1 target is `spectre-staging` only.
- No production configuration change.
- No ToS activation (Phase 2B remains dormant).
- No Phase 2C applicant-facing verification live-mode activation
  (`SPECTRE_SIGNUP_2C_VERIFICATION_LIVE` remains unset).
- No gov-ID surface anywhere; grep-sweep contract test asserts.

## 10. Known limitations and outstanding risks

### 10a Limitations

- **No retention worker.** `OperatorVerificationRecord` rows persist
  indefinitely until explicit operator deletion.  Documented
  retention policy ships in Phase 2H.
- **No bulk operations.** Operators act on one registration at a
  time.  Adequate for the pilot's small operator population.
- **No dual-approval chain yet.** Phase 2D requires three distinct
  operators but each verification is a single-signature action.  A
  future Phase 2H can split `platform:signups:release` into
  finer-grained scopes with a dual-approval chain.
- **No evidence-file upload.** The `evidenceReference` field is a
  short string (<= 500 chars) — a reference ID, URL, or case number.
  File uploads to S3 + KMS are a Phase 2H deliverable.
- **No delegation / handoff workflow.** If an operator starts a
  verification and cannot complete it, another operator must simply
  file a fresh record; no formal handoff is modelled.
- **DRH-1 pipeline stall.** The initial Phase 2D DRH-1 release
  stalled with the web machine remaining on the prior image.
  Recovered by a manual `flyctl deploy --image` from this session.
  Follow-up: add a post-deploy machine-image-tag assertion to the
  GitHub Actions workflow.

### 10b Residual risks

- A rogue SUPER_ADMIN could in principle sign all three verifications
  across multiple sessions — but each would require a DIFFERENT
  authenticated user id to satisfy the three-distinct-operators
  rule.  A single compromised user id cannot forge the chain.
- The applicant could in principle be a SUPER_ADMIN (currently
  impossible — zero platform admins on staging today — but worth
  noting for future production rollout).  The service's email-equality
  check short-circuits this; contract-asserted.
- Operator authority currently is granted globally (clubId null) via
  `platform:signups:release`.  No tenant isolation applies because
  Phase 2D is pre-tenancy.  Not a defect but something to note when
  Phase 2G later provisions Club shells.

## 11. Recommendation for founder acceptance

**Recommended for founder acceptance.**

Phase 2D delivers the authorised scope with every amendment honoured
verbatim:
- Four verification concepts separated.
- Three-distinct-operator rule enforced strictly (no exception policy
  proposed).
- Nine evidence fields captured on every record.
- 500 / 1000 character caps enforced server-side.
- Fail-closed feature flag; controlled staging activation performed
  (ON 2 min 13 s → full Playwright PASS → OFF immediately after).
- `platform:signups:release` granted to SUPER_ADMIN only at launch.
- Zero gov-ID surface anywhere.
- Zero existing-tenant impact; zero Stripe entities; zero tenant
  provisioning; Phase 2B + Phase 2C live-mode flags untouched.
- 189 new contract-test assertions, 544 combined SIGNUP regression,
  608 total regression (incl. posting-guard adjacent) all green.
- Baseline + controlled-activation Playwright passes against the
  deployed staging image.

**Phase 2E remains unauthorized.**  Phase 2D is the standalone
operator-release layer bridging Phase 2C's HOLD_FOR_REVIEW state and
Phase 2E's eventual mandate collection.  When Phase 2E planning
begins, it will build against a real production-reachable
`AUTHORISED` state.
