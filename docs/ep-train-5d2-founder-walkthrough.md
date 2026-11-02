# EP-TRAIN-5D-2 — Founder Visual Walkthrough + Reconciled Inventory

**Status:** READ-ONLY walkthrough. Zero code changes. Zero DB writes. Zero deploys. No obligations issued. Marc Maldiney's two OUTSTANDING INITIAL obligations preserved. Founder `{9, 30, 9, 0}` byte-identical.

**Baseline:** `spectre-staging:sha-79b05f36616d`. `/api/health` = 200.

**Reference:** EP-TRAIN-5D-1 audit (commit `06888d1`).

All screenshots: `test-results/ep-train-5d1-admin-audit/` + `test-results/ep-train-5d2-walkthrough/` (gitignored). The browser spec that captured the extra 5D-2 shots is in-repo at `tests/e2e/ep-train-5d2-walkthrough-screenshots.staging.spec.ts`.

---

## 1. Administrative Training walkthrough — 7 screens

Captured as the founder (Chris Turcato) via `loginAsFounder` on 2026-11-02 at 1440×900, no destructive clicks.

### 1.1 Safety & Training catalogue (admin dashboard)

**Route:** `/app/admin/people/safety-training`
**Screenshot:** `01-training-list-1440x900.png`

**What it shows:** The primary training admin page. Serif heading "Safety & Training" with a one-line description. Two tabs: **Courses** (active) and **Compliance**. Under Courses, a toggle between **Active (10)** and **Archived (0)**. A table lists all 10 Coulee Ridge courses with columns **COURSE** (title + code), **CATEGORY**, **REQUIRED**, **STATE** (`Published · vN` pill), and a trailing **View / Archive** link per row.

**Admin actions available:**
- `+ Create course` (top-right CTA) → navigates to `/safety-training/new`.
- Per-row `View` → course detail.
- Per-row `Archive` → archives the course (gated on `hr:training:publish`).
- Tab switch to Compliance.

**Current functionality:** Fully implemented. The current-version badge accurately reflects each course's PUBLISHED version (`v1` or `v2`).

**Existing limitations:**
- The CATEGORY column shows the raw enum (`Safety`, `Orientation`, `SAFETY`). Consistency of capitalisation would be a tiny polish.
- Column widths are generous; on narrower monitors the trailing View/Archive stacks.

**Recommended improvements:** None required for daily use.

### 1.2 Compliance dashboard

**Route:** `/app/admin/people/safety-training/compliance`
**Screenshot:** `02-training-compliance-1440x900.png`

**What it shows:** The second tab. Summary line: "5 active employees · 0 up to date · 5 require training · 10 published courses." Four filter controls: **Status**, **Department**, **Course**, **Search** (by name or employee #) + **Apply** / **Reset**. A roster table with columns **EMPLOYEE**, **DEPARTMENT**, **REQUIRED**, **COMPLETED**, **OUTSTANDING**, **STATUS**, **SCHEDULING** + per-row **Open** link.

The 5 Coulee Ridge active employees are listed: FounderDemo (10/0/10), Marc Maldiney (10/2/8, Administration), PAY1A Test-A, PAY1A Test-B, Chris Turcato (10/8/2). All show `Training required` + `Not eligible`.

**Admin actions:** Filter / search / open an employee record.

**Existing limitations:**
- **The OUTSTANDING column counts BOTH the 8 inferred `INITIAL_REQUIRED` entries AND the 2 persisted `INITIAL` obligations from the Marc pilot identically** (Marc shows OUTSTANDING = 8). There is no visible distinction between an obligation-backed outstanding course and an inferred-only required course in this admin surface.
- No pagination (will slow at larger clubs).
- No CSV / PDF export.
- No "overdue" filter despite `TrainingObligation.dueAt` existing in the schema.

**Recommended improvements:** See §5 top-5 recommendations (bulk assign, admin obligation chip, pagination).

### 1.3 Create course

**Route:** `/app/admin/people/safety-training/new`
**Screenshot:** `03-training-new-1440x900.png`

**What it shows:** Three editorial cards: **Identity** (Course code + Category select + Course title + Description), **Compliance** (Required-for-scheduling checkbox with explanatory copy), and **Who needs to complete this?** (3-way radio: Everyone / Specific departments or positions / Assign individually). The applicability sub-pickers (dept + position checkbox clusters) are intentionally **deferred to the editor** — a one-line hint says "You can refine department and position selectors after the course is created."

**Admin actions:** Cancel | **Create draft** (primary).

**Current functionality:** Fully implemented. Produces a `TrainingCourse` + `TrainingCourseVersion v1 DRAFT`, redirects to the version editor.

**Existing limitations:**
- Course code is a free-text field with a placeholder — no server-side uniqueness validation hint before submit.
- The hint about deferred sub-pickers is clear but easy to miss.

**Recommended improvements:** None required.

### 1.4 Course detail (Fire Safety)

**Route:** `/app/admin/people/safety-training/[courseId]`
**Screenshot:** `04-course-detail-fire-1440x900.png`

**What it shows:** The course landing page for a specific course. Serif heading **Fire Safety** + code chip `FIRE_SAFETY`. Three action buttons top-right:
- **Revise training** (secondary) — starts a new DRAFT version cloned from v1.
- **Require retake** (secondary) — opens the RequireRetakeDialog (see §1.7).
- **Retire course** (red, destructive) — soft-retires the course.

Below: **Versions** table showing `v1 PUBLISHED` on 10/31/2026 (no retired date, "View" link). An explanatory sentence: *"Currently published: v1. Publishing a new draft will retire the previous version. Historical completions remain valid against the version they were earned against."*

**Applicable employees** roster: 5 rows (FounderDemo, Marc, PAY1A-A, PAY1A-B, Chris) with status chip (`Not started` / `Completed`), SCORE, COMPLETED date, APPLIES VIA ("Applies to all employees" for all rows), and `Open` link.

**Admin actions available:** Revise training | Require retake | Retire course | Open employee row.

**Existing limitations:**
- **Marc's row shows "Not started"** — his 2 OUTSTANDING INITIAL obligations from the pilot are present in the DB but NOT distinguished here. The admin cannot tell at a glance that Marc has a persisted INITIAL obligation vs just inferred `INITIAL_REQUIRED`.
- No per-row "+ Assign training" (admin must click Open → navigate to the employee's Training tab → click + Assign training).

**Recommended improvements:** Add the amber "Initial Training Required" chip to this roster when `activeObligation.reason === "INITIAL"` (same pattern as 5C-4B-α on the employee portal, applied to the admin surface).

### 1.5 Version editor (Fire Safety v1 — PUBLISHED, read-only)

**Route:** `/app/admin/people/safety-training/[courseId]/[versionId]`
**Screenshot:** `05-version-detail-fire-v1-1440x900.png` (full-page capture is tall)

**What it shows:** The full version editor. All form fields are disabled because v1 is PUBLISHED. A banner at the top explains:
> *"This version is published. To edit content, **open the course** and start a new draft."*

Six sections render vertically:

1. **Course content** — title, description, passing score (80%), retakes allowed, include knowledge test, required for scheduling.
2. **Who needs to complete this?** — the 3-way `ApplicabilityPicker` with "Everyone" selected (disabled).
3. **Training video** — HTML5 video player (0:00/0:41), video metadata (`video/mp4`, 47.2 MB, 0m 42s).
4. **Interactive checkpoints** — second video player + a horizontal **CHECKPOINT TIMELINE** (orange markers at 0:10 and 0:20), + table listing both checkpoints with Position, Label, Required=Yes, Retries=3, Questions=1, and `Edit` links.
5. **Final assessment** — the quiz question appears below ("Who is the Fire Marshal at Coulee Ridge Golf and Country Club?") with Single answer dropdown and two options ("Smokey the Bear", "Fin the Flame").
6. **Publish panel** (not visible in this crop; is at the bottom of the editor for DRAFT versions).

**Admin actions available (DRAFT state only):** every field is editable; **Save draft** button; VideoUploader; TimelineEditor create/edit/delete checkpoint; QuizEditor add/edit/delete/reorder questions; PublishPanel (first-publish) or PublishRevisionDialog (revision-publish).

**Current functionality:** Fully implemented.

**Existing limitations:**
- The read-only banner correctly explains the editing path.
- The ApplicabilityPicker is correctly disabled on PUBLISHED versions.
- The "Interactive checkpoints" section renders TWO videos (one preview + one timeline scrubber). On larger clubs with longer videos this may feel heavy; current fixture course is 42s so it's manageable.

### 1.6 Employee profile — Marc, Training tab

**Route:** `/app/admin/people/employees/[id]?tab=training`
**Screenshot:** `07-employee-detail-marc-training-tab-1440x900.png` (captured by 5D-2 spec)

**What it shows:** Marc's full training record visible to the admin:
- **Scheduling eligibility:** `Not eligible · 8 required courses outstanding`
- **Current Requirements** header + `+ Assign training` button (top-right).
- 10 course rows, each with the title + code + "Applies to all employees" + `Required` chip + status chip (`Not Started` × 8, `Completed` × 2). Safety Basics and Workplace Safety Orientation show their completion dates + scores (Sep 14, 2026, 100%).
- **Training History** table at the bottom listing historical completions by course + VERSION + COMPLETED + SCORE. Marc's history shows Workplace Safety Orientation v2 + Safety Basics v1 (annotated "Superseded by newer version").

**Admin actions available:** `+ Assign training` (opens the AssignTrainingButton form).

**Existing limitations (same as §1.4):**
- Marc's OUTSTANDING INITIAL obligations for ORIENTATION_2027 and FIRE_SAFETY show as `Not Started` (same chip as the other 6 inferred requirements). The admin cannot tell which 2 are backed by a persisted obligation.
- No per-row deadline / overdue indicator.

### 1.7 Require Retake dialog (Fire Safety)

**Route:** opened from the Fire Safety course-detail page via the **Require retake** button.
**Screenshot:** `08-require-retake-dialog-step1-1440x900.png` (captured by 5D-2 spec; dialog opened + closed via Escape immediately, no retake issued).

**What it shows:** A 3-step wizard dialog. Step 1 presents:
- Heading **Require retake — Fire Safety** + explanatory subtitle.
- Required field **REASON FOR RETAKE** (multi-line textarea with example placeholder).
- Optional **DEADLINE** (yyyy-mm-dd date picker).
- **EMPLOYEES (0 SELECTED)** — filter input + 5 employee checkboxes, each with the current status beside the name (`Not started` or `Completed 10/31/2026`).
- Footer: **Cancel** | **Review** (step 2 — review conflicts) → confirmation (step 3 — Keep Both / Replace per employee).

**Admin actions:** Pick employees + reason + optional due-date → Review → confirm → `requireRetakeAction` → `issueManualReinstatement` creates MANUAL_REINSTATE obligations.

**Current functionality:** Fully implemented. Exercised end-to-end in EP-TRAIN-5C-3A/B/C acceptance.

**Existing limitations:** None material.

---

## 2. Applicability management — demonstration

### 2.1 The 3 modes (as rendered in `ApplicabilityPicker`)

| Mode | Semantics | Server effect on `TrainingCourseVersion` |
|---|---|---|
| **Everyone** | Every active employee in the club is required. | `appliesToAll = true`; `appliesToDeptIds = null`; `appliesToPositionIds = null`. |
| **Specific departments or positions** | Members of ANY checked department OR ANY checked position are required. The two clusters compose as OR, not AND. | `appliesToAll = false`; `appliesToDeptIds = JSON [ids]`; `appliesToPositionIds = JSON [ids]`. |
| **Assign individually** | The course applies ONLY to employees you explicitly add via each employee's profile. | `appliesToAll = false`; both JSON fields = `null`. **The radio does NOT open an employee picker on this page** — assignment happens in each employee's profile via `+ Assign training`. |

The picker is rendered inside the version editor (`05-version-detail-fire-v1-1440x900.png`) and in a simpler form on the new-course page (`03-training-new-1440x900.png`, sub-pickers deferred until after draft creation).

### 2.2 DRAFT vs PUBLISHED — the critical difference

Editing a **DRAFT** version:
- The ApplicabilityPicker is interactive.
- Save draft → `updateDraftAction` persists the new flags.
- The DRAFT does not yet produce obligations for anyone.

Changing a **PUBLISHED** version's applicability requires a Revise workflow:
1. From the course detail (§1.4) click **Revise training**.
2. `startNewDraft` service clones v1 content into a new DRAFT (v2), **but does NOT clone checkpoints** — a known defect noted in the 5C-3C audit; the admin must re-create them before publishing.
3. Open the new DRAFT in the version editor; change the applicability.
4. Open the **Publish Revision** dialog; pick a policy:
   - **ALL_APPLICABLE** — issue REVISION obligations to EVERY employee the new version applies to.
   - **NON_COMPLETERS** — only to those who did not complete the prior version.
   - **SELECTED** — pick a per-employee list.
5. Confirm → `publishDraftWithPolicy` runs. v1 → RETIRED, v2 → PUBLISHED + `currentVersionId` flipped. REVISION obligations are issued; prior OUTSTANDING INITIAL/REVISION on older versions auto-superseded (`SUPERSEDED` status).

**Important:** MANUAL_REINSTATE obligations are NEVER auto-superseded by a publish (EP-TRAIN-5B-1 invariant), so a currently-pending Require-Retake obligation survives a revision publish.

### 2.3 What happens when you change ONLY applicability (not content)?

If the admin starts a new DRAFT and edits ONLY the applicability (keeps the video, checkpoints, questions, title, score), then publishes with `ALL_APPLICABLE`:

- **Every employee in the new applicability set receives a new REVISION obligation.** The resolver treats this as a mandatory new completion requirement — even if the actual content didn't change.
- Historical TrainingCompletion rows on v1 are PRESERVED (schema invariant) but no longer "count" for compliance against v2 (the obligation-aware resolver requires a completion on the current PUBLISHED versionId).
- Employees see "Updated Training Required" chips on their dashboard.

**This is almost certainly NOT the admin's intent when they only wanted to narrow a course from club-wide to specific departments.** The admin probably wants to _tell the resolver_ "narrow the applicable set" without issuing retake obligations to the employees who remain in-scope.

### 2.4 Unintended-REVISION risk — the specific scenarios

The founder asked for the exact pathways by which an applicability-only change could create unintended REVISION obligations or retake requirements:

1. **Narrowing the applicability** (e.g., "Everyone" → "Scoped: GOLF_OPS only").
   - Admins who publish `ALL_APPLICABLE`: issue REVISION obligations to the NEW applicable set (GOLF_OPS members). GOLF_OPS employees who ALREADY completed v1 nonetheless get a REVISION obligation — even though content is unchanged.
   - Admins who publish `NON_COMPLETERS`: GOLF_OPS employees who completed v1 are skipped; only GOLF_OPS non-completers get the REVISION.
   - Employees who move OUT of applicability (non-GOLF_OPS): no REVISION issued. Their existing OUTSTANDING INITIAL obligations stay OUTSTANDING on the retired v1 but are no longer surfaced on their dashboard (`activeObligation` resolution picks the course's `currentVersionId` v2; their obligation is on v1 which is no longer current).

2. **Broadening the applicability** (e.g., "Scoped: ADMIN only" → "Everyone").
   - `ALL_APPLICABLE`: every employee in the club gets a REVISION obligation.
   - `NON_COMPLETERS`: every employee who hasn't completed v1 — likely most of the club if the course was previously ADMIN-only.
   - `SELECTED`: admin cherry-picks who gets the REVISION.

3. **No applicability change, content change**:
   - `ALL_APPLICABLE`: issue REVISION to all current applicable employees (expected and correct).

4. **No applicability change, no content change**:
   - This should rarely happen (why publish a revision?), but technically the admin can. Same effect as #3.

### 2.5 Mitigations currently available

- The `PublishRevisionDialog` shows a COUNT of applicable employees per policy before confirming (e.g., "N of M employees would receive a new requirement"). The admin can therefore see the magnitude of the issuance before confirming.
- The SELECTED policy lets the admin opt out individual employees.
- For "I only want to narrow applicability without issuing retakes": the admin can use **SELECTED** and simply not check any employees — the publish still happens, applicability narrows, but no obligations are issued. This is a workaround but currently the ONLY way to perform a silent narrowing.

**Gap worth flagging to the founder (see §5 recommendations):** a `NO_RETAKE` policy that publishes a revision without issuing any REVISION obligations — ideal for pure-applicability narrowing. Not implemented; would be an additive service argument.

---

## 3. Assignment workflows — review + bulk gap

### 3.1 Current single-employee assignment flow

1. Admin opens an employee's profile (`/app/admin/people/employees/[id]?tab=training`).
2. Clicks `+ Assign training` in the Current Requirements header (§1.6 screenshot).
3. A compact form appears with:
   - Course dropdown filtered to PUBLISHED + not retired + not already assigned.
   - Optional note field.
   - Submit button.
4. Submit → `assignTrainingCourseAction` → `assignments.assignCourseToEmployee` → creates `TrainingAssignment` row + audit log entry (`hr.training.assignment.create`).

**Permission gate:** `hr:training:assign` (CLUB_ADMIN + GENERAL_MANAGER).

### 3.2 Course-level "Applicable employees" roster (read-only)

The course-detail "Applicable employees" roster (§1.4) **lists every employee a course currently applies to** (via `appliesToAll`, dept match, position match, or explicit `TrainingAssignment`). Each row deep-links to the employee's profile via `Open`.

**There is NO "+ Add employee" button on the roster.** The roster is derived from the current applicability flags + explicit assignments; the admin cannot add a per-employee assignment from this page.

### 3.3 What's missing from a bulk-assign workflow

The gap is that performing an "assign this course to a cohort" operation requires one page load + two clicks per employee:
- Navigate to employee profile (Open link).
- Click + Assign training.
- Select course from dropdown.
- Submit.
- Return to the course detail.
- Repeat for the next employee.

For a 5-employee pilot like Coulee Ridge this is tolerable; for larger clubs or for "assign this new course to the whole Culinary department" it becomes slow.

### 3.4 Could bulk assign live on an existing screen?

**Yes — the "Applicable employees" roster on the course detail is the obvious host.** Specifically:
- Add a filter box at the top of the roster (same filter the compliance tab uses — status / dept / search).
- Add row-level checkboxes + a "Select all filtered" header.
- Add a trailing `+ Assign to selected` button that batches `assignCourseToEmployee` across the selected `employeeIds`.
- Add a one-click "Open employee" affordance (already present via `Open` link).

This stays within an existing screen (no new modal, no new page, no new route), reuses the already-visible roster, and composes cleanly with the existing `+ Assign training` on the employee profile (which stays as the single-employee shortcut).

**Alternative placement considered:** adding a dialog from the catalogue row. Rejected because it introduces another modal + duplicates the roster.

---

## 4. Inventory reconciliation (directive §4)

The EP-TRAIN-5D-1 audit report's executive summary and matrix rollup gave inconsistent totals. Reconciling with per-row evidence from the feature matrix:

### 4.1 Row-by-row counting (the correct basis)

The matrix in `docs/ep-train-5d1-feature-inventory.md` contains **83 numbered features** across 7 sections:

| Section | Feature IDs | Count |
|---|---|---|
| A — Training administration dashboard | 1–8 | 8 |
| B — Course creation + management | 9–25 | 17 |
| C — Interactive training builder | 26–37 | 12 |
| D — Applicability + assignments | 38–49 | 12 |
| E — Revisions, retakes, reinstatement | 50–60 | 11 |
| F — Employee monitoring + compliance | 61–74 | 14 |
| G — Permissions + governance | 75–83 | 9 |
| **Total audited features** | | **83** |

### 4.2 Classification totals (recounted from the matrix rows)

| Classification | A | B | C | D | E | F | G | **Total** |
|---|---|---|---|---|---|---|---|---|
| FULLY IMPLEMENTED | 4 | 17 | 11 | 6 | 11 | 8 | 8 | **65** |
| IMPLEMENTED — NOT VERIFIED | 1 | 0 | 0 | 0 | 0 | 2 | 0 | **3** |
| BACKEND ONLY | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| PARTIALLY IMPLEMENTED | 0 | 0 | 1 | 3 | 0 | 1 | 0 | **5** |
| NOT IMPLEMENTED | 3 | 0 | 0 | 3 | 0 | 3 | 0 | **9** |
| INACCESSIBLE | 0 | 0 | 0 | 0 | 0 | 0 | 1 | **1** |
| DORMANT | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| **Section total** | **8** | **17** | **12** | **12** | **11** | **14** | **9** | **83** |

**Sum check:** 65 + 3 + 0 + 5 + 9 + 1 + 0 = **83** ✓

### 4.3 Prior-document corrections

The 5D-1 audit report (commit `06888d1`) stated:

- Executive summary §1 row 1: *"44 features audited; 32 FULLY, 4 IMPL-NOT-VERIFIED, 3 DORMANT, 1 INACCESSIBLE, 4 PARTIALLY, 0 NOT IMPLEMENTED"* → **this count is wrong**; the correct totals are above.
- Matrix rollup bottom: *"48/2/0/6/8/1/1 = 66 Total audited features"* → **this count is wrong**; the correct section-sum is 83 and the classification totals are 65/3/0/5/9/1/0.

The individual per-row classifications in the matrix body are correct; the rollup aggregation was undercounting (missed rows during manual counting). This supersedes the earlier two tallies.

### 4.4 Why DORMANT dropped to 0

In the 5D-1 narrative I described `resolveEmployeeTrainingCompliance` as "DORMANT by design" because it is not yet the authoritative scheduling-eligibility gate. In the matrix I classified every row that reads it (dashboard chip, employee portal state pill, etc.) as FULLY IMPLEMENTED because those surfaces DO read the resolver live. The resolver's **cutover to be the scheduling authority** is a strategic decision, not a feature row. On reflection it does not warrant a dedicated DORMANT row in the inventory — it is a config/policy decision captured as `R9` in the recommendations.

### 4.5 Classification shift decisions

No row's classification is CHANGED by this reconciliation. The correction is only the aggregate rollup numbers.

---

## 5. Prioritised founder review — top-5 improvements

Each recommendation lists: **What exists today** / **What is missing** / **Why it matters** / **Classification** (functional defect / governance / UX refinement) / **Estimated scope** / **Compatibility with accepted workflows**.

### Rec 1 — Course-level bulk-assign on the "Applicable employees" roster

- **What exists today:** The course-detail "Applicable employees" roster (§1.4) is read-only. The compliance dashboard filters work great. The per-employee `+ Assign training` button on each employee profile creates one `TrainingAssignment` at a time.
- **What is missing:** Row-level checkboxes + a batched `+ Assign to selected` button on the course-detail roster.
- **Why it matters:** The common "assign this new SOP to the Culinary department" workflow currently requires one navigation + two clicks per employee. For a 20-person department, that's ~60 clicks across ~20 page loads. The bulk control reduces this to a filter + check-all + one click.
- **Classification:** UX refinement.
- **Scope:** Small. 1 new UI component on the course-detail page + 1 new server action `assignCoursesToEmployeesBatchAction` wrapping the existing `assignCourseToEmployee` in a loop (per-row audit preserved). No schema change. No resolver change.
- **Compatibility with accepted workflows:** Fully compatible. The single-employee flow stays as the quick shortcut from the employee profile. The bulk flow is additive.

### Rec 2 — Admin-visible persisted-INITIAL distinction (parity with Employee Portal)

- **What exists today:** The Employee Portal distinguishes a persisted OUTSTANDING INITIAL obligation (amber "Initial Training Required" chip + state pill + status panel) from an inferred `INITIAL_REQUIRED` state (chip-suppressed "Required" + "Not Started" pill). This was shipped as EP-TRAIN-5C-4B-α. The ADMIN surfaces still render both as "Not Started" in the course-detail "Applicable employees" roster (§1.4) and the employee-profile Training tab (§1.6).
- **What is missing:** The admin's roster rows (course-detail + employee-profile Training tab + compliance dashboard OUTSTANDING column) should surface the same amber "Initial Training Required" distinction when `activeObligation.reason === "INITIAL"`. The chip in the compliance dashboard can be a count badge next to the OUTSTANDING total ("8 outstanding · 2 persisted").
- **Why it matters:** The founder deliberately authorised the 5C-4B-β pilot specifically so the pilot's effect would be visible on admin surfaces. The pilot shows correctly on Marc's EMPLOYEE PORTAL but admins reviewing the course roster or the compliance dashboard see no difference between Marc's 2 persisted obligations and his 6 inferred requirements. If an operator wants to spot-check "which Marc courses were covered by the pilot?" they currently need DB access.
- **Classification:** Governance / UX parity.
- **Scope:** Small. Copy of the 5C-4B-α branch logic from `src/app/employee/(authed)/safety-training/page.tsx:171-190` to the admin pages. 3 files touched (course-detail roster, employee-profile Training tab, compliance dashboard). No resolver change.
- **Compatibility:** Full. Pure additive UI.

### Rec 3 — "NO_RETAKE" publication policy for silent applicability narrowing

- **What exists today:** `publishDraftWithPolicy` supports `ALL_APPLICABLE`, `NON_COMPLETERS`, `SELECTED`. All three issue at least one REVISION obligation per newly-applicable employee. The only workaround for "I just want to narrow applicability without issuing any REVISION" is to pick SELECTED and uncheck everybody.
- **What is missing:** A fourth policy, `NO_RETAKE`, that performs the publish (retires v1 + flips `currentVersionId` + supersedes stale OUTSTANDING) but issues ZERO new REVISION obligations.
- **Why it matters:** The applicability deep dive (§2.4) showed that admins who want to narrow a course from club-wide to departmental risk issuing redundant REVISION obligations to employees who already completed v1 of the same content. The workaround (SELECTED with no employees checked) is non-obvious and feels like a workaround.
- **Classification:** Functional + UX. Resolves a genuine mismatch between admin intent ("just update applicability") and system behaviour (which issues retake obligations).
- **Scope:** Small. One new enum value + one branch in `publishDraftWithPolicy` + one radio option in `PublishRevisionDialog`. No schema change (REVISION obligations are not created in this branch).
- **Compatibility:** Full. Existing three policies unchanged.

### Rec 4 — Fix the known checkpoint-clone defect in `startNewDraft`

- **What exists today:** The "Revise training" workflow invokes `courses.startNewDraft` which clones video + title + questions + answer options + applicability flags from v1 into v2 DRAFT, but **does NOT clone the TrainingCheckpoint rows**. The admin must re-create every checkpoint on the new DRAFT before it is publishable (the publish-readiness check will refuse otherwise).
- **What is missing:** Extend the clone loop in `src/lib/hr/training/courses.ts:385-480` to also clone `TrainingCheckpoint` rows and remap the `question.checkpointId` FK.
- **Why it matters:** Every revision today requires manual checkpoint re-creation. For a 2-checkpoint fixture course this is quick; for a real training with 5+ checkpoints it is both tedious AND error-prone (the admin has to re-watch the video to re-time each checkpoint). This was discovered during EP-TRAIN-5C-3C §2 acceptance.
- **Classification:** Functional defect (surprising incomplete behaviour).
- **Scope:** Small. ~30 lines of code added to the service. Needs 1 Playwright test for the revise-then-publish path (the existing 5C-3C §2 spec can be extended) + DRH-1 staging deploy.
- **Compatibility:** Full. The clone is additive to existing content; existing revisions on staging continue to work.

### Rec 5 — Server-side pagination on the compliance dashboard

- **What exists today:** The compliance page renders the entire active-employee roster of the active club in a single table (§1.2). Coulee Ridge has 5 employees so this is fine. The underlying service (`compliance.getClubTrainingCompliance`) fetches every row.
- **What is missing:** A `?page=N&limit=M` query-string + a UI pager. The existing filters already shrink the result set but there is no top-of-page cap.
- **Why it matters:** The current implementation performs an N × M (employees × courses) join on every compliance page load. On a club with 50 employees + 15 required courses that is 750 compliance rows + the associated obligation + completion joins; render time + payload becomes a user-visible delay.
- **Classification:** UX refinement (becomes blocker beyond ~50 employees / club).
- **Scope:** Small. Add offset+limit to `getClubTrainingCompliance` + a pager component to the page. No schema change. No resolver change.
- **Compatibility:** Full. Existing single-page clubs render identically with the default `page=1, limit=50`.

### Prioritisation rationale

| Rec | Operational impact | Risk to accepted workflows | Scope | Suggested order |
|---|---|---|---|---|
| **Rec 1** — Bulk assign | High (saves ~90% of clicks for cohort assignment) | Zero | Small | 1 |
| **Rec 2** — Admin obligation chip | High (makes the pilot visible on admin side, directly serves future obligation-aware operations) | Zero | Small | 2 |
| **Rec 3** — NO_RETAKE policy | High (prevents an entire class of unintended retake issuance) | Zero (new enum, existing policies untouched) | Small | 3 |
| **Rec 4** — Checkpoint clone | Medium (fixes a known defect; admin pain scales with course complexity) | Low (service change needs test coverage + staging deploy) | Small | 4 |
| **Rec 5** — Compliance pagination | Low today, becomes blocker at scale | Zero | Small | 5 |

Each is small, each is additive, each is independently shippable. If the founder authorises any subset, the natural order is 1 → 2 → 3 → 4 → 5.

---

## 6. Preservation + STOP

**Preservation audit at end of 5D-2:**
- Fly image: `sha-79b05f36616d` (unchanged).
- Global totals: `{obligations: 2, completions: 11, attempts: 33, progress: 12}` byte-identical.
- Founder (Chris Turcato, E-00002): `{completions: 9, attempts: 30, progress: 9, obligations: 0}` byte-identical.
- Marc Maldiney (E-00003): 2 OUTSTANDING INITIAL obligations present + unmodified.
- Zero course applicability changes. Zero new assignments. Zero new obligations. Zero cancellations. Zero permission changes. Zero resolver activation. Zero scheduling-enforcement change. Zero deploy.

**STOP honoured (directive §6):** No implementation initiated for any of Rec 1-5. Founder decides which (if any) to authorise.

Awaiting founder review.
