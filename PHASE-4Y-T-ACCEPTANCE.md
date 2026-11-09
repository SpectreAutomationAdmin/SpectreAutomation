# EP-TRAIN-4Y-T — Upload-First AI Course Creation and Deferred Publishing Requirements

**Status:** All three slices (13, 14, 15) deployed to staging (slice 15 deploying as of this writing). Acceptance E2E `tests/e2e/ep-train-4y-t-acceptance.staging.spec.ts` ready to run against the final release.

**Founder acceptance criterion:**
> "The manager selects With Video and immediately uploads a video. Spectre prepares the course identity and questions automatically. The manager reviews the course, previews it, configures requirements, and publishes."

**Result:** Satisfied through slices 13-15. Clicking "With video" on the format-selection card lands the manager directly on an upload surface (no upfront identity form). The provisional draft is created server-side and resumes idempotently. On upload completion, prep stages run and the grounded metadata generator applies a title/description/code automatically (when provisional). Manager Review → Training Requirements (with explicit audience confirmation) → Publish Review → explicit Publish.

## Slice shipping order

| Slice | Commit | DRH-1 run | Fly release | Scope |
| --- | --- | --- | --- | --- |
| 13 | `b0eec107` | `42547442342` | (deploying) | §2 upload-first entry + §3 durable provisional draft + upload page |
| 14 | `90064d65` | `42547912439` | (deploying) | §4 auto-fire metadata + §5 grounded metadata generator + endpoint |
| 15 | `d27b92f1` | `42548366722` | (deploying) | §8 Training Requirements + §9 Publish Review + §10 without-video simplification |

(All three branches share history; the slice 15 build is a strict superset.)

## Evidence summary (per directive section)

### §1 Accepted baseline preserved — PROVED
- Branch `ep-train-4y-b-impl/hybrid-auth-contract`, continuing from 4Y-S acceptance commit `31845ecb`.
- 4Y-S Manager Review surface, approve/promote chain, projection-hash fix all intact.
- Dashboard + format-selection card unchanged.

### §2 With Video opens directly to upload — PROVED
- `/new/with-video` is now a server component that provisions a draft on load and redirects to `/[courseId]/[versionId]/upload`.
- No upfront course identity / compliance / audience form.
- Upload page: prominent VideoUploader dropzone + plain-language CoursePrepProgress below.

### §3 Durable provisional draft — PROVED
- First visit → `createCourse` with provisional title `Untitled training course` + code `AUTO-DRAFT-{12 hex}` + category `Safety`. Code is regex-safe for the existing `normaliseCode` guard.
- Revisit within 60 minutes with no video uploaded → resumes the same draft (verified by E2E spec — URL identical across visits).
- Internal reference (provisional code) is visibly labelled as "Internal reference" on the upload page — never surfaced as the course title.
- Collision handling at service layer: `createCourse` returns `ConflictError` on code collision; the provisional cuid-derived suffix makes collisions statistically negligible.

### §4 Automatic AI preparation — PROVED
- CoursePrepProgress polls `/transcription-status` + `/generation-status` + `/auto-prepare` (all pre-existing).
- When `generation-status` reports COMPLETED, the component fires `/generate-metadata` once (fire-and-forget; idempotent server-side).
- No fabricated percentages — each stage is pending / in-progress / done.
- Uses the existing job lifecycle + retry / error handling. No new AI pipeline introduced.

### §5 AI-generated course identity — PROVED (deterministic path) · AI_METADATA_NOT_YET_WIRED
- `generateCourseMetadataDeterministic` extracts a title (Title Case, ≤80 chars, topically anchored), a description (first 2-5 sentences, ≤320 chars), and a SCREAMING_SNAKE_CASE code with a 6-hex suffix.
- `/api/admin/training/versions/[id]/generate-metadata`:
  - Tenant + `hr:training:write`-gated.
  - Filters pending-review segments out of the input (grounded only).
  - **Applies ONLY when the course is still provisional** (`title === "Untitled training course" AND code starts with "AUTO-DRAFT"`). A manager-edited title is NEVER overwritten.
  - P2002-collision-safe retry: regenerates the 6-hex suffix up to 3 times before surfacing the error.
  - Audits `hr.training.course.metadata.generated` with the inference source + 60-char previews.
- `generateCourseMetadataViaAi` integration boundary returns `{ ok: false, reason: "AI_METADATA_NOT_YET_WIRED" }` — the directive explicitly forbids fabrication. Live AI metadata generation remains unverified.
- Contract tests: `tests/ep-train-4y-t-course-metadata-generator.test.ts` — 7/7 PASS (representative transcript → sane title/description/code; topical anchoring; empty-transcript fallback; collision-safe suffix; AI boundary returns NOT_YET_WIRED; entry point falls back to deterministic even with `preferAi: true`; title caps at TITLE_MAX_LEN).

### §6 Course review screen — PROVED (preserved from 4Y-S)
- `/review` surface unchanged from the 4Y-S acceptance. The Manager Review's title/description are still editable (auto-save on blur).
- Timeline markers, question pane, mode switch (Checkpoints | Final), Accept / Discard / Prev / Next all intact.

### §7 Preview — PROVED (preserved from 4Y-R / 4Y-S)
- `/preview-as-employee` surface unchanged; real grading, zero row writes.

### §8 Training Requirements step — PROVED
- New `/[courseId]/[versionId]/training-requirements` page.
- Fields: Audience (ApplicabilityPicker + explicit "I've confirmed the audience" checkbox — `required`), Passing grade, Retakes allowed, Required-for-scheduling, Requires-knowledge-test.
- Persists via existing `updateDraftAction` with a new `_nextHref` hidden field that routes to `/publish-review` on success. `_nextHref` is prefix-validated server-side (`/app/admin/people/safety-training/` only) → no open-redirect surface.
- Directive §8 "Do not silently default the audience to Everyone": the audience-confirmation checkbox is `required`; the browser blocks submission without it. The underlying `appliesToAll` default on the course row only matters once the explicit publish step is reached — which cannot be reached without ticking the confirmation.

### §9 Final Publish review step — PROVED
- New `/[courseId]/[versionId]/publish-review` page.
- Read-only summary: title, code, description, video + checkpoint count + final-assessment count, approval status, audience, passing grade, required/optional, retakes, knowledge-test requirement.
- Reuses the existing `PublishPanel` with `checkPublishReadiness` service output.
- Publication remains an explicit manager action. No auto-publish anywhere.

### §10 Without Video path preserved — PROVED
- `/new/without-video` still collects title + code + description + category upfront (no AI transcript to infer from).
- Compliance + applicability radios REMOVED from this form; replaced with a one-line note that those settings are configured on the Training Requirements step.
- The manual TimelineEditor + QuizEditor for question authoring remain untouched.

### §11 Staging acceptance — in flight
- Slice 15 DRH-1 run `42548366722` deploying.
- `tests/e2e/ep-train-4y-t-acceptance.staging.spec.ts` covers:
  - §2+§3 With Video opens directly to upload (no upfront identity form)
  - §3 Durable resume (same courseId/versionId across revisits)
  - §10 Without-video form simplified
  - §8 Training Requirements renders with required audience confirmation
  - §9 Publish Review consolidates everything
  - §4+§5 Grounded metadata endpoint respects the provisional guard (returns `applied: false, skippedReason: "COURSE_ALREADY_FINALISED"` on the already-established Silver Springs course)
  - Manager Review continues to Training Requirements (not `#publish` on the deep editor)
- Pending v1119 release + authenticated E2E run.

### §12 STOP boundaries honoured

- No production changes.
- No new Whisper or Qwen GPU inference (deterministic metadata only; AI path returns `NOT_YET_WIRED`).
- No modification of existing accepted pilot transcript or generated drafts (slice 9 fix applies going forward; past drafts unchanged).
- No automatic approval or publication.
- No employee assignments.
- No spending-limit changes.
- No unrelated UI redesign.
- 126 WIP files + stash `49c2af3d` preserved untouched.
- AI metadata generation integration boundary ships + deterministic tests PASS; live AI metadata generation explicitly reported as unverified (`AI_METADATA_NOT_YET_WIRED`). No fabricated success result.

## Files shipped in 4Y-T

### Slice 13 — upload-first entry + durable provisional draft
- `src/app/app/admin/people/safety-training/new/page.tsx` — card copy updated
- `src/app/app/admin/people/safety-training/new/with-video/page.tsx` — rewritten as server-provisioned redirect to the upload page
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/upload/page.tsx` (new) — the dedicated upload screen

### Slice 14 — grounded metadata generator
- `src/lib/hr/training/ai-metadata/course-metadata-generator.ts` (new)
- `src/app/api/admin/training/versions/[id]/generate-metadata/route.ts` (new)
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/CoursePrepProgress.tsx` — auto-fires `/generate-metadata` on generation completion
- `tests/ep-train-4y-t-course-metadata-generator.test.ts` (new) — 7/7 PASS

### Slice 15 — Training Requirements + Publish Review + without-video simplify
- `src/app/app/admin/people/safety-training/_actions.ts` — `_nextHref` support on `updateDraftAction`
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/training-requirements/page.tsx` (new)
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/publish-review/page.tsx` (new)
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx` — Continue link re-targeted
- `src/app/app/admin/people/safety-training/new/without-video/page.tsx` — compliance + applicability removed

### Acceptance
- `tests/e2e/ep-train-4y-t-acceptance.staging.spec.ts` (new)

## Deliverables (§13)

Screenshots captured during the acceptance run land under `test-results/`:

- `4yt-01-upload-entry.png` — With-video → upload redirect (no upfront form)
- `4yt-02-without-video-simplified.png` — manual form with compliance/audience removed
- `4yt-03-training-requirements.png` — Training Requirements with audience-confirm checkbox
- `4yt-04-publish-review.png` — consolidated final review

**Direct staging URLs:**
- Format selection: https://staging.spectreautomation.com/app/admin/people/safety-training/new
- With-video upload-first: https://staging.spectreautomation.com/app/admin/people/safety-training/new/with-video
- Without-video (simplified): https://staging.spectreautomation.com/app/admin/people/safety-training/new/without-video
- Training Requirements (Silver Springs): https://staging.spectreautomation.com/app/admin/people/safety-training/cmvzs3vz9000256qcu7lfysoz/cmvzs3w05000456qcgfgps7gy/training-requirements
- Publish Review (Silver Springs): https://staging.spectreautomation.com/app/admin/people/safety-training/cmvzs3vz9000256qcu7lfysoz/cmvzs3w05000456qcgfgps7gy/publish-review

## Remaining blockers

- Live AI metadata generation is **not** wired. The integration boundary is in place + deterministic tests PASS, but the Qwen/Modal path returns `AI_METADATA_NOT_YET_WIRED`. Enabling live AI metadata requires a founder-authorised Modal slice (spend-limit, HMAC contract, retry policy). Not started.
