# EP-TRAIN-5C-4A — Founder Approval Checklist

**Status:** Decision gate — EP-TRAIN-5C-4B cannot begin until every
item below is answered.

**Author:** Model (EP-TRAIN-5C-4A audit).
**Required approver:** Founder.
**Baseline at authoring time:** `spectre-staging:sha-a6bf36202d71` (Fly v1074).

Companion deliverables:
- `ep-train-5c4a-readiness-report.md` — audit summary.
- `ep-train-5c4a-backfill-impact-register.csv` — per-pair detail.
- `ep-train-5c4a-resolver-comparison.md` — legacy vs new.
- `ep-train-5c4a-execution-plan.md` — proposed 5C-4B.

Return decisions in writing (e.g., inline response or a signed
message). Any decision left unanswered defaults to the SKIP /
EXCLUDE option per the Readiness Report §10 narrow scope.

---

## §1 — Founder's own training record

**Decision needed:** Should EP-TRAIN-5C-4B issue INITIAL
obligations against Chris Turcato (`E-00002`) for the 2 courses
he has not completed on their current published version
(EQUIPMENT_SAFETY_2026, GAS_VERSUS_DIESEL)?

| Option | Default |
|---|---|
| (a) **NO — do not issue obligations against the founder.** The founder-preservation standing instruction overrides the default CREATE_INITIAL recommendation. | ✅ **Default** |
| (b) YES — treat the founder like any other legitimate active employee. Note: this would create 2 OUTSTANDING obligations visible on Coulee Ridge dashboards + the admin controller UI. |  |

**Rationale for default:** Every prior slice's directive memory
("Do not issue obligations against the founder") treats this
employee as an untouchable preservation target. Changing that
requires an explicit override.

---

## §2 — Mandatory course scope

**Decision needed:** Confirm that all 10 Coulee Ridge courses
flagged `required: true` + `appliesToAll: true` are MANDATORY under
the obligation model. The courses are:

- ORIENTATION_2027 (Coulee Ridge Staff Orientation)
- EQUIPMENT_SAFETY_2026 (Equipment Safety)
- FIRE_SAFETY (Fire Safety)
- FOOD_SAFETY_2026 (Food Handling and Safety 2026)
- DEMO_FR_SAFETY (Founder Demo – Safety & Training)
- KNIFE_SAFETY_2026 (Knife Safety)
- ROOFTOP_SAFETY_2026 (Rooftop Safety 2026)
- SAFE-BASICS (Safety Basics)
- GAS_VERSUS_DIESEL (The benefits of Gas vs Diesel)
- B31_STAGING_ACCEPTANCE (Workplace Safety Orientation)

**Note:** `DEMO_FR_SAFETY` is explicitly a "Founder Demo"
course — intended to showcase the training workflow. The founder
should confirm whether this demo course should participate in the
backfill against legitimate employees or should be marked
appliesToAll=false to exclude it from mandatory applicability.

| Option | Default |
|---|---|
| (a) All 10 are mandatory, DEMO_FR_SAFETY included. | ✅ **Default** |
| (b) All 10 are mandatory, DEMO_FR_SAFETY excluded (demo course should not create obligations on real employees). |  |
| (c) Some other subset — specify. |  |

---

## §3 — FounderDemo employee treatment

**Decision needed:** Should EP-TRAIN-5C-4B issue 10 INITIAL
obligations against `E-FOUNDER-DEMO` (FounderDemo DemoEmployee,
Coulee Ridge, LEGITIMATE_ACTIVE)?

| Option | Default |
|---|---|
| (a) **NO — exclude from 5C-4B.** FounderDemo appears to be a demo-only employee intentionally maintained for founder-visible dashboard examples. Issuing 10 OUTSTANDING INITIAL against this employee would clutter Coulee Ridge dashboards + make the demo artefact look like a real compliance problem. | ✅ **Default** |
| (b) YES — treat as a legitimate active employee. Produces 10 OUTSTANDING INITIAL obligations. Dashboards show the demo employee as noncompliant until a backfill completion is recorded (which is a demo artefact and would require manual completion seeding). |  |
| (c) Reclassify as FIXTURE (do not delete, but tag as fixture via a new classification signal, e.g., employeeNumber prefix `E-FOUNDER-DEMO`). Future runs auto-skip. |  |

**If (a) is selected, no action is required in 5C-4B.** If (c) is
selected, add a prefix rule to `scripts/ep-train-5c4a-impact-register.mjs`
and `scripts/ep-train-5c1-obligation-backfill-dryrun.mjs` before
the next regeneration.

---

## §4 — PAY1A-Test-A / PAY1A-Test-B classification

**Decision needed:** Should EP-TRAIN-5C-4B treat the two
`E-PAY1A-Test-*` employees as FIXTURE (skip) or as INCOMPLETE_ONBOARDING
(wait for onboarding approval, no backfill)?

Current state:
- Both sit in the real Coulee Ridge tenant.
- Both have `onboardingState = DRAFT`.
- Both are flagged `LEGITIMATE_ACTIVE` on `status` / `lifecycle` but
  `INCOMPLETE_ONBOARDING` on `onboardingState`.
- Neither has any training completion.
- Both are tagged with employeeNumbers that look like fixture
  prefixes (`PAY1A-Test-*`) but the current classifier does not
  recognize this prefix as a fixture signal.
- 20 pairs are flagged REVIEW_REQUIRED pending this decision.

| Option | Default |
|---|---|
| (a) **FIXTURE — skip in 5C-4B.** Add a classifier rule to recognize `E-PAY1A-Test-*` as fixtures (do not delete). 20 REVIEW_REQUIRED rows become 20 SKIP_FIXTURE. | ✅ **Default** |
| (b) INCOMPLETE_ONBOARDING — skip in 5C-4B but revisit after onboarding is approved. 20 REVIEW_REQUIRED rows become 20 SKIP_INACTIVE / INCOMPLETE_ONBOARDING. |  |
| (c) LEGITIMATE_ACTIVE — treat like Marc, issue 10 INITIAL obligations against each. |  |
| (d) Delete the fixture rows (destructive — requires separate authorization). |  |

If (a) is selected, update the classifier rule before 5C-4B's
register regeneration (per the plan's P5 precondition).

---

## §5 — Ambiguous employee-course applicability

**Decision needed:** The register currently assumes every
`appliesToAll: true` course applies to every legitimate active
employee in the club. Confirm this is correct, OR identify any
edge cases where applicability should be narrower.

Current staging has no cases requiring resolution — all 51
applicable pairs resolve via `appliesToAll`. No department /
position / assigned-employee gating is in play.

| Option | Default |
|---|---|
| (a) **Policy is correct as-is.** | ✅ **Default** |
| (b) Add a department / position / assignment constraint — specify. |  |

---

## §6 — Scheduling-enforcement timing

**Decision needed:** The 5C-4B backfill creates OUTSTANDING
obligations but does NOT change the scheduling resolver. However,
once activated, the obligation-aware resolver will drive scheduling
eligibility decisions.

Should outstanding training obligations:
| Option | Default |
|---|---|
| (a) **Immediately affect scheduling** after the obligation-aware resolver is activated. (Note: current legacy resolver already blocks for missing completions, so for the Marc cohort there is zero effective delta — this choice sets the policy for FUTURE REVISION / MANUAL_REINSTATE obligations.) | ✅ **Default** |
| (b) NOT affect scheduling — treat OUTSTANDING as a dashboard advisory only, with no block on shift assignment. Requires a separate scheduling-eligibility code path change. |  |

**Note:** This decision does NOT block 5C-4B — scheduling-enforcement
semantics are not touched by the backfill itself. 5C-4C (resolver
cutover) is where this policy lands.

---

## §7 — Activation cohort scope

**Decision needed:** Choose the exact authorized cohort for
5C-4B's first execution.

| Option | Default |
|---|---|
| (a) **Narrow — Marc only (8 obligations).** | ✅ **Default** per Readiness Report §10 |
| (b) Narrow + FounderDemo (18 obligations). |  |
| (c) All LEGITIMATE_ACTIVE except founder (18 obligations: Marc 8 + FounderDemo 10). |  |
| (d) All LEGITIMATE_ACTIVE including founder (20 obligations: Marc 8 + FounderDemo 10 + Chris 2). |  |
| (e) All resolved CREATE_INITIAL + reclassified PAY1A-Test-* (if §4=a, +20 FIXTURE skip; if §4=c, +20 execute). |  |
| (f) Coulee Ridge only, in all cases. |  |

**Recommended default (a) because:**
- Smallest blast radius.
- Exercises every code path (apply, idempotency, audit, resolver outputs).
- Zero effective scheduling delta.
- Easy rollback.

---

## §8 — Rollback method

**Decision needed:** Confirm the preferred rollback method for
accidentally-issued obligations.

| Option | Default |
|---|---|
| (a) **CANCELED-status update.** Preserves audit trail. Reversible. Non-destructive. | ✅ **Default** |
| (b) Destructive deletion (`deleteMany`). Removes audit trail. Requires separate authorization per plan §7.3. |  |

---

## §9 — DEMO_FR_SAFETY course policy

**Decision needed:** The Coulee Ridge course `DEMO_FR_SAFETY`
(Founder Demo – Safety & Training) is tagged `appliesToAll: true`
+ `required: true`. Should it:

| Option | Default |
|---|---|
| (a) **Remain required for all employees in the club.** FounderDemo-cohort obligations include it. | ✅ **Default** |
| (b) Be reclassified as non-required / applicability-false so it does not create backfill obligations against real employees. (Would require an admin workflow outside 5C-4B.) |  |

---

## §10 — Timing + authorization

**Decision needed:** When should EP-TRAIN-5C-4B execute, and
what evidence is required?

| Item | Required |
|---|---|
| Separate written founder authorization for EP-TRAIN-5C-4B | ✅ |
| DB snapshot captured before execution | ✅ |
| Rollback anchor documented | ✅ |
| Acceptance report drafted post-run before founder sign-off | ✅ |
| Playwright authenticated V2 (Marc's dashboard) before founder sign-off | ✅ |
| Chris's dashboard unchanged screenshot | ✅ |

---

## Summary — minimum answers required to proceed

For the recommended narrow scope (Marc only, 8 obligations, CANCELED
rollback), the following must be answered:

1. §1 — Founder's own record: **(a) NO** confirmed.
2. §2 — Mandatory course scope: **(a) all 10 mandatory** or alternative specified.
3. §3 — FounderDemo: **(a) exclude** confirmed.
4. §4 — PAY1A-Test-A/B: **(a) FIXTURE skip** OR alternative specified.
5. §5 — Applicability policy: **(a) correct as-is** confirmed.
6. §6 — Scheduling-enforcement timing: either (a) or (b), noting 5C-4B is unaffected either way.
7. §7 — Activation cohort scope: **(a) Marc only** confirmed, OR alternative specified.
8. §8 — Rollback method: **(a) CANCELED-status** confirmed.
9. §9 — DEMO_FR_SAFETY: **(a) remain required** confirmed.
10. §10 — Timing: authorization window + evidence requirements acknowledged.

Once all 10 answers are received, EP-TRAIN-5C-4B can be
authorized and executed per the execution plan.
