# EP-TRAIN-3 — Safety & Training Founder-Review Guide

**Status:** Slice 3 ACCEPTED on `sha-ee236957866e` / Fly v1026.
**Scope:** Hands-on review of the complete Safety & Training workflow.
**Date prepared:** 2026-10-30.

---

## 1. Where to log in

### Manager (course author)

- Open: <https://staging.spectreautomation.com/login>
- Use your existing Spectre Automation admin credentials (the ones you
  normally use for staging). The account `cturcato@spectreautomation.com`
  is a **CLUB_ADMIN** at **Coulee Ridge Golf & Country Club** and has
  all five Safety & Training permissions:
  `hr:training:read`, `hr:training:write`, `hr:training:publish`,
  `hr:training:assign`, `hr:training:compliance:read`.
- No account changes have been made.

### Employee (course taker)

- Open: <https://staging.spectreautomation.com/employee/login>
- A **disposable demonstration employee** has been provisioned for the
  review — `FounderDemo DemoEmployee` (employee number
  `E-FOUNDER-DEMO`, personal email
  `ep-train-3-founder-demo@spectre.test`). Credentials are delivered
  via your approved secure channel; no password appears in this guide
  or any file in the repo.
- The demo employee holds no payroll, no CLUB_ADMIN role, and no
  financial permissions.
- Teardown script (deletes the demo employee + course only, legitimate
  records untouched): `scripts/ep-train-3-review-fixture-teardown.mjs`
  — run on staging via `flyctl ssh console` when the review wraps.

---

## 2. Direct staging navigation

### Manager — Safety & Training

| Workflow | URL |
|---|---|
| Training course catalogue | <https://staging.spectreautomation.com/app/admin/people/safety-training> |
| **New course** (video upload, title, applicability) | <https://staging.spectreautomation.com/app/admin/people/safety-training/new> |
| Compliance / assignment view | <https://staging.spectreautomation.com/app/admin/people/safety-training/compliance> |
| **Demo course detail** (version history + Start new draft) | <https://staging.spectreautomation.com/app/admin/people/safety-training/cmvvgku6p00062ml0lb9jj5nd> |
| **Demo course version editor** (read-only — course is PUBLISHED) | <https://staging.spectreautomation.com/app/admin/people/safety-training/cmvvgku6p00062ml0lb9jj5nd/cmvvgku7b00082ml0hvy6deof> |

The version editor renders:

- Title / description / passing score / retakes allowed / knowledge-test required
- Applicability picker (all employees / by department / by position)
- Video uploader
- **Checkpoint timeline editor** (atSecond, label, maxRetries, required flag)
- **Question editor** per checkpoint — SINGLE_CHOICE, MULTI_ANSWER, TRUE_FALSE
- **Final knowledge test** question editor
- Publish readiness panel (preconditions + publish button)

> On a DRAFT version every panel is editable. On a PUBLISHED or RETIRED
> version everything is read-only; use the "Start new draft" button on
> the course-detail page to make a new editable draft.

### Employee — Safety & Training

| Workflow | URL |
|---|---|
| Portal login | <https://staging.spectreautomation.com/employee/login> |
| Portal home | <https://staging.spectreautomation.com/employee> |
| **Required / recommended courses list** | <https://staging.spectreautomation.com/employee/safety-training> |
| Direct link to demo course player | <https://staging.spectreautomation.com/employee/safety-training/cmvvgku7b00082ml0hvy6deof> |

---

## 3. Review checklist — hands-on walkthrough

### Manager side (your own account)

1. **Upload a video.** Catalogue → "New course" → fill title ("Founder
   Review Trial Course"), category "Safety", description → create. On
   the new course's detail page click into v1 (DRAFT) → the version
   editor opens with the video uploader at the top. Drag / select a
   short MP4 (e.g. 30-60 s) and upload. The uploader shows the
   fast-start remuxing status while processing.
2. **Verify video processing and playback.** Once the uploader shows
   READY, press play on the inline preview. You should see your clip
   render with the standard portal video controls.
3. **Add checkpoint questions.** Scroll to the Checkpoint Timeline
   editor → "Add checkpoint" → set atSecond (e.g. 10), label, "required
   to proceed" → save. On the checkpoint's row, "Add question" →
   choose SINGLE_CHOICE / MULTI_ANSWER / TRUE_FALSE, fill the prompt
   and options, mark the correct one(s).
4. **Configure retries.** On each checkpoint, set `maxRetries` (the
   demo fixture uses 2).
5. **Create the final assessment.** Scroll to the "Knowledge test"
   section. "Add question" (checkpointId = null) → choose a type → set
   prompt and options → save. Repeat for a second question. Set the
   version's passing score (default 80 %).
6. **Preview the employee experience.** From the version editor, open
   the course detail page → the published-version row has a
   `/employee/safety-training/{versionId}` link. (Alternatively, log
   in as the demo employee in a different browser profile and open
   the demo course directly.)
7. **Publish the course.** The Publish panel at the bottom of the
   version editor shows preconditions; when green, press "Publish".
   The version flips to PUBLISHED and the course's `currentVersionId`
   updates. You can then go back to the catalogue.

### Employee side (demo-employee account)

8. **Open the course as an employee.** Log into the portal with the
   demo credential (delivered via secure channel). Portal home → "My
   Safety & Training" → open the **Founder Demo – Safety & Training**
   card. (A new course you just published should appear here too.)
9. **Complete the checkpoints.** Play the video. At the 15-s mark the
   first checkpoint pauses playback. Answer Q1 (Orange), Q2 (Hard hat
   + Safety goggles), Q3 (True) → Submit. The overlay confirms
   "Checkpoint cleared"; click Resume. The second checkpoint pauses at
   28 s; answer "Your supervisor immediately" → Submit → Resume. (The
   demo course exercises retry behavior if you intentionally miss an
   answer first — maxRetries is 2.)
10. **Complete the final assessment.** The video finishes playing;
    the "Start knowledge test" button appears. Click → the two final
    questions render ("Risk assessment", "True"). Submit. The pass
    banner reads "Training complete. Score: 100 %."
11. **Verify the completion record.** Refresh the page or navigate
    back to `/employee/safety-training`. The completed-course banner
    is now visible on the course card, and the course surface shows
    the completion date and score. (Server-side the completion is
    recorded in `TrainingCompletion` and the attempt history on the
    course detail page shows every checkpoint + final attempt.)

---

## 4. Design-review evidence

Desktop (1440 × 900) and mobile (390 × 844) screenshots of the five
manager surfaces and two employee surfaces are in
`test-results/ep-train-3-review-screenshots/`:

| Surface | Desktop | Mobile |
|---|---|---|
| Manager — course catalogue | `desktop-1440x900-mgr-01-course-catalogue.png` | `mobile-390x844-mgr-01-course-catalogue.png` |
| Manager — New course form | `desktop-1440x900-mgr-02-new-course.png` | `mobile-390x844-mgr-02-new-course.png` |
| Manager — Version editor | `desktop-1440x900-mgr-03-version-editor.png` | `mobile-390x844-mgr-03-version-editor.png` |
| Manager — Course detail | `desktop-1440x900-mgr-04-course-detail.png` | `mobile-390x844-mgr-04-course-detail.png` |
| Manager — Compliance | `desktop-1440x900-mgr-05-compliance.png` | `mobile-390x844-mgr-05-compliance.png` |
| Employee — Course list | `desktop-1440x900-emp-01-course-list.png` | `mobile-390x844-emp-01-course-list.png` |
| Employee — Course player w/ cp1 overlay | `desktop-1440x900-emp-02-cp1-overlay.png` | `mobile-390x844-emp-02-cp1-overlay.png` |

### Known visual limitations (not changed as part of this prep)

- Manager version editor at **mobile 390** is dense — the
  checkpoint-timeline editor and the quiz-question editor are
  primarily tuned for desktop. Day-to-day course authoring is
  expected at desktop width; the mobile view remains readable but
  requires scrolling. Not changed in this preparation step per
  directive §4.
- The video uploader surfaces fast-start remuxing status inline but
  does not currently show a progress bar for the client-to-R2 upload
  phase. Not changed.
- `portal-course-quiz-passed` div renders briefly on the client, then
  `router.refresh()` replaces the quiz section with the completed
  banner. The banner is the durable post-pass UI. (This is the
  Slice 3E secondary finding; the acceptance test now checks either
  the banner or the quiz-passed div so the pass is captured reliably.)

---

## 5. Teardown + data protection

- Teardown script: `scripts/ep-train-3-review-fixture-teardown.mjs`.
  Deletes only the demo employee (`E-FOUNDER-DEMO`) and demo course
  (`DEMO_FR_SAFETY`) + their checkpoints / questions / attempts /
  progress / completions. Audits `hr.training.teardown.disposable.review-fixture`.
- No legitimate employees, courses, completions, payroll records, or
  historical training evidence are touched by either the provisioning
  script or the teardown.
- The demo portal password lives only in the operator's secure
  channel. It is not written to any file in the repo.

---

## 6. Deployment + out-of-scope changes

- No new deployment was performed for this review preparation.
- No new application features were added.
- No existing design was altered.
- Slice 4 is **not** authorized and has not been started.
