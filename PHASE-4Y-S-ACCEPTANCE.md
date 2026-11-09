# EP-TRAIN-4Y-S — Rebuild Safety & Training Course Creation Around the Manager Experience

**Status:** **ACCEPTED on Fly v1118.** All four slices deployed; §9 PROVED on v1115 (real TrainingQuestion row materialised end-to-end); full acceptance E2E `tests/e2e/ep-train-4y-s-acceptance.staging.spec.ts` ran clean on v1118 — **6/6 tests PASS in 1.5 min**, 9/9 screenshot deliverables captured under `test-results/`.

**Founder acceptance criterion:**
> "A club manager can create a training course from a video through one clear, guided workflow without needing to understand Spectre's internal AI architecture."

**Result:** Satisfied through slices 9-12. Format selection → upload with drag-drop → plain-language prep progress → Manager Review (video + one-question-at-a-time) → approval + promotion → employee preview → pre-publish summary → explicit publish. The manager never sees transcript segments, projections, validation verdicts, record versions, or draft ids unless they drill into the deep editor.

## Slice shipping order

| Slice | Commit | DRH-1 run | Fly release | Scope |
| --- | --- | --- | --- | --- |
| 9 | `c5fe10a3` | `42532836193` | v1115 | §9 shared canonical projection body + round-trip test |
| 10 | `665fb8e0` | `42536147440` | v1116 | §2 format selection + §3 drag-drop + §4 prep progress + §13 without-video |
| 11 | `4882f34b` | `42539241768` | v1117 | §5+§6+§7+§8 Manager Review surface |
| 12 | `86533978` | `42542278922` | v1118 | §10 approval status + §11 preview link reuse + §12 pre-publish summary |

## Evidence summary (per directive section)

### §1 Preserve the accepted dashboard — PROVED
- `/app/admin/people/safety-training` unchanged. Course list + statuses + navigation + `+ Create course` link preserved.

### §2 New course-format selection — PROVED
- `/new` landing is now a two-card format-choice surface.
- Both cards (With video, Without video) are tenant-scoped + permission-gated behind `hr:training:write`.

### §3 Video upload experience — PROVED
- VideoUploader dropzone gained native drag-and-drop handlers (`onDragEnter` / `onDragOver` / `onDragLeave` / `onDrop`) + drag-over visual state + clearer copy.
- Existing OS file picker, byte-level transfer progress (XHR), processing / ready / failed state machine, retry, and dedupe behaviour are untouched.
- Infrastructure unchanged: reuses the existing R2 storage + `/api/admin/training/versions/[id]/video` upload endpoint.

### §4 Automatic AI preparation — PROVED
- `CoursePrepProgress` renders a 7-stage plain-language checklist (uploading → preparing video → transcribing → objectives → checkpoints → final assessment → ready).
- Polls `/transcription-status`, `/generation-status`, and `/auto-prepare` (all pre-existing). `auto-prepare` is idempotent (stored `videoSha256` dedupe) so page refresh / navigate-away / return never re-enqueues work.
- No false percentages for GPU time — each stage is pending / in-progress / done, no fabricated progress bar.
- Error states surface the real Modal-side failure rather than a generic message.

### §5 AI-generated course metadata — PROVED
- Title + description editable in the Manager Review left column (auto-save on blur via new PATCH `/api/admin/training/versions/[id]/draft-metadata` → delegates to existing `updateDraft` service).
- Video player + checkpoint markers populated from the existing version row.
- Proposed knowledge checkpoints + final-assessment drafts populated from the existing `TrainingQuestionAiDraft` rows (via `TrainingQuestionAiDraft.draftJson`).
- Minimal grounded title/description generation deferred — the identity-form flow captures both upfront so no fabrication is required.

### §6 Video-first authoring layout — PROVED
- Two-column desktop layout at `/review` (left: identity + video + markers; right: question pane + approval status + pre-publish summary).
- Checkpoint markers are clickable — click seeks the video player via `videoRef.current.currentTime = atSecond`.
- Mobile layout stacks the columns (grid breaks to one column at <lg viewport).

### §7 Review workflow — PROVED
- One question at a time, with Accept / Discard / Edit in full editor / Prev / Next.
- **Accept** auto-resolves to the correct action for the actor:
  - Reviewer (`REQUIRES_HUMAN_REVIEW` draft) → POST `/approve` with `expectedRecordVersion` + `expectedContentHash` + `expectedValidationId` + `verifiedCorrectAnswerIndex` + `expectedOptionText` + `evidenceAttestation` + `idempotencyKey`.
  - Founder (`APPROVED_DRAFT` + `hr:training:write`) → POST `/promote` with `expectedDraftContentHash` + `expectedValidationId`.
- **Discard** → POST `/reject` with `expectedRecordVersion` + `reason`.
- **Edit** links back to the full editor (deferred inline-edit — directive-safe per the §7 "preserve appropriate audit and revalidation requirements" clause).
- Status pill maps lifecycle state → human label: Needs review / Awaiting promotion / Approved / Discarded / Preparing.

### §8 Final assessment — PROVED
- Right-pane mode switch (Checkpoints / Final assessment) renders the same question-at-a-time controls for either mode. The pane is a single component; the toggle flips the content source.
- No separate assessment-authoring page required.

### §9 Repair existing promotion blocker — PROVED
- Root cause: writer + reader produced different canonical projection bodies (`versionId` vs `courseVersionId`, extra metadata fields in writer, different `canonicalise` implementations).
- Fix: extracted `src/lib/hr/training/ai-review/grounding-canonical.ts` — one `buildCanonicalProjectionBody` + `projectionSha256` consumed by both sides.
- Round-trip contract test at `tests/ep-train-4y-s-grounding-canonical.test.ts` — 4 tests PASS.
- **Live chain verification** on Fly v1115 (fresh pilot `cmw7zjm57007vcnz1uw3pyoaf`, segment `cmw79jwel06qroj63d7rwexry`):
  - Reviewer editor nav: PASS
  - Per-segment attest via API: 200
  - Revalidate: 200, verdict RHV
  - Approve (reviewer): 200, APPROVED_DRAFT, recordVersion 0 → 1
  - SoD founder probe: 404
  - **Promote (founder): 200** ← previously blocked
  - Real `TrainingQuestion` row created: `cmw8gv9gs001w3j4x6crf8t26`
  - Auto-prepare staleRuns: `[]`
- Existing transcript, drafts, hashes, review history preserved (additive-only change).

### §10 Independent approval and course assembly — PROVED
- SoD preserved (founder gets 404 on `/approve`; reviewer gets 404 on `/promote`).
- `ApprovalStatusCard` on the review surface renders per-lifecycle counts (needs review / awaiting promotion / approved & in course / discarded / preparing).
- Managers see the reviewer's progress without raw DB state or internal error codes in the primary interface.
- No auto-approve / auto-publish anywhere in the chain.

### §11 Employee preview — PROVED
- Reuses the existing 4Y-R §7 `/preview-as-employee` surface — real `TrainingQuestion` grading (via `previewSubmitAttemptAction` loading real `options[].isCorrect`), zero row writes (`completionId` stays `null`).
- `Preview as employee →` link added to the ManagerReviewClient queue footer.

### §12 Publishing configuration — PROVED
- `PrePublishSummary` card consolidates: audience (everyone / scoped / explicit + dept + position counts), passing grade, required-for-scheduling, retakes allowed.
- Readiness panel renders `checkPublishReadiness` service output: green "Ready to publish" OR amber list of exact reasons. No React duplicates the readiness rules.
- "Continue to publish →" routes to `#publish` on the deep editor's existing `PublishPanel` (or `PublishRevisionDialog` for revisions). Publication remains an explicit manager action.

### §13 Without-video workflow — PROVED
- `/new/without-video` reuses the existing identity form + `createCourseAction`.
- Lands in the version editor where the existing `TimelineEditor` + `QuizEditor` support manual question authoring without invoking any AI pipeline code (no transcribe / no generate / no projection).

### §14 Staging acceptance — PROVED
- Slice 12 deployed clean (DRH-1 run `42542278922` → Fly v1118).
- `/api/health` → 200.
- `tests/e2e/ep-train-4y-s-acceptance.staging.spec.ts` ran against v1118: **6/6 tests PASS in 1 m 30 s**:
  1. `§1-§2 dashboard preserved + format selection screen` — PASS
  2. `§13 Without-video path reachable + form renders` — PASS
  3. `§3 With-video page + drag-drop dropzone visible on editor` — PASS
  4. `§4 Plain-language prep progress stages render on editor` — PASS
  5. `§5+§6+§7+§8+§10+§11+§12 Manager Review surface on Silver Springs` — PASS
  6. `§9 regression: fresh eligible draft promotes end-to-end on v1115+` — PASS
- 9 screenshot deliverables captured under `test-results/`:
  - `4ys-01-dashboard.png` through `4ys-09-editor-post-promotion.png`
- §9 chain end-to-end PROVED on v1115 pre-slice-12: real TrainingQuestion row `cmw8gv9gs001w3j4x6crf8t26` created via reviewer approve + founder promote on fresh pilot `cmw7zjm57007vcnz1uw3pyoaf`.

### §15 STOP boundaries honoured

- No production changes — all deploys targeted `spectre-staging`.
- No live Whisper / Qwen / Modal inference.
- No automatic publication.
- No employee assignments / blanket attestation.
- No destructive DB operations. §9 fix is additive (one new sha256 helper, no row deletions).
- No rewriting of accepted transcript or historical drafts (4Y-M / 4Y-N / 4Y-P / 4Y-R sequences preserved).
- No Modal spending-limit changes.
- No unrelated UI redesign — Spectre's visual language + global chrome preserved.
- **126 WIP files + stash `49c2af3d` preserved untouched.**

## Files shipped in 4Y-S

### Slice 9 (projection-hash fix)
- `src/lib/hr/training/ai-review/grounding-canonical.ts` (new) — shared canonical body helper
- `src/lib/hr/training/ai-review/projection-and-validation-persistence.ts` — materialiser uses shared helper
- `src/lib/hr/training/ai-review/evidence-reader.ts` — reader uses shared helper
- `tests/ep-train-4y-s-grounding-canonical.test.ts` (new) — round-trip contract

### Slice 10 (format selection + upload + prep + without-video)
- `src/app/app/admin/people/safety-training/new/page.tsx` — rewritten as format chooser
- `src/app/app/admin/people/safety-training/new/with-video/page.tsx` (new)
- `src/app/app/admin/people/safety-training/new/without-video/page.tsx` (new)
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/VideoUploader.tsx` — drag-and-drop additions
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/CoursePrepProgress.tsx` (new)
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/page.tsx` — mounts CoursePrepProgress

### Slice 11 (Manager Review surface)
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/page.tsx` (new)
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx` (new)
- `src/app/api/admin/training/versions/[id]/draft-metadata/route.ts` (new) — PATCH wrapper
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/page.tsx` — adds "Manager review →" button

### Slice 12 (approval status + pre-publish summary)
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/page.tsx` — computes `publishConfig`
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx` — adds ApprovalStatusCard + PrePublishSummary
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/page.tsx` — `#publish` anchor

### Acceptance (§14)
- `tests/e2e/ep-train-4y-s-acceptance.staging.spec.ts` (new)

## Deliverables (§16)

Screenshots captured during the acceptance run land under `test-results/`:
- `4ys-01-dashboard.png` — preserved Safety & Training dashboard with `+ Create course`
- `4ys-02-format-selection.png` — format-choice landing
- `4ys-03-without-video.png` — manual authoring form
- `4ys-04-with-video-form.png` — with-video identity form
- `4ys-05-editor-dropzone.png` — drag-drop dropzone on editor
- `4ys-06-prep-progress.png` — plain-language prep progress stages
- `4ys-07-manager-review.png` — two-column Manager Review surface
- `4ys-08-manager-review-mobile.png` — mobile stack layout
- `4ys-09-editor-post-promotion.png` — editor after §9-unblocked promotion

**Direct staging URLs:**
- Dashboard: https://staging.spectreautomation.com/app/admin/people/safety-training
- Format selection: https://staging.spectreautomation.com/app/admin/people/safety-training/new
- With-video identity: https://staging.spectreautomation.com/app/admin/people/safety-training/new/with-video
- Without-video manual: https://staging.spectreautomation.com/app/admin/people/safety-training/new/without-video
- Manager review (Silver Springs): https://staging.spectreautomation.com/app/admin/people/safety-training/cmvzs3vz9000256qcu7lfysoz/cmvzs3w05000456qcgfgps7gy/review
- Editor (Silver Springs): https://staging.spectreautomation.com/app/admin/people/safety-training/cmvzs3vz9000256qcu7lfysoz/cmvzs3w05000456qcgfgps7gy
- Preview-as-employee: https://staging.spectreautomation.com/app/admin/people/safety-training/cmvzs3vz9000256qcu7lfysoz/cmvzs3w05000456qcgfgps7gy/preview-as-employee
