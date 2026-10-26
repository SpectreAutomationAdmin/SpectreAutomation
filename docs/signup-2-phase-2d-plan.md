# SIGNUP-2 Phase 2D — Implementation Authorisation Package (DRAFT)

**Status.** PLANNING ONLY, pending founder authorisation.  No
application code; no Prisma migration; no Stripe entity; no
production configuration; no tenant provisioning; no live
attestation; no activation of Phase 2E.

**Supersedes.** None (Phase 2D first draft).
**Depends on.**
- SIGNUP-2 Architecture Decision Document v3 (`sha-07db40b`).
- SIGNUP-2 Phase 2A accepted baseline `sha-c3e337e / v870`.
- SIGNUP-2 Phase 2B accepted baseline `sha-9c717e1 / v875`.
- SIGNUP-2 Phase 2C accepted baseline `sha-adfe13c / v877`.
- SIGNUP-1G locked baseline (sha-270d9d4 / v865 + repair at v875).
- Commercial-authority verification requirements v2
  ([docs/signup-2-commercial-authority-verification.md](signup-2-commercial-authority-verification.md)).

**Confirmed on filing this document:**
- No production state has changed.
- No new Stripe entity exists.
- No DB migration has been applied.
- No existing-tenant `accessTier` has been written.
- Phase 2B remains dormant.
- Phase 2C baseline is preserved (sha-adfe13c / v877).

---

## 0. Why Phase 2D exists — the sequencing problem

The v3 architecture names Phases 2A, 2B, 2C, 2E, 2F, 2G, 2H, 2I.
It does NOT name a Phase 2D explicitly.  The founder's Phase 2D
authorisation email (§2) identifies the gap directly:

> *"Phase 2C routes real registrations to manual review because
> authoritative registry integrations are not yet available.  The
> full operator verification workflow is currently scheduled for
> Phase 2H.  Before proceeding toward payment integration,
> evaluate whether a minimal secure manual-verification approval
> capability should be implemented earlier.  The objective is to
> avoid building payment onboarding around a registration state
> that no real applicant can reach."*

The sequencing problem is concrete:

- Phase 2C ships only manual-review stubs for every CA jurisdiction.
  Every real applicant on staging routes to
  `HOLD_FOR_REVIEW:ENTITY_VERIFICATION`.
- The `AUTHORISED` state is the input to Phase 2E (mandate
  collection) + Phase 2G (tenant provisioning).
- Without an operator release path, `AUTHORISED` is unreachable.
- Phase 2E design, build, and acceptance test cannot proceed
  against a state no real applicant can reach without resorting to
  database fixtures that bypass real controls.

**Phase 2D is therefore scoped as:** the smallest secure operator
capability that lets SpectreAdmin independently verify
organisation standing + signing authority, record evidence
references + decisions + reasons, and transition a
`HOLD_FOR_REVIEW` registration to `AUTHORISED` (or `REJECTED`).
Phase 2H will later ship the full operator surface (rich filters,
bulk operations, delegation flows, retention worker).  Phase 2D
ships only what's needed to unblock Phase 2E realistically.

---

## 1. Phase 2D objectives and boundaries

### 1a Objectives

1. Make `AUTHORISED` reachable in production via a
   **human-authored release path** — not via a registry-adapter
   bypass, not via a classifier override, not via a feature-flag
   flip.
2. Record every operator decision as independently auditable
   evidence of both (a) organisation standing and (b) signing
   authority.
3. Preserve every Phase 2C invariant: no gov-ID collection, no
   payment side effects, no tenant provisioning, no existing-
   tenant access change.
4. Give Phase 2E a real input: the `AUTHORISED` state becomes a
   production-reachable state, with proven provenance.

### 1b In-scope for Phase 2D

- Minimal operator queue surface at
  `/app/admin/signup-ops` — one list page showing every
  registration whose `verificationVerdict = HOLD_FOR_REVIEW`,
  sorted oldest-first.
- Minimal operator review surface at
  `/app/admin/signup-ops/registration/[id]` — read-only summary
  of classifier, attestation, standing check, and the per-concept
  evidence form (one text input + one evidence-reference URL
  per verification concept, plus the operator's final decision
  + reason).
- API routes:
  - `POST /api/admin/signup-ops/registration/[id]/standing-verified`
    — operator records that organisation standing has been
    independently verified; attaches an evidence reference
    (free-form text; a Certificate-of-Status filename, a
    registry URL, or a case id) and a short note.
  - `POST /api/admin/signup-ops/registration/[id]/authority-verified`
    — operator records that signing authority has been
    independently corroborated; attaches an evidence reference
    (delegation letter filename, board minutes citation, officer
    list match reference) and a short note.
  - `POST /api/admin/signup-ops/registration/[id]/release`
    — final AUTHORISED transition; requires BOTH prior
    verifications on record + a reason string.
  - `POST /api/admin/signup-ops/registration/[id]/reject`
    — final REJECT transition; requires a reason string;
    transitions `status = ABANDONED`.
- New model `OperatorVerificationRecord` persisting each
  per-concept verification (standing / authority) + the final
  release/reject outcome.  Immutable append-only; no mutation
  path.
- Augmentation of the Phase 2C `verificationHoldCategory` state
  machine with explicit transitions `HOLD_FOR_REVIEW →
  AUTHORISED` and `HOLD_FOR_REVIEW → REJECT`.
- Audit emissions for every operator action with tails + evidence
  reference hashes (never raw evidence content).
- Fail-closed feature flag
  `SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE` (default OFF).
  Flag OFF means operator POST routes return 503 with a
  structured "disabled" error.
- Narrow Playwright acceptance covering a full operator release
  + a reject + an unauthorised-operator refusal.

### 1c Out-of-scope for Phase 2D (deferred by phase)

| Area | Deferred to | Why |
|---|---|---|
| Full operator inbox UI (filtering, search, saved views) | Phase 2H | Phase 2D ships "one list, one review page" only. |
| Bulk operations (bulk release, bulk reject) | Phase 2H | Operator population at launch is small; one-at-a-time is safe. |
| Delegation / multi-operator approval flows | Phase 2H | Phase 2D requires one operator; dual-approval is a later control. |
| Retention worker for `EntityStandingCheck` payload redactions | Phase 2H | Documented policy only. |
| Live registry adapters (CA-ON licensee, CA-BC procurement) | Separate per-jurisdiction authorisation | Procurement work is independent of 2D. |
| Operator-override of the classifier itself | Phase 2H | Phase 2D releases on signing-authority evidence; classifier value is preserved as read. |
| Evidence-file upload storage (S3 + KMS) | Phase 2H | Phase 2D stores evidence REFERENCES (short strings), not files. |
| Gov-ID collection | NEVER without separate founder decision | Preserved from Phase 2C §8. |

### 1d Hard non-authorisations

- No Stripe entity.
- No payment call.
- No tenant provisioning.
- No `ClubSubscription` write.
- No `accessTier` write to any existing tenant.
- No production configuration change.
- No activation of Phase 2B live-mode.
- No activation of Phase 2C live state surface.
- No initiation of Phase 2E.
- No gov-ID collection, retention, or path.

---

## 2. Dependencies on Phases 2A–2C

### 2a Reads from Phase 2A

- `SubscriptionAuthorisationAttestation` — read-only reference
  (Phase 2B's write; Phase 2D displays metadata for operator
  review).
- `EntityStandingCheck` — read-only reference (Phase 2C's write;
  Phase 2D displays the classification without the raw payload).
- `SignupRegistration` — read + mutate the `verificationVerdict` /
  `verificationDecidedAt` / `verificationDeciderUserId` /
  `verificationHoldCategory` columns (added by Phase 2C's
  additive migration).

### 2b Writes

- New table `OperatorVerificationRecord` (see §4).
- Column updates on `SignupRegistration` — no new columns.

### 2c Guarantees relied upon

- Phase 2C's grandfather semantics in `assertAccessTierForPosting`:
  Phase 2D never touches `ClubSubscription`, so legacy tenants
  are unaffected.
- Phase 2B's immutable attestation record: Phase 2D references its
  content but never mutates it.
- SIGNUP-1G recovery link mechanics: Phase 2D does not alter the
  applicant-facing recovery path.

### 2d Preserved founder decisions

- Four-concept separation (Phase 2C §2 amendment) is honoured:
  Phase 2D's two POST routes write the standing and the signing-
  authority verifications on SEPARATE records.  Release requires
  BOTH to be present.
- No gov-ID.
- No applicant self-approval.
- Operator overrides require documented reason + operator identity
  + timestamp + immutable audit record.

---

## 3. Proposed user experience and workflow

### 3a Operator (SpectreAdmin) workflow

1. SpectreAdmin opens `/app/admin/signup-ops`.
2. The list page shows up to 50 oldest `HOLD_FOR_REVIEW`
   registrations with: legal name, jurisdiction, created-at date,
   hold category.  Fifty is the pilot limit; Phase 2H adds
   pagination.
3. SpectreAdmin clicks one row → review page at
   `/app/admin/signup-ops/registration/[id]`.
4. Review page shows the three verification artefacts (classifier,
   attestation metadata, standing-check summary) — the same data
   the Phase 2C super-admin diagnostic endpoint returns, surfaced
   as a reviewable screen.
5. The page has two per-concept forms:
   - **Organisation standing** — the operator enters an evidence
     reference string (e.g., `AB-CORES-cert-of-status-2026-10-26`,
     `BC-registry-case-#12345`, `signed-pdf-url` under 500 chars)
     and a short note.  Submits via POST → the API persists one
     `OperatorVerificationRecord` row with `concept = STANDING`.
   - **Signing authority** — same shape, `concept = AUTHORITY`,
     with the operator attesting that they independently
     corroborated authority (delegation letter, officer list,
     Board confirmation).
6. Once BOTH records exist, the "Release to AUTHORISED" button
   enables.  Operator clicks → final POST with a reason string
   (e.g., "Both verifications corroborated; release.") → the
   registration flips to `AUTHORISED`.
7. Alternative: at any stage, "Reject" is available.  Operator
   enters a reason string → `POST /reject` → registration
   `verificationVerdict = REJECT`, `status = ABANDONED`.

### 3b Applicant workflow

Phase 2D does not change the applicant's visible flow.  The
Phase 2C verification state surface remains gated by its own
feature flag.  When `SPECTRE_SIGNUP_2C_VERIFICATION_LIVE === "1"`
AND a verdict exists, the applicant sees the appropriate state.
If the operator has released the registration to AUTHORISED, the
applicant sees the "Verification complete; next step prepared"
copy (identical to the Phase 2C PASS_AUTOMATED copy — the
applicant need not distinguish between an automated pass and an
operator release).

### 3c Prerequisite acceptance test for Phase 2E

Phase 2E's acceptance tests MUST exercise a full
Phase 2D operator-released `AUTHORISED` state.  No Phase 2E test
should write directly to the `verificationVerdict` column; the
only legitimate production path to `AUTHORISED` is through the
Phase 2D operator release route.

---

## 4. Required services, APIs, and database changes

### 4a New service modules (planned paths)

- `src/lib/signup/operator-verification.ts` — the service writer
  for `OperatorVerificationRecord` rows + the state-machine
  transitions.  Pure in → single `prisma.$transaction` out.
- `src/lib/signup/operator-verification-authz.ts` — the
  authorisation helper: resolves the operator principal, checks
  the operator permission scope (see §5), and refuses self-
  approval + unauthorised operator overrides.

### 4b New API routes (planned paths)

- `POST /api/admin/signup-ops/registration/[id]/standing-verified`
- `POST /api/admin/signup-ops/registration/[id]/authority-verified`
- `POST /api/admin/signup-ops/registration/[id]/release`
- `POST /api/admin/signup-ops/registration/[id]/reject`
- `GET  /api/admin/signup-ops/queue` — returns the first 50
  oldest HOLD_FOR_REVIEW registrations.
- `GET  /api/admin/signup-ops/registration/[id]` — the merged
  diagnostic + verification-records read endpoint.  Super-admin
  gated.

### 4c New UI routes (planned paths)

- `/app/admin/signup-ops` — the list surface.
- `/app/admin/signup-ops/registration/[id]` — the review surface.

### 4d Prisma schema addition (one new model)

```prisma
model OperatorVerificationRecord {
  id                    String   @id @default(cuid())
  signupRegistrationId  String
  signupRegistration    SignupRegistration @relation(fields: [signupRegistrationId], references: [id], onDelete: Cascade)
  // "STANDING" | "AUTHORITY" | "RELEASE" | "REJECT"
  concept               String
  outcome               String   // "VERIFIED" (per-concept) or "AUTHORISED" / "REJECTED" (final)
  evidenceReference     String?  // short free-form string -- NEVER a file blob; NEVER PII
  reason                String?  // operator-written rationale
  operatorUserId        String
  operatorIp            String?
  operatorUserAgent     String?
  createdAt             DateTime @default(now())

  @@index([signupRegistrationId, createdAt])
  @@index([operatorUserId, createdAt])
  @@index([concept, createdAt])
}
```

Phase 2D's additive migration adds this one model.  No existing
column is altered.  The migration is dual-schema (SQLite + Postgres),
matching the Phase 2A pattern.

The `SignupRegistration.verificationDeciderUserId` column (added
by the Phase 2C migration) is finally USED in Phase 2D — the
release / reject routes populate it with the operator's user id.

### 4e Access-tier posture

Phase 2D is entirely pre-tenant.  No Club shell exists for a
`HOLD_FOR_REVIEW` registration.  Phase 2D therefore DOES NOT
interact with `assertAccessTierForPosting` or
`assertAccessTierForClubEmail` in any way.  The posting-guard +
email-adapter seams established by Phase 2B remain untouched.

---

## 5. Security and financial controls

### 5a Operator authorisation

A new permission scope is introduced:
`platform:signups:release`.  Semantics:

- Grants write access to the Phase 2D operator surface (standing-
  verified, authority-verified, release, reject).
- Granted ONLY to the `SUPER_ADMIN` role at Phase 2D launch
  (operator population is Spectre's own founder + staff).
- Phase 2H can later split this into finer-grained scopes
  (`platform:signups:verify-standing`,
  `platform:signups:verify-authority`, `platform:signups:release`,
  `platform:signups:reject`) with a dual-approval chain.  Phase
  2D keeps a single scope for simplicity.
- The read-only diagnostic from Phase 2C continues to use the
  super-admin equivalent and remains available at the GET
  endpoints.

### 5b Self-approval protection

The operator's user id is read from the authenticated session.
The registration's `adminMicrosoftOid` is server-read from the
DB.  Phase 2D's authorisation helper asserts:

- The operator user id MUST NOT be the applicant.  Direct check:
  if `operator.email === registration.adminEmail`, 403.
- The operator user id MUST NOT be a user whose Microsoft tenant
  id matches the registration's `adminMicrosoftTenantId`.  This
  prevents an admin at the applicant's own Club from approving
  their own Club's registration.
- An operator cannot sign both the standing-verification and the
  authority-verification for the same registration — contract
  test asserts that `operatorUserId` on the STANDING record
  differs from `operatorUserId` on the AUTHORITY record.  Future
  Phase 2H can relax this (small operator populations) via a
  dedicated founder decision; Phase 2D keeps the strict rule.

### 5c Idempotency + replay protection

- `POST /release` and `POST /reject` are idempotent: a second
  POST on an already-AUTHORISED or already-REJECTED registration
  returns a no-op response with the existing record metadata.
  The transition is single-shot via a conditional `updateMany`.
- `POST /standing-verified` and `POST /authority-verified` allow
  updating the latest record per concept (operator may need to
  correct a note or evidence reference).  Each new POST appends
  a new `OperatorVerificationRecord`; the latest row per concept
  is what the release / reject gate reads.  Immutable history
  survives.

### 5d Audit emissions

Every POST writes an `audit()` row with:

- `action = signup.operator.standing_verified` /
  `signup.operator.authority_verified` /
  `signup.operator.released` / `signup.operator.rejected`.
- `entityType = SignupRegistration`.
- `entityId = registration.id`.
- `meta` carries: `registrationIdTail`, `operatorUserIdTail`,
  `evidenceReferenceHashTail` (SHA-256 of the operator's evidence
  string, trimmed to 10 chars), `reasonLength` (int only, not the
  reason text).

### 5e Rate limiting

- Per-operator rate limit on all four POST routes
  (`signup_operator_action` bucket, Phase 2D-added AuthScope),
  conservatively set via a new env knob
  `SIGNUP_OPERATOR_ACTION_RATE_LIMIT_PER_MIN` (default 20, min
  5, max 200).  This matches the founder's §5 "conservative,
  configurable limits … avoid arbitrary hard-coded limits".

### 5f Financial controls

Phase 2D touches NO financial state:

- No Stripe entity.
- No `ClubSubscription` write.
- No `accessTier` write.
- No `BillingCycle` write.
- No `PaymentReconciliationEntry` write.
- No `TenantProvisioningJob` write.

Contract tests enforce every negative assertion above.

### 5g Fail-closed feature flag

`SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE` — default OFF.  When
unset or anything other than the literal string `"1"`, every POST
route returns 503 with a structured "operator_release_disabled"
error.  The GET routes continue to work (super-admin read-only
diagnostic + queue).

---

## 6. Manual-verification sequencing implications

### 6a Why Phase 2D is the right slice

Without Phase 2D, Phase 2E would need to either:
- Build fixtures that write `verificationVerdict = PASS_AUTOMATED`
  directly to the DB — bypassing the Phase 2C corroborator and
  the §2 amendment's core invariant.
- Build Phase 2E on top of a state no real applicant can reach —
  rendering Phase 2E's acceptance tests meaningless outside
  fixtures.
- Delay Phase 2E until Phase 2H lands — adding months of operator-
  UI work on the critical path, when a minimal release capability
  is adequate for the pilot's operator population (Spectre's
  founder + staff).

Phase 2D's narrow slice resolves the sequencing cleanly:
- Minimal operator surface → `AUTHORISED` is production-reachable.
- Phase 2E can build its mandate collection against a real state
  machine.
- Phase 2H's richer UI remains deferred without blocking Phase 2E.

### 6b Phase 2H's role is preserved

Phase 2D is a strict subset of what Phase 2H ships:
- Phase 2D's `OperatorVerificationRecord` schema is forward-
  compatible: Phase 2H adds enum values + more concept rows
  (e.g., `CONFLICT_RESOLUTION`) without migrations.
- Phase 2D's `platform:signups:release` scope is upgradeable to a
  split scope-set in Phase 2H.
- Phase 2D's queue + review pages are the first two pages of the
  Phase 2H operator inbox; Phase 2H adds filtering + bulk
  actions + delegation on top.

### 6c Explicit sequencing recommendation to the founder

**Recommended:** Implement Phase 2D after this planning package
is authorised, BEFORE authorising Phase 2E.  Phase 2D's acceptance
unblocks Phase 2E's design against a real `AUTHORISED` state.

**Alternative considered (and rejected):** Procure a live CA-BC
registry adapter first.  Rejected because (a) procurement adds
weeks of lead time, (b) BC-only live adapter still leaves AB + ON
on manual review, (c) the founder's §2 directive explicitly asks
to evaluate operator-release-first — procurement does not resolve
AUTHORISED-reachability outside BC.

---

## 7. Contract and Playwright test plan

### 7a Vitest contract tests (target: >= 70 passing assertions)

1. `tests/signup-2-phase-2d-schema.test.ts` (~10 assertions):
   `OperatorVerificationRecord` model exists in both Prisma
   schemas with required columns + indexes; cascades on
   registration delete.
2. `tests/signup-2-phase-2d-service.test.ts` (~20 assertions):
   service transactions are atomic; release requires BOTH prior
   concept records; reject does NOT require them; writes
   `verificationDeciderUserId` + `verificationDecidedAt`;
   idempotent-replay semantics; audit emission tails-only.
3. `tests/signup-2-phase-2d-authz.test.ts` (~15 assertions):
   self-approval protection (same email AND same tenant);
   permission scope requirement; distinct operator for standing
   vs authority; fail-closed on missing flag.
4. `tests/signup-2-phase-2d-ui-contract.test.ts` (~15 assertions):
   queue page uses `platform:signups:release` gate; review page
   lists all four concept rows; evidence-reference field has
   length limits (<= 500 chars); reason field required; stable
   `data-testid`s for Playwright; no gov-ID surface anywhere.
5. `tests/signup-2-phase-2d-no-financial-side-effects.test.ts`
   (~10 assertions): grep sweep across Phase 2D files for
   absence of `prisma.clubSubscription`, `accessTier`,
   `stripe.`, `prisma.billingCycle`, `prisma.user.create`,
   `prisma.club.create`.

### 7b Playwright staging acceptance

`tests/e2e/signup-2-phase-2d-operator-acceptance.staging.spec.ts`
runs four scenarios:

- **A.** Full happy path.  Fixture registration created at
  `HOLD_FOR_REVIEW:ENTITY_VERIFICATION` by the Phase 2B/2C
  harness.  SpectreAdmin operator submits standing-verified,
  then authority-verified (via a secondary operator fixture to
  satisfy the distinct-operator rule), then release with reason.
  Registration transitions to `AUTHORISED`.
- **B.** Self-approval refusal.  The applicant themselves (same
  Microsoft tenant id) attempts to release — 403.
- **C.** Reject path.  Operator submits reject with reason;
  registration becomes `REJECT` / `status = ABANDONED`.
- **D.** Fail-closed flag.  With
  `SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE` unset, every POST
  returns 503.

The Playwright spec runs under `staging-authenticated` only;
chromium project is skipped per the Phase 2B/2C guard pattern.

### 7c Full regression

- SIGNUP-1 + 1F + 2A + 2B + 2C contract suites remain green.
- Posting-guard adjacent suites remain green.
- No regression allowed in the SIGNUP-1G recovery flow or the
  Phase 2B attestation flow.

### 7d Placeholder scan

`npm run scan:placeholders` must remain clean on Phase 2D
surfaces.

---

## 8. Existing-tenant compatibility requirements

- Phase 2D does not write to any `ClubSubscription` row.
  Contract-asserted.
- Phase 2D does not write to any `Club` row.  Contract-asserted.
- Phase 2D does not write to any `User` row.  Contract-asserted.
- Phase 2D does not change `accessTier` semantics anywhere.
  The Phase 2B seams are untouched.
- Phase 2D's additive migration (one new model) does not alter
  any existing column.
- Legacy tenants remain grandfathered under the Phase 2B gate.

---

## 9. DRH-1 staging deployment plan

Phase 2D follows the Phase 2A/2B/2C DRH-1 pattern:

1. Implementation on `staging-deploy/web1b1-framer-fidelity`
   (or a dedicated branch if the founder prefers isolation).
2. Local gates: typecheck; four new Phase 2D contract suites;
   SIGNUP-1 + 1F + 2A + 2B + 2C regression; posting-guard
   adjacent regression; placeholder scan.
3. Commit with the standard attribution footer.
4. Push → GitHub Actions "Deploy — spectre-staging" fires.
5. Watch DRH-1 run; wait for success (worker + web both on new
   sha-tag; `/api/health` 200).
6. Capture the Fly release version + image sha in the acceptance
   evidence doc.
7. Run the Phase 2D Playwright acceptance against the new
   release; capture screenshots + JSON evidence.
8. Scan staging logs for 60 seconds post-release; confirm zero
   errors / warnings on Phase 2D paths.

Rollback anchor: **v877** (`sha-adfe13c3e2c6`) — Phase 2C baseline.

Live-mode activation on staging:
- Phase 2D ships with `SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE`
  unset.  To exercise the full workflow for the founder's own
  acceptance, Spectre's staging secret can be set to `"1"` AFTER
  the baseline deploy succeeds.  This is a two-step rollout: the
  code lands dormant; a secret flip activates the write side.
  Both steps happen on staging only, never on production.

---

## 10. Acceptance criteria

Modeled on the Phase 2A / 2B / 2C acceptance evidence docs:

| Dimension | Criterion |
|---|---|
| Prisma migration | Applies cleanly on a fresh DB; dual-schema parity; adds only the new `OperatorVerificationRecord` model. |
| Typecheck | `npm run typecheck` clean. |
| Contract tests | Four new Phase 2D contract suites, >= 70 passing assertions in aggregate. |
| Playwright acceptance | `signup-2-phase-2d-operator-acceptance.staging.spec.ts` passes under `staging-authenticated` with all four scenarios green. |
| Regression | Full SIGNUP-1 + 1F + 2A + 2B + 2C contract regression green; posting-guard adjacent regression green. |
| Audit coverage | Every operator POST is contract-tested for an `audit()` call with the correct action string + tails-only meta. |
| Placeholder scan | No new Phase 2D surface flagged. |
| Fail-closed safety | Feature-flag env-var contract-tested; distinct-operator rule contract-tested; self-approval rule contract-tested. |
| Existing-tenant compatibility | Zero `ClubSubscription` writes; zero `accessTier` writes; zero `Club` or `User` writes. |
| Documentation | `docs/signup-2-phase-2d-acceptance.md` filled with evidence (test counts, migration id, image sha, Fly release). |
| Deployment | DRH-1 to staging; `/api/health` 200; log scan clean. |
| Non-authorisations preserved | No production state; no Stripe entity; SIGNUP-1G baseline untouched; Phase 2B + 2C live-mode preconditions unchanged. |

---

## 11. Founder decisions required

The following decisions must land in writing before Phase 2D
implementation is authorised:

1. **Operator permission scope naming.**  Phase 2D proposes
   `platform:signups:release` as a single scope granted to
   `SUPER_ADMIN` at launch.  Confirm this naming (or specify
   alternative) and whether a split scope-set is desired at
   launch rather than deferred to Phase 2H.
2. **Distinct-operator rule for standing-vs-authority.**  Phase
   2D proposes requiring a different operator user id on the
   STANDING record versus the AUTHORITY record.  Confirm this is
   correct, or relax to "same operator may sign both" (acceptable
   at pilot operator population).
3. **Evidence-reference field length.**  Phase 2D proposes
   500-character max on `evidenceReference`.  Confirm or
   specify a different cap.
4. **Reason-string length.**  Phase 2D proposes 1000-character
   max on `reason`.  Confirm or specify.
5. **Rate-limit default.**  Phase 2D proposes 20 operator POST
   actions per minute per operator (env-tunable with min 5 /
   max 200).  Confirm or specify.
6. **Flag naming convention.**  Phase 2D proposes
   `SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE`.  Confirm or
   specify.
7. **Staging live-mode activation.**  Phase 2D ships with the
   flag OFF.  Confirm whether, on acceptance, the staging secret
   should be flipped to `"1"` so the founder can personally
   exercise an end-to-end release.
8. **Access to the operator surface.**  Confirm which Microsoft
   accounts hold `SUPER_ADMIN` on staging today, so Phase 2D's
   acceptance can be targeted at those accounts without creating
   new identities.

Decisions 1 + 2 are the only ones that materially change Phase
2D's code surface.  The others are configuration / copy choices.

---

## 12. Dependencies on Phase 2E payment integration

Phase 2E depends on Phase 2D in TWO ways:

### 12a Phase 2E reads AUTHORISED

The mandate-collection surface (Phase 2E's primary deliverable)
only fires when `SignupRegistration.step === "AUTHORISED"` AND
`verificationVerdict === "PASS_AUTOMATED"`.  Phase 2D is the sole
production path to that state.

### 12b Phase 2E must preserve the audit chain

Each `BillingCycle` created by Phase 2E will carry a reference to
the `OperatorVerificationRecord` of type `RELEASE` whose outcome
decided the authorisation.  The reference is a direct FK — this
means Phase 2E's own migration will add one nullable column to
`BillingCycle` (`releasedByOperatorRecordId`), filled on
creation.  Phase 2D does NOT ship that column; it is a Phase 2E
responsibility.  Phase 2D ships the model Phase 2E will reference.

### 12c Phase 2E does NOT re-run verification

Phase 2E does not re-fetch the registry.  Phase 2D's release is
the trust anchor.  If a dispute arises after Phase 2E has
collected a mandate, Phase 2H's operator surface can retroactively
flip the registration (via `reject` + a reversal path in Phase
2F); Phase 2E does not re-corroborate on its own.

### 12d Phase 2E is a separate founder authorisation

Phase 2E is NOT authorised by this document.  It is NOT authorised
by Phase 2D's acceptance.  Phase 2E requires its own authorisation
cycle (plan → founder review → authorisation → implementation →
acceptance), consistent with the SIGNUP-2 phasing cadence
established on Phases 2A, 2B, and 2C.

---

## 13. What this document is + is not

**IS:**
- The Phase 2D planning document, awaiting founder authorisation.
- A reconciliation of the architectural gap identified by the
  founder's Phase 2D authorisation email §2 (sequencing of
  operator-release relative to Phase 2E payment integration).
- A specification complete enough that implementation is a direct
  translation.

**IS NOT:**
- Authorisation to implement.
- A code change.
- A deployment.
- A Stripe API call.
- A commitment to any specific operator-UI layout beyond the
  minimum needed to unblock Phase 2E.
- A change to the Phase 2A / 2B / 2C accepted baselines.
- Authorisation to activate the Phase 2C verification-live flag.
- Authorisation to activate the Phase 2B attestation flag.

**Awaiting founder authorisation of Phase 2D per Section 10.**
