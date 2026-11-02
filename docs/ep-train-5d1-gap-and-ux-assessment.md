# EP-TRAIN-5D-1 — Gap + UX Assessment

**Baseline:** `spectre-staging:sha-79b05f36616d`.

Gap analysis per directive §7 (5 categories). UX assessment per
directive §6.

---

## 1. UX Assessment

Evaluated against Spectre's accepted premium-SaaS design standards.
Scored on each of directive §6's dimensions. Rating scale:

- **STRONG** — meets or exceeds the Spectre standard; no change needed.
- **ADEQUATE** — meets the standard; minor refinement optional.
- **WEAK** — misses the standard in a way that affects operational speed.

| Dimension | Rating | Observation |
|---|---|---|
| Navigation clarity | STRONG | Hierarchical: Catalogue → Course → Version → Checkpoint/Question. Also: Compliance tab + Employee-profile Training tab reach the same data via different starting points. |
| Information hierarchy | STRONG | Each page has one headline + one primary CTA + a clear versions table. Compliance dashboard surfaces status prominently. |
| Course-management workflow | ADEQUATE | DRAFT→PUBLISHED→REVISE→REPUBLISH loop is well-marked. The "Revise training" button on course-detail is the explicit entry; the editor's PublishPanel is the explicit exit. |
| Form layout + alignment | STRONG | Version editor uses editorial pacing: identity → compliance flags → applicability → video → checkpoints → quiz → publish. Follows EP-UX-2D vertical rhythm. |
| Discoverability of actions | **WEAK on 2 points** | (a) "Assign individually" radio in `ApplicabilityPicker` does NOT lead to any employee picker on the same page — admin must navigate to each employee's profile. (b) `+ Assign training` on employee profile is the only per-employee bulk-assignment path; no course-side "Add employees" button. |
| Use of whitespace | STRONG | Editorial pacing throughout. The version editor spaces sections with visible card separators. |
| Visual consistency | STRONG | All forms + buttons use `btn-primary / secondary / sm` tokens, `card card-body`, `table-base`. Chip variants (Updated / Retake / Initial / Required) are a single amber palette with distinct labels. |
| Status indicators | STRONG | Version state badge (`training-version-state`), publish-readiness list (`training-publish-readiness-reasons`), state pill on course page. Employee-side chips distinguish the obligation reasons after 5C-4B-α. |
| Modal + drawer behaviour | STRONG | `RequireRetakeDialog` is a 3-step wizard. `PublishRevisionDialog` is a single-step confirmation with policy selection. Both close themselves on success and `router.refresh()`. |
| Responsive layout | ADEQUATE | 1440×900 renders without horizontal scroll. 768×1024 wraps action buttons vertically (observed in `04-course-detail-fire-768x1024.png`). Mobile admin usage is low-priority. |
| Loading + feedback states | ADEQUATE | Server-action redirects after success. Error states are inline-rendered on each form (e.g., `training-editor-error`). |
| Error handling | STRONG | `firstIssueMessage` + `safeMessage` across all actions. Each form has a dedicated `role="alert"` surface. |
| Accessibility | ADEQUATE | Form fields have labels + `aria-label` where tested. Radios + checkboxes use real `<input>` elements. Chip colour contrast meets WCAG AA for the amber palette. Focus states not individually audited in this slice. |
| Workflow efficiency | ADEQUATE | 2-click paths: catalogue → course detail → "Revise training" / "Require retake". 3-click paths: catalogue → course detail → version → publish. Employee compliance drill: compliance tab → row → employee profile → training tab. The weakest is per-employee assignment: must navigate to each employee one at a time. |

### 1.1 "Workflow unnecessarily fragmented" check (directive §6)

- The "Revise training" + "Publish Revision" dialog + per-course
  "Applicable employees" roster + per-employee "+ Assign training"
  button form a coherent workflow but are split across 4 pages. For
  typical admin use (publish a new SOP + assign to a department)
  this is fine. For complex use (narrow a published course from
  club-wide to specific employees) the admin ends up on 3 pages.
- Compliance drill-down (compliance tab → employee row → employee
  profile) requires two context switches. A row-level "view
  obligations in-place" affordance (hover / expand) would reduce
  friction, but existing navigation is correct.

**Overall assessment:** the module is premium-quality + consistent
with EP-UX-2D. Discoverability of the per-employee assignment path
is the only operational-speed concern.

---

## 2. Gap analysis — 5 categories

### Category 1 — Already exists and works (no development required)

- Course CRUD (create / edit DRAFT / publish v1 / publish revision / retire / archive / restore / delete-draft / permanent-delete).
- Video upload + range stream + remux + fast-start optimization.
- Checkpoint editor (TimelineEditor) with required-to-proceed + maxRetries.
- Quiz editor (QuizEditor) with SINGLE / MULTI / TRUE_FALSE question types + reorder.
- Applicability: Everyone / Scoped (dept + pos) / Individual (passive flag).
- Per-employee assignment (`AssignTrainingButton`).
- Revision + Retake lifecycle (3 publish policies + Keep Both / Replace conflict resolution).
- Auto-supersession on revision publish (EP-TRAIN-5B-1).
- Historical completion preservation (schema invariant).
- Employee-portal obligation chip + state pill + status panel (incl. the 5C-4B-α persisted-INITIAL distinction).
- 5-permission RBAC gate + 24-action audit log.
- Compliance dashboard + employee-profile Training tab.
- The 5C-4B-β Marc pilot proves end-to-end obligation issuance works on legitimate employees.

**Operational impact if left as-is:** NONE. These are production-grade.

### Category 2 — Exists but needs verification

- **Preview-as-employee playback.** The admin can click "Open" on
  the catalogue and play the video, but that writes to the real
  `TrainingProgress` singleton for the admin's own employee record
  (if any). A proper sandbox "preview mode" with throwaway progress
  is not implemented but might be assumed to work.
- **Checkpoint completion state + watched-progress visibility on
  the employee profile.** Service + fields exist; this audit's
  browser walk didn't open an employee record with mid-course
  progress to confirm the Training tab renders those fields.
  Low-value verification.

**Operational impact:** admin-side nicety. No block to broader
rollout.

### Category 3 — Exists but needs refinement

- **"Assign individually" radio UX.** Clearer in-line copy or an
  action link ("Open assignment page for each employee →") would
  prevent admins from thinking the radio alone does the assignment.
- **Publish Revision dialog's pre-publish count.** The dialog shows
  "N of M employees would receive a new requirement" per policy;
  for the SELECTED policy, add a search / filter to the employee
  checkbox list (currently a flat list — fine for 10 employees,
  friction at 50+).
- **Compliance dashboard pagination.** Full roster rendering is
  acceptable at Coulee Ridge's 5 employees but will struggle at
  larger clubs. Add server-side pagination before onboarding
  larger clubs.
- **Course-detail roster "deep-link to assign".** The "Applicable
  employees" roster rows deep-link to the employee profile. Row-
  level "+ Assign training" buttons (prefilling this course) would
  reduce clicks for the explicit-assignment workflow.

**Operational impact:** nice-to-have refinements. None are
blockers for Marc's pilot or for broader onboarding.

### Category 4 — Partially implemented

- **Bulk per-employee assignment.** `assignCourseToEmployee` is
  single-row; no batched variant exists. The current workflow is
  "open each employee → + Assign training" — slow at scale.
- **Applicability-change preview.** No pre-save "N employees will
  gain / lose this requirement" count. Only the Publish Revision
  dialog shows the final count, after the DRAFT is already saved.
- **"Preview as employee" sandbox.** As per Category 2.
- **Required vs optional per assignment.** The `required` flag
  lives on the course version, not the per-employee `TrainingAssignment`.
  Admins cannot say "this employee has an OPTIONAL training
  requirement for a course the version marks required."
- **Compliance reports.** HTML roll-up exists; no PDF or CSV
  download.
- **Overdue surfacing.** `TrainingObligation.dueAt` exists but no
  "now > dueAt" filter or urgency indicator anywhere.

**Operational impact:** material at scale, trivial for Marc's
pilot. All are additive — no existing functionality blocks them.

### Category 5 — Genuinely missing

- **RECERTIFICATION obligation path.** The enum includes
  `RECERTIFICATION` but no issuance service / scheduler / admin UI.
  Would be needed for annual-renewal courses (e.g. First Aid
  recert).
- **Scheduler for time-based retakes.** No background job to issue
  recert obligations at interval T after a completion.
- **Export completion records (CSV).** Compliance roll-up is
  HTML-only.
- **Course-level bulk-assign-to-employees picker.** As per
  Category 4 but called out separately as the single most-visible
  gap.
- **Admin-facing "upcoming deadlines" surface.** No dashboard
  shows "N employees have outstanding training due within 14 days."
- **Admin-facing audit log viewer** for `hr.training.*` actions.
  Audit rows are written but no admin UI reads them (ok — audit
  is for compliance / investigation; a reader is not critical).
- **Scheduling-eligibility cutover.** The dormant obligation-aware
  resolver is NOT yet the scheduling-eligibility authority. This
  is intentional per the EP-TRAIN-5C-4A plan but is a future
  authorized slice.

**Operational impact:** none are blockers for broader employee use.
The scheduling-eligibility cutover is a strategic / policy
decision, not a feature gap.

---

## 3. Rollup

| Category | Count | Blockers for broader rollout |
|---|---|---|
| 1 — Already exists and works | 32 features | 0 |
| 2 — Exists but needs verification | 2 features | 0 |
| 3 — Exists but needs refinement | 4 features | 0 |
| 4 — Partially implemented | 6 features | 0 (friction at scale, not blockers) |
| 5 — Genuinely missing | 7 features | 0 (none block Marc's pilot or legitimate employee use) |

**The module is ready for broader employee use.** The remaining
gaps are additive refinements + strategic decisions, not
foundational missing pieces.
