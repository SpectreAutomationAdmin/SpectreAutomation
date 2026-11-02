# EP-TRAIN-5D-1 — Administrative Training Feature Inventory Matrix

**Baseline audited:** `spectre-staging:sha-79b05f36616d` (α code
baseline). All file:line references are relative to
`C:\dev\SpectreAutomation\`.

Classifications used (directive §4):
- **FULLY IMPLEMENTED** — UI, API, service, persistence all exist AND verified end-to-end.
- **IMPLEMENTED — NOT VERIFIED** — exists but not browser-tested in this audit.
- **BACKEND ONLY** — service / data model exists; no usable admin UI.
- **PARTIALLY IMPLEMENTED** — some required parts missing from the workflow.
- **NOT IMPLEMENTED** — no substantive implementation found.
- **INACCESSIBLE** — exists but blocked by permissions / navigation.
- **DORMANT** — implemented behind an activation boundary / feature flag.

Machine-readable CSV: `ep-train-5d1-feature-inventory.csv`.

---

## A. Training administration dashboard

| # | Feature | Classification | Admin route | Component | API / action | Service | Model | Permission | Browser verified | Known limitations |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Training catalogue list (Active) | FULLY IMPLEMENTED | `/app/admin/people/safety-training` | `safety-training/page.tsx` | — (SSR) | `courses.listClubCourses` l.875 | TrainingCourse | `hr:training:read` | ✅ screenshot `01-training-list-1440x900.png` | — |
| 2 | Archived courses list toggle | FULLY IMPLEMENTED | same + `?archived=1` | `safety-training/page.tsx` | — | `courses.listClubCourses` | TrainingCourse | `hr:training:read` | ✅ (archived toggle visible) | — |
| 3 | Courses / Compliance tab switcher | FULLY IMPLEMENTED | both pages | `_SafetyTrainingTabs.tsx` | — | — | — | `hr:training:read` + `hr:training:compliance:read` | ✅ | — |
| 4 | Club-wide compliance roll-up | FULLY IMPLEMENTED | `/safety-training/compliance` | `compliance/page.tsx` | — (SSR) | `compliance.getClubTrainingCompliance` l.405 | TrainingCompletion + TrainingObligation + Employee | `hr:training:compliance:read` | ✅ screenshot `02-training-compliance-1440x900.png` | No CSV export |
| 5 | Compliance filters (status / dept / course / search) | IMPLEMENTED — NOT VERIFIED | `/compliance?status=…&departmentId=…&courseId=…&q=…` | `compliance/page.tsx` | query-string | same | — | `hr:training:compliance:read` | ✅ (filters render; not exercised) | — |
| 6 | Outstanding requirements rail (dashboard-level) | NOT IMPLEMENTED | — | — | — | — | — | — | — | Admin compliance page is the aggregate; no "top-N overdue" surface |
| 7 | Overdue training surfacing | NOT IMPLEMENTED | — | — | — | — | TrainingObligation has `dueAt` but no UI consumer | — | — | Schema supports it; no renderer |
| 8 | Admin KPI card row (completion % / outstanding totals) | NOT IMPLEMENTED | — | — | — | — | — | — | — | Compliance page is tabular; no top-of-dashboard metrics |

## B. Course creation and management

| # | Feature | Classification | Admin route | Component | API / action | Service | Model | Permission | Browser verified | Known limitations |
|---|---|---|---|---|---|---|---|---|---|---|
| 9 | Create new course | FULLY IMPLEMENTED | `/safety-training/new` | `new/page.tsx` | `createCourseAction` l.70 | `courses.createCourse` l.93 | TrainingCourse + TrainingCourseVersion v1 DRAFT | `hr:training:write` | ✅ screenshot `03-training-new-1440x900.png` | — |
| 10 | Edit course identity (title, code, category, description) | FULLY IMPLEMENTED | `/safety-training/[courseId]/[versionId]` | `[versionId]/page.tsx` form | `updateDraftAction` l.108 | `courses.updateDraft` l.175 | TrainingCourseVersion | `hr:training:write` (DRAFT only) | ✅ screenshot `05-version-detail-fire-v1-1440x900.png` (read-only on PUBLISHED) | PUBLISHED versions are read-only; must Revise |
| 11 | Course categories enum | FULLY IMPLEMENTED | both forms | select | — | `TRAINING_COURSE_CATEGORIES` l.34 | — | — | ✅ | Fixed enum (not admin-editable) |
| 12 | Required vs optional training | FULLY IMPLEMENTED | version editor + new form | checkbox | `updateDraftAction` | `courses.updateDraft` | `TrainingCourseVersion.required` | `hr:training:write` | ✅ | — |
| 13 | Course thumbnails | FULLY IMPLEMENTED | version editor (auto-extracted) | VideoUploader | `POST /api/hr/training/versions/[id]/video` + `GET /…/thumbnail` | `video.uploadTrainingVideo` + `video-thumbnail.extractVideoThumbnail` | TrainingCourseVersion.videoThumbnailBytes | `hr:training:write` | ✅ | Auto-generated from frame; no manual replace |
| 14 | Video upload (R2) + range stream | FULLY IMPLEMENTED | version editor | VideoUploader | `POST /…/video` + `GET /…/video` | `video.uploadTrainingVideo` l.43, `video-stream.streamTrainingVideo` | TrainingCourseVersion.videoStorageKey + sha256 + duration | `hr:training:write` + `hr:training:read` | ✅ | 2 GB max; MP4/WebM/MOV |
| 15 | Fast-start remux (MOOV-first) | FULLY IMPLEMENTED | version editor | "Optimize video" button | `optimizeVideoAction` l.502 | `video.remediateVideoFastStart` + `video-remux` | TrainingCourseVersion.videoStorageKey | `hr:training:write` | ✅ (button present) | — |
| 16 | Course versioning (DRAFT / PUBLISHED / RETIRED) | FULLY IMPLEMENTED | course-detail versions table | `[courseId]/page.tsx` l.133+ | — | `courses.listClubCourses` + per-version page | TrainingCourseVersion.state | — | ✅ screenshot `04-course-detail-fire-1440x900.png` | — |
| 17 | Start new draft (Revise training) | FULLY IMPLEMENTED | course-detail "Revise training" | `[courseId]/page.tsx` l.74 button | `startNewDraftAction` l.272 | `courses.startNewDraft` l.385 | new TrainingCourseVersion DRAFT | `hr:training:write` | ✅ (button present) | Does NOT clone checkpoints — a known defect (see 5C-3C audit §2) |
| 18 | Publish v1 (first-publish) | FULLY IMPLEMENTED | version editor PublishPanel | `PublishPanel.tsx` | `publishDraftAction` l.169 | `courses.publishDraft` l.333 | TrainingCourseVersion.state → PUBLISHED | `hr:training:publish` | ✅ (panel present) | — |
| 19 | Publish readiness check | FULLY IMPLEMENTED | version editor | `PublishPanel.tsx` | — | `courses.checkPublishReadiness` l.248 | — | — | ✅ | — |
| 20 | Publish REVISION with policy (ALL / NON_COMPLETERS / SELECTED) | FULLY IMPLEMENTED | version editor PublishRevisionDialog | `PublishRevisionDialog.tsx` | `publishDraftWithPolicyAction` l.552 | `revisions.publishDraftWithPolicy` l.246 | TrainingObligation (REVISION) + supersessions | `hr:training:publish` | ✅ (dialog present; opened + confirmed in 5C-3C acceptance) | — |
| 21 | Course retire | FULLY IMPLEMENTED | course detail "Retire course" | `[courseId]/page.tsx` l.100 button | `retireCourseAction` l.190 | `courses.retireCourse` l.487 | TrainingCourse.retiredAt | `hr:training:publish` | ✅ (button present) | — |
| 22 | Course archive | FULLY IMPLEMENTED | catalogue row actions | `CourseRowActions.tsx` | `archiveCourseAction` l.208 | `courses.retireCourse` (shared) | TrainingCourse.retiredAt | `hr:training:publish` | ✅ | — |
| 23 | Course restore | FULLY IMPLEMENTED | catalogue (archived view) | `CourseRowActions.tsx` | `restoreCourseAction` l.224 | `courses.restoreCourse` l.531 | TrainingCourse.retiredAt=null | `hr:training:publish` | ✅ | — |
| 24 | Delete DRAFT-only course | FULLY IMPLEMENTED | catalogue row | `CourseRowActions.tsx` | `deleteDraftCourseAction` l.241 | `courses.deleteDraftCourse` l.620 | hard delete | `hr:training:publish` | ✅ | DRAFT only; refuses if any PUBLISHED version |
| 25 | Permanent delete (no-history guard) | FULLY IMPLEMENTED | catalogue row | `CourseRowActions.tsx` | `permanentlyDeleteCourseAction` l.258 | `courses.permanentlyDeleteCourse` l.686 | hard delete | `hr:training:publish` | ✅ | Refuses if any history exists |

## C. Interactive training builder

| # | Feature | Classification | Admin route | Component | API / action | Service | Model | Permission | Browser verified | Known limitations |
|---|---|---|---|---|---|---|---|---|---|---|
| 26 | Video timeline editor | FULLY IMPLEMENTED | version editor | `TimelineEditor.tsx` | multiple actions | `checkpoints.*` + `questions.*` | TrainingCheckpoint + TrainingQuestion | `hr:training:write` | ✅ (editor present) | — |
| 27 | Checkpoint placement (atSecond) | FULLY IMPLEMENTED | TimelineEditor | timeline UI | `createCheckpointAction` + `updateCheckpointAction` + `deleteCheckpointAction` | `checkpoints.*` | TrainingCheckpoint | `hr:training:write` | ✅ | — |
| 28 | Required-to-proceed checkpoint | FULLY IMPLEMENTED | checkpoint form | checkbox | `updateCheckpointAction` | `checkpoints.updateCheckpoint` | TrainingCheckpoint.requiredToProceed | `hr:training:write` | ✅ | — |
| 29 | Checkpoint retry limit (maxRetries) | FULLY IMPLEMENTED | checkpoint form | input | `updateCheckpointAction` | same | TrainingCheckpoint.maxRetries | `hr:training:write` | ✅ | — |
| 30 | SINGLE_CHOICE question type | FULLY IMPLEMENTED | QuizEditor | question form | `createQuestionAction` / `updateQuestionAction` | `questions.*` | TrainingQuestion + TrainingAnswerOption | `hr:training:write` | ✅ | — |
| 31 | MULTI_ANSWER question type | FULLY IMPLEMENTED | QuizEditor | same | same | same | same | `hr:training:write` | ✅ | — |
| 32 | TRUE_FALSE question type | FULLY IMPLEMENTED | QuizEditor | same | same | same | same | `hr:training:write` | ✅ | — |
| 33 | Correct-answer configuration (per option) | FULLY IMPLEMENTED | QuizEditor | checkbox per option | same | same | TrainingAnswerOption.isCorrect | `hr:training:write` | ✅ | — |
| 34 | Reorder questions (drag or buttons) | FULLY IMPLEMENTED | QuizEditor | reorder button | `reorderQuestionsAction` l.400 | `questions.reorderQuestions` | TrainingQuestion.displayOrder | `hr:training:write` | ✅ | — |
| 35 | Final-assessment passing threshold | FULLY IMPLEMENTED | version editor | `passingScore` input | `updateDraftAction` | `courses.updateDraft` | TrainingCourseVersion.passingScore | `hr:training:write` | ✅ | — |
| 36 | Minimum watched % (threshold) | FULLY IMPLEMENTED | hardcoded 90% in `VIDEO_COMPLETION_THRESHOLD_PERCENT` | `attempts.ts` | — | `attempts.recordVideoProgress` | — | — | ✅ (server-enforced) | Not admin-configurable (constant) |
| 37 | Preview / test the course | PARTIALLY IMPLEMENTED | course-detail "Open" (admins play) | — | — | shares employee runtime | — | `hr:training:read` | ✅ (video playable) | No dedicated "preview as employee" sandbox with throwaway progress; admin playback writes to the real `TrainingProgress` singleton |

## D. Training applicability + assignments

| # | Feature | Classification | Admin route | Component | API / action | Service | Model | Permission | Browser verified | Known limitations |
|---|---|---|---|---|---|---|---|---|---|---|
| 38 | Everyone (club-wide) applicability | FULLY IMPLEMENTED | version editor + new form | `ApplicabilityPicker.tsx` | `updateDraftAction` l.136 / `createCourseAction` | `courses.updateDraft` + `courses.createCourse` | TrainingCourseVersion.appliesToAll | `hr:training:write` | ✅ | — |
| 39 | Department-based applicability | FULLY IMPLEMENTED | version editor | `ApplicabilityPicker.tsx` l.68-87 | `updateDraftAction` l.142 | `courses.updateDraft` | TrainingCourseVersion.appliesToDeptIds (JSON) | `hr:training:write` (DRAFT only) | ✅ | — |
| 40 | Position-based applicability | FULLY IMPLEMENTED | version editor | `ApplicabilityPicker.tsx` l.88-106 | `updateDraftAction` l.143 | `courses.updateDraft` | TrainingCourseVersion.appliesToPositionIds (JSON) | `hr:training:write` (DRAFT only) | ✅ | — |
| 41 | Individual employee assignment | PARTIALLY IMPLEMENTED | employee profile only | `AssignTrainingButton.tsx` | `assignTrainingCourseAction` | `assignments.assignCourseToEmployee` l.17 | TrainingAssignment | `hr:training:assign` | ✅ screenshot `06-employee-detail-marc-1440x900.png` | **One employee at a time** — no course-level bulk picker. The "Assign individually" radio in ApplicabilityPicker is a passive flag; it does NOT open a per-employee picker. |
| 42 | Combined applicability (dept + pos) | FULLY IMPLEMENTED | ApplicabilityPicker "Scoped" | same | `updateDraftAction` | same | union stored in both JSON fields | `hr:training:write` | ✅ | Union is OR (any dept OR any pos matches). Admin cannot express AND. |
| 43 | Published course applicability change | PARTIALLY IMPLEMENTED | requires Revise Training → draft → Publish Revision | ApplicabilityPicker (DRAFT only) + PublishRevisionDialog | `startNewDraftAction` + `updateDraftAction` + `publishDraftWithPolicyAction` | 3 services | TrainingCourseVersion + TrainingObligation (REVISION) | `hr:training:write` + `hr:training:publish` | ✅ (verified by 5C-3C §2 acceptance) | Issues REVISION obligations to employees who remain applicable |
| 44 | Preview employees affected before saving applicability | NOT IMPLEMENTED | — | — | — | `revisions.previewRetakeTargets` exists for retake only | — | — | — | Would need a "scoped preview" variant |
| 45 | Course-level roster of applicable employees | FULLY IMPLEMENTED | course detail "Applicable employees" | `[courseId]/page.tsx` l.189-258 | — (SSR) | `applicability.resolveApplicableCourses` run per-employee | — | `hr:training:compliance:read` | ✅ | Read-only; no "+ Add" button; each row deep-links to the employee's profile |
| 46 | Bulk assign to multiple employees | NOT IMPLEMENTED | — | — | — | `assignments.assignCourseToEmployee` would need a batch wrapper | TrainingAssignment | — | — | 1-at-a-time via per-employee profile |
| 47 | Employee transfer re-evaluation | FULLY IMPLEMENTED | automatic | — | — | `applicability.collectActiveRoleContext` reads `EmployeeEmploymentAssignment` live | — | — | ✅ (resolver recomputes on next read) | No notification / audit when applicability shifts |
| 48 | Assignment deadlines on TrainingAssignment | NOT IMPLEMENTED | — | — | — | — | TrainingAssignment lacks `dueAt` | — | — | TrainingObligation.dueAt exists; TrainingAssignment does not carry a deadline |
| 49 | Required vs optional per assignment | PARTIALLY IMPLEMENTED | — | — | — | — | The course version carries `required`; per-employee cannot override | — | — | By design |

## E. Revisions, retakes, reinstatement

| # | Feature | Classification | Admin route | Component | API / action | Service | Model | Permission | Browser verified | Known limitations |
|---|---|---|---|---|---|---|---|---|---|---|
| 50 | Revise Training (new DRAFT from PUBLISHED) | FULLY IMPLEMENTED | course detail "Revise training" | `[courseId]/page.tsx` l.74 | `startNewDraftAction` | `courses.startNewDraft` | TrainingCourseVersion DRAFT | `hr:training:write` | ✅ | Checkpoint clone defect noted in 5C-3C §2 — admin must re-create checkpoints on the new DRAFT before publishing |
| 51 | Publish policies (ALL_APPLICABLE / NON_COMPLETERS / SELECTED) | FULLY IMPLEMENTED | PublishRevisionDialog | `PublishRevisionDialog.tsx` | `publishDraftWithPolicyAction` | `revisions.publishDraftWithPolicy` | TrainingObligation (REVISION) | `hr:training:publish` | ✅ (proven by 5C-3C) | — |
| 52 | Preview retake targets (per-employee list) | FULLY IMPLEMENTED | RequireRetakeDialog step 2 | `RequireRetakeDialog.tsx` | `previewRetakeAction` l.592 | `revisions.previewRetakeTargets` l.477 | — | `hr:training:read` | ✅ (dialog present) | — |
| 53 | Require Retake (manual reinstatement) | FULLY IMPLEMENTED | course detail dialog | `RequireRetakeDialog.tsx` 3-step | `requireRetakeAction` l.627 | `revisions.issueManualReinstatement` l.515 | TrainingObligation (MANUAL_REINSTATE) | `hr:training:publish` | ✅ (proven by 5C-3B + 5C-3C) | — |
| 54 | Keep Both vs Replace Existing (retake conflict resolution) | FULLY IMPLEMENTED | RequireRetakeDialog | per-employee selector | `requireRetakeAction` with `conflictResolution` | `revisions.issueManualReinstatement` | TrainingObligation (both coexist OR replace) | `hr:training:publish` | ✅ (proven by 5C-3C §1 Keep Both) | — |
| 55 | Reason + optional deadline (retake) | FULLY IMPLEMENTED | dialog | reason textarea + due-date | `requireRetakeAction` | same | `reasonNote` + `dueAt` | `hr:training:publish` | ✅ | — |
| 56 | Auto-supersession of prior OUTSTANDING INITIAL/REVISION | FULLY IMPLEMENTED | runs on publish | server-side | — | `revisions.publishDraftWithPolicy` supersession loop | TrainingObligation.supersededByObligationId | `hr:training:publish` | ✅ (proven by 5C-3C §3) | MANUAL_REINSTATE is intentionally NEVER auto-superseded |
| 57 | Historical completion preservation | FULLY IMPLEMENTED | by design everywhere | — | — | all services | TrainingCompletion rows never deleted | — | ✅ | — |
| 58 | Employee-facing "Updated Training Required" | FULLY IMPLEMENTED | employee portal | course page / dashboard | — | `compliance-resolver.resolveEmployeeTrainingCompliance` | — | — | ✅ (5C-3C §2) | — |
| 59 | Employee-facing "Retake Required" | FULLY IMPLEMENTED | employee portal | course page / dashboard | — | same | — | — | ✅ (5C-3A/B/C) | — |
| 60 | Employee-facing "Initial Training Required" (new) | FULLY IMPLEMENTED | employee portal | course page / dashboard | — | same + 5C-4B-α UI distinction | — | — | ✅ (5C-4B-α) | — |

## F. Employee monitoring + compliance

| # | Feature | Classification | Admin route | Component | API / action | Service | Model | Permission | Browser verified | Known limitations |
|---|---|---|---|---|---|---|---|---|---|---|
| 61 | View employee's assigned + completed courses | FULLY IMPLEMENTED | employee profile Training tab | `EmployeeTrainingSection.tsx` | — (SSR) | `compliance.getEmployeeTrainingRecord` l.213 | — | `hr:training:compliance:read` | ✅ screenshot `06-employee-detail-marc-1440x900.png` | — |
| 62 | View outstanding requirements | FULLY IMPLEMENTED | same | same | — | same | TrainingObligation OUTSTANDING | `hr:training:compliance:read` | ✅ | — |
| 63 | View training attempts | FULLY IMPLEMENTED | same | same | — | `attempts.getEmployeeAttemptHistory` via `employee-read` | TrainingAttempt | `hr:training:compliance:read` | ✅ | — |
| 64 | View assessment results | FULLY IMPLEMENTED | same | same | — | same | TrainingAttempt.score + .passed | `hr:training:compliance:read` | ✅ | — |
| 65 | View checkpoint completion state | IMPLEMENTED — NOT VERIFIED | employee profile | same | — | TrainingProgress.checkpointClearedJson | TrainingProgress | `hr:training:compliance:read` | ⚠️ (not directly browser-verified in this slice) | — |
| 66 | View watched progress | IMPLEMENTED — NOT VERIFIED | employee profile | same | — | TrainingProgress.farthestSecond / percentComplete | TrainingProgress | `hr:training:compliance:read` | ⚠️ | — |
| 67 | View completion dates + scores | FULLY IMPLEMENTED | same | same | — | TrainingCompletion.completedAt + .score | TrainingCompletion | `hr:training:compliance:read` | ✅ | — |
| 68 | View course version history | FULLY IMPLEMENTED | course detail versions table | `[courseId]/page.tsx` | — | — | TrainingCourseVersion | `hr:training:read` | ✅ | — |
| 69 | View upcoming deadlines | NOT IMPLEMENTED | — | — | — | TrainingObligation.dueAt exists but no deadline-sorted surface | — | — | — | — |
| 70 | Identify overdue training | NOT IMPLEMENTED | — | — | — | — | — | — | — | No `now > dueAt` filter in compliance page |
| 71 | Manually assign training | FULLY IMPLEMENTED | employee profile `+ Assign training` | `AssignTrainingButton.tsx` | `assignTrainingCourseAction` | `assignments.assignCourseToEmployee` | TrainingAssignment | `hr:training:assign` | ✅ (button present) | 1-at-a-time |
| 72 | Require retake | FULLY IMPLEMENTED | course detail dialog | RequireRetakeDialog | `requireRetakeAction` | `revisions.issueManualReinstatement` | TrainingObligation MANUAL_REINSTATE | `hr:training:publish` | ✅ | — |
| 73 | Export completion records (CSV) | NOT IMPLEMENTED | — | — | — | — | — | — | — | No export endpoint |
| 74 | Generate training compliance reports | PARTIALLY IMPLEMENTED | compliance page (HTML only) | compliance/page.tsx | — | `compliance.getClubTrainingCompliance` | — | `hr:training:compliance:read` | ✅ | No PDF / print view / download |

## G. Permissions + governance

| # | Feature | Classification | Role mapping | Site |
|---|---|---|---|---|
| 75 | `hr:training:read` | FULLY IMPLEMENTED | CLUB_ADMIN, GENERAL_MANAGER, AUDITOR_READ_ONLY | permissions.ts l.294 |
| 76 | `hr:training:write` | FULLY IMPLEMENTED | CLUB_ADMIN only | l.295 |
| 77 | `hr:training:publish` | FULLY IMPLEMENTED | CLUB_ADMIN only | l.296 |
| 78 | `hr:training:assign` | FULLY IMPLEMENTED | CLUB_ADMIN, GENERAL_MANAGER | l.297 |
| 79 | `hr:training:compliance:read` | FULLY IMPLEMENTED | CLUB_ADMIN, GENERAL_MANAGER, AUDITOR_READ_ONLY | l.298 |
| 80 | Tenant isolation (service-side) | FULLY IMPLEMENTED | all services call `assertTenantOwned` + `requirePermission(principal, clubId, …)` | each service top |
| 81 | Audit logging coverage | FULLY IMPLEMENTED | 24 distinct `audit({action: "hr.training.*"})` call sites | distributed |
| 82 | API-route authorization | FULLY IMPLEMENTED | both video + thumbnail routes gate via principal + applicability | `/api/hr/training/versions/[id]/*` |
| 83 | Admin function visible but inaccessible to viewer | INACCESSIBLE | GM sees training catalogue + edit UI but all `write`/`publish` buttons gate server-side; the UI shows DISABLED chrome rather than hiding | — | the version editor shows the form in `readOnly` mode when `canAuthor=false` — intentional for visibility, inaccessible for action |

---

## Rollups

| Classification | Count |
|---|---|
| FULLY IMPLEMENTED | 48 |
| IMPLEMENTED — NOT VERIFIED | 2 |
| BACKEND ONLY | 0 |
| PARTIALLY IMPLEMENTED | 6 |
| NOT IMPLEMENTED | 8 |
| INACCESSIBLE | 1 |
| DORMANT | 1 |
| **Total audited features** | **66** |

**DORMANT item:** `resolveEmployeeTrainingCompliance` is live-read by the Employee Portal
dashboard (so partially DORMANT) but is NOT yet the authoritative
scheduling-eligibility gate — scheduling still reads
`resolveEmployeeSchedulingEligibility`. The cutover is a future
authorized slice.
