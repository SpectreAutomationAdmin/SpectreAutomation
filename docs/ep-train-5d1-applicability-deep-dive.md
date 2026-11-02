# EP-TRAIN-5D-1 — Applicability Deep Dive

**Baseline:** `spectre-staging:sha-79b05f36616d` (α code baseline).
Zero course applicability changes performed by this audit.

Answers the directive §5 question set with source + screenshot
evidence. All file:line references relative to
`C:\dev\SpectreAutomation\`.

Companion:
- Picker component: `src/app/app/admin/people/safety-training/[courseId]/[versionId]/ApplicabilityPicker.tsx`.
- Server action: `_actions.ts:108-163` (`updateDraftAction`).
- Service: `src/lib/hr/training/courses.ts:175` (`updateDraft`).
- Resolver: `src/lib/hr/training/applicability.ts:115` (`resolveApplicableCourses`).

---

## Q1 — Can a manager choose which departments require a course?

**Yes.** The `ApplicabilityPicker` (`ApplicabilityPicker.tsx:53-110`)
renders the "Scoped by departments or positions" radio. When
selected, a progressive-disclosure block displays every active
`Department` for the club as a checkbox cluster
(`ApplicabilityPicker.tsx:71-86`). Each checked box submits via
`<input type="checkbox" name="appliesToDeptIds" value={id}>`;
`updateDraftAction` collects `formData.getAll("appliesToDeptIds")`
and persists to `TrainingCourseVersion.appliesToDeptIds` (JSON array).

**Where:** version editor (`/safety-training/[courseId]/[versionId]`),
DRAFT state only. The picker is disabled on PUBLISHED versions
(`readOnly = !isDraft || !canAuthor` in `[versionId]/page.tsx:113`).

**Role gate:** `hr:training:write` (`CLUB_ADMIN` only; `GENERAL_MANAGER`
does NOT have write permission — they can see the editor but every
form field is disabled).

**Screenshot:** `05-version-detail-fire-v1-1440x900.png` shows the
picker in its disabled (PUBLISHED) state with the Everyone option
selected.

## Q2 — Can a manager choose specific positions?

**Yes.** Same picker, same radio ("Scoped"). The second cluster
below departments lists every `EmployeePosition` for the club as
checkbox options (`ApplicabilityPicker.tsx:88-106`). Submits via
`appliesToPositionIds`. Persisted to
`TrainingCourseVersion.appliesToPositionIds`.

Current staging has 19 positions defined but 0 employees have a
position record populated (per the EP-TRAIN-5C-4B applicability
audit at `docs/ep-train-5c4b-applicability-audit.md`). So the
picker renders position checkboxes but choosing them matches zero
employees today — the resolver still returns the correct empty
intersection.

## Q3 — Can a manager assign a course to individual employees?

**Yes, but through a separate flow.** Two mechanisms exist:

1. **The picker's "Assign individually" radio** (`ApplicabilityPicker.tsx:111-128`)
   is a PASSIVE FLAG: it clears `appliesToAll`, `appliesToDeptIds`,
   and `appliesToPositionIds` on the current version
   (`_actions.ts:146-150`). It does NOT open an employee picker. An
   admin who selects this radio sees only the explanatory text:
   *"The course applies only to employees you assign one at a time.
   Useful for remedial or role-specific training."*

2. **The `AssignTrainingButton`** (`src/components/hr/AssignTrainingButton.tsx`)
   is the actual per-employee assignment UI. It lives on each
   employee's profile page (`/app/admin/people/employees/[id]?tab=training`).
   The admin selects a published course from a dropdown + enters an
   optional note; the form invokes `assignTrainingCourseAction`
   → `assignments.assignCourseToEmployee` which creates a
   `TrainingAssignment` row.

**Role gate:** `hr:training:assign` (`CLUB_ADMIN` + `GENERAL_MANAGER`).

**Screenshot:** `06-employee-detail-marc-1440x900.png` shows the
`+ Assign training` button on Marc's profile. The form shows a
course dropdown filtered to `publishableCourses` (PUBLISHED + not
retired, excluding already-assigned).

**UX GAP:** the two mechanisms are discoverable in different places
(editor vs employee profile). An admin who sets a course to
"Assign individually" in the editor must then open each affected
employee's profile and click `+ Assign training`. No course-level
"add employees" picker exists.

## Q4 — Can these methods be combined?

**Combined dept + position: YES** (same radio, both pickers active;
resolver matches ANY dept OR ANY position per
`applicability.ts:143-146`). The resulting union is OR, not AND —
admins cannot express "GOLF_OPS department AND Greenskeeper
position". The resolver's logic is strict precedence: `assigned` >
`all` > `department` > `position`, with the first positive signal
winning per course.

**Combined dept/position + per-employee: PARTIAL.** The version-level
flags and `TrainingAssignment` rows coexist. The resolver returns
"assigned" first (highest precedence), so an explicit `TrainingAssignment`
row makes a course applicable to an employee EVEN IF the version
has `appliesToAll: false` and no dept/position match
(`applicability.ts:143`). But there is NO UI control that lets the
admin see / manage this combination in a single surface.

## Q5 — Can a published course's applicability be changed?

**Not directly.** `[versionId]/page.tsx:113` sets
`readOnly = !isDraft || !canAuthor`. On PUBLISHED versions the
picker is disabled.

**Workaround path:** publish a new revision with the desired
applicability.

## Q6 — Does changing applicability require publishing a new version?

**Yes, for PUBLISHED courses.** The workflow is:

1. On the course detail page, click **"Revise training"** (`[courseId]/page.tsx:74`,
   button present when `canAuthor && !course.retiredAt && !openDraft`).
2. `startNewDraftAction` → `courses.startNewDraft` creates a new
   DRAFT version with v1's content cloned (video + title + flags).
   **Known defect from 5C-3C §2:** checkpoints are NOT cloned; the
   admin must re-create them.
3. On the DRAFT, open the version editor, change the applicability
   via `ApplicabilityPicker`, Save Draft.
4. Click **"Publish this version"** (`PublishRevisionDialog`).
5. Pick a policy: ALL_APPLICABLE / NON_COMPLETERS / SELECTED.
6. Confirm → `publishDraftWithPolicy` runs. Retires v1, publishes v2,
   issues REVISION obligations to the target set, auto-supersedes
   prior OUTSTANDING INITIAL/REVISION on older versions
   (EP-TRAIN-5B-1).

The 5C-3C §2 Playwright acceptance test fully exercises this path.

## Q7 — Can a manager preview the employees affected?

**Partially.** The `PublishRevisionDialog` shows a count of applicable
employees per policy, including a per-employee checkbox list for the
SELECTED policy. The counts reflect `applicableEmployees` resolved
AFTER the new applicability is already set in the DRAFT.

**Gap:** there is no "if you change applicability from X to Y, these
N employees will gain / lose this requirement" preview BEFORE saving
the DRAFT's applicability. The retake-side `previewRetakeTargets`
service exists; a scoped variant for applicability changes does not.

## Q8 — What happens to existing obligations when applicability narrows?

**Outstanding obligations are auto-superseded by newer REVISION
obligations ONLY for the same (employee, courseId) pair.** The
supersession loop at `revisions.ts:420-430` scans every target
employee's prior OUTSTANDING INITIAL/REVISION on OLDER versions of
the same course and transitions them to `SUPERSEDED`. The new
REVISION obligation is created on the new version.

**If applicability NARROWS such that an employee is no longer
applicable:** no new obligation is created for them (they're not in
the target set). Their old OUTSTANDING obligation on the prior
version REMAINS OUTSTANDING unless they're also in the target set
of some other active publish. In practice this means a narrowing
change can leave orphan outstanding obligations on old versions.
These are not visible to the employee because the course page
redirects to the current published version; the compliance-resolver's
`activeObligation` picks them up when a prior version's obligation
remains OUTSTANDING with no newer REVISION.

**EP-TRAIN-5B-1 explicitly protects `MANUAL_REINSTATE` from
auto-supersession** — a retake obligation is never dismissed by a
publish.

## Q9 — What happens when an employee changes departments?

**No persistent re-evaluation. The resolver recomputes applicability
on EVERY read** via `applicability.collectActiveRoleContext()`
(`applicability.ts:79-103`). This reads the union of departments and
positions from `EmployeeEmploymentAssignment` rows (active at `now`)
+ the legacy `Employee.departmentId` / `positionId` fields.

**Effects:**

- An employee who moves from `GOLF_OPS` to `ADMIN` will see their
  applicable course set change on next dashboard load.
- Historical TrainingCompletion rows are NEVER deleted; the
  compliance-resolver surfaces them in Training History even when
  the course is no longer applicable.
- Existing OUTSTANDING obligations on courses the employee is no
  longer applicable to STAY outstanding — the resolver does not
  auto-cancel. A manager would need to manually cancel via a
  future admin control (no such UI exists today).
- The employee receives NO notification when their applicability
  changes.

## Q10 — Does the UI explain the consequences before saving?

**Partially.** The `ApplicabilityPicker`'s radio labels + help text
describe the semantics ("Every active employee at the Club is
required…"), but there is no pre-save preview of:

- How many employees will gain a new requirement.
- How many employees will have their requirement removed.
- Whether existing historical completions will be preserved
  (they always are — but the UI doesn't say so).
- Whether REVISION obligations will be issued (depends on policy
  chosen in the Publish Revision dialog AFTER the DRAFT is saved).

The `PublishRevisionDialog` is the only surface with a
quantitative count ("N of M employees would receive a new
requirement" per policy), but that count appears at
*publication* time — not at *applicability edit* time.

---

## Reference evidence (for the matrix)

- `ApplicabilityPicker` three modes rendered: 05-version-detail screenshot.
- `AssignTrainingButton` on employee profile: 06-employee-detail-marc screenshot.
- Course-detail "Applicable employees" roster: 04-course-detail-fire screenshot (read-only roster at the bottom of that page).
- Create-course form's 3-way radio (dept/pos clusters deferred to editor): 03-training-new screenshot.
