# SIGNUP-2 Phase 2B -- Implementation Authorisation Package

**Status.** PLAN -- awaiting founder authorisation.
**Supersedes.** None (Phase 2B first draft).
**Depends on.** SIGNUP-2 architecture v3 (sha-07db40b).  Phase 2A
accepted baseline (sha-c3e337e, Fly v870).  SIGNUP-1G baseline
(sha-fb604f9).

**This document is NOT authorisation to implement.**  No code
written.  No tenant disturbed.  No Stripe entity created.  No
production state changed.

---

## 1 Scope + exclusions

### 1a Scope

Phase 2B wires two things together: (A) a signatory-attestation
surface that creates the first "post-SIGNUP-1" record of
commercial authority, and (B) server-side access-tier enforcement
at Spectre's existing posting-guard seam so that -- when Phase 2G
later provisions real tenants -- their initial `accessTier =
STAGED` is actually enforced against the FULL-tier posting /
sensitive-action write paths.

Concretely:

1. **Attestation surface**
   - New page: `/signup/t/[token]/authority` (server-rendered).
     Reads the resumed `SignupRegistration`; renders the
     attestation copy + ToS link + "I confirm" button.
   - New API: `POST /api/signup/authority/accept`.
     Writes `SubscriptionAuthorisationAttestation` with
     `signatoryFullName`, `signatoryTitle`, `clubLegalName`,
     attestation-text SHA-256, ToS SHA-256, `acceptedAt`, IP,
     user agent, Microsoft `oid` + `tid`.
     Transitions `SignupRegistration.step` to the new value
     `AUTHORITY_ACCEPTED` (additive step; legacy steps unchanged).
     Emits `audit("signup.authority.accepted", ...)`.
     Redirects applicant to `/signup/t/[token]/authority/complete`
     ("Your authorisation is recorded; the mandate collection
     and payment flow is being prepared.  You will be notified
     when the next step is available." -- deliberately a dead-end
     until Phase 2E).

2. **Terms-of-service document + hash pipeline**
   - New document: `docs/legal/terms-of-service-v1.md` with the
     $38K CAD subscription terms (reviewed + committed).
     Reviewers: founder + legal counsel (operator-driven; not
     Spectre's engineering decision).  Phase 2B SHIP A STUB with
     a founder-visible warning banner that the content needs
     legal review before the first real signatory sees it;
     operator unlocks the "accept" button via a feature flag
     once the ToS is finalised.
   - New helper: `src/lib/billing/terms-of-service.ts` that reads
     the active ToS file, computes SHA-256 at acceptance time,
     records label + hash on the attestation row.
   - **Decision deferred to founder (see Section 8):** final ToS
     content.

3. **Access-tier enforcement wire-in (ONE SEAM)**
   - Modify `src/lib/posting-guard/index.ts`:
     - `assertPostingAllowed(principal, clubId, action, ...)` now
       additionally calls `assertAccessTierForPosting(clubId)`.
     - `assertSensitiveActionAllowed(principal, clubId, action, ...)`
       now additionally calls `assertAccessTierForPosting(clubId)`.
   - New helper in `src/lib/billing/access-tier.ts`:
     - `assertAccessTierForPosting(clubId: string): Promise<void>`
     - Reads `ClubSubscription.accessTier` for `clubId`.
     - If no `ClubSubscription` row exists OR `accessTier` is
       `null` -> **PASS** (legacy grandfather).
     - If `accessTier` is `FULL` or `MANUAL_INVOICE` -> PASS.
     - Otherwise (`STAGED`, `SUSPENDED_READ_ONLY`, or any
       unexpected value) -> throws `ForbiddenError` with
       `code: "SIGNUP_2_TIER_BLOCKS_POSTING"`.
   - This single edit propagates FULL-tier enforcement to every
     caller of `assertPostingAllowed` -- see Section 2 for the
     complete inventory.

4. **Audit on access-tier change**
   - Any code path that writes `ClubSubscription.accessTier`
     (in Phase 2B, there is none; in Phase 2G there will be)
     must call `audit("subscription.access_tier.changed",
     entityType: "ClubSubscription", clubId, meta: { before, after })`.
   - Phase 2B ships a lint-level contract test that greps the
     repo for `accessTier:` writes outside the authorised code
     paths.

5. **Recovery from incomplete onboarding**
   - A `SignupRegistration` in `AUTHORITY_ACCEPTED` state can be
     resumed via SIGNUP-1G's recovery-link flow (unchanged).
     The resumed session lands on `/signup/t/[token]/status`;
     the status page detects `AUTHORITY_ACCEPTED` and renders
     a "Your authorisation is recorded; next step is being
     prepared" variant.
   - If the signatory never clicks "I confirm", `SignupRegistration`
     stays at `ADMIN_VERIFIED` indefinitely (same as pre-Phase-2B
     behaviour).
   - If the signatory accepts but the system crashes before writing
     the attestation row + stepping the registration, the API
     is wrapped in a single DB transaction so partial writes
     cannot occur.  Contract test asserts this.

6. **Contract tests + Playwright staging acceptance**
   - Four new contract-test suites (details in Section 5).
   - One new Playwright staging acceptance spec that walks the
     real attestation UI, asserts the attestation row persists,
     and asserts posting-guard enforcement rejects a STAGED
     Club's `assertPostingAllowed` call via a staging-only
     synthetic test record.

7. **DRH-1 staging deploy**
   - Standard DRH-1 flow (git push → GitHub Actions → Fly
     staging).  Pre-flight migration preflight asserts no
     destructive operation.

### 1b Exclusions (deferred)

Explicitly NOT in Phase 2B:

- **Club shell creation.**  `ClubSubscription` rows for new
  tenants are NOT created in Phase 2B.  Phase 2B's attestation
  record attaches to the `SignupRegistration`, not to a Club.
  `ClubSubscription` creation lands in Phase 2G alongside the
  real Club + User + UserClubRole provisioning.
- **Any Stripe call.**  Phase 2B does not touch Stripe.
- **Mandate collection + payment initiation.**  Phase 2E.
- **Entity-standing registry call.**  Phase 2C.
- **Government-ID collection.**  Banned per founder decision 9.
- **Operator surface pages.**  Phase 2H.
- **Reconciliation worker.**  Phase 2I.
- **Welcome emails / invitations.**  Phase 2G.
- **Enforcement for STAGED-tier capabilities.**  STAGED-tier
  capabilities (Club identity edit, COA dry-run upload, etc.)
  do not flow through `assertPostingAllowed`.  Those paths are
  guarded by RBAC `requirePermission` + Phase-2B leaves them
  unchanged.  Enforcement at the STAGED-tier boundary wires in
  Phase 2C/2G when the Club shell exists and `accessTier =
  STAGED` is the realistic state.

### 1c Why the posting-guard seam

Posting-guard is called from **every** financial-mutation /
sensitive-action code path in Spectre (verified by grep across
`src/`).  Twenty-plus callers across accounting, AP, AR, payroll,
HR training, imports, opening balance, inventory, approvals.
Adding the tier gate here is a one-line change that propagates
to all of them without touching individual routes.  Any new
feature that posts to the ledger ALSO already calls posting-guard
per the project's `CLAUDE.md` discipline, so future features
inherit tier enforcement automatically.

---

## 2 Route + capability enforcement matrix

### 2a FULL-tier capabilities covered by the posting-guard wire-in

All of these capabilities route through `assertPostingAllowed`
or `assertSensitiveActionAllowed`.  Phase 2B's one-line
addition to those functions guards them all.

| Capability (v3 Section 2) | Entry file(s) that call assertPostingAllowed | Covered by Phase 2B? |
|---|---|---|
| `gl.journal.post` | `src/lib/accounting/journal.ts` | YES |
| `ap.invoice.post` | `src/lib/ap/invoices.ts` | YES |
| `ap.payment.post` | `src/lib/ap/payments.ts` | YES |
| `ar.invoice.post` (member statements fall through here) | `src/lib/ar/*` (via posting-guard caller list) | YES |
| `payroll.batch.run` | `src/lib/payroll/approve-and-post.ts` | YES |
| `payroll.statement.publish` | `src/lib/payroll/approved-time.ts` | YES |
| `member.billing.post` | `src/lib/ar/*` (member billing via posting-guard) | YES |
| `member.statement.publish` | `src/lib/ar/*` | YES |
| `club.coa.commit` | `src/lib/opening-balance/index.ts`, `src/lib/imports/index.ts` | YES |
| `club.opening-balance.commit` | `src/lib/opening-balance/index.ts` | YES |
| `club.mailbox.send` | `src/lib/integrations/email.ts` -- caller discipline: posting-guard before send on operator path | YES |
| `club.mailbox.integration.write` | `src/lib/integrations/*` write paths | YES |
| `hr.sensitive-identity.edit` | `src/lib/hr/sensitive-identity.ts` | YES (via sensitive-action gate) |
| `hr.compensation.edit` | `src/lib/hr/compensation.ts` | YES |
| `hr.employment-assignment.change` | `src/lib/hr/employment-assignments.ts` | YES |
| `member.portal.publish` | `src/lib/club/media.ts` + member-portal write paths | YES |
| `api.token.issue` | `src/lib/secrets.ts` + API-token write paths | YES (via sensitive-action gate) |
| `integration.webhook.enable` | `src/lib/integrations/*` write paths | YES |

### 2b Capability map verification contract test

Phase 2B adds `tests/signup-2-phase-2b-capability-coverage.test.ts`
that greps `src/` for every file importing `assertPostingAllowed`
or `assertSensitiveActionAllowed` and asserts the posting-guard
tier-gate call is reachable from each.  The grep output is
emitted into the test report so a future reviewer can diff
coverage over time.

### 2c Routes NOT touched

Phase 2B does NOT alter any individual route handler or server
action.  Enforcement is applied at the posting-guard seam only.
A route's existing RBAC / tenant-isolation / posting-guard
semantics are preserved; the tier gate is additive.

### 2d Background jobs

Three existing background jobs call posting-guard surfaces:

- `src/lib/payroll/approve-and-post.ts` (scheduled approve-and-post)
- `src/lib/opening-balance/index.ts` (import worker)
- `src/lib/imports/index.ts` (CSV import pipeline)

All three automatically inherit the tier gate via the
posting-guard seam.  No per-job wire-up needed.

### 2e UI gate on top of server-side enforcement

UI-level gating of STAGED vs FULL capabilities is **secondary**;
the server-side guard in posting-guard is primary.  Phase 2B
ships a thin UI-level affordance only on the one Phase 2B page
(the attestation surface) and does not retrofit tier-aware UI
hints onto existing admin pages.  Those hints land in Phase 2G
alongside the real Club shell + tier display.

---

## 3 Existing-tenant compatibility strategy

### 3a Grandfather semantics (PRIMARY SAFEGUARD)

Phase 2A's `access-tier.ts` already implements the grandfather:
`isTierSufficient(null, _)` returns `true` for every required
tier.  Phase 2B's `assertAccessTierForPosting(clubId)` reads
`ClubSubscription.accessTier` and PASSES when null.

**Zero existing `ClubSubscription` rows on staging** (confirmed
on Fly v870 probe); `accessTier` has never been written anywhere.
Every pre-Phase-2B Club has either no `ClubSubscription` row OR
a `ClubSubscription` row with `accessTier = null`.  Both pass.

### 3b No-write guarantee on legacy rows

Phase 2B does NOT write to any existing `ClubSubscription` row.
The only ClubSubscription write path Phase 2B introduces is
inside the Phase-2B attestation acceptance API, and that path
specifically creates NOTHING for Phase 2B.  (The ClubSubscription
row for the new tenant is deferred to Phase 2G.)

Contract test asserts: no SIGNUP-2 Phase 2B code path contains
`prisma.clubSubscription.create` or `prisma.clubSubscription.update`
with an `accessTier` field.

### 3c Zero-row staging as a feature

The staging DB has zero `ClubSubscription` rows.  This means
Phase 2B's enforcement wire-in has no real-tenant test subject
to exercise against.  Phase 2B's acceptance tests must therefore:

- Verify the guard's behavior on synthetic in-memory tier values
  (contract tests, Phase 2A-style).
- Create a staging-only "harness" `ClubSubscription` with
  `accessTier = STAGED` (via the same staging-only debug
  endpoint pattern used in signup-1-conditional-acceptance),
  attempt a posting-guard call, assert the guard throws.
- Immediately delete / mark-cancelled the harness row so no
  Coulee Ridge or other staging data is disturbed.

### 3d Audit on tier change

Any future `ClubSubscription.accessTier` write (Phase 2G
onwards) MUST call `audit("subscription.access_tier.changed",
...)` with before/after values.  Phase 2B lands a lint-level
contract test asserting this via source scan.

---

## 4 Database + migration implications

### 4a New migration

Phase 2B adds ONE additive migration:
`20261026_signup_2b_attestation_step` (both dual schemas):

- Extends `SignupRegistration.step` with a new permitted value
  `AUTHORITY_ACCEPTED`.  The column is already `String`, not
  an enum; no schema change at the DB level.  Phase 2B adds
  the value to the TypeScript union in
  `src/lib/signup/registration.ts`.
- Adds ONE index: `SignupRegistration_step_idx` on the step
  column.  Already exists (verified in schema).  No-op.
- **No new tables.**  Phase 2B uses the Phase 2A
  `SubscriptionAuthorisationAttestation` table as-is.
- **No column additions.**  Phase 2A already provisioned the
  attestation table + ToS version columns.

Verdict: **the migration is effectively a no-op at the SQL
level.**  The step value change is TypeScript-only.

### 4b Rollback semantics

Application-code rollback (`flyctl releases rollback`) reverts
Phase 2B's application code.  The Phase 2A tables + columns
remain in the database (as documented in the corrected rollback
section of `docs/signup-2-phase-2a-acceptance.md`).  Any new
`SubscriptionAuthorisationAttestation` rows written during
Phase 2B remain in the database post-rollback as unused data.

### 4c Preflight guard

Standard DRH-1 preflight asserts the migration is additive.
No `DROP`, `RENAME`, data mutation, or destructive change.

---

## 5 Test plan + acceptance criteria

### 5a Contract tests (new in Phase 2B)

Four new source-contract test suites in `tests/`:

| Suite | Target assertions | Covers |
|---|---|---|
| `signup-2-phase-2b-attestation-contract.test.ts` | 20+ | Attestation API shape; SHA-256 lock; audit emission; transaction wrap; step transition; recovery semantics |
| `signup-2-phase-2b-posting-guard-wiring.test.ts` | 15+ | posting-guard calls assertAccessTierForPosting; new helper reads ClubSubscription.accessTier; null -> PASS; FULL / MANUAL_INVOICE -> PASS; STAGED / SUSPENDED_READ_ONLY -> ForbiddenError |
| `signup-2-phase-2b-capability-coverage.test.ts` | 10+ | Every file importing assertPostingAllowed is reachable from the tier gate; capability-map keys match the architecture doc |
| `signup-2-phase-2b-tos-pipeline.test.ts` | 8+ | ToS document location; SHA-256 helper; label format; feature-flag gate |

**Total target: 50+ passing contract assertions** (same
discipline as Phase 2A's 91).

### 5b Playwright acceptance (new in Phase 2B)

`tests/e2e/signup-2-phase-2b-authority-acceptance.staging.spec.ts`:

- Walks the real signup through Microsoft identity (reusing
  force-verify for the Microsoft callback).
- Navigates to the new `/signup/t/[token]/authority` page.
- Asserts attestation copy renders + "I confirm" is enabled
  only after the operator-only feature-flag check passes.
- Clicks "I confirm".
- Asserts the applicant lands on
  `/signup/t/[token]/authority/complete`.
- Verifies via staging-only debug endpoint that
  `SubscriptionAuthorisationAttestation` row exists with the
  expected text SHA-256 + ToS SHA-256.
- Verifies the `SignupRegistration.step` is `AUTHORITY_ACCEPTED`.

Harness probe:
- Creates a staging-only harness `ClubSubscription` row with
  `accessTier = STAGED`.
- Calls a staging-only test action that invokes
  `assertPostingAllowed`.
- Asserts the call throws `ForbiddenError` with the Phase-2B
  code `SIGNUP_2_TIER_BLOCKS_POSTING`.
- Cleans up the harness row.

### 5c Regression gates

Must remain green post-Phase-2B:

- `npm run typecheck`.
- `tests/signup-1-contract.test.ts` (61 passing).
- `tests/signup-1f-recovery-link.test.ts` (31 passing).
- `tests/signup-2-*.test.ts` (91 passing from Phase 2A + Phase
  2B's 50+ = ~140+ total).
- Playwright SIGNUP-1 + SIGNUP-1G + Phase-2B authority
  acceptance (14 passing from Phase 2A + 2 new = ~16 passing
  across chromium + staging-authenticated projects).

### 5d Acceptance criteria

Phase 2B is READY FOR ACCEPTANCE when:

1. All contract tests pass (new + existing).
2. All Playwright specs pass against the Phase-2B staging deploy.
3. Staging DB probe shows no `ClubSubscription` row disturbed
   (same probe as Phase 2A).
4. Legacy grandfather semantics confirmed via contract test +
   staging harness.
5. Posting-guard tier gate confirmed to throw on `STAGED` and
   `SUSPENDED_READ_ONLY` + confirmed to pass on `null`, `FULL`,
   `MANUAL_INVOICE`.
6. Audit emission confirmed for attestation accept + for any
   future `accessTier` write.
7. ToS document stub committed with the "needs legal review"
   banner + the SHA-256 pipeline functional.
8. DRH-1 staging deploy succeeded.
9. `docs/signup-2-phase-2b-acceptance.md` filled with evidence.

---

## 6 DRH-1 staging deployment plan

Standard DRH-1 flow:

1. Git commit the Phase-2B slice.
2. Git push to `staging-deploy/web1b1-framer-fidelity`.
3. GitHub Actions builds + pushes the Fly image.
4. Fly deploys to `spectre-staging`.
5. `prisma migrate deploy` applies
   `20261026_signup_2b_attestation_step` on the Postgres DB
   (functionally a no-op at the SQL level per Section 4a).
6. Fly rolls the web machines.
7. Health probe: `curl -s /api/health` -> 200.
8. Diagnostic probe:
   `curl -s /api/admin/signup/debug/status` -> `effectiveAdapter=microsoft365`.
9. Playwright regression + Phase-2B acceptance.
10. Fill acceptance evidence.

**Not using local Docker.  Not using `fly deploy --local-only`.**

Rollback: `flyctl releases rollback --to v870` reverts code to
the Phase 2A baseline.  Any `SubscriptionAuthorisationAttestation`
rows created during Phase 2B stay in the database (unused by the
Phase-2A code).

---

## 7 Security + financial risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| New-tenant Club shell accidentally created at attestation and granted operational access | Impossible by design | N/A | Phase 2B does NOT create any Club or ClubSubscription row.  Club creation is Phase 2G. |
| Legacy Club incorrectly tier-gated and loses access | Low | High (service outage for Coulee Ridge + 70 other Clubs) | Grandfather path in access-tier.ts is Phase-2A-tested + Phase-2B contract-tested; `assertAccessTierForPosting` reads `null -> PASS` BEFORE any Stripe or Phase-2B-specific logic |
| Attestation accepted without the final legal ToS | Possible if the operator unlocks the feature flag prematurely | High (legal exposure) | ToS stub ships with a founder-visible "needs legal review" banner on the ToS doc; the attestation acceptance API refuses to proceed unless `SPECTRE_SIGNUP_2B_TOS_READY=1` env flag is set on the running image |
| Attestation API partial write (crash between SubscriptionAuthorisationAttestation.create + SignupRegistration.update) | Possible without transaction | Low (just needs operator cleanup) | Both writes wrapped in a single `prisma.$transaction` |
| Attestation text SHA-256 drift | Low (operator could edit ToS post-signatory-accept) | Medium (legal uncertainty) | ToS text SHA-256 locked at acceptance; `termsVersionSha256` column immutable per Phase 2A schema |
| Access-tier gate added to posting-guard breaks a background job | Possible | Medium | Contract test enumerates every posting-guard caller + grep-tests coverage; grandfather path dominates |
| `assertSensitiveActionAllowed` now tier-gated could break a secret rotation path | Possible | High (operator can't rotate secrets) | Grandfather path (`null -> PASS`) applies here too; legacy clubs have `accessTier = null`; new path tested |
| Signatory races the feature flag flip | Low | Low | The flag is operator-only; signatory UI shows a "coming soon" state until the flag is set |

### 7a Explicit financial-safety invariants

- No Stripe entity created, listed, or mutated.
- No `BillingCycle` row created.
- No `SubscriptionPaymentMandate` row created.
- No welcome email sent.
- No tenant provisioned.

These are testable; the contract tests include "grep for `stripe.`
across the Phase 2B diff + expect zero matches".

---

## 8 Remaining founder decisions

Phase 2B begins only after:

1. **Final ToS content.**  The committed ToS document (location
   TBD; recommend `docs/legal/terms-of-service-v1.md`) must be
   finalised + reviewed by founder + legal counsel.  Phase 2B
   ships a stub + a feature flag; neither should be removed
   until the real content lands.
2. **Terms-of-service document location.**  Spectre's repo or
   a separate legal-document store?  Phase 2B uses whichever
   path the founder confirms.
3. **Attestation-page copy approval.**  The exact wording of
   the "I confirm" sentence + accompanying explanation.
   Phase 2B ships a draft (based on the v3 architecture
   Section 4b wording); the founder's final text lands before
   the first real signatory sees it.
4. **Attestation feature-flag name.**  Current recommendation:
   `SPECTRE_SIGNUP_2B_ATTESTATION_LIVE`.  Alternative: a
   DB-row-based toggle on `SignupRegistration` or a
   per-registration operator release.  Which?
5. **Harness tenant for Phase-2B staging acceptance.**  Phase 2B's
   posting-guard tests need a staging-only `ClubSubscription`
   with `accessTier = STAGED`.  Options:
   (a) create via a staging-only debug endpoint + delete after;
   (b) create tied to a dedicated test-only Club.
   Recommend (a) for cleanup simplicity.
6. **Does Phase 2B install the UI "Continue to authorisation"
   button on `/signup/t/[token]/status`?**  Recommend YES so
   the signatory has a clear next step after Microsoft identity.
   Button is operator-feature-flagged until ToS is finalised.

---

## 9 Timeline + milestones

Estimated engineering effort (single-focused):

- Attestation UI + API + schema touch: ~1 day.
- Posting-guard wire-in + access-tier helper: ~0.5 day.
- Four contract test suites: ~1 day.
- Playwright acceptance + staging harness: ~0.5 day.
- DRH-1 deploy + acceptance evidence doc: ~0.5 day.

**Total: ~3-4 engineering days.**  Real-time dependencies: founder
ToS review + content approval (external).

---

## 10 Non-authorisations (preserved)

- No Phase 2B implementation begins until founder authorises
  this plan.
- No Stripe entity.
- No tenant provisioning.
- No new application code deployed.
- No production change.
- No existing tenant access change.
- No SIGNUP-1G reopen.
- No government-ID collection.
- No ClubSubscription write for new tenants (deferred to Phase
  2G).

---

## 11 Authorisation requested

Return to this document after founder review.  Phase 2B
implementation begins only after:

1. Founder authorisation of this plan (or revisions).
2. Founder responses to Section 8 decisions (or acceptance of
   recommended defaults).

Phase 2B's acceptance evidence will land as
`docs/signup-2-phase-2b-acceptance.md` following the Phase 2A
pattern.  Subsequent phases (2C onwards) require their own
authorisation.
