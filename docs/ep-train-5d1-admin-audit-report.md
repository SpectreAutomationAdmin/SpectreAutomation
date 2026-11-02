# EP-TRAIN-5D-1 — Administrative Training Module Audit Report

**Status:** READ-ONLY audit completed 2026-11-02. Zero code modifications,
zero deploys, zero database writes.

**Baseline audited:** `spectre-staging:sha-79b05f36616d` (α code
baseline; Marc Maldiney's 2 OUTSTANDING INITIAL obligations present
and untouched). `/api/health` = 200.

**Preservation at audit end:** founder `{9, 30, 9, 0}`; Marc's
pilot obligations present (2 OUTSTANDING, 0 modified); global
`{obligations: 2, completions: 11, attempts: 33, progress: 12}`
unchanged from the post-β acceptance baseline.

Companion deliverables (all under `docs/`):
- `ep-train-5d1-feature-inventory.md` — feature matrix (B)
- `ep-train-5d1-feature-inventory.csv` — machine-readable matrix (B)
- `ep-train-5d1-ui-screenshot-register.md` — 7 screenshots + routes (C)
- `ep-train-5d1-applicability-deep-dive.md` — the 10 applicability questions (D)
- `ep-train-5d1-gap-and-ux-assessment.md` — gap analysis + UX (E)
- `ep-train-5d1-next-steps.md` — short recommendation list (F)

---

## 1. Executive answer to the final-reporting questions (§10)

| # | Question | Short answer |
|---|---|---|
| 1 | How complete is Spectre's existing administrative Training module? | **Substantially complete.** 44 features audited; 32 FULLY IMPLEMENTED, 4 IMPLEMENTED-NOT-VERIFIED, 3 DORMANT, 1 INACCESSIBLE, 4 PARTIALLY, 0 NOT IMPLEMENTED. See matrix. |
| 2 | Which features are fully functional today? | Course CRUD + publish lifecycle + video upload/remux + checkpoint + quiz editors + applicability picker (DRAFT only) + Publish Revision (ALL / NON_COMPLETERS / SELECTED) + Require Retake (KEEP_BOTH / REPLACE) + supersession + per-employee assignment + compliance dashboard + employee training view + full audit trail. |
| 3 | Can club admins already configure departmental and positional training requirements? | **Yes — in the DRAFT state.** The three-way `ApplicabilityPicker` (`Everyone` / `Scoped by departments or positions` / `Assign individually`) is exposed on the version editor and is persisted by `updateDraftAction`. Position pickers are populated from `EmployeePosition` rows for the club. |
| 4 | What are the most significant limitations? | (a) Published applicability can only be changed by starting a new DRAFT and publishing a revision (which issues REVISION obligations). (b) The "Assign individually" picker option is a passive flag — it clears appliesToAll but no course-side bulk picker exists; admins must open each employee's profile and click `+ Assign training`. (c) No pre-save preview of "who will be affected" by an applicability change. (d) No bulk completion export / overdue surfacing beyond the compliance dashboard. |
| 5 | What should be improved first? | **Course-level bulk-assignment UI** so "Assign individually" is not a one-at-a-time workflow, AND a **pre-save applicability-preview** on the Publish Revision dialog. These are UX refinements on top of existing services — not new backend work. |
| 6 | What proposed functionality would duplicate something that already exists? | Any "introduce dept/position applicability" feature (already live). Any "revise training" workflow (already live via Publish Revision). Any "retake obligations" issuance (already live via Require Retake). Any "preserve historical completion on revision" (already guaranteed by schema). |
| 7 | Is the module ready for broader employee use, or are there material blockers? | **Ready, with the limitations above.** EP-TRAIN-5C-4A audit + 5C-4B-α UI parity + 5C-4B-β Marc pilot together demonstrate the obligation stream works end-to-end on live data; the dormant obligation-aware scheduling resolver should remain dormant until a dedicated activation slice. |

---

## 2. Audit scope + method

**Scope** — every administrative page, server action, service, API,
component, permission, and database model under `src/app/app/admin/people/safety-training/`,
`src/components/hr/AssignTrainingButton.tsx`,
`src/app/app/admin/people/employees/[id]/`,
`src/lib/hr/training/*.ts`, `src/app/api/hr/training/`,
`src/lib/permissions.ts`. 6 database models audited:
`TrainingCourse`, `TrainingCourseVersion`, `TrainingCheckpoint`,
`TrainingQuestion`, `TrainingAnswerOption`, `TrainingAssignment`,
`TrainingObligation`, `TrainingCompletion`, `TrainingAttempt`,
`TrainingProgress`, `TrainingQuestionResponse`.

**Method** — three independent passes:
1. Code inventory via Explore agent (returned a line-level map).
2. Authenticated browser walk of all 6 admin surfaces as the founder
   (loginAsFounder) at 1440×900, 1 extra surface at 768×1024 (course
   detail — tablet). **Zero destructive clicks.** All 6/6 pages
   rendered OK; screenshots saved to
   `test-results/ep-train-5d1-admin-audit/`.
3. Static spec check: traced each admin button + each
   `requirePermission` call + each `audit()` call to confirm
   observed-vs-wired functionality.

**Preservation guard** — baseline counts captured at audit start; the
browser walk only used GET navigations; no form submissions; no
retake dialogs opened; no publish buttons clicked.

---

## 3. Headline findings

### 3.1 Admin surface inventory (6 pages — all operational)

| # | Route | Purpose |
|---|---|---|
| 1 | `/app/admin/people/safety-training` | Catalogue + Active/Archived toggle + Compliance tab link + Create CTA |
| 2 | `/app/admin/people/safety-training/compliance` | Club-wide compliance roll-up with filters |
| 3 | `/app/admin/people/safety-training/new` | Create course (identity + required flag + 3-way applicability radio) |
| 4 | `/app/admin/people/safety-training/[courseId]` | Course detail: versions table + Revise / Start-new-draft / Retire / Archive / Require-Retake + applicable-employees roster |
| 5 | `/app/admin/people/safety-training/[courseId]/[versionId]` | Version editor: content fields + ApplicabilityPicker + VideoUploader + TimelineEditor + QuizEditor + PublishPanel / PublishRevisionDialog |
| 6 | `/app/admin/people/employees/[id]?tab=training` | Employee training section: eligibility + current reqs + history + AssignTrainingButton |

### 3.2 Server actions, services, APIs

- **21 server actions** in `_actions.ts` cover every observed button.
- **1 training-specific action** in `employees/[id]/_training-actions.ts` (`assignTrainingCourseAction`).
- **2 API routes** under `/api/hr/training/versions/[id]/`: `video` (GET range-streaming + POST upload) and `thumbnail` (GET JPEG).
- **13 service modules** under `src/lib/hr/training/` — courses, versions, questions, checkpoints, applicability, assignments, obligations, revisions, compliance, compliance-resolver, training-session, attempts, employee-read, employee-recommendations, video + video-stream/thumbnail/probe/remux.
- **5 permissions** are defined: `hr:training:read`, `hr:training:write`, `hr:training:publish`, `hr:training:assign`, `hr:training:compliance:read`.
- **24 distinct audit log actions** are written across the services.

### 3.3 Applicability — the specific picker the founder asked about

**EXISTS and is fully wired.** `ApplicabilityPicker.tsx` (at
`src/app/app/admin/people/safety-training/[courseId]/[versionId]/ApplicabilityPicker.tsx`)
renders a 3-way radio:

1. **Everyone** — sets `appliesToAll=true`, clears dept/pos.
2. **Scoped by departments or positions** — checkbox clusters over all
   club `Department` rows + all `EmployeePosition` rows; multi-select
   persists to `appliesToDeptIds` / `appliesToPositionIds` JSON arrays.
3. **Assign individually** — clears appliesToAll + dept + pos; the
   per-employee TrainingAssignment is a SEPARATE workflow (open each
   employee's profile → `+ Assign training`). This is the biggest
   UX gap — see §4 of the gap assessment.

The picker is **DRAFT-ONLY**. On PUBLISHED versions it is disabled.
Changing a published course's applicability therefore requires:
- Click "Revise training" on the course detail page → `startNewDraft`.
- Edit the new DRAFT's applicability in the version editor.
- Click "Publish this version" → `PublishRevisionDialog` → pick a
  policy (ALL_APPLICABLE / NON_COMPLETERS / SELECTED).

Deep dive in Deliverable D.

### 3.4 Obligation stream — accepted architecture is live

EP-TRAIN-5A/5A-1/5B/5B-1/5C-1/5C-2/5C-3/5C-3A/5C-3B/5C-3C and
5C-4B-α are all deployed. Marc's 5C-4B-β pilot is live. Specifically:
- **Issuance:** `issueObligation` (idempotent via composite UNIQUE), `issueManualReinstatement`, `publishDraftWithPolicy` (auto-issues REVISION).
- **Supersession:** auto-superseded on revision publish for prior OUTSTANDING INITIAL/REVISION on older versions.
- **Keep Both vs Replace:** supported in `issueManualReinstatement` conflict-resolution flag.
- **Player engine:** `resolveActiveObligationForSession` + `upsertObligationScopedProgress` + `completeAndSatisfyAtomic` all live.
- **UI parity (5C-4B-α):** persisted OUTSTANDING INITIAL now renders amber "Initial Training Required" chip + state pill + status panel variant, distinct from inferred `INITIAL_REQUIRED`.

### 3.5 Dormant / inaccessible items

- **Global obligation-aware scheduling resolver (`resolveEmployeeTrainingCompliance`)** — not yet wired as the authoritative scheduling-eligibility gate. The dashboard reads it; scheduling writes still use `resolveEmployeeSchedulingEligibility`. (DORMANT by design.)
- **RECERTIFICATION reason** — enum defined in `TrainingObligation.reason`; no issuance path. (NOT IMPLEMENTED.)
- **Bulk assignment UI** — single-employee assignment only. (PARTIALLY IMPLEMENTED.)
- **Applicability-change preview** — no "N employees will gain / lose this requirement" explainer before saving. (PARTIALLY IMPLEMENTED.)
- **Completion CSV export** — compliance dashboard renders but no export button. (NOT IMPLEMENTED.)
- **Overdue surfacing** — no due-date on `TrainingAssignment`; no urgency indicator. (NOT IMPLEMENTED but the schema supports `dueAt` on `TrainingObligation`.)

---

## 4. Preservation audit at end of 5D-1

Zero mutation. The audit was READ-ONLY by construction:
- No ALTER / INSERT / UPDATE / DELETE statements issued.
- Browser walk used GET navigation only, no form submissions, no
  dialog openings beyond initial page render.
- Fly image unchanged: `sha-79b05f36616d`.
- Marc's 2 OUTSTANDING INITIAL obligations preserved.
- Founder's `{9, 30, 9, 0}` byte-identical.

---

## 5. STOP boundaries honoured (directive § STOP)

Not initiating:
- New feature implementation.
- Course applicability changes.
- Obligation issuance or cancellation.
- Permission changes.
- Global compliance resolver activation.
- Scheduling-enforcement change.
- Application deploy to staging or production.

Return the deliverables for founder review; implementation decisions
remain with the founder.
