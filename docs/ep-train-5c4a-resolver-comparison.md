# EP-TRAIN-5C-4A — Legacy vs Obligation-Aware Resolver Comparison

**Status:** Read-only comparison completed 2026-11-02.
**Baseline:** `spectre-staging:sha-a6bf36202d71` (Fly v1074).

**Both resolvers were executed inside the same transaction snapshot
against the current staging DB.** Neither was activated or changed
as the authoritative scheduling gate. The purpose is to prove that
activating the new resolver produces no surprising reversals.

Companion deliverables:
- `ep-train-5c4a-readiness-report.md` — audit summary.
- `ep-train-5c4a-backfill-impact-register.csv` — per-pair detail.
- `ep-train-5c4a-execution-plan.md` — proposed 5C-4B.
- `ep-train-5c4a-founder-approval-checklist.md` — decisions blocking any write.

---

## 1. The two resolvers

| | Legacy | Obligation-aware (new) |
|---|---|---|
| Location | `src/lib/hr/training/applicability.ts:202` | `src/lib/hr/training/compliance-resolver.ts:98` |
| Function | `resolveEmployeeSchedulingEligibility(employeeId)` | `resolveEmployeeTrainingCompliance(employeeId)` |
| State model | 2-state: `completed` ↔ `not-completed` | 7-state: `NO_REQUIREMENT`, `INITIAL_REQUIRED`, `COMPLIANT`, `UPDATED_REQUIRED`, `RETAKE_REQUIRED`, `IN_PROGRESS`, `MULTIPLE_OUTSTANDING` |
| Completion check | ANY TrainingCompletion row on course (version-agnostic) | TrainingCompletion AND no OUTSTANDING TrainingObligation on current version |
| Applicability | `resolveApplicableCourses` (same helper) | `resolveApplicableCourses` (same helper) |
| Active in production | ✅ Yes — hard-blocks scheduling | 🚫 Dormant — defined + tested but not read by any production code path |

Both share the same applicability resolver, so the universe of
(employee, course) pairs is identical.

---

## 2. Comparison methodology

For each of the 51 applicable employee-course pairs on current
staging, the two resolvers produce one of two decisions:
- `compliant` — the employee meets the training requirement.
- `noncompliant` — the employee does not meet the training
  requirement (legacy) or has an OUTSTANDING obligation (new).

Pre-activation (TODAY), the new resolver's `outstanding` state is
driven solely by missing completions (because zero obligations
exist). The comparison therefore reduces to:

- **Legacy "compliant"**: ANY TrainingCompletion on `courseId`.
- **New "compliant"**: Completion on `courseVersionId == currentVersionId` AND no OUTSTANDING obligation.

The two differ only when a historical completion exists on a
PREVIOUS version of a currently-published course. The dry-run
reports zero such mismatches on current staging data.

---

## 3. Pair-level matrix (all 51 applicable pairs)

| Legacy outcome | New outcome | Count | Explanation |
|---|---|---|---|
| compliant | COMPLIANT | **10** | Historical completion on current version. Both resolvers agree. |
| noncompliant | INITIAL_REQUIRED | **41** | No completion exists for the current version. Legacy classifies as "not-completed"; new classifies as "initial-required" (which becomes OUTSTANDING once a backfill issues an INITIAL obligation). Effective scheduling outcome identical: `eligible: false`. |
| compliant | **UPDATED_REQUIRED / RETAKE_REQUIRED** | **0** | A REVISION or MANUAL_REINSTATE obligation would downgrade a formerly-compliant employee to outstanding. **None exist today**, so no reversals. |
| noncompliant | COMPLIANT | **0** | — |
| compliant | IN_PROGRESS | **0** | — |
| compliant | MULTIPLE_OUTSTANDING | **0** | — |

**The acceptable number of unexplained reversals is zero. The
observed number is zero.** This confirms the directive §7
safety invariant.

### 3.1 PRESERVE_COMPLIANT rows (10)

| Employee | Course | Historical completion |
|---|---|---|
| E-00002 Chris Turcato | FIRE_SAFETY | id `cmv…` on current version |
| E-00002 Chris Turcato | FOOD_SAFETY_2026 | current version |
| E-00002 Chris Turcato | DEMO_FR_SAFETY | current version |
| E-00002 Chris Turcato | KNIFE_SAFETY_2026 | current version |
| E-00002 Chris Turcato | ORIENTATION_2027 | current version |
| E-00002 Chris Turcato | ROOFTOP_SAFETY_2026 | current version |
| E-00002 Chris Turcato | SAFE-BASICS | current version |
| E-00002 Chris Turcato | B31_STAGING_ACCEPTANCE | current version |
| E-00003 Marc Maldiney | SAFE-BASICS | current version |
| E-00003 Marc Maldiney | GAS_VERSUS_DIESEL | current version |

Every historical completion is on the course's `currentVersionId`.
Legacy and new resolvers both read "compliant"; no version-sensitive
downgrade.

### 3.2 Noncompliant rows (41)

Breakdown by employee + classification:

| Employee | Classification | Count | Legacy says | New says |
|---|---|---|---|---|
| E-00003 Marc Maldiney | LEGITIMATE_ACTIVE | 8 | noncompliant | INITIAL_REQUIRED |
| E-FOUNDER-DEMO | LEGITIMATE_ACTIVE (demo) | 10 | noncompliant | INITIAL_REQUIRED |
| E-00002 Chris Turcato | LEGITIMATE_ACTIVE (founder) | 2 | noncompliant | INITIAL_REQUIRED |
| E-PAY1A-Test-A | INCOMPLETE_ONBOARDING | 10 | noncompliant | INITIAL_REQUIRED |
| E-PAY1A-Test-B | INCOMPLETE_ONBOARDING | 10 | noncompliant | INITIAL_REQUIRED |
| FIX-HR2B5-DE9D6AA055 Alex Fixture | FIXTURE | 1 | noncompliant | INITIAL_REQUIRED |

In every row the two resolvers agree the employee has not met the
training requirement. Legacy returns "not-completed"; new returns
"INITIAL_REQUIRED" (which transitions to a concrete OUTSTANDING
obligation once a backfill issues the INITIAL row). The effective
scheduling outcome is identical: `eligible: false` on both.

---

## 4. Why there are no reversals

### 4.1 No historical completions on retired course versions

A reversal (legacy=compliant, new=outstanding) would occur if an
employee had completed an OLDER version of a currently-published
course. The dry-run checked every applicable pair:

- 2 courses have RETIRED prior versions: `B31_STAGING_ACCEPTANCE
  v1`, `ORIENTATION_2027 v1`.
- Chris's `B31_STAGING_ACCEPTANCE` completion is on the CURRENT
  version (not v1). Chris's `ORIENTATION_2027` completion is on
  the CURRENT version (not v1). No reversal.
- Marc's completions are on `SAFE-BASICS` and `GAS_VERSUS_DIESEL`,
  neither of which has a RETIRED prior version.

The B31 and Orientation `v1` RETIRED versions pre-date the current
staging dataset's completion rows.

### 4.2 No existing REVISION or MANUAL_REINSTATE obligations

With zero obligations present pre-activation, the new resolver has
no path to turn a compliant employee into outstanding beyond the
retired-version check above. Any future REVISION or
MANUAL_REINSTATE operation after activation will go through the
real admin workflow (EP-TRAIN-5B / 5C-3B flows) — the backfill
itself issues only INITIAL and only against employees with no
qualifying completion.

### 4.3 No applicability change

Both resolvers call `resolveApplicableCourses`, which produces an
identical input set. The classification table in the Readiness
Report is byte-identical when derived from the legacy helper or
the new resolver's internal applicability pass.

---

## 5. Scheduling-eligibility outcome summary

| Pair count | Legacy says | New says (post-backfill) | Scheduling outcome |
|---|---|---|---|
| 10 | compliant | COMPLIANT | ✅ allowed — unchanged |
| 20 (Marc 8 + FounderDemo 10 + Chris 2) | noncompliant | OUTSTANDING (INITIAL) | ❌ blocked — unchanged (was already blocked) |
| 20 (PAY1A × 2) | noncompliant | INITIAL_REQUIRED (dormant until decision) | ❌ blocked — unchanged |
| 1 (Alex Fixture) | noncompliant | OUTSTANDING if executed, else INITIAL_REQUIRED | ❌ blocked — unchanged |
| 2 (SE-ZH-01, SC-D22B) | n/a | NO_REQUIREMENT | ✅ allowed — unchanged |

**No employee gains or loses scheduling eligibility on activation.**
The new resolver surfaces a richer failure reason ("Updated Training
Required" / "Retake Required" / "Multiple Outstanding") in the UI
but the block/allow bit is unchanged.

---

## 6. Edge cases that WOULD cause a reversal (not present today)

Documented for the 5C-4B pre-flight checklist:

1. **A completion row with `courseVersionId != currentVersionId`
   on a currently-published course.** Legacy=compliant, new=outstanding
   (the completion is "stale" per the version-sensitive rule).
   *Current count: 0.*

2. **An existing OUTSTANDING REVISION obligation on a course where
   the employee has a historical completion.** Legacy=compliant,
   new=UPDATED_REQUIRED. *Current count: 0.*

3. **An existing OUTSTANDING MANUAL_REINSTATE obligation on a
   course where the employee has a historical completion.**
   Legacy=compliant, new=RETAKE_REQUIRED. *Current count: 0.*

The 5C-4B execution plan recommends regenerating the register
immediately before backfill to re-verify all three counts remain
zero.

---

## 7. Conclusion

Activating the obligation-aware resolver on the current staging
dataset produces **zero compliance reversals and zero scheduling
reversals**. The visible effect on dashboards + course pages is:
- Reason strings become more specific ("Updated Training Required",
  "Retake Required").
- Dashboard rails may show new obligation chips once INITIAL
  obligations are issued (and only for the exact cohort the
  backfill scope targets).

The resolver cutover is safe to proceed in a controlled 5C-4B
window with the narrow Marc-only scope recommended in the
Readiness Report §10. Expansion to FounderDemo + reclassified
PAY1A fixtures is a follow-up decision after the narrow slice is
accepted.
