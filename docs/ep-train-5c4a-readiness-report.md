# EP-TRAIN-5C-4A — Activation Readiness Report

**Status:** READ-ONLY audit complete 2026-11-02. Zero writes performed.
Zero obligations issued. Founder preservation verified.

**Scope:** Impact assessment and backfill plan for transitioning
Spectre's existing training records to the obligation-aware
compliance model. Prepares the ground for EP-TRAIN-5C-4B (controlled
activation) pending founder approval.

**STOP boundary honoured:** no backfill executed, no resolver
activated, no fixtures touched, no scheduling-eligibility
enforcement changed, no production deploy. All deliverables are
documentation + a read-only diagnostic script.

Companion deliverables (all under `docs/`):
- `ep-train-5c4a-backfill-impact-register.csv` — the full
  per-pair register (53 rows).
- `ep-train-5c4a-resolver-comparison.md` — legacy vs
  obligation-aware side-by-side.
- `ep-train-5c4a-execution-plan.md` — proposed EP-TRAIN-5C-4B.
- `ep-train-5c4a-founder-approval-checklist.md` — decisions
  blocking any write.

---

## 1. Accepted staging baseline

| Field | Value |
|---|---|
| Running image | `spectre-staging:sha-a6bf36202d71` |
| Fly release | v1074 |
| Image digest | `sha256:63c981f2818f44560b1a68007c3e5e8c1adffa570539c8b854a75e2c08aa236b` |
| Accepted application baseline | `sha-1c10508065b3` (EP-TRAIN-5C-3C acceptance) |
| Running vs accepted | **Zero application-code delta** (`git diff 1c10508..a6bf362 -- 'src/**' 'prisma/**' 'package.json' 'next.config.*'` → empty) |
| `/api/health` | 200 |
| App commit | `a6bf362` (test-only follow-up to the accepted 5C-3C baseline) |

The follow-up commit shipped tests + docs only. Application
behaviour is identical to the directive's cited baseline
`sha-1c10508065b3`. No redeploy performed.

### 1.1 Current global record counts

| Table | Count |
|---|---|
| TrainingObligation | **0** |
| TrainingCompletion | 11 |
| TrainingAttempt | 33 |
| TrainingProgress | 12 |
| Club | 76 |
| Employee (any lifecycle) | 9 |
| TrainingCourse | 75 |
| TrainingCourseVersion | 77 |

### 1.2 Founder preservation audit

Chris Turcato (E-00002, employee id `cmu0fiaod000187prcy9ufo2d`,
Coulee Ridge Golf & Country Club) — verified unchanged:

| Field | Value |
|---|---|
| TrainingCompletion | **9** |
| TrainingAttempt | **30** |
| TrainingProgress | **9** |
| TrainingObligation | **0** |

Matches the directive's §2 preservation requirement exactly. The
founder has issued zero obligations against himself and the
historical record is intact. The non-founder growth across the
staging DB since the EP-TRAIN-5C-3B acceptance baseline (completions
9→11, attempts 30→33, progress 9→12) is attributable to legitimate
scenarios on other employees (Marc Maldiney's historical
completions + the FounderDemo + the PAY1A fixtures), verified in
the per-employee breakdown below.

### 1.3 Resolver configuration

- `resolveEmployeeSchedulingEligibility` (legacy) is the active
  scheduling gate — unchanged.
- `resolveEmployeeTrainingCompliance` (EP-TRAIN-5C-1 7-state
  resolver) is defined and tested but **dormant** — no production
  code path reads it yet.
- `resolveActiveObligationForSession` (EP-TRAIN-5C-2 player
  orchestrator) is live — reads obligations if any exist, returns
  null otherwise. Pre-5C-4 all employees get null, so behaviour is
  identical to pre-5C-2.

---

## 2. Refreshed EP-TRAIN-5C-1 dry-run — matches historical reference

Fresh run against the current staging DB
(`scripts/ep-train-5c1-obligation-backfill-dryrun.mjs`):

| Grand total | Historical reference | Fresh run |
|---|---|---|
| Clubs | 76 | **76** |
| Employees (ACTIVE / PRE_HIRE / LEAVE) | 8 | **8** |
| Applicable employee-course pairs | 51 | **51** |
| Previously completed compliant | 10 | **10** |
| Applicable not completed | 41 | **41** |
| Proposed new INITIAL obligations | 41 | **41** |
| Revision-required | 0 | **0** |
| Manual-reinstate-required | 0 | **0** |
| **willFlipFromCompliantToOutstanding** | **0** | **0** |
| **willFlipFromOutstandingToCompliant** | 0 | 0 |
| Potential conflicts | 0 | 0 |

**Critical safety invariant preserved: zero employees would become
newly noncompliant on resolver activation.** The acceptable number
of unexplained compliance reversals is zero; the observed number is
zero.

### 2.1 Per-club breakdown (only clubs with any pair)

| Club | Employees in scope | Applicable pairs | Proposed INITIAL |
|---|---|---|---|
| Coulee Ridge Golf & Country Club | 5 | 50 | 40 |
| Riverside Country Club (HR-2B.5 Staging Fixture) | 1 | 1 | 1 |
| SLICE C BENEFITS TEST — Synthetic Club | 2 | 0 | 0 |

The 73 other clubs have zero employees in scope — the dry-run
numerics agree with the directive §3 reference.

---

## 3. Employee classification (§4 of directive)

The impact register classifies every ACTIVE / PRE_HIRE / LEAVE
employee into one of five tiers using only existing database
metadata (employeeNumber prefix, club.slug, club.name, employee
lifecycle + status + onboarding state). The signals are:

- `E-SLICE3-*` employeeNumber → EP-TRAIN-3 Slice 3 disposable
  fixture.
- Club slug `hr-2b5-staging*` → HR-2B.5 staging fixture tenant.
- Club name matching `SLICE C BENEFITS TEST — Synthetic*` → Slice C
  benefits synthetic tenant.
- `employeeLifecycle=ACTIVE + status=ACTIVE + onboardingState=APPROVED`
  → LEGITIMATE_ACTIVE.
- `employeeLifecycle=TERMINATED` or `status=TERMINATED` →
  LEGITIMATE_INACTIVE / terminated.
- `employeeLifecycle=LEAVE` → LEGITIMATE_INACTIVE / on-leave.
- `onboardingState != APPROVED` (DRAFT / SUBMITTED / etc.) →
  INCOMPLETE_ONBOARDING.
- No positive signal → REVIEW_REQUIRED.

| # | Employee number | Display name | Club | Lifecycle | Status | Onboarding | Classification |
|---|---|---|---|---|---|---|---|
| 1 | **E-00002** | Chris Turcato | Coulee Ridge | ACTIVE | ACTIVE | APPROVED | **LEGITIMATE_ACTIVE** (founder) |
| 2 | **E-00003** | Marc Maldiney | Coulee Ridge | ACTIVE | ACTIVE | APPROVED | **LEGITIMATE_ACTIVE** |
| 3 | **E-FOUNDER-DEMO** | FounderDemo DemoEmployee | Coulee Ridge | ACTIVE | ACTIVE | APPROVED | **LEGITIMATE_ACTIVE** (demo) |
| 4 | E-PAY1A-Test-A | PAY1A Test-A | Coulee Ridge | ACTIVE | ACTIVE | DRAFT | **INCOMPLETE_ONBOARDING** |
| 5 | E-PAY1A-Test-B | PAY1A Test-B | Coulee Ridge | ACTIVE | ACTIVE | DRAFT | **INCOMPLETE_ONBOARDING** |
| 6 | FIX-HR2B5-DE9D6AA055 | Alex Fixture | Riverside HR-2B.5 Staging Fixture | PRE_HIRE | ACTIVE | SUBMITTED | **FIXTURE** |
| 7 | SE-ZH-01 | SliceE HourlyZeroHours | SLICE C BENEFITS synth | ACTIVE | ACTIVE | DRAFT | **FIXTURE** |
| 8 | SC-D22B | SliceC BenefitsFixture | SLICE C BENEFITS synth | ACTIVE | ACTIVE | DRAFT | **FIXTURE** |

**Review-required ambiguities (founder decision needed):**
- Employees #4 and #5 (`E-PAY1A-Test-A/B`) look like PAY1A acceptance
  fixtures but live in the real Coulee Ridge tenant with
  `onboardingState=DRAFT`. The classifier cannot confidently assign
  FIXTURE (not using any fixture-prefix) nor LEGITIMATE (not through
  onboarding). Flagged **REVIEW_REQUIRED**; founder decision needed —
  see Approval Checklist §4.
- Employee #3 (`E-FOUNDER-DEMO`) is a legitimate ACTIVE/APPROVED
  Coulee Ridge employee. The classifier does not auto-detect "demo
  employee intentionally maintained"; founder decision needed on
  whether to issue 10 INITIAL obligations against this employee or
  exclude them from backfill — see Approval Checklist §3.
- Employee #1 (Chris Turcato) is the founder with 2 applicable
  courses lacking completions (Equipment Safety, Gas vs Diesel).
  Under current rules the register proposes CREATE_INITIAL for these
  two — see Approval Checklist §1. Default founder policy is: **do
  not issue obligations to the founder.**

---

## 4. Course classification (§4 of directive)

All 77 course versions classified:

| Tier | Count |
|---|---|
| LEGITIMATE_PUBLISHED | 75 |
| RETIRED | 2 |
| DRAFT | 0 |
| FIXTURE | 0 |

The two RETIRED versions are:
- `B31_STAGING_ACCEPTANCE v1` @ Coulee Ridge (RETIRED — superseded)
- `ORIENTATION_2027 v1` @ Coulee Ridge (RETIRED — superseded)

Both are the OLD versions of currently-published courses; the
backfill scope targets only `currentVersionId` of each course, so
these retired versions are excluded from obligation creation by the
applicability resolver itself. No fixture courses remain on staging
(the EP-TRAIN-5C-3 teardown chain removed every `SLICE3_*` course
cleanly).

---

## 5. Impact register headline (full detail in CSV deliverable B)

| Recommended action | Count | Who |
|---|---|---|
| **CREATE_INITIAL** | **20** | Marc Maldiney × 8 + FounderDemo × 10 + Chris Turcato × 2 |
| **PRESERVE_COMPLIANT** | **10** | Chris × 8 + Marc × 2 |
| **REVIEW_REQUIRED** | **20** | PAY1A-Test-A × 10 + PAY1A-Test-B × 10 |
| **SKIP_FIXTURE** | 1 | Alex Fixture (HR-2B.5 staging) |
| **SKIP_NONAPPLICABLE** | 2 | SE-ZH-01, SC-D22B (SLICE C synth club has no training courses) |
| **ALREADY_COVERED** | 0 | (no OUTSTANDING obligations exist today) |
| **SKIP_INACTIVE** | 0 | (no TERMINATED / LEAVE employees in scope) |

### 5.1 CREATE_INITIAL cohort — detail

The 20 proposed CREATE_INITIAL obligations break down as:

| Employee | # courses | Courses |
|---|---|---|
| **E-00003 Marc Maldiney** (LEGITIMATE_ACTIVE) | 8 | ORIENTATION_2027, EQUIPMENT_SAFETY_2026, FIRE_SAFETY, FOOD_SAFETY_2026, DEMO_FR_SAFETY, KNIFE_SAFETY_2026, ROOFTOP_SAFETY_2026, GAS_VERSUS_DIESEL |
| E-FOUNDER-DEMO FounderDemo | 10 | ORIENTATION_2027, EQUIPMENT_SAFETY_2026, FIRE_SAFETY, FOOD_SAFETY_2026, DEMO_FR_SAFETY, KNIFE_SAFETY_2026, ROOFTOP_SAFETY_2026, SAFE-BASICS, GAS_VERSUS_DIESEL, B31_STAGING_ACCEPTANCE |
| E-00002 Chris Turcato (founder) | 2 | EQUIPMENT_SAFETY_2026, GAS_VERSUS_DIESEL |

**Marc's 8 obligations are the only cohort that is safely
executable under default policy.** FounderDemo requires founder
decision on whether a demo employee should receive mandatory
training. Chris Turcato is the founder and the founder-preservation
rule overrides the default CREATE_INITIAL recommendation.

### 5.2 PRESERVE_COMPLIANT cohort — detail

Chris Turcato has qualifying historical completions on 8 of his 10
applicable courses: FIRE_SAFETY, FOOD_SAFETY_2026, DEMO_FR_SAFETY,
KNIFE_SAFETY_2026, ORIENTATION_2027, ROOFTOP_SAFETY_2026, SAFE-BASICS,
B31_STAGING_ACCEPTANCE. His 2 remaining courses have no completion
on the current published version → CREATE_INITIAL (deferred).

Marc Maldiney has qualifying completions on 2 of his 10 applicable
courses: SAFE-BASICS, GAS_VERSUS_DIESEL. The remaining 8 → CREATE_INITIAL.

### 5.3 REVIEW_REQUIRED cohort — detail

`E-PAY1A-Test-A` and `E-PAY1A-Test-B` each have 10 pairs flagged
REVIEW_REQUIRED. The classifier cannot auto-decide:
- They sit in the real Coulee Ridge tenant (not a fixture tenant).
- They lack APPROVED onboarding (DRAFT state).
- Their employeeNumber doesn't match any fixture prefix.
- Their names (`PAY1A Test-A/B`) suggest they're PAY1A acceptance
  fixtures that were never torn down.

Founder decision needed:
(a) Treat as fixtures → delete (NOT authorized in 5C-4A), or
(b) Treat as legitimate pending onboardings → wait for onboarding
    approval, no backfill needed, or
(c) Reclassify as fixtures without deletion → SKIP_FIXTURE on 5C-4B.

See Approval Checklist §4.

---

## 6. Issuance idempotency verification (§6 of directive)

The impact register generates a proposed issuance key for every
CREATE_INITIAL row of the form:
```
init:v<versionNumber>:<applicabilityReason>:5C-4B-initial-backfill
```

This is a readable stand-in; the actual service-generated key is
owned by `issueManualReinstatement` / internal INITIAL issuance code
and follows the schema's `init:${applicabilityWindowBucket}`
convention. Confirmed properties:

- **Zero collisions across the proposed set.** Every
  `(clubId, employeeId, courseVersionId, reason, issuanceKey)`
  5-tuple is unique.
- **Rerun safety.** The composite UNIQUE at the schema level
  (`@@unique([clubId, employeeId, courseVersionId, reason,
  issuanceKey])`) refuses a duplicate submission of the same
  authorized event — rerunning the backfill with the same bucket
  key is a no-op per the EP-TRAIN-5A-1 invariant.
- **No overlap with existing obligations.** Zero existing
  OUTSTANDING obligations today → zero risk of accidentally
  overwriting MANUAL_REINSTATE or cancelling REVISION; the
  invariant is trivially satisfied.
- **Scope guard.** Each proposed row carries both `courseId` and
  `courseVersionId` resolved from the applicability resolver —
  cross-tenant inclusion is prevented at generation time by
  `resolveApplicableCourses` filtering on `course.clubId`.
- **No pre-dating.** The register never satisfies an obligation
  with a prior completion; existing historical completions result
  in PRESERVE_COMPLIANT (do not create any obligation) rather than
  CREATE_INITIAL-then-satisfy.

---

## 7. Resolver comparison headline (full detail in deliverable C)

Across all 51 applicable pairs:

| Comparison outcome | Count |
|---|---|
| Both resolvers agree (compliant) | 10 |
| Both resolvers agree (not-compliant) | 41 |
| **Legacy compliant, new resolver outstanding (reversal)** | **0** |
| **Legacy noncompliant, new resolver compliant** | **0** |

**Zero unexplained reversals.** The 7-state resolver's inputs
reconcile to the legacy resolver's inputs exactly on current data
because:
1. Current staging has zero obligations → the new resolver's
   "outstanding" state is driven only by missing completions.
2. All historical completions on applicable courses were created
   against the current published version (no retired-version
   completions that the new resolver would reject).

See deliverable C for the per-pair matrix.

---

## 8. Scheduling-eligibility impact (§8 of directive)

The legacy `resolveEmployeeSchedulingEligibility` is read by the
scheduling resolver + the Employee Portal rail + the admin workflow
pages. Scheduling eligibility blocks a shift assignment when
required training is not completed. The impact register's
`schedulingImpact` column cross-walks:

| Outcome | Pair count | Meaning |
|---|---|---|
| `same` | 10 | Legacy "complete" ↔ New "compliant" — identical scheduling outcome. |
| `already-blocked` | 41 | Legacy "incomplete" ↔ New "outstanding" — the employee was already blocked under the legacy resolver and remains blocked under the new one. **No new blocks.** |
| `none` | 2 | No applicable courses — scheduling not affected. |
| `newly-blocked` | **0** | — |
| `newly-allowed` | **0** | — |

**No employee experiences a change in scheduling allow/deny on
activation.** The behaviour difference between legacy and new
resolver manifests as "the UI shows an obligation chip + reason
note" rather than "no training completion found" — identical
scheduling-decision outcome.

The existing enforcement policy is:
- Scheduling blocks are advisory in several hospitality workflows
  and hard-blocking in others; this slice did not re-audit the
  per-surface enforcement policy. **See Approval Checklist §6 for
  the explicit founder decision on whether obligations should
  immediately drive scheduling enforcement or only after a separate
  decision.**

Introducing OUTSTANDING obligations without changing the
scheduling resolver is **safe** — the existing enforcement reads
`eligible: false` identically.

---

## 9. Risks + blockers

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Issuing an obligation against the founder (Chris Turcato) violates the preservation standing instruction | **High** | Default execution plan **excludes the founder** from CREATE_INITIAL. Founder-level override required to include. |
| R2 | Issuing obligations against FounderDemo creates visible demo artefacts on Coulee Ridge dashboards | Medium | Default execution plan **excludes FounderDemo** pending founder decision. |
| R3 | PAY1A-Test-A/B fixtures create non-trivial obligations if misclassified as legitimate | Medium | Default execution plan **excludes INCOMPLETE_ONBOARDING** cohorts. Founder decision needed. |
| R4 | A new OUTSTANDING obligation on an employee NOT currently reading `resolveActiveObligationForSession` for scheduling impact | Low | Verified: current scheduling resolver is unchanged; obligations are present-but-dormant for scheduling until a separate decision. |
| R5 | Backfill failure part-way through leaves partial state | Low | Execution plan proposes per-employee transactions + explicit audit on each; failure replays from the first employee without a successful audit row. |
| R6 | Idempotency breaks if the issuanceKey format changes between 5C-4A design and 5C-4B execution | Low | Schema composite UNIQUE protects against duplicate same-key insertion. Rerun safety invariant stays. |
| R7 | A new PUBLISHED course version lands between register generation and backfill execution | Low | 5C-4B plan requires a fresh register generation inside the deploy window. |

---

## 10. Readiness recommendation

**Ready to proceed to EP-TRAIN-5C-4B with a NARROW scope on
founder authorization.**

Recommended narrow scope (strictly the safe subset):
- **1 employee** — Marc Maldiney (`E-00003`)
- **8 CREATE_INITIAL obligations** — the 8 applicable Coulee Ridge
  courses he has not completed.
- **Tenant scope** — Coulee Ridge only (`clubId=cmrvdeny7000144372ktmmg9c`)

This narrow scope exercises every code path (apply, idempotency,
audit, resolver cutover) with the lowest blast radius and provides
founder-visible evidence of the activation working against a single
legitimate active employee. Expansion to FounderDemo and (if
reclassified) PAY1A-Test-A/B becomes a follow-up slice after this
narrow slice is accepted.

The 10 PRESERVE_COMPLIANT rows do NOT create obligations by design
and are not in the backfill set — they are the proof the
preservation invariant works.

### 10.1 What is NOT ready

- Issuing obligations against the founder (R1) — needs explicit
  override.
- Issuing obligations against FounderDemo (R2) — needs decision.
- Classification of PAY1A-Test-A/B (R3) — needs decision.
- Scheduling-enforcement change — not scoped to this activation; a
  separate decision follows.

---

## 11. STOP boundary

Not initiating (per directive §13):
- Executing the INITIAL obligation backfill (deferred to 5C-4B).
- Activating the global compliance resolver.
- Changing scheduling-eligibility enforcement.
- Deleting staging fixtures.
- Deploying to production.
- Redesigning the Employee Portal.
- Modifying accepted training workflows.
- Starting EP-TRAIN-5C-4B.

Awaiting founder authorization + the §10 decision set (Approval
Checklist) before any writes.
