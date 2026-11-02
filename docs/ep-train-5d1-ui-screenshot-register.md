# EP-TRAIN-5D-1 — Admin Training UI Screenshot Register

**Baseline:** `spectre-staging:sha-79b05f36616d` (α code baseline;
Marc Maldiney's 2 OUTSTANDING INITIAL obligations present).

**Captured:** 2026-11-02 via authenticated Playwright navigation as
the founder (`loginAsFounder`). Full-page screenshots. **No
destructive clicks.** No form submissions. No dialogs opened beyond
initial page render.

All screenshots saved under:
`test-results/ep-train-5d1-admin-audit/` (gitignored). The browser
walk's run summary is in `test-results/ep-train-5d1-admin-audit/summary.json`.

The spec that captured these is in-repo at
`tests/e2e/ep-train-5d1-admin-training-audit.staging.spec.ts`.

---

## 1. Admin pages captured

| # | File | Route | Viewport | Observations |
|---|---|---|---|---|
| 1 | `01-training-list-1440x900.png` | `/app/admin/people/safety-training` | 1440×900 | Catalogue page with the Courses tab active. Lists every Coulee Ridge training course (`FIRE_SAFETY`, `ORIENTATION_2027`, `EQUIPMENT_SAFETY_2026`, `FOOD_SAFETY_2026`, `KNIFE_SAFETY_2026`, `ROOFTOP_SAFETY_2026`, `GAS_VERSUS_DIESEL`, `DEMO_FR_SAFETY`, `SAFE-BASICS`, `B31_STAGING_ACCEPTANCE`). Current version column visible. "Create course" CTA upper-right. Archived toggle present. Compliance tab accessible via `_SafetyTrainingTabs`. |
| 2 | `02-training-compliance-1440x900.png` | `/app/admin/people/safety-training/compliance` | 1440×900 | Compliance tab render. Filters: status select, department select, course select, search input. Roll-up table lists each Coulee Ridge employee with completion / outstanding summary. The 2 OUTSTANDING INITIAL obligations against Marc are visible here (surfaced as outstanding requirements). No CSV export control present. |
| 3 | `03-training-new-1440x900.png` | `/app/admin/people/safety-training/new` | 1440×900 | Create-course form. Fields: `code`, `title`, `category` (select from `TRAINING_COURSE_CATEGORIES`), `description`, `required` (checkbox), applicability 3-way radio (Everyone / Scoped / Individual). **The scoped sub-pickers (dept+pos checkbox clusters) are intentionally deferred to the editor** — the new-course form shows only the top-level radio. |
| 4 | `04-course-detail-fire-1440x900.png` | `/app/admin/people/safety-training/cmvwwgs4k005gjjkgr20rxbv0` | 1440×900 | Fire Safety course detail. Title/code/description header. Right-side action group: "Revise training" (Start-new-draft), "Require retake" (opens RequireRetakeDialog), "Retire course". Versions table shows `v1 PUBLISHED`. "Applicable employees" roster lists every Coulee Ridge employee the current version applies to. No dialogs opened. |
| 4b | `04-course-detail-fire-768x1024.png` | same | 768×1024 (tablet) | Same page at tablet width. Action buttons wrap vertically; versions table remains legible; roster scrolls horizontally within its container. No layout regression observed. |
| 5 | `05-version-detail-fire-v1-1440x900.png` | `/app/admin/people/safety-training/cmvwwgs4k005gjjkgr20rxbv0/cmvwwgs5c005ijjkgt3zzuefw` | 1440×900 | Fire Safety v1 (PUBLISHED, read-only) version editor. Sections visible: identity + compliance flags (`passingScore`, `retakesAllowed`, `requiresKnowledgeTest`, `required`), **"Who needs to complete this?" ApplicabilityPicker (disabled because PUBLISHED)**, Training video (VideoUploader shows current video metadata), Interactive checkpoints (TimelineEditor shows CP1 + CP2), Final assessment (QuizEditor), Publish panel (shows "Published" state). The ApplicabilityPicker currently reads `Everyone` — the course is `appliesToAll=true`. All form fields are disabled; a banner note explains this version is published. |
| 6 | `06-employee-detail-marc-1440x900.png` | `/app/admin/people/employees/cmu0ndf4p001vk9md2ntmo2ck` | 1440×900 | Marc Maldiney's employee profile. The Training tab (`EmployeeTrainingSection.tsx`) shows: Scheduling eligibility (`not eligible` with the outstanding-training list), Current requirements (10 cards including 2 **"Initial Training Required"** for the pilot's ORIENTATION_2027 + FIRE_SAFETY, and 6 generic "Required" for the inferred set, 2 "Completed" for SAFE-BASICS + B31_STAGING_ACCEPTANCE), Training history, Explicit assignments (empty — Marc has no TrainingAssignment rows), the "+ Assign training" button (AssignTrainingButton). |

## 2. Dialogs + sub-components NOT opened

Per directive §3 ("Do not use destructive actions"): the following
UI surfaces are present in the source but were NOT exercised in
this audit's browser walk. Each has prior acceptance evidence from
earlier slices and is retained here as a reference for the matrix.

| Component | File | Prior acceptance | Would have opened via |
|---|---|---|---|
| `RequireRetakeDialog` | `.../[courseId]/RequireRetakeDialog.tsx` | 5C-3A C, 5C-3B §2, 5C-3C §1 | Click "Require retake" on course detail |
| `PublishRevisionDialog` | `.../[versionId]/PublishRevisionDialog.tsx` | 5C-3C §2 + §3 | Click "Publish this version" on DRAFT version |
| `CourseRowActions` menus (archive / restore / delete-draft / permanent-delete) | `.../CourseRowActions.tsx` | — (one-click confirmed) | Click row-level menu on catalogue |
| `VideoUploader` upload flow | `.../[versionId]/VideoUploader.tsx` | EP-TRAIN-3 Slice 3 provisioning | Choose file + upload |
| `TimelineEditor` checkpoint CRUD | `.../[versionId]/TimelineEditor.tsx` | — | Add / edit / delete checkpoints |
| `QuizEditor` question CRUD | `.../[versionId]/QuizEditor.tsx` | — | Add / edit / delete / reorder |
| `AssignTrainingButton` form | `src/components/hr/AssignTrainingButton.tsx` | — | Click "+ Assign training" on employee profile |

The screenshots are sufficient for the UX assessment because the
observed surfaces reveal the information hierarchy, the action
affordances, and the responsive behaviour; the deferred dialogs
have specific acceptance evidence from the 5C-3 slice chain.

## 3. Observations surfaced during the walk

- The admin Training catalogue mixes active + archived views via a
  tab-like toggle inside the Courses tab (not a separate route) —
  predictable, matches EP-UX-2D's "toggle-in-place" pattern.
- Course titles in the catalogue are long and visually dominate the
  layout — borderline overflow at 1440 but readable.
- The version editor's layout stacks sections vertically with
  generous whitespace. On a 1440×900 viewport, the PublishPanel +
  Interactive-checkpoints + Final-assessment sections require
  scrolling. This is intentional per EP-UX-2D (editorial pacing)
  but means a user has to scroll to see the publish state.
- `ApplicabilityPicker` renders as 3 stacked radios. The "Scoped"
  variant expands inline to show dept + position checkbox clusters
  (progressive disclosure). The "Individual" variant renders NO
  sub-UI — the admin receives no in-line hint that per-employee
  assignment requires opening each employee's profile.
- The compliance roll-up on `/compliance` currently loads the full
  roster + obligations for the active club. There is no server-side
  pagination; for larger clubs this will need chunking.
- Marc's profile shows the 5C-4B-α amber chips exactly as described
  by the applicability + α acceptance docs — direct visual
  confirmation.
