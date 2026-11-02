# EP-TRAIN-5C-4B — Applicability Audit + Proposed Course Configuration

**Status:** READ-ONLY audit, 2026-11-02. Zero course configuration
changes performed. Zero obligations issued. Zero employee records
modified. Founder preservation `{9, 30, 9, 0}` byte-identical.

**Baseline:** `spectre-staging:sha-a6bf36202d71` (Fly v1074). `/api/health` = 200.

**Trigger:** Founder HOLD on the 8-obligation Marc Maldiney pilot pending
departmental and role-based applicability review. Marc is a Payroll
Administrator in the Administration department; the current
club-wide `appliesToAll: true` configuration on 8 courses creates
mandatory requirements that are likely inappropriate for his role.

**STOP:** No course configuration changes, obligation writes, resolver
activation, or scheduling-eligibility changes until this proposal is
reviewed + the exact post-review configuration is approved in writing.

---

## 1. How Spectre determines course applicability (today)

Source of truth: [`src/lib/hr/training/applicability.ts:115`](src/lib/hr/training/applicability.ts#L115)
(`resolveApplicableCourses(employeeId)`). The resolver returns every
currently-PUBLISHED-and-active course version that applies to the
employee, matched on **first winning signal in this order**:

| Precedence | Signal | Data field | Scope |
|---|---|---|---|
| 1 | `assigned` | `TrainingAssignment { clubId, employeeId, courseId }` row | **Individual employee** — explicit, highest precedence. |
| 2 | `all` | `TrainingCourseVersion.appliesToAll = true` | **Club-wide** — every employee in the course's `clubId`. |
| 3 | `department` | `TrainingCourseVersion.appliesToDeptIds` (JSON array) intersects employee's active department IDs | **Department** — scoped to selected departments. |
| 4 | `position` | `TrainingCourseVersion.appliesToPositionIds` (JSON array) intersects employee's active position IDs | **Position** — scoped to selected positions. |

An employee receives a course if ANY of (1), (2), (3), (4) matches
on the CURRENT published version. One winning reason per course
(the resolver dedupes by `courseId`). Historical completions are
never deleted; if an employee changes department and a
previously-applicable course becomes non-applicable, their
historical completion is preserved.

**Active role context** (feeding (3) + (4)): the union of
`departmentId` + `positionId` across:
- Every currently-active `EmployeeEmploymentAssignment` row
  (`effectiveFrom <= now AND (effectiveTo IS NULL OR effectiveTo >
  now)`), PRIMARY and ADDITIONAL.
- The legacy `Employee.departmentId` + `Employee.positionId` fields
  (kept for backwards compatibility with un-migrated employees).

Cross-trained employees receive training applicable to ANY of their
active roles, not only their primary department.

**Required designation.** `TrainingCourseVersion.required: true`
means the course is a scheduling-eligibility gate (employee must
have a valid completion on the current version to be `eligible`).
`required: false` means the course is applicable but doesn't block
scheduling.

**Scheduling resolver.** `resolveEmployeeSchedulingEligibility`
calls `resolveApplicableCourses`, then checks completions against
the applicable required set. The dormant obligation-aware resolver
(`resolveEmployeeTrainingCompliance`) uses the same applicability
helper + treats OUTSTANDING obligations as a non-compliance signal.

---

## 2. Marc Maldiney's role context on staging

| Field | Value |
|---|---|
| Employee id | `cmu0ndf4p001vk9md2ntmo2ck` |
| Employee number | `E-00003` |
| Display name | Marc Maldiney |
| Club | Coulee Ridge Golf & Country Club |
| Lifecycle | ACTIVE |
| Status | ACTIVE |
| Onboarding state | APPROVED |
| Legacy `Employee.departmentId` | ADMIN (Administration) |
| Legacy `Employee.positionId` | **null** |
| Active `EmployeeEmploymentAssignment` rows | 1 — `department: ADMIN`, `position: null`, effective from 2026-09-01, no end |
| Explicit `TrainingAssignment` rows | 0 |

**Effective role for applicability resolution:**
- `deptIds = { ADMIN }`
- `positionIds = {}` (empty)

Marc is in the Administration department with no specific position
assigned on staging. The founder's description ("Payroll
Administrator") does not have a dedicated staging position record —
see §4 below for the implication.

---

## 3. Coulee Ridge taxonomy (what exists today)

### 3.1 Departments (16)
| Code | Name |
|---|---|
| ADMIN | Administration |
| CLUBHOUSE | Clubhouse |
| CORPORATE | Corporate Income & Expenses |
| CULINARY | Culinary |
| DUES_AND_CHARGES | Dues & Charges |
| EVENTS | Events |
| F&B | Food & Beverage |
| GOLF_OPS | Golf Operations |
| GOLF_SHOP | Golf Shop |
| GROUNDS | Course & Grounds |
| LADIES_SECTION | Ladies Section |
| LONG_RANGE_PLAN | Long Range Plan & Renovation |
| MENS_SECTION | Mens Section |
| PROSHOP | Golf Pro Shop |
| SERVICE | Service |
| TOURNAMENTS | Tournament Accounts |

### 3.2 Positions (19) — grouped by department
- **ADMIN:** ADMIN_ASSISTANT, CLUBHOUSE_MANAGER, CONTROLLER, EVENTS_COORD, GENERAL_MANAGER, MEMBERSHIP_COORD
- **CULINARY:** EXECUTIVE_CHEF, LINE_COOK, SOUS_CHEF
- **EVENTS:** BAR, SRV
- **GOLF_OPS:** GREENSKEEPER, GROUNDS_MANAGER, PRO_SHOP_ATTENDANT, PRO_SHOP_MANAGER
- **SERVICE:** BARTENDER, F_AND_B_MANAGER, HEAD_SERVER, SERVER

### 3.3 Coulee Ridge active employees (5 total)
| Employee | Dept | Position | Lifecycle | Onboarding |
|---|---|---|---|---|
| E-00002 Chris Turcato (founder) | ADMIN | — | ACTIVE | APPROVED |
| E-00003 Marc Maldiney | ADMIN | — | ACTIVE | APPROVED |
| E-FOUNDER-DEMO FounderDemo | — | — | ACTIVE | APPROVED |
| E-PAY1A-Test-A | — | — | ACTIVE | DRAFT |
| E-PAY1A-Test-B | — | — | ACTIVE | DRAFT |

Only Chris + Marc have a department assigned (ADMIN). No employee
has a specific position record. No one has an EXPLICIT
`TrainingAssignment` row.

---

## 4. The eight courses — current configuration on staging

Every one of the eight courses has **identical, maximally broad
applicability**: `required: true` + `appliesToAll: true` +
`appliesToDeptIds: null` + `appliesToPositionIds: null`.

| # | Code | Title | Current version | `required` | `appliesToAll` | Current scope |
|---|---|---|---|---|---|---|
| 1 | `ORIENTATION_2027` | Coulee Ridge Staff Orientation | v2 | ✅ | ✅ | club-wide |
| 2 | `EQUIPMENT_SAFETY_2026` | Equipment Safety | v1 | ✅ | ✅ | club-wide |
| 3 | `FIRE_SAFETY` | Fire Safety | v1 | ✅ | ✅ | club-wide |
| 4 | `FOOD_SAFETY_2026` | Food Handling and Safety 2026 | v1 | ✅ | ✅ | club-wide |
| 5 | `DEMO_FR_SAFETY` | Founder Demo – Safety & Training | v1 | ✅ | ✅ | club-wide |
| 6 | `KNIFE_SAFETY_2026` | Knife Safety | v1 | ✅ | ✅ | club-wide |
| 7 | `ROOFTOP_SAFETY_2026` | Rooftop Safety 2026 | v1 | ✅ | ✅ | club-wide |
| 8 | `GAS_VERSUS_DIESEL` | The benefits of Gas versus Diesel | v1 | ✅ | ✅ | club-wide |

**Observation:** every mandatory course is currently club-wide
regardless of role. That is the broad default the founder has
flagged for review.

---

## 5. Proposed per-course configuration (for founder approval)

Each row proposes a new scope, lists the rationale, states the
required change, and shows the impact on every current Coulee Ridge
active employee under the proposed config.

### 5.1 Summary table

| # | Course | Proposed scope | `appliesToAll` | `appliesToDeptIds` | `appliesToPositionIds` | Rationale |
|---|---|---|---|---|---|---|
| 1 | ORIENTATION_2027 | club-wide (unchanged) | ✅ | — | — | Orientation applies to every employee at hire. **No config change needed.** |
| 2 | EQUIPMENT_SAFETY_2026 | GROUNDS + GOLF_OPS + CULINARY | ❌ | `[GROUNDS, GOLF_OPS, CULINARY]` | — | Operating course equipment / mowers / kitchen equipment. Admin + Service staff do not operate this equipment. |
| 3 | FIRE_SAFETY | club-wide (unchanged) | ✅ | — | — | Fire safety applies to every person on premises. **No config change needed.** |
| 4 | FOOD_SAFETY_2026 | CULINARY + F&B + SERVICE + EVENTS | ❌ | `[CULINARY, F&B, SERVICE, EVENTS]` | — | Food handling/service only. Admin + Golf + Grounds staff don't handle food. |
| 5 | DEMO_FR_SAFETY | **EXCLUDE** from legitimate employee obligations | ❌ | `[]` or retire | — | Demo course — not a real training requirement. Options: (a) `appliesToAll: false` + empty depts (never applies, but still a published course for demo purposes); (b) `required: false` (applicable but doesn't block scheduling); (c) retire the course. |
| 6 | KNIFE_SAFETY_2026 | CULINARY (optionally F&B) | ❌ | `[CULINARY]` (or `[CULINARY, F&B]`) | — | Knife handling in kitchen. Strict proposal: CULINARY only; permissive: include F&B for prep stations. Server/Admin/Grounds don't need. |
| 7 | ROOFTOP_SAFETY_2026 | GROUNDS | ❌ | `[GROUNDS]` | — | Rooftop access is a facilities/grounds responsibility. |
| 8 | GAS_VERSUS_DIESEL | GROUNDS + GOLF_OPS | ❌ | `[GROUNDS, GOLF_OPS]` | — | Course-equipment fuel choice. Grounds + Golf Operations only. |

### 5.2 Position-level scoping — not proposed

Only `ADMIN` department has any staging employees with a department
assignment (Chris + Marc). No employees have specific position
records on staging. **Position-level applicability (`appliesToPositionIds`)
is not needed for any of the 8 courses on current data.** Position
scoping becomes useful once positions are populated (e.g., a future
"Pro Shop Attendant" POS course scoped to `PRO_SHOP_ATTENDANT` only).

### 5.3 Explicit `TrainingAssignment` rows — not proposed

Zero courses in the 8-course set require per-employee overrides.
Department-level scoping is sufficient.

---

## 6. Impact on every existing employee-course requirement (under proposed config)

Applied to the 5 current Coulee Ridge active employees + the 3
other-club employees (unchanged, out of scope).

### 6.1 Marc Maldiney (E-00003, ADMIN dept, no position)

| # | Course | Current scope → recommended action | Proposed scope → recommended action | Delta |
|---|---|---|---|---|
| 1 | ORIENTATION_2027 | all → CREATE_INITIAL | all → CREATE_INITIAL | **unchanged** |
| 2 | EQUIPMENT_SAFETY_2026 | all → CREATE_INITIAL | depts=[GROUNDS,GOLF_OPS,CULINARY] → **NOT APPLICABLE** | removed |
| 3 | FIRE_SAFETY | all → CREATE_INITIAL | all → CREATE_INITIAL | **unchanged** |
| 4 | FOOD_SAFETY_2026 | all → CREATE_INITIAL | depts=[CULINARY,F&B,SERVICE,EVENTS] → **NOT APPLICABLE** | removed |
| 5 | DEMO_FR_SAFETY | all → CREATE_INITIAL | excluded → **NOT APPLICABLE** | removed |
| 6 | KNIFE_SAFETY_2026 | all → CREATE_INITIAL | depts=[CULINARY] → **NOT APPLICABLE** | removed |
| 7 | ROOFTOP_SAFETY_2026 | all → CREATE_INITIAL | depts=[GROUNDS] → **NOT APPLICABLE** | removed |
| 8 | GAS_VERSUS_DIESEL | all → CREATE_INITIAL | depts=[GROUNDS,GOLF_OPS] → **NOT APPLICABLE** | removed |

**Marc's pilot narrows from 8 → 2 obligations under proposed config.**

PRESERVE_COMPLIANT for Marc under current config was 2 (SAFE-BASICS,
GAS_VERSUS_DIESEL on current version). Under proposed config:
- SAFE-BASICS: not in the 8-course set — unchanged.
- GAS_VERSUS_DIESEL: no longer applicable to Marc. His historical
  completion remains in the DB but is no longer part of his
  compliance profile. The new resolver would classify it as
  `NO_REQUIREMENT` for Marc on this course.

### 6.2 Chris Turcato (E-00002, ADMIN dept — founder; obligations withheld by default)

Under current config: 8 PRESERVE_COMPLIANT + 2 CREATE_INITIAL
(EQUIPMENT_SAFETY_2026, GAS_VERSUS_DIESEL) across these 8 courses +
SAFE-BASICS.

Under proposed config, Chris (ADMIN) would be applicable only to:
- ORIENTATION_2027 (current compliant: ✅ completion exists)
- FIRE_SAFETY (current compliant: ✅ completion exists)

Chris's remaining applicable set (other than these 8) stays as-is.
His 8-course delta:
| # | Current | Proposed | Resulting |
|---|---|---|---|
| 1 | PRESERVE_COMPLIANT | PRESERVE_COMPLIANT | COMPLIANT |
| 2 | CREATE_INITIAL | NOT APPLICABLE | NO_REQUIREMENT |
| 3 | PRESERVE_COMPLIANT | PRESERVE_COMPLIANT | COMPLIANT |
| 4 | PRESERVE_COMPLIANT | NOT APPLICABLE | NO_REQUIREMENT (completion preserved) |
| 5 | PRESERVE_COMPLIANT | NOT APPLICABLE | NO_REQUIREMENT (completion preserved) |
| 6 | PRESERVE_COMPLIANT | NOT APPLICABLE | NO_REQUIREMENT (completion preserved) |
| 7 | PRESERVE_COMPLIANT | NOT APPLICABLE | NO_REQUIREMENT (completion preserved) |
| 8 | CREATE_INITIAL | NOT APPLICABLE | NO_REQUIREMENT |

Chris's compliance view simplifies from "10 applicable (8 compliant +
2 outstanding)" to "2 applicable (both compliant)". No obligations
issued regardless, per founder-preservation policy.

### 6.3 FounderDemo (E-FOUNDER-DEMO, no dept, no position)

With no `departmentId`, FounderDemo matches NO `appliesToDeptIds`
list. Under proposed config, FounderDemo is applicable to:
- ORIENTATION_2027 (appliesToAll)
- FIRE_SAFETY (appliesToAll)

8 CREATE_INITIAL under current config → 2 CREATE_INITIAL under
proposed config (if FounderDemo is retained in the pilot). Per
5C-4A §3 default: FounderDemo is excluded from the pilot regardless.

### 6.4 PAY1A-Test-A / PAY1A-Test-B (no dept, no position, DRAFT onboarding)

Same as FounderDemo: 2 applicable courses under proposed config
(ORIENTATION_2027, FIRE_SAFETY). All currently REVIEW_REQUIRED
regardless of config (INCOMPLETE_ONBOARDING). Still 20 REVIEW_REQUIRED
rows → still blocked from any obligation issuance pending the §4
Approval Checklist decision in 5C-4A.

### 6.5 Non-Coulee-Ridge employees

- Alex Fixture (HR-2B.5 Staging Fixture tenant): the config change
  applies only to Coulee Ridge's course rows. HR-2B.5 fixture
  tenant has its own course set and is unaffected.
- SLICE C Benefits (SE-ZH-01, SC-D22B): tenant has no training
  courses; unaffected.

### 6.6 Aggregate impact across staging

| Metric | Current config | Proposed config |
|---|---|---|
| Marc applicable pairs | 10 | **4** (ORIENTATION_2027, FIRE_SAFETY, + 2 outside the 8-course set) |
| Marc CREATE_INITIAL | 8 | **2** (ORIENTATION_2027, FIRE_SAFETY) |
| Marc PRESERVE_COMPLIANT | 2 | 2 (SAFE-BASICS unchanged; GAS_VERSUS_DIESEL now NO_REQUIREMENT but completion preserved) |
| Chris applicable pairs | 10 | **4** |
| Chris CREATE_INITIAL | 2 | **0** |
| FounderDemo applicable pairs | 10 | **2** |
| FounderDemo CREATE_INITIAL (if authorized) | 10 | **2** |
| Total CREATE_INITIAL across staging (if everyone authorized) | 20 | **~4** (Marc 2 + FounderDemo 2) |
| Historical completions preserved | 11 | **11** (zero mutation) |
| Compliance reversals (willFlipFromCompliantToOutstanding) | 0 | **0** (narrower scope cannot flip anyone from compliant to outstanding) |

---

## 7. Change path options

The proposed config requires modifying `TrainingCourseVersion`
flags. Three paths differ in semantics and auditability. **No path
is authorized to execute yet.**

### 7.1 Option A — Direct edit of the current PUBLISHED version

- **How:** admin "edit course" workflow updates `appliesToAll`,
  `appliesToDeptIds`, `appliesToPositionIds` on the SAME
  `courseVersionId` without issuing a REVISION.
- **Effect:** applicability changes retroactively. Historical
  completions on this `versionId` remain; no new REVISION
  obligations.
- **Pros:** simple, idempotent, no new obligations issued, no UI
  "Updated Training Required" chip appears on anyone.
- **Cons:** rewrites the "what applied when" record for this
  version. Must be allowed by the admin UI (support TBD — may be
  a schema-level DRAFT-only guard).

### 7.2 Option B — Publish a new revision with narrower applicability

- **How:** admin starts a new draft from each course's current
  version, edits applicability, publishes with policy
  `ALL_APPLICABLE`. The service issues REVISION obligations
  against anyone still applicable on the new version.
- **Effect:**
  - Marc (ADMIN) remains applicable for Orientation + Fire Safety →
    receives 2 REVISION obligations (one per course).
  - Non-ADMIN employees for Equipment Safety / Food Safety etc.
    receive REVISION obligations within their newly-applicable
    department scopes. No one in Coulee Ridge today is in those
    departments except FounderDemo (no dept), so FounderDemo
    (if excluded from the pilot) is unaffected.
  - Chris's dashboard shows 2 OUTSTANDING REVISION obligations for
    Orientation + Fire Safety (he's compliant on both already, so
    historical completion satisfies the REVISION via the
    satisfiedByCompletionId rule — actually no, REVISION requires a
    completion AFTER the publish event, so Chris would need to
    redo. Confirm with admin UI's "preserve historical completion"
    semantics before using this path.)
- **Pros:** canonical "we changed scope" workflow. Fully audited.
- **Cons:** issues REVISION obligations on legitimate employees
  that we may not want. Chris would see outstanding Orientation +
  Fire Safety on his dashboard until he re-completes (violates
  founder-preservation unless the REVISION policy excludes him).

### 7.3 Option C — Leave course config as-is; narrow pilot execution scope only

- **How:** no config changes. 5C-4B's backfill ONLY processes
  courses #1 and #3 for Marc, skipping #2/#4/#5/#6/#7/#8 at the
  script level.
- **Effect:**
  - Marc receives 2 INITIAL obligations (Orientation + Fire Safety).
  - Course versions remain `appliesToAll: true`. Chris + FounderDemo
    + PAY1A fixtures remain applicable for all 8 courses but no
    obligation is issued (pilot scope excludes them).
  - If/when activation extends to other employees, the 8-course
    config decision must be revisited.
- **Pros:** zero config edit, zero REVISION issuance, lowest blast
  radius for the pilot. Avoids the Option A/B issues entirely.
- **Cons:** doesn't resolve the long-term "club-wide requirement
  is too broad" issue. Second founder decision required later.

**Recommendation for the pilot:** Option C. Narrow the pilot
execution scope to the two courses Marc should have (Orientation +
Fire Safety) WITHOUT changing course configuration. The config
decision becomes a separate deliverable after the pilot has proved
the obligation mechanics.

---

## 8. Proposed pilot (post-review) — 2-obligation Marc Maldiney

If the founder approves the recommended narrow scope under Option C:

| # | Course | Current scope | Historical completion | Proposed obligation | Expected scheduling impact |
|---|---|---|---|---|---|
| 1 | ORIENTATION_2027 v2 | all | none | **INITIAL** (`init:5c4b-marc-pilot:v2`) | unchanged (legacy already blocks) |
| 2 | FIRE_SAFETY v1 | all | none | **INITIAL** (`init:5c4b-marc-pilot:v1`) | unchanged |

Omitted from the pilot (held for departmental/role review):
- EQUIPMENT_SAFETY_2026, FOOD_SAFETY_2026, KNIFE_SAFETY_2026,
  ROOFTOP_SAFETY_2026, GAS_VERSUS_DIESEL (5 courses).

Omitted entirely (per founder decision):
- DEMO_FR_SAFETY (demo course, excluded from legitimate obligations).

---

## 9. Decisions required before any write

| Decision | Options | Default |
|---|---|---|
| D1 — Pilot scope under current config | (i) 2 obligations (ORIENTATION_2027 + FIRE_SAFETY) under Option C; (ii) different subset | **(i)** per §8 |
| D2 — Course config change path for the broader 6 courses | A / B / C (defer indefinitely) | **C (defer)** |
| D3 — If D2 chooses A or B: who approves each per-course config change | per-course approval list | — |
| D4 — DEMO_FR_SAFETY handling | (a) leave as-is but pilot excludes; (b) edit `appliesToAll: false`; (c) edit `required: false`; (d) retire | **(a)** |
| D5 — Chris's path under proposed config | preservation unchanged (0 obligations) | **unchanged** |
| D6 — FounderDemo + PAY1A-Test-A/B | excluded from pilot (per 5C-4A Approval Checklist §3 + §4) | **excluded** |
| D7 — Pilot execution date + window | founder-chosen | — |

---

## 10. Pre-execution gate (unchanged from 5C-4A §4)

Even after the course list is approved, the following must pass
before any obligation is written:
1. Refresh Marc's current completion history.
2. Recheck `resolveApplicableCourses(E-00003)`.
3. Recheck zero OUTSTANDING obligations on Marc.
4. Verify issuance-key uniqueness.
5. Verify no approved course has been completed since approval.
6. Record pre-run DB counts.
7. Record a database recovery reference (Fly Postgres snapshot id).
8. Confirm the active application image + health.

If anything has shifted since approval: STOP, re-request approval.

---

## 11. What this audit did NOT change (preservation)

- Zero `TrainingCourseVersion` writes.
- Zero `TrainingObligation` writes.
- Zero `TrainingCompletion` / `TrainingAttempt` / `TrainingProgress`
  writes.
- Zero `Employee` / `EmployeeEmploymentAssignment` / `TrainingAssignment`
  writes.
- Zero scheduling-eligibility code path modifications.
- Zero deployments.

Final preservation audit (post-audit): founder (E-00002) =
`{completions:9, attempts:30, progress:9, obligations:0}`. Global
counts: `{obligations:0, completions:11, attempts:33, progress:12}`
— byte-identical to the 5C-4A acceptance.

---

## 12. STOP boundaries honoured

- No course configuration changed.
- No obligations issued.
- No compliance enforcement activated.
- No scheduling restrictions modified.
- No production deploy.
- No new live API route or background scheduler.
- No fixtures deleted or modified.

**Awaiting founder authorization on D1–D7 above before any 5C-4B
execution.**
