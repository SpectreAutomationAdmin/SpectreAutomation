# EP-TRAIN-5D-3B — Controlled Cancellation Acceptance + v3 Integrity Review

**Status:** READY FOR ACCEPTANCE on staging 2026-11-02.

**Baseline:** `spectre-staging:sha-b2d47f1ebe90` (Fly v1083; same server code as 5D-3's `sha-00ef2887abd7`; 5D-3A was docs-only).
**Rollback anchor:** `sha-79b05f36616d` (Fly v1076, pre-5D-3).
**Health:** `/api/health` → 200 before + after.
**Writes performed:** 5 `TrainingObligation` status transitions + 7 `AuditLog` rows (5 per-row cancellations + 2 run-level summaries). Zero deletions.

---

## 1. Approved target set (directive §2) and exact obligation IDs

Five OUTSTANDING REVISION obligations issued by publication event
`f5771743-5940-4263-8e08-248a8c5221f7` on ORIENTATION_2027 v3
(`cmvzdjzt10002wu9jpfsp9hjc`), per the EP-TRAIN-5D-3A provenance
report:

| # | Obligation ID | Employee | IssuanceKey |
|---|---|---|---|
| 1 | `cmvzdkr1c001kwu9j9sd3esk5` | E-FOUNDER-DEMO FounderDemo DemoEmployee (`cmvvgku5e00022ml0iz618mul`) | `rev:f5771743-5940-4263-8e08-248a8c5221f7:cmvvgku5e00022ml0iz618mul` |
| 2 | `cmvzdkr54001nwu9jwv18toux` | E-00002 Chris Turcato (`cmu0fiaod000187prcy9ufo2d`) | `rev:f5771743-5940-4263-8e08-248a8c5221f7:cmu0fiaod000187prcy9ufo2d` |
| 3 | `cmvzdkr86001qwu9jckxe8wp2` | E-00003 Marc Maldiney (`cmu0ndf4p001vk9md2ntmo2ck`) | `rev:f5771743-5940-4263-8e08-248a8c5221f7:cmu0ndf4p001vk9md2ntmo2ck` |
| 4 | `cmvzdkrcy001twu9j5cgpnm68` | E-PAY1A-Test-A (`cmuizrw1w000cgmtia9hma0b6`) | `rev:f5771743-5940-4263-8e08-248a8c5221f7:cmuizrw1w000cgmtia9hma0b6` |
| 5 | `cmvzdkrgr001wwu9j5ohvu95b` | E-PAY1A-Test-B (`cmuizrw4j000ggmtiq6yutgtz`) | `rev:f5771743-5940-4263-8e08-248a8c5221f7:cmuizrw4j000ggmtiq6yutgtz` |

Tenant: `cmrvdeny7000144372ktmmg9c` (Coulee Ridge).
Course: `cmvvgznyf000gz9nu3nbqm09q` (ORIENTATION_2027).

---

## 2. Pre-execution safety checks (directive §3)

All PASS. Composite `allPreflightOk = true`.

| # | Check | Result |
|---|---|---|
| 1 | Staging + health 200 | **PASS** |
| 2 | Running image + Fly release recorded | `sha-b2d47f1ebe90` v1083 |
| 3 | All 5 targets scoped to Coulee Ridge tenant | **PASS** (clubId check inside tx) |
| 4 | All 5 currently OUTSTANDING + reason REVISION | **PASS** |
| 5 | None satisfied / canceled / superseded / modified since 5D-3A | **PASS** (`satisfiedByCompletionId=null`, `supersededByObligationId=null`, status unchanged) |
| 6 | No active TrainingProgress on v3 for any target | **PASS** (0 rows) |
| 7 | No TrainingAttempt on v3 for any target | **PASS** (0 attempts across all 5) |
| 8 | No TrainingCompletion linked to any target | **PASS** |
| 9 | Marc's v2 INITIAL (`cmvzb74ed…`) status SUPERSEDED + supersededByObligationId = `cmvzdkr86…` (target #3) | **PASS** |
| 10 | Marc's FIRE_SAFETY INITIAL (`cmvzb74i9…`) status OUTSTANDING | **PASS** |
| 11 | Global pre-counts recorded | obligations=7, completions=11, attempts=33, progress=12 |
| 12 | Rollback mechanism documented | Setting `status='OUTSTANDING'` on each of the 5 ids + writing a `rollback` audit row restores pre-execution state (not executed — see §12) |

Zero `refusedReasons`. Zero preflight failure.

---

## 3. Controlled cancellation (directive §4)

### 3.1 Mechanism

The cancellation replicates `src/lib/hr/training/obligations.ts::cancelObligation`
semantics exactly:

- Optimistic status guard: refuses if `status !== "OUTSTANDING"`.
- Transition: `OUTSTANDING → CANCELED`.
- Preserves: `issuanceKey`, `courseVersionId`, `reason`, `employeeId`, `clubId`, `courseId`, `issuedAt`, `dueAt`, `issuedByUserId`, `satisfiedByCompletionId`, `supersededByObligationId`.
- Mutates: `status` + `reasonNote` (appends `[canceled] <reason>` per the service's convention) + `updatedAt`.
- No deletion.

All 5 obligations plus all 6 audit rows (5 per-row + 1 run-level) committed inside a single `prisma.$transaction`.

The cancel reason recorded for every row:

> *"Founder-authorized cancellation: ORIENTATION_2027 v3 was published during exploratory administrative testing; associated REVISION requirement was unintended."*

### 3.2 Before vs after obligation status table

| # | Obligation ID | Before | After | IssuanceKey preserved | supersededBy / satisfiedBy |
|---|---|---|---|---|---|
| 1 | `cmvzdkr1c001kwu9j9sd3esk5` | OUTSTANDING | **CANCELED** | ✅ | null / null (preserved) |
| 2 | `cmvzdkr54001nwu9jwv18toux` | OUTSTANDING | **CANCELED** | ✅ | null / null (preserved) |
| 3 | `cmvzdkr86001qwu9jckxe8wp2` | OUTSTANDING | **CANCELED** | ✅ | null / null (preserved); Marc's SUPERSEDED INITIAL still points at this row |
| 4 | `cmvzdkrcy001twu9j5cgpnm68` | OUTSTANDING | **CANCELED** | ✅ | null / null (preserved) |
| 5 | `cmvzdkrgr001wwu9j5ohvu95b` | OUTSTANDING | **CANCELED** | ✅ | null / null (preserved) |

### 3.3 Audit chain (directive §4)

7 new `AuditLog` rows written:

| Action | Count | Entity type | Notes |
|---|---|---|---|
| `hr.training.obligation.cancel.rollback` | 5 | TrainingObligation (one per cancellation) | `beforeJson` carries the pre-cancel snapshot (status, reasonNote, courseVersionId, reason, issuanceKey, issuedAt, employeeId). `afterJson` carries the post-cancel snapshot + the cancel reason text + the cancelled eventId + the slice name. |
| `hr.training.backfill.cancel.run` | 2 | TrainingCourseVersion (ORIENTATION_2027 v3) | Summary row written at the end of the cancellation transaction (`canceledCount: 5`) + a second row from the idempotency rerun (`canceledCount: 0, alreadyCanceledCount: 5`). |

Example per-obligation audit payload (obligation #3, Marc's REVISION):

```json
{
  "action": "hr.training.obligation.cancel.rollback",
  "entityType": "TrainingObligation",
  "entityId": "cmvzdkr86001qwu9jckxe8wp2",
  "beforeJson": "{...status:OUTSTANDING, reasonNote:null, courseVersionId:cmvzdjzt10002wu9jpfsp9hjc, reason:REVISION, issuanceKey:rev:f5771743-...:marc, issuedAt:2026-11-02T14:49:42.101Z, employeeId:cmu0ndf4p001vk9md2ntmo2ck}",
  "afterJson": "{...status:CANCELED, reasonNote:[canceled] Founder-authorized cancellation: ..., cancelReason:Founder-authorized cancellation: ORIENTATION_2027 v3 was published during exploratory administrative testing..., eventIdCanceled:f5771743-5940-4263-8e08-248a8c5221f7, slice:EP-TRAIN-5D-3B}",
  "clubId": "cmrvdeny7000144372ktmmg9c",
  "userId": "cmrvdenz700034437agp7gqs5"
}
```

The audit chain reconstructs the full lineage: the original REVISION issuance event (`rev:f5771743-…` in the preserved `issuanceKey`), the authorised cancellation reason, and the slice identifier for forensic traceability.

### 3.4 Idempotency rerun

Executed the identical script a second time. Result:
`perTarget: [{action:"already-canceled"} × 5]`.

The optimistic guard refused all 5 (status !== OUTSTANDING). Zero obligation rows mutated on the second run. One additional run-level audit written noting `canceledCount: 0, alreadyCanceledCount: 5`.

**No duplicate CANCELED transitions. No second supersession. No creation of replacement obligations.**

---

## 4. Marc Maldiney obligation lineage (directive §5)

| Obligation ID | Reason | Status | Course version | Issuance key | Note |
|---|---|---|---|---|---|
| `cmvzb74ed0002g41rrbxtlyk5` | INITIAL | **SUPERSEDED** (unchanged) | ORIENTATION_2027 v2 (RETIRED) | `init:5c4b-marc-pilot:v2` | Still carries `supersededByObligationId=cmvzdkr86001qwu9jckxe8wp2`. The SUPERSEDED→SUPERSEDED pointer is deliberately retained even though the referenced row is now CANCELED (preserves historical relationship per directive §5). |
| `cmvzdkr86001qwu9jckxe8wp2` | REVISION | **CANCELED** | ORIENTATION_2027 v3 | `rev:f5771743-…:marc` | Just-cancelled. |
| `cmvzb74i90007g41ryj0d7rc2` | INITIAL | **OUTSTANDING** (unchanged) | FIRE_SAFETY v1 | `init:5c4b-marc-pilot:v1` | Preserved. Marc's active pilot obligation. |

**Marc's SUPERSEDED INITIAL on v2 was NOT reopened.** The `status` stays SUPERSEDED, the `supersededByObligationId` pointer stays. The directive §5 explicitly prohibits reopening or clearing — honoured.

**Marc's FIRE_SAFETY INITIAL stays OUTSTANDING unchanged.**

### 4.1 Marc's effective ORIENTATION_2027 compliance after cancellation

- No persisted OUTSTANDING obligation on ORIENTATION_2027 (v3 REVISION canceled).
- Marc has no TrainingCompletion on v3 (current PUBLISHED).
- Marc has no TrainingCompletion on v2 (RETIRED) either.
- The compliance resolver (`resolveEmployeeTrainingCompliance`) + legacy scheduling resolver both classify ORIENTATION_2027 as **INITIAL_REQUIRED_INFERRED** for Marc — the resolver INFERS a requirement because the course is `required + applicable + no completion`, with no persisted obligation driving the state.

This is exactly the inferred-vs-persisted distinction the directive §7 asked us to preserve: *"The existing resolver may continue to infer INITIAL_REQUIRED from a required, applicable published course even when no active obligation exists. Do not change that resolver behaviour during this slice."*

Marc's dashboard (per the 5C-4B-α UI distinction) now shows ORIENTATION_2027 with the generic chip-suppressed "Required" label (inferred), **NOT** the amber "Initial Training Required" (which requires a persisted INITIAL obligation).

Marc's FIRE_SAFETY card still shows the amber "Initial Training Required" chip (persisted INITIAL obligation unchanged).

**No new obligation issued to Marc for ORIENTATION_2027.** Directive §5 prohibits that explicitly.

---

## 5. Historical record preservation (directive §6)

| Record | Expected | Observed |
|---|---|---|
| Founder completions | 9 | **9** ✅ |
| Founder attempts | 30 | **30** ✅ |
| Founder progress | 9 | **9** ✅ |
| Founder's v3 REVISION obligation (`cmvzdkr54…`) | OUTSTANDING → CANCELED, history retained | ✅ CANCELED, issuanceKey preserved, issuedAt preserved |
| Marc FIRE_SAFETY INITIAL | OUTSTANDING, unchanged | **OUTSTANDING** ✅ |
| Marc v2 INITIAL | SUPERSEDED, unchanged | **SUPERSEDED** ✅ |
| Marc v3 REVISION | OUTSTANDING → CANCELED after execution | **CANCELED** ✅ |
| Global TrainingCompletion count | 11 | **11** (no change) ✅ |
| Global TrainingAttempt count | 33 | **33** (no change) ✅ |
| Global TrainingProgress count | 12 | **12** (no change) ✅ |
| Global TrainingObligation **row count** (status transitions only) | 7 | **7** (0 deletions) ✅ |
| ByStatus distribution | OUTSTANDING: 1, SUPERSEDED: 1, CANCELED: 5 | ✅ |
| ByReason distribution | INITIAL: 2, REVISION: 5 | ✅ (unchanged) |

**No unintended obligation creation. No status change outside the 5 approved targets. No employee or tenant touched beyond the 5 affected rows.**

---

## 6. Post-cancellation compliance verification (directive §7)

### 6.1 Per-employee ORIENTATION_2027 state after cancellation

| Employee | Active obligation | Resolver state | Effective employee-facing display |
|---|---|---|---|
| E-FOUNDER-DEMO | `null` | INITIAL_REQUIRED (inferred) | Chip-suppressed "Required"; "Not Started" state pill. No amber "Initial Training Required". |
| E-00002 Chris Turcato (founder) | `null` | INITIAL_REQUIRED (inferred) | Same as above. The amber "Updated Training Required" that would have shown pre-cancel is now gone. |
| E-00003 Marc Maldiney | `null` | INITIAL_REQUIRED (inferred) | Same. His FIRE_SAFETY amber chip remains unchanged. |
| E-PAY1A-Test-A | `null` | INITIAL_REQUIRED (inferred) | Same. |
| E-PAY1A-Test-B | `null` | INITIAL_REQUIRED (inferred) | Same. |

### 6.2 Legacy scheduling eligibility comparison

The legacy scheduling resolver reads TrainingCompletion only; obligations have no effect on it. Pre-cancel vs post-cancel is identical:

| Employee | Pre-cancel `eligible` | Pre-cancel outstanding count | Post-cancel `eligible` | Post-cancel outstanding count | Delta |
|---|---|---|---|---|---|
| E-FOUNDER-DEMO | false | 10 | false | 10 | **unchanged** |
| E-00002 Chris Turcato | false | 3 | false | 3 | **unchanged** |
| E-00003 Marc Maldiney | false | 8 | false | 8 | **unchanged** |
| E-PAY1A-Test-A | false | 10 | false | 10 | **unchanged** |
| E-PAY1A-Test-B | false | 10 | false | 10 | **unchanged** |

**No scheduling-enforcement change.** The legacy resolver was unaffected by the cancellation (as expected — it reads completions, not obligations).

### 6.3 Compliance verification checklist (directive §7)

| Check | Result |
|---|---|
| No employee sees active "Updated Training Required" solely from canceled v3 obligation | ✅ All 5 `activeObligationId = null` |
| Canceled obligations remain available in historical/audit views | ✅ Rows preserved; audit chain intact |
| Marc's Fire Safety requirement remains visible | ✅ OUTSTANDING INITIAL on FIRE_SAFETY v1 unchanged |
| No employee incorrectly compliant solely because an obligation was canceled | ✅ All 5 still inferred as INITIAL_REQUIRED by the resolver (no false-positive compliance) |
| No scheduling enforcement change | ✅ Legacy outstandingCounts byte-identical |
| Inferred requirements reported separately from persisted obligations | ✅ Per §4.1 above |

---

## 7. v2 vs v3 integrity assessment (directive §8)

Comparison of the two course versions (v2 RETIRED, v3 PUBLISHED):

| Attribute | v2 (RETIRED) | v3 (PUBLISHED) | Observation |
|---|---|---|---|
| Title | "Coulee Ridge Staff Orientation" | "Coulee Ridge Staff Orientation" | identical |
| Description | — (not captured in diff) | "Orientation for the upcoming golf season" | v3 adds a description |
| Applicability (`appliesToAll`) | true | true | unchanged |
| Required | true | true | unchanged |
| Passing threshold | (unknown in snapshot) | 85 | v3 raised (was 80 per 5C-4A audit) |
| Video storage key | present | present (same key family) | identical video asset |
| Video duration | — | 51 s | — |
| **Checkpoint count** | **2** | **0** | **DEFECT:** v3 lost both checkpoints during pre-5D-3 clone |
| Checkpoint details (v2) | CP1 + CP2 with configured retries | — | — |
| **Question count** | **6 total** | **6 total** | preserved |
| **Checkpoint-bound questions** | **2** (one `SINGLE_CHOICE` bound to CP1, one `TRUE_FALSE` bound to CP2) | **0** | **DEFECT:** `checkpointId` dropped by pre-5D-3 clone |
| **Final-assessment questions** | **4** (all `SINGLE_CHOICE`) | **6** (all `SINGLE_CHOICE`) | 2 formerly checkpoint-bound questions migrated into the final-assessment bucket |
| **Question type on "Ta dah?"** | **`TRUE_FALSE`** | **`SINGLE_CHOICE`** | **DEFECT:** questionType downgraded by pre-5D-3 clone |
| Option count per question | 2 to 4 | 2 to 4 | preserved |
| Correct-answer count per question | 1 | 1 | preserved (quiz still functionally gradable) |
| v3 TrainingCompletion rows | — | **0** | No employee has engaged with v3 since publish |
| v3 TrainingAttempt rows | — | **0** | — |
| v3 TrainingProgress rows | — | **0** | — |

**Three specific defects observed on v3, all consistent with the pre-5D-3 `startNewDraft` clone bug fixed in commit `00ef288`:**

1. **0 checkpoints** vs v2's 2 — mid-video checkpoint learning moments are absent on v3.
2. **`checkpointId=null` on all 6 questions** vs v2's 2 CP-bound + 4 final — former CP-bound questions became orphaned final-assessment entries.
3. **"Ta dah?" question type SINGLE_CHOICE** vs v2's TRUE_FALSE — question UI renders differently from the authored intent.

### 7.1 Is v3 safe for employees to complete?

**No — but no employee has started v3 yet.** The quiz itself is technically gradable (every question has exactly one correct answer and non-empty options), but:

- The authored structure (2 checkpoints at `atSecond` positions, with 2 CP-bound questions) is lost.
- An employee completing v3 would watch the 51-second video with NO checkpoint overlays interrupting playback. The 2 formerly CP-bound questions appear only in the final assessment, with no video context.
- The "Ta dah?" question would render as a 2-option single-choice instead of a True/False toggle.
- The content is otherwise valid: video asset present, options present, correct answers configured.

**Zero employees have engaged with v3 (0 completions, 0 attempts, 0 progress).** The defective structure has not yet been experienced by any employee. The cancellation of the 5 REVISION obligations removes the only driver that would push employees toward v3.

---

## 8. Supported v3 remediation options (directive §9)

**NOT IMPLEMENTED in this slice.** Presented for founder decision.

### Option A — Preserve v3 temporarily with a documented integrity warning

- **Technical feasibility:** Trivial — zero DB writes required.
- **Historical preservation:** Perfect — v3 row intact, audit trail intact.
- **Employee impact:** v3 remains the current PUBLISHED version. Employees whose dashboard infers ORIENTATION_2027 as INITIAL_REQUIRED (all 5 Coulee Ridge actives) would see v3 if they click into the course. The video would play without checkpoint overlays; the quiz would present 6 single-choice questions.
- **Obligation impact:** None (no persisted obligations drive v3 engagement).
- **Risks:**
  - Any employee who completes v3 in this state would receive a `TrainingCompletion` on a defective version.
  - A future `startNewDraft` (post-5D-3 code) cloning from v3 would faithfully clone v3's structural defects into v4 (correct code, defective source).
- **Recommended approach:** NOT recommended as a long-term state. Acceptable as a short-term hold while the founder decides on Option B or C.

### Option B — Create a corrected v4 through the existing Revise Training workflow (post-5D-3 code)

- **Technical feasibility:** Supported by existing admin UI. `startNewDraft` (now fixed) would clone whichever source is picked.
- **Clone source choice is critical:**
  - **Cloning from v3** (the current PUBLISHED version) would faithfully clone v3's three defects into v4 (because the fixed code faithfully preserves what's on the source — v3 has `checkpoints:[]` so v4 would have `checkpoints:[]`).
  - **Cloning from v2** would correctly clone the 2 checkpoints + checkpoint bindings + TRUE_FALSE type into v4. But the admin UI's "Revise training" button on the course detail currently clones from the LATEST version (per `startNewDraft`'s `course.versions[0]` ordered by `version` DESC) — that's v3. There is no admin UI control to pick a specific source version.
- **Historical preservation:** Perfect — v2 and v3 both preserved.
- **Employee impact:** On publish of v4 with ALL_APPLICABLE policy, 5 new REVISION obligations would be issued to the same 5 employees. **This repeats the exact situation the cancellation just corrected.** The admin would need to use `SELECTED` policy with ZERO employees checked to avoid issuing REVISION — the current only workaround for silent applicability updates (see 5D-2 Rec 3).
- **Obligation impact:** Depends on policy. ALL_APPLICABLE → 5 new REVISIONs (undesirable). NON_COMPLETERS → 5 new REVISIONs (same cohort, same effect). SELECTED (empty) → 0 obligations issued but v4 becomes current (defect-free if cloned from v2, defective if cloned from v3).
- **Risks:**
  - If admin clones from v3 (default behaviour), v4 inherits v3's defects. The 5D-3 fix is correct code; v3 is a defective SOURCE.
  - Admin would need a bespoke workflow to clone from v2 (not currently supported by the UI).
- **Recommended approach:** Do NOT clone from v3 blindly. If Option B is chosen, require a one-off service invocation that explicitly specifies v2 as the clone source + publishes v4 with `SELECTED` policy and ZERO employees checked.

### Option C — Retire v3 through an existing supported workflow

Three sub-paths:

**C.1 — Retire the entire course** via admin "Retire course" button on the course detail page → `retireCourse` service.
- **Technical feasibility:** Supported.
- **Consequences:**
  - `TrainingCourse.retiredAt` set + both v2 (already RETIRED) and v3 become inaccessible as "current".
  - `currentVersionId` on the course is cleared.
  - `resolveApplicableCourses` filters out retired courses — the 5 employees would no longer have ORIENTATION_2027 as applicable at all.
  - Scheduling becomes compliant for Marc on ORIENTATION_2027 (his outstanding count would drop by 1).
- **Historical preservation:** Perfect — all completions / attempts / audit history retained.
- **Risks:** retires the entire course (not just v3). The founder would then need to Create Course + Author Content + Publish to re-introduce an Orientation course.
- **Recommended approach:** Appropriate IF the founder determines the entire ORIENTATION course set is to be rebuilt. Overkill for just fixing v3.

**C.2 — Flip v3's `state` from PUBLISHED to RETIRED directly** (and flip v2's `state` from RETIRED to PUBLISHED, restoring v2 as current).
- **Technical feasibility:** No admin UI control for this. Would require a one-off script.
- **Consequences:**
  - v3 becomes RETIRED (invisible to employees + resolver).
  - v2 becomes PUBLISHED (current).
  - Chris + any employee with historical v2 completion is COMPLIANT again.
  - Marc has no v2 completion so his INITIAL requirement stays inferred.
- **Historical preservation:** Perfect — all rows retained.
- **Risks:** Un-retiring a version from RETIRED → PUBLISHED is unprecedented. No existing code path performs this write. The service invariants (publish causes `retire v1` + `flip currentVersionId`) are one-way.
- **Recommended approach:** NOT recommended. Violates the EP-TRAIN-5B invariant.

**C.3 — "Soft-deprecate" v3 while leaving it PUBLISHED** by publishing a v4 cloned from v2 via a founder-authorized one-off service invocation.
- Essentially Option B but with the v2-source + empty SELECTED policy constraints spelled out.
- See Option B's recommended approach.

### 8.1 Recommended v3 remediation (not implemented)

**Option B with v2 as the clone source + SELECTED policy with zero employees checked.** Rationale:
- Produces a v4 that is byte-for-byte correct (checkpoints preserved, question types preserved, bindings preserved).
- Issues zero new REVISION obligations (no employee is in the SELECTED set).
- v2 and v3 both preserved in history.
- Employees see v4 as the current PUBLISHED version; the inferred INITIAL_REQUIRED resolver output reports on v4.
- The admin workflow needs a one-off service invocation (because the admin UI's Revise Training button clones from the latest version, which is v3). This could be:
  - A short SSH-driven script that invokes `startNewDraft(founderPrincipal, courseId)` after temporarily reordering v2 to be the "latest" (unsupported — not recommended).
  - OR a bespoke `cloneDraftFromSpecificVersion(sourceVersionId)` admin action added to the admin UI, authorized separately as a future small slice.
- Either path requires separate founder authorization.

**Explicit non-execution.** Option B is NOT performed in this slice per directive §9 and §12.

---

## 9. Test isolation improvements (directive §10)

**Documented, not implemented.** Each is additive, additive, and requires separate authorization.

| # | Safeguard | Rationale | Scope |
|---|---|---|---|
| S1 | Use disposable courses + employees for mutation-based tests (ONLY). | Already the EP-TRAIN-3 Slice 3 fixture harness pattern. Codify as a hard rule in `.claude/CLAUDE.md` for Training-touching tests. | Documentation. |
| S2 | Require explicit confirmation before any publish-revision run against a legitimate course. | Prevent `publishRevisionViaAdminUI`-style helpers from accidentally accepting a legitimate `courseId`. Guard: reject if `courseCode` does NOT start with the fixture prefix. | Small helper-code change. |
| S3 | Record before-and-after preservation snapshots at the START of every Training-touching acceptance slice. | Serializes the pre-slice state so the acceptance diff is cleanly separable from concurrent human admin usage (as in EP-TRAIN-5D-3A's forensic challenge). | Thin SSH-only script invoked at slice start; writes to `test-results/`. |
| S4 | Announce acceptance-window timing to the founder before running a slice that could coincide with interactive admin use. | Operational, not code. Reduces the chance of unrelated activity overlapping. | Convention. |
| S5 | Source-course integrity check before revision publication. | A pre-publish readiness check that compares the DRAFT to the source version it was cloned from and flags any missing-field delta (e.g., "DRAFT has 0 checkpoints; source has 2"). | Service-level `checkRevisionReadiness` extension; medium slice. |
| S6 | Prohibit using real employees' obligations as disposable test artifacts. | Already codified by the 5C-3B/C spec patterns (which use `teardownIsolatedFixture` in `finally`). The ORIENTATION v3 publication was NOT an acceptance test (it was interactive founder usage), so this safeguard would not have prevented it — but reiterates the principle. | Documentation. |

**None of these mitigations would have prevented the specific
ORIENTATION_2027 v3 event (which was interactive admin usage, not
an automated test).** They collectively reduce the risk surface for
future co-mingling of acceptance tests + interactive admin usage.

---

## 10. Deployment + health (directive §11)

**No application deployment performed.** The cancellation ran via
SSH-driven data mutation on the existing deployed image. The 5D-3B
work is entirely a data operation + an acceptance report.

| Field | Value |
|---|---|
| Running image | `spectre-staging:sha-b2d47f1ebe90` |
| Fly release | v1083 |
| Rollback mechanism | `UPDATE TrainingObligation SET status='OUTSTANDING', updatedAt=NOW() WHERE id IN ('cmvzdkr1c…', 'cmvzdkr54…', 'cmvzdkr86…', 'cmvzdkrcy…', 'cmvzdkrgr…')` + per-row `hr.training.obligation.restore.rollback` audit. Not executed. |
| `/api/health` | 200 before + after |
| Recovery reference | Pre-cancel snapshot in `scratchpad/5d3b-preflight.json`; before/after audit payloads carry byte-for-byte reconstructable state. |

---

## 11. STOP boundaries honoured (directive §12)

Not initiating:
- Obligation row deletion.
- Reopening Marc's SUPERSEDED INITIAL.
- Creating replacement obligations.
- Modifying v2 or v3 course content.
- Publishing v4.
- Retiring v3.
- Changing course applicability.
- Activating global compliance enforcement.
- Changing scheduling-enforcement.
- Modifying founder training completions / attempts / progress.
- Deploying application changes.
- Deploying to production.
- Implementing recurring recertification.

The exactly-5 approved cancellation transitions + a read-only v3 integrity assessment is the entire slice.

Awaiting founder review.
