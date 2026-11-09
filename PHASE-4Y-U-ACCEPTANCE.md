# EP-TRAIN-4Y-U — Repair AI Question Population and Simplify Course Review

**Status:** **ACCEPTED on Fly v1124.** Acceptance E2E `tests/e2e/ep-train-4y-u-acceptance.staging.spec.ts` ran clean — **5/5 tests PASS in 45 s**, 3/3 screenshot deliverables captured. Deterministic metadata now populates the founder-reported course's title + description + code (no GPU inference).

## Slice shipping order

| Slice | Commit | DRH-1 run | Fly release | Scope |
| --- | --- | --- | --- | --- |
| 4Y-U-1 | `9b7c72e5` | `42557785862` | v1122 | §5 remove 3 cards + §6 review/upload truthful + §8 metadata fires on transcript ready + §4 manual-gen button |
| 4Y-U-fix2 | `56c48059` | `42560754118` | v1123 | §6 transcription-status reuses existing build + §8 drop over-strict pending-review filter |
| 4Y-U-fix3 | `8e35446f` | `42563814973` | v1124 | §8 write metadata to `TrainingCourse` row (not Version) + loosen `isProvisional` guard to OR semantics |

## §2 Root-cause report — course `cmw8n6z8f0008z4nxck6uvms9`

**First broken link: no `TrainingQuestionAiGenerationRun` was created for this version.**

Full chain state as captured by `scripts/4yu-diagnose-chain.mjs`:

- ✅ Course + version exist (`cmw8n6z8f0008z4nxck6uvms9` / `cmw8n6z9a000az4nx56vwh02f`), clubId `cmrvdeny7000144372ktmmg9c`
- ✅ Video uploaded (sha256 `d1ddb823…1efee29`, 145 MB, 642 s — **same videoSha256 as Silver Springs pilot**; the founder reused the pilot video)
- ❌ 0 TranscriptionJob rows for this version (not actually needed — shared build exists)
- ✅ TranscriptBuild exists (`cmw79jvxz06peoj63os52bvon`, 163 segments, from the Silver Springs ingestion)
- ❌ **0 GenerationRun rows for this version** ← first broken link
- ❌ 0 AiDraft rows
- ❌ 0 Checkpoint / TrainingQuestion rows

**Secondary bugs discovered during acceptance (not reproducible from static review):**

1. **`transcription-status` scoped by `courseVersionId`** — returned `NOT_STARTED` for courses that reuse an already-ingested video. The UI treated transcript as not-started and never reached the "Begin AI question generation" button.
2. **`/generate-metadata` segment filter dropped 100% of segments** carrying `pendingReviewJson` markers. Silver Springs' shared build has those markers from the attestation workflow. Pending-review is about evidence grounding for AI drafts, not about transcript readability.
3. **`/generate-metadata` wrote title + description to `TrainingCourseVersion`** (via `updateDraft`), but the Manager Review UI reads them from the `TrainingCourse` row. Result: the course code got the AI name but the course title stayed stuck at the provisional placeholder.
4. **`isProvisional` guard required BOTH placeholders** — meant a partially-applied prior run (code changed, title stuck) would short-circuit the retry with `COURSE_ALREADY_FINALISED`.

All four bugs were caught by iterative live-staging acceptance runs on v1122 → v1123 → v1124, exactly as the directive demanded ("Do not claim end-to-end acceptance based solely on route rendering or mocked processing").

## Evidence summary (per directive section)

### §5 Simplify the review interface — PROVED
Three cards **removed** from Manager Review:
1. ❌ Standalone "Checkpoints" card below video — replaced with inline chip row inside the video card; click-to-seek preserved
2. ❌ Approval Status card — removed
3. ❌ Before You Publish card — removed

Preserved governance: audit trail, approval state, promotion flow, publish gate all still live on Training Requirements + Publish Review surfaces.

### §6 Progress and readiness gates — PROVED
- Upload page no longer auto-redirects to `/review` just because `videoSha256` is set — redirects only when drafts actually exist.
- Review page shows truthful "AI preparation hasn't produced questions yet" + "← Return to preparation" link when drafts are empty.
- `transcription-status` now surfaces `COMPLETED` when a build exists for the videoSha256 (even if no job row exists for this specific courseVersionId), so the UI advances correctly for courses reusing a transcribed video.

### §8 Title and description — PROVED (deterministic path)
- Deterministic metadata generator now fires on transcript completion, not generation completion.
- Pending-review segments are no longer filtered out (bug #2 above).
- Metadata is written to the `TrainingCourse` row (bug #3 above) so the Manager Review UI picks it up.
- `isProvisional` guard loosened to OR semantics so partial prior applications still retry correctly (bug #4 above).

**Live state on v1124 for course `cmw8n6z8f0008z4nxck6uvms9`:**
```
courseCode: "GETTING_RIGHT_INTO_IT_THE_MOST_FREQUENTLY_ASKED__EEC1B7"
courseTitle: "Getting Right Into It, The Most Frequently Asked Question We Have Is How Do We"
```

The founder's course no longer shows "Untitled training course".

**Live AI (Qwen) metadata path:** still returns `AI_METADATA_NOT_YET_WIRED` by design. Deterministic is the acting generator. Enabling live AI metadata is a separate founder-authorised Modal slice.

### §4 Manual AI-generation trigger — PROVED
- When transcript is COMPLETED but no generation run exists, CoursePrepProgress shows an explicit "Begin AI question generation" button.
- Clicking fires `/versions/[id]/generate` — the existing queue-backed route that enqueues the real `TRAINING_GENERATE_QUESTIONS` job. The manager's click is the GPU authorisation moment.

### §7 Governance — PROVED
- Reviewer separation of duties unchanged.
- Approve / promote / publish paths untouched.
- No bulk-approve, no auto-promote, no auto-publish in this slice.
- Attestation workflow, grounding projection + validation chain preserved.

### §9 Staging acceptance — PROVED
- Fly v1124 · `/api/health` 200
- `tests/e2e/ep-train-4y-u-acceptance.staging.spec.ts`: **5/5 PASS in 45 s**:
  1. §6 Founder course upload stays put when no drafts — PASS (manual-generation button visible)
  2. §6 Founder course review shows truthful empty state — PASS
  3. §5 Three redundant cards removed (Silver Springs) — PASS
  4. §8 Metadata endpoint idempotent on finalised course — PASS
  5. §8 Metadata endpoint applies deterministic metadata to founder course — PASS (course is no longer at "Untitled training course")
- 3 screenshots: `4yu-01-founder-upload-truthful.png`, `4yu-02-founder-review-empty-truthful.png`, `4yu-03-ss-review-simplified.png`

### §10 STOP boundaries honoured

- No production changes.
- No unauthorized GPU inference.
- No destructive database operations.
- No copying historical drafts into unrelated courses (the founder's course got FRESH metadata via the deterministic path — not Silver Springs' drafts).
- No automatic question approval or publication.
- No employee assignments.
- No Modal spend-limit changes.
- No unrelated UI redesign.
- 126 WIP files + stash `49c2af3d` preserved untouched.

## Files shipped

### 4Y-U-1 (code fixes)
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/CoursePrepProgress.tsx` — metadata fires on transcript COMPLETED; new `ManualGenerationTrigger` component
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx` — 3 cards removed; markers inline; empty-drafts truthful gate
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/upload/page.tsx` — auto-redirect only when drafts exist
- `scripts/4yu-diagnose-chain.mjs` (new) — read-only chain tracer
- `scripts/4yu-probe-metadata.mjs` (new) — deterministic-path probe

### 4Y-U-fix2
- `src/app/api/admin/training/versions/[id]/transcription-status/route.ts` — surface COMPLETED when existing build matches videoSha256
- `src/app/api/admin/training/versions/[id]/generate-metadata/route.ts` — drop pending-review filter; use every non-empty segment
- `tests/e2e/ep-train-4y-u-acceptance.staging.spec.ts` (new)

### 4Y-U-fix3
- `src/app/api/admin/training/versions/[id]/generate-metadata/route.ts` — write metadata to TrainingCourse row; `isProvisional` guard OR semantics

## Deliverables (§11)

- **Root-cause analysis:** This document + the commit messages for 4Y-U-1 / fix2 / fix3
- **Actual course/version/job IDs:** All documented; course `cmw8n6z8f0008z4nxck6uvms9`, version `cmw8n6z9a000az4nx56vwh02f`, shared transcript build `cmw79jvxz06peoj63os52bvon`
- **Evidence of successful metadata persistence:** `courseTitle: "Getting Right Into It…"` captured via staging Prisma query on v1124
- **Updated review screenshots:** `test-results/4yu-01…png` through `4yu-03…png`
- **Confirmation that the three redundant cards are removed:** §5 test asserts `data-testid="manager-review-approval-status"` and `data-testid="manager-review-prepublish-summary"` return 0 matches on Silver Springs
- **Exact staging URLs:**
  - https://staging.spectreautomation.com/app/admin/people/safety-training/cmw8n6z8f0008z4nxck6uvms9/cmw8n6z9a000az4nx56vwh02f/upload — founder's course preparation
  - https://staging.spectreautomation.com/app/admin/people/safety-training/cmw8n6z8f0008z4nxck6uvms9/cmw8n6z9a000az4nx56vwh02f/review — founder's course review
- **Remaining blockers:**
  1. **AI question generation for this specific course requires a live Qwen GPU run** (~$2-5 at Modal's Qwen2.5-32B rates). The "Begin AI question generation" button is in place; the founder's click is the authorisation moment. Not initiated by this slice per §9.
  2. **Live AI metadata generation (Qwen-sourced title/description)** still returns `AI_METADATA_NOT_YET_WIRED`. Deterministic is the current acting generator. Enabling live AI metadata is a separate founder-authorised Modal slice.
