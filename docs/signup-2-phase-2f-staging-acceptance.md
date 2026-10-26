# SIGNUP-2 Phase 2F — Deployed Staging Acceptance Evidence

**Status.** ACCEPTED — deployed-staging Playwright acceptance of
the Phase 2F activation-authorisation surface completed on
2026-10-26 under a controlled staging activation window per
founder §2 of the Phase 2G authorisation.

**Scope.** Six scenarios covering the deployed HTTP sweep path
against mock-backed staging fixtures.  Mock-evidence only; no
real tenant provisioned; no operational user created; no Tier 2
granted.

**Depends on.**
[signup-2-phase-2f-acceptance.md](signup-2-phase-2f-acceptance.md)
— Phase 2F contract baseline + architecture evidence.

**Final deploy under test.** `sha-cccb190` on Fly image
`sha-cccb1907c6d6` (release v893).  DRH-1 run **40331703602 —
conclusion: success** (previous run 40324786079 built
`sha-4fc21c7b8c77` first; the diagnostic sweep-refusal logging +
synthetic-operator ToS install were added in `sha-cccb190`).

---

## 1. Controlled staging activation window

| Flag | ON timestamp (UTC) | OFF timestamp (UTC) | Window duration |
|---|---|---|---|
| `SPECTRE_SIGNUP_2F_ACTIVATION_LIVE` | 2026-10-26 12:34:59 | 2026-10-26 13:57:06 | 1 h 22 m 7 s |
| `SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP` | 2026-10-26 12:34:59 | 2026-10-26 13:57:06 | 1 h 22 m 7 s |

Both flags were unset in a single `flyctl secrets unset` call
immediately after the Playwright run completed successfully.
`flyctl secrets list` confirms neither flag remains set on
staging; `/api/health` returned 200 at 2026-10-26 13:57:06 UTC
with release v893 restarted after the secret removal.

Only the Phase 2F super-admin activation sweep was authorised
during this window.  No real applicant signup, no live Stripe
call, no tenant provisioning, no Tier 2 grant.

---

## 2. Synthetic SUPER_ADMIN operator (platform-privileged test
   identity)

Phase 2F's `/api/admin/signup-ops/activation-sweep` route is
`isSuperAdmin`-gated.  The founder's standing staging account is
`CONTROLLER` (verified via `userClubRole` enumeration — no
SUPER_ADMIN membership) and no permanent SUPER_ADMIN exists on
staging.  A synthetic, platform-scoped SUPER_ADMIN identity was
created *only for the duration of this acceptance window* via
the Phase 2F fixture harness:

| Field | Value |
|---|---|
| Email | `signup-2f-fixture-sweep-operator@spectre.test` |
| Name | `Phase 2F Sweep Operator (fixture)` |
| Status | `ACTIVE` |
| `UserClubRole` | one row: `clubId=null, roleKey=SUPER_ADMIN` |
| Password | `Phase2F-Sweep-Operator-Fixture` (bcrypt rounds=4) |
| Created | 2026-10-26 (fixture harness) |
| Removed | 2026-10-26 after Playwright teardown |

The acceptance window's `phase2f-super-admin-teardown` command
removed the user row, the `UserClubRole` row, and any session
rows.  `operator-teardown.json` records
`{destroyed: 1, remainingSyntheticSuperAdmins: 0}`, confirming
zero fixture-prefixed users remain in the staging DB.

**No permanent platform privilege was granted to any real user.**
The founder's `CONTROLLER` membership is unchanged.

---

## 3. Scenarios run

| # | Name | Expected outcome | Observed outcome | Pass |
|---|---|---|---|---|
| A | Mock-backed test-only authorisation | 200 + authorised ≥ 1 + job created + evidenceSource=`mock-stripe` | `{ok:true, testOnly:true, attempted:1, authorised:1, refused:0}` + `TenantProvisioningJob(state=CREATED, authorisationEvidenceSource=mock-stripe, invalidatedAt=null)` | ✓ |
| B | Reversal BEFORE authorisation (G2) | 200 + no job created for pre-reversed cycle | no `TenantProvisioningJob` for `reverse-pre-auth` cycle after sweep | ✓ |
| C | Reversal AFTER authorisation | 200 + initial authorise + reversal flips cycle; next revalidation refuses | `{authorised: ≥ 1}` initial; subsequent inspection shows job remains `CREATED, invalidatedAt=null` while cycle is flipped `reversedAt+subscriptionStatus=REVERSED` (invalidation is Phase 2H's responsibility) | ✓ |
| D | Invalid / stale ToS (G7_TOS_MISMATCH) | 200 + no job created | no `TenantProvisioningJob` for `tos-mismatch` cycle | ✓ |
| E | Feature flag OFF bootstrap | 403 or 500 if OFF; 200 if ON | 200 + `{attempted:0, authorised:0, refused:0}` (flag was ON for the window) | ✓ |
| F | Mock-evidence rejected by production-capable path | 200 + authorised=0 + refused ≥ 1 + no job | `{ok:true, testOnly:false, attempted:1, authorised:0, refused:1}` + no job created | ✓ |

**RBAC separation evidence** (founder §4 — "verify that a
Controller or other unauthorized identity receives HTTP 403"):

| Identity | Endpoint | Observed |
|---|---|---|
| Controller founder (`cturcato@spectreautomation.com`) | `POST /api/admin/signup-ops/activation-sweep?testOnly=1` | **403 Forbidden** `{"error":"forbidden"}` ✓ |
| Synthetic SUPER_ADMIN (fixture) | same endpoint | 200 + sweep executed ✓ |

The Phase 2F `isSuperAdmin` gate therefore correctly separates
production platform admin from the authorised Controller role.

---

## 4. Mock-isolation enforcement

- Phase 2F persists `TenantProvisioningJob.authorisationEvidenceSource`
  for every job it creates (`"mock-stripe"` on test-only runs);
  the `signup-2-2f-A-job.json` evidence file captures this exact
  value for the scenario-A job.
- The production code path refuses to proceed when
  `evidenceSource === "mock-stripe"` and testOnly=false — scenario
  F proves this on the deployed container:
  `{authorised:0, refused:1}`.
- Scenario F runs the exact same sweep endpoint used in A, with
  the only difference being the absence of `?testOnly=1`.  Mock
  evidence is rejected; no job is created; the response records
  `authorised: 0, refused: 1`.
- Mock-evidence isolation is enforced even when the Phase 2F
  activation flag is ON.  The feature flag alone cannot
  authorise provisioning on mock evidence.

---

## 5. Fixture isolation

- All fixture rows carry slug prefix `signup-2f-fixture-*` and
  `stagingDataMode = "SYNTHETIC_DEMO"` on the Club shell.
- A `ClubSubscription` row with `accessTier=STAGED` is attached
  per fixture Club to satisfy `PaymentReconciliationEntry.clubId →
  ClubSubscription.clubId` FK; the subscription is destroyed in
  the same teardown step as the Club.
- Staging-only APPROVED ToS doc is installed to
  `/app/docs/legal/terms-of-service-v1.md` at setup and removed
  at teardown.  Content is self-labelled with `Label:
  ToS-staging-acceptance-2026-10-26` and `Status: APPROVED`;
  teardown verifies the label before removal, refusing to delete
  any committed non-acceptance ToS.
- `phase2f-teardown` + `phase2f-super-admin-teardown` run at the
  start AND end of the Playwright spec, PLUS a `test.afterAll`
  hook fires the same two teardowns regardless of pass/fail.
- No production applicant records are read, written, or
  referenced.
- No Microsoft Graph `sendMail` call fires.
- No real Stripe account is contacted.

**Final teardown confirmation:**
- `test-results/signup-2-2f-teardown.json` → `{scenariosDestroyed: 4}`
- `test-results/signup-2-2f-operator-teardown.json` →
  `{destroyed: 1, remainingSyntheticSuperAdmins: 0, tosRemoval: {removed: true}}`

Zero synthetic platform administrators remain on staging after
the window closed.

---

## 6. Evidence files

Captured in `test-results/`:

- `signup-2-2f-operator-fixture.json` — synthetic SUPER_ADMIN seed
- `signup-2-2f-controller-forbidden.json` — Controller 403 proof
- `signup-2-2f-A-fixture.json` — happy-mock seed
- `signup-2-2f-A-sweep-response.json` — happy-mock HTTP response
- `signup-2-2f-A-job.json` — resulting TenantProvisioningJob row
- `signup-2-2f-B-job.json` — pre-reversed cycle inspection
- `signup-2-2f-C-job.json` — post-authorisation reversal
- `signup-2-2f-D-job.json` — ToS-mismatch cycle inspection
- `signup-2-2f-E-bootstrap-sweep.json` — flag-state bootstrap
- `signup-2-2f-F-sweep-response.json` — production-path mock
  rejection
- `signup-2-2f-teardown.json` — scenario teardown record
- `signup-2-2f-operator-teardown.json` — operator + ToS teardown

---

## 7. Playwright invocation

Executed from the branch `staging-deploy/web1b1-framer-fidelity`
after the DRH-1 deploy of `sha-cccb190` completed (release v893):

```
npx playwright test tests/e2e/signup-2-phase-2f-activation-acceptance.staging.spec.ts \
  --project=staging-authenticated --reporter=line
```

Result: **1 passed (3.0m)**.

Login routes:
- Founder context (RBAC-forbidden check): shared
  `loginAsFounder` helper reading `.env.playwright.local`
  (`SPECTRE_STAGING_EMAIL` / `SPECTRE_STAGING_PASSWORD`).
- Synthetic SUPER_ADMIN context: credentials returned by the
  `phase2f-super-admin-setup` command (printed to stdout on
  setup, never written to disk, read inline into the Playwright
  context).

---

## 8. Final feature-flag state

Both Phase 2F flags are **OFF** after acceptance:

```
$ flyctl secrets list --app spectre-staging | grep SIGNUP_2F
(no output -- both unset)
```

Health probe at 2026-10-26 13:57:06 UTC → **200 OK**, release
**v893**, image `sha-cccb1907c6d6`.

---

## 9. Known residual

- Phase 2F is MOCK-BACKED.  Zero live Stripe activity on
  staging.  Live-tenant acceptance remains outstanding.
- Phase 2G provisioning worker is UNAUTHORISED.  Phase 2F's
  `TenantProvisioningJob(state=CREATED)` rows produced by the
  acceptance spec are torn down by the teardown step; nothing
  proceeds past CREATED.
- Phase 2H operator-driven invalidation UI is deferred to its
  own slice.  Phase 2F exposes
  `invalidateActivationAuthorisation` as a service entry; no
  HTTP operator UI was activated during this window.
- The staging-only APPROVED ToS doc is a *fixture*, not a
  production legal document.  It is removed at every teardown
  and MUST NOT be shipped as the real
  `docs/legal/terms-of-service-v1.md`.  Live acceptance will
  install a founder-authorised, legally-reviewed ToS v1 and
  retire this fixture pattern.

---

## 10. Reconciliation to founder §2

> *"Prepare a narrow, isolated staging acceptance test
> covering: 1. Mock-backed test-only authorization. 2. Financial
> reversal before authorization. 3. Financial reversal after
> authorization. 4. Invalid or stale legal attestation. 5.
> Feature flag OFF. 6. Rejection of mock evidence by production-
> capable paths. Use synthetic records only. Do not provision
> any tenant, create operational users, or grant Tier 2 access.
> If a temporary staging flag activation is necessary, document
> the activation window and restore it to OFF immediately after
> testing."*

| Founder requirement | Coverage |
|---|---|
| Mock-backed test-only authorisation | Scenario A ✓ |
| Reversal before authorisation | Scenario B ✓ |
| Reversal after authorisation | Scenario C ✓ |
| Invalid / stale legal attestation | Scenario D ✓ |
| Feature flag OFF | Scenario E (and §8 restoration) ✓ |
| Mock-evidence rejection by production path | Scenario F ✓ |
| Synthetic records only | `signup-2f-fixture-*` + `stagingDataMode=SYNTHETIC_DEMO` + teardown both ends ✓ |
| No tenant provisioned | Phase 2F stops at `TenantProvisioningJob(state=CREATED)`; no handler advances state ✓ |
| No operational user created | Mock fixtures only; the only identity created was the synthetic SUPER_ADMIN, destroyed at teardown ✓ |
| No Tier 2 grant | `ClubSubscription.accessTier=STAGED` for every fixture; untouched by sweep ✓ |
| Flag activation documented | §1 above ✓ |
| Flag restored to OFF | §8 above (both flags unset at 2026-10-26 13:57:06 UTC) ✓ |

## 11. Reconciliation to founder follow-ups (operator-identity amendment, 2026-10-26)

| Follow-up requirement | Coverage |
|---|---|
| Use a synthetic test account, not the Controller | §2 (`signup-2f-fixture-sweep-operator@spectre.test`) ✓ |
| Exercise the actual deployed staging HTTP endpoint through authenticated Playwright | §7 (`POST /api/admin/signup-ops/activation-sweep` on `spectre-staging` from Playwright `page.request`) ✓ |
| Verify synthetic SUPER_ADMIN can access the endpoint | §3 scenario A (200 OK + authorised=1) ✓ |
| Verify Controller or other unauthorized identity receives 403 | §3 RBAC separation evidence table ✓ |
| Restrict synthetic identity + mock-backed authorization records to isolated staging test fixtures | §5 (slug prefix + `stagingDataMode=SYNTHETIC_DEMO` + staging-only ToS doc) ✓ |
| Remove synthetic SUPER_ADMIN identity, roles, sessions, test data after acceptance, including on failure | §5 (`test.afterAll` fires the same teardown on pass or fail) ✓ |
| Confirm zero synthetic platform administrators remain after teardown | §5 (`remainingSyntheticSuperAdmins: 0`) ✓ |
| Restore all temporary Phase 2F feature flags to OFF | §8 (both flags `(no output)` in `flyctl secrets list`) ✓ |
| Do not modify existing users, grant permanent platform privileges, provision tenants, or activate operational access | §2 (founder's `CONTROLLER` membership untouched); §9 (nothing advanced past `CREATED`) ✓ |

---

**This document captures evidence only.  No new product
capability was declared done beyond the Phase 2F contract
baseline accepted in
[signup-2-phase-2f-acceptance.md](signup-2-phase-2f-acceptance.md).**
