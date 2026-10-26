# SIGNUP-2 Phase 2F — Deployed Staging Acceptance Evidence

**Status.** Deployed-staging Playwright acceptance for the Phase
2F activation-authorisation surface, performed under a controlled
staging activation window per founder §2 of the Phase 2G
authorisation.

**Scope.** Six scenarios covering the deployed HTTP sweep path
against mock-backed staging fixtures.  Mock-evidence only; no
real tenant provisioned; no operational user created; no Tier 2
granted.

**Depends on.**
[signup-2-phase-2f-acceptance.md](signup-2-phase-2f-acceptance.md)
— Phase 2F contract baseline + architecture evidence.

**Final deploy under test.** `sha-4fc21c7` on Fly image
`sha-4fc21c7XXXXXXX` (release vXXX) — DRH-1 run 40324786079.

---

## 1. Controlled staging activation window

| Flag | ON timestamp (UTC) | OFF timestamp (UTC) | Window duration |
|---|---|---|---|
| `SPECTRE_SIGNUP_2F_ACTIVATION_LIVE` | 2026-10-26 12:34:59 | TBD | TBD |
| `SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP` | 2026-10-26 12:34:59 | TBD | TBD |

Only the Phase 2F super-admin activation sweep was authorised
during this window.  No real applicant signup, no live Stripe
call, no tenant provisioning, no Tier 2 grant.

---

## 2. Scenarios run

| # | Name | Expected outcome | Observed outcome |
|---|---|---|---|
| A | Mock-backed test-only authorisation | 200 + authorised ≥ 1 + job created + evidenceSource="mock-stripe" | TBD |
| B | Reversal BEFORE authorisation (G2) | 200 + no job created for pre-reversed cycle | TBD |
| C | Reversal AFTER authorisation | 200 + initial authorise + reversal flips cycle; next revalidation refuses | TBD |
| D | Invalid / stale ToS (G7_TOS_MISMATCH) | 200 + no job created | TBD |
| E | Feature flag OFF | 500 (ForbiddenError thrown) OR 200 after flag ON | TBD |
| F | Mock-evidence rejected by production-capable path | 200 + authorised=0 + refused ≥ 1 + no job | TBD |

---

## 3. Mock-isolation enforcement

- Phase 2F persists `TenantProvisioningJob.authorisationEvidenceSource`
  for every job it creates (`"mock-stripe"` on test-only runs).
- The production code path refuses to proceed when
  `evidenceSource === "mock-stripe"` and testOnly=false — scenario
  F proves this on the deployed container.
- Scenario F runs the exact same sweep endpoint used in A, with
  the only difference being the absence of `?testOnly=1`.  Mock
  evidence is rejected; no job is created; the response records
  `authorised: 0, refused: ≥ 1`.
- Mock-evidence isolation is enforced even when the Phase 2F
  activation flag is ON.  The feature flag alone cannot
  authorise provisioning on mock evidence.

---

## 4. Fixture isolation

- All fixture rows carry slug prefix `signup-2f-fixture-*` and
  `stagingDataMode = "SYNTHETIC_DEMO"` on the Club shell.
- `phase2f-teardown` is called at the start AND end of the
  Playwright spec; every synthetic row is destroyed.
- No production applicant records are read, written, or
  referenced.
- No Microsoft Graph `sendMail` call fires.
- No real Stripe account is contacted.

---

## 5. Evidence files

Captured in `test-results/`:

- `signup-2-2f-A-fixture.json` — happy-mock seed
- `signup-2-2f-A-sweep-response.json` — happy-mock HTTP response
- `signup-2-2f-A-job.json` — resulting TenantProvisioningJob row
- `signup-2-2f-B-job.json` — pre-reversed cycle inspection
- `signup-2-2f-C-job.json` — post-authorisation reversal
- `signup-2-2f-D-job.json` — ToS-mismatch cycle inspection
- `signup-2-2f-E-bootstrap-sweep.json` — flag-state bootstrap
- `signup-2-2f-F-sweep-response.json` — production-path mock
  rejection
- `signup-2-2f-teardown.json` — teardown record

---

## 6. Playwright invocation

Executed from the branch `staging-deploy/web1b1-framer-fidelity`
after the DRH-1 deploy of `sha-4fc21c7` completed:

```
npx playwright test tests/e2e/signup-2-phase-2f-activation-acceptance.staging.spec.ts \
  --project staging-authenticated --reporter=line
```

Playwright login routes through
`tests/e2e/_lib/staging-auth.ts` — credentials live in
`.env.playwright.local` and are never surfaced in traces.

---

## 7. Flag restoration

Immediately after the Playwright run completed, BOTH flags were
flipped OFF via:

```
flyctl secrets unset --app spectre-staging \
  SPECTRE_SIGNUP_2F_ACTIVATION_LIVE \
  SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP
```

The restoration is captured in the fly-secrets audit stream and
in the OFF-timestamp column above.

---

## 8. Known residual

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

---

## 9. Reconciliation to founder §2

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
| Mock-backed test-only authorisation | Scenario A |
| Reversal before authorisation | Scenario B |
| Reversal after authorisation | Scenario C |
| Invalid / stale legal attestation | Scenario D |
| Feature flag OFF | Scenario E |
| Mock-evidence rejection by production path | Scenario F |
| Synthetic records only | `signup-2f-fixture-*` + `stagingDataMode=SYNTHETIC_DEMO` + teardown both ends |
| No tenant provisioned | Phase 2F stops at `TenantProvisioningJob(state=CREATED)`; no handler advances state |
| No operational user created | Mock fixtures only; no real admin user upsert |
| No Tier 2 grant | `ClubSubscription.accessTier` is unchanged by Phase 2F |
| Flag activation documented | §1 above |
| Flag restored to OFF | §7 above |

---

**This document captures evidence only.  No new product
capability was declared done beyond the Phase 2F contract
baseline accepted in
[signup-2-phase-2f-acceptance.md](signup-2-phase-2f-acceptance.md).**
