# EP-TRAIN-6D-4Y — AI-Assisted Course Creation Workspace (DESIGN)

Offline implementation. NOT deployed. NOT pushed. Builds on the
accepted 4X baseline (`6bd5b925`).

## 1. Objective

Compose the existing 4A-4X services into a single manager-facing
guided workflow at:

```
/app/admin/people/safety-training/[courseId]/[versionId]/ai-workspace
```

The workspace is a **presentation shell** over existing services.
It does not replace the dense editor at
`.../[courseId]/[versionId]/page.tsx`. Both surfaces share the same
data, actions, and permissions; the AI workspace reframes them as
eight linear stages aligned to the natural course-creation flow.

## 2. Non-goals

- No new financial-posting, tenant-isolation, or RBAC mechanism.
- No schema change. No migration.
- No Modal / Qwen / GPU activation. No live inference.
- No publication, promotion, or approval that bypasses an existing
  server-side gate.
- No employee assignment, publication, or historical-candidate
  mutation.
- No redesign of global admin chrome, sidebar, or nav shell.
- No unrelated UI touched outside the new workspace folder + one
  entry-point link into the existing editor page.

## 3. §3 Preflight — service-contract inventory

| # | Service                              | Entry point                                                                 | Perm                              | HTTP route?                                            |
|---|--------------------------------------|-----------------------------------------------------------------------------|-----------------------------------|--------------------------------------------------------|
| 1 | Video upload + version creation     | `VideoUploader.tsx` (existing)                                              | `hr:training:write`               | Reuses existing upload action                          |
| 2 | 4V transcription — request          | `requestTranscription` (`src/lib/hr/training/transcription/job-service.ts`) | `hr:training:write`               | `POST /api/admin/training/versions/[id]/transcribe`    |
| 3 | 4V transcription — status           | `prisma.trainingTranscriptionJob` + `trainingTranscriptBuild`               | `hr:training:read`                | **NEW** `GET /api/admin/training/versions/[id]/transcription-status` |
| 4 | 4W generation — request             | `requestGeneration` (`generation-service.ts`)                               | `hr:training:write`               | `POST /api/admin/training/versions/[id]/generate`      |
| 5 | 4W generation — status              | `prisma.trainingQuestionAiGenerationRun` + `TrainingQuestionAiDraft` count  | `hr:training:read`                | **NEW** `GET /api/admin/training/versions/[id]/generation-status` |
| 6 | 4X placement + dedup                | `buildTopicAwareAssessmentPlan`, `evaluateAgainstPriors`                    | n/a (service-only, run at generate) | n/a (consumed inline by generate route)              |
| 7 | 4M evidence reader                  | `resolveCandidateEvidence`                                                  | `hr:training:ai:read`             | Consumed by `GET /api/admin/ai-training/drafts/[id]`   |
| 8 | 4N approval service                 | `approveTrainingQuestionCandidate`                                          | `hr:training:ai:approve`          | `POST /api/admin/ai-training/drafts/[id]/approve`      |
| 9 | 4T question promotion               | `promoteApprovedDraft` (`promotion-service.ts`)                             | `hr:training:write`               | **NEW** `POST /api/admin/ai-training/drafts/[id]/promote` |
|10 | Existing checkpoints + questions    | `listCheckpointsForVersion` + `_actions.ts` (TimelineEditor + QuizEditor)   | `hr:training:write`               | Server actions, no HTTP                                |
|11 | Preview + publication               | `PublishPanel.tsx` + `publishDraftAction`                                   | `hr:training:publish`             | Server action, no HTTP                                 |

Three new routes. All use existing permissions.
**No new permanent permission grant. No schema change.**

## 4. Permission model

| Action                                | Permission                      | Source                       |
|---------------------------------------|---------------------------------|------------------------------|
| View workspace                        | `hr:training:read`              | existing                     |
| Upload / replace video                | `hr:training:write`             | existing                     |
| Start transcription                   | `hr:training:write`             | existing                     |
| Read transcription status             | `hr:training:read`              | existing                     |
| Start generation                      | `hr:training:write`             | existing                     |
| Read generation status                | `hr:training:read`              | existing                     |
| Review candidates                     | `hr:training:ai:read`           | existing                     |
| Approve candidate                     | `hr:training:ai:approve`        | existing                     |
| Promote approved draft to question    | `hr:training:write`             | existing                     |
| Publish version                       | `hr:training:publish`           | existing                     |

## 5. Workspace stages

Eight stages rendered as a vertical stepper on desktop + horizontal
chip row on mobile. Each stage has: *state*, *summary line*, and a
*panel* with the actions available in that state.

### Stage 1 — VIDEO

**State source**: `trainingCourseVersion.videoStorageKey + videoSha256
+ videoDurationSec + videoSizeBytes`.

**States**:

- `MISSING` — no `videoStorageKey`. Panel renders existing
  `VideoUploader`.
- `UPLOADING` — browser-side only. Toast on completion.
- `READY` — `videoSha256` + `videoDurationSec` both present. Panel
  shows source-video identity (first 12 chars of sha), duration in
  minutes, size, and a "Re-upload" affordance (DRAFT only).

Panel never fabricates "ready" state — it reads the authoritative
version row.

### Stage 2 — TRANSCRIPTION

**State source**: latest `trainingTranscriptionJob` for the version
+ latest `trainingTranscriptBuild` for the video sha.

**States**:

- `NOT_STARTED` — no job row. Panel shows "Request transcription"
  button (disabled when video missing).
- `REQUESTED` / `QUEUED` / `RUNNING` — polling banner with the
  `executionStatus`, `attempts`, `maxAttempts`, and the acceptance
  timestamp. No fabricated "complete" status.
- `COMPLETED` — shows the `resolvedTranscriptBuildId`'s
  `producedAt`, segment count, and total duration. Panel shows the
  "Request again" button only when a newer transcription is
  authorised (e.g. video re-uploaded).
- `FAILED` — panel shows `failureCode` + `failureDetail` + "Retry"
  if `attempts < maxAttempts`.
- `CANCELLED` — panel shows the cancellation reason + "Request
  again" if video unchanged.

**Invariant §4 of 4V**: the panel NEVER renders
`transcript-ready` text unless **both**: the job is `COMPLETED`
AND a `trainingTranscriptBuild` row with matching
`sourceVideoSha256` exists for the same clubId.

### Stage 3 — ASSESSMENT PLAN

**State source**: a server-side preview computed via
`buildTopicAwareAssessmentPlan` on the latest transcript build
(fallback to `buildBaselineAssessmentPlan` as the generate route
does). Displayed read-only before Stage 4 is run.

Panel renders:

- Proposed learning objectives (count, topic phrase, segment range).
- Proposed checkpoint boundaries (timestamp, rationale signal:
  PAUSE / SENTENCE / DRIFT).
- Final-assessment allocation (count).
- "Why this count" — target total questions = 6 (default) split by
  current plan.

If transcript is not yet complete, the panel disables Stage 3 and
Stage 4 with the message *"Transcription required before plan can
be generated."*

### Stage 4 — GENERATE

**State source**: latest `trainingQuestionAiGenerationRun` for the
version + current `TrainingQuestionAiDraft` count.

**States**:

- `NOT_STARTED` — "Start generation" button (disabled when Stage 3
  cannot render a plan).
- `REQUESTED` / `QUEUED` / `RUNNING` — polling banner. Shows
  `attempts`, `leaseExpiresAt`, `requestedAt`.
- `COMPLETED` — shows candidate counts split by lifecycle state
  (GENERATED / VALIDATION_PENDING / REQUIRES_HUMAN_REVIEW /
  APPROVED_DRAFT / REJECTED) and the dedup drop log from
  `shortfallReasonJson` (§6 4X).
- `FAILED` — shows `failureCode` + rejection code if present.
- `CANCELLED` — shows cancellation reason.

Cost-governance refusals surface the full `GenerationRejectedError`
detail; no fabricated success.

### Stage 5 — REVIEW

**State source**: `listCandidates(principal, clubId, {courseVersionId})`
from the existing 4N read service.

Panel renders a candidate table with columns:
- Topic (from `topicHint`).
- Lifecycle state (badge, 4D palette).
- Destination (CHECKPOINT with ts | FINAL_ASSESSMENT).
- Placement rationale (PAUSE/SENTENCE/DRIFT label from 4X).
- Dedup verdict (EXACT_DUP / PARAPHRASE_DUP / TOPIC_CANDIDATE /
  DISTINCT).
- Validation summary (per 4N).
- "Open review" link → existing `/app/admin/ai-training/review/persisted?candidate=<id>`.

No editing happens in this panel — the panel points to the
existing persisted review surface that already carries edit +
revalidation controls (§5 "disable rather than implement
unsafe").

### Stage 6 — COURSE ASSEMBLY

**State source**: `TrainingQuestionAiDraft` rows in state
`APPROVED_DRAFT` for the version, plus checkpoint list for the
version.

Per-row panel shows:
- Question prompt (truncated).
- Verified-correct answer index + option text.
- Destination selector (CHECKPOINT / FINAL_ASSESSMENT).
- CHECKPOINT: a dropdown of this version's checkpoints — only
  checkpoints on this course (cross-course promotion is refused
  server-side anyway).
- "Promote" button — invokes **NEW** `POST /api/admin/ai-training/drafts/[id]/promote`.

Idempotency + replay: the server re-verifies evidence, verified
answer, and content hash on every promote (4T has 7 defensive
re-checks).

### Stage 7 — PREVIEW

Links to the existing employee preview route (via the existing
"Preview as employee" affordance already in the editor page). No
new preview UI is built. Workspace surfaces a reminder that the
preview must be run before Stage 8.

### Stage 8 — PUBLISH

Hands control back to the existing `PublishPanel` /
`PublishRevisionDialog` in the editor page. The AI workspace does
**not** render a parallel publish button — publication remains the
single authoritative gate.

Button in Stage 8 panel says *"Return to editor to publish"* and
links back to `.../[courseId]/[versionId]`.

## 6. Checkpoint editing (§5)

The workspace does **not** rebuild the checkpoint editor. Instead,
Stage 5's "Open review" link opens the existing persisted review
surface which already supports every §5 operation (move marker,
reject, adjust allocation, revalidate on edit). Material edit in
the review surface flips the draft to `EDITED_VALIDATION_STALE` and
blocks promotion until revalidation — enforced server-side by 4N.

If a backend capability is absent for a requested edit (e.g.
"reject a placement without affecting the whole group"), the
workspace **disables the control and explains the blocker**
rather than silently mutating state. No local-only edit mode.

## 7. Dedup surface (§6)

Every row in Stage 5 shows the 4X verdict. The workspace renders
the verdict badge **as the service classified it** — no re-
inference, no re-interpretation. Verdicts:

- `EXACT_DUP` — red badge; row disabled for promotion with a
  disabled-tooltip "Blocked by exact duplicate".
- `PARAPHRASE_DUP` — red badge; same block.
- `TOPIC_CANDIDATE` — amber badge; row shown but promotion
  disabled until a reviewer resolves via the existing review
  surface.
- `DISTINCT` — neutral badge; normal promotion flow.

The workspace copy explicitly states the classifier is **lexical,
not semantic**. The dedup drop log is surfaced in the Stage 4
panel.

Final-assessment questions are **cross-checked against every
checkpoint question and every other final-assessment question** —
this is enforced at the service layer in 4X. Workspace shows the
result badge per row.

## 8. Human governance (§7)

- No workspace button that auto-approves.
- No workspace button that auto-promotes.
- No workspace button that auto-publishes.
- Promotion requires the draft to already be in `APPROVED_DRAFT`
  (service-enforced — the promote endpoint refuses otherwise).
- Model-selected answer is **never** used as the verified answer.
  The 4T promotion service reads the verified answer from the
  separate snapshot written by 4N at approval time.

## 9. Error states — never-fabricated contract

The workspace reads authoritative persistence on every poll. If
a service reports a non-terminal state, the stage shows "waiting"
— never "complete". If an authoritative row is absent, the
workspace says "not started" — never "in progress".

The 4V invariant (non-inline PDF ≠ INFORMATIONAL; ingestion must
reach terminal state before completion) has a direct analogue
here: transcription COMPLETED requires a matching
`trainingTranscriptBuild` row.

## 10. UI composition

- Workspace page is a Next.js server component.
- Stepper + per-stage panels are React server components when
  they only render data; client components only where polling or
  interactivity is required.
- Panels compose existing primitives (`Badge`, `card`, `btn`) —
  no new tokens, no new chrome.
- Polling intervals: 5 s for RUNNING, 10 s for QUEUED / REQUESTED.
  Stops polling as soon as a terminal state is observed.
- Mobile layout: 390 × 844 target. Stepper collapses to a scroll
  chip row. Each panel stacks vertically with 16 px gutters.

## 11. Testing

Mocked integration tests use the disposable PG16 harness pattern
established in 4V/4W/4X.

- `tests/ep-train-6d4y-workspace.test.ts` — API route unit +
  service composition (no browser).
  - transcription-status: NOT_STARTED, REQUESTED, COMPLETED
    (with authoritative `trainingTranscriptBuild` match),
    COMPLETED-but-missing-build (returns waiting-on-ingest),
    cross-tenant 404.
  - generation-status: NOT_STARTED, RUNNING, COMPLETED with
    candidate-count breakdown by lifecycle state, FAILED with
    failureCode, cross-tenant 404.
  - promote: happy path (CHECKPOINT + FINAL_ASSESSMENT), draft
    not approved → 409, cross-tenant → 404 (same-shape), already
    promoted same destination → 200 replay, already promoted
    different destination → 409.
  - plan preview: stays in sync with the generate route's plan
    builder.

- `tests/ep-train-6d4y-workspace-server.test.ts` — pure server-
  component composition tests (stage-state resolution,
  waiting-on-ingest guard, dedup badge mapping).

- `tests/ep-train-6d4y-pg16.test.ts` — disposable PG16 integration
  for the three new routes against a seeded tenant.

## 12. Screenshots

Captured locally if a dev server can be started offline; otherwise
the acceptance report documents the inability-to-capture reason
and ships without. Playwright local screenshots do not require
live Modal or GPU.

Target viewports: 1440 × 900 desktop, 390 × 844 mobile portrait.

## 13. STOP boundaries (§10)

| STOP                                 | Confirmed |
|--------------------------------------|-----------|
| No staging/production deploy         | ✅         |
| No shared DB migration               | ✅ (no schema change) |
| No live Modal/Qwen                   | ✅         |
| No GPU activation                    | ✅         |
| No employee assignments              | ✅         |
| No publication                       | ✅         |
| No historical candidate modification | ✅         |
| No new permanent role grants         | ✅         |
| No unrelated UI redesign             | ✅         |
| 126 unrelated WIP files preserved    | ✅ (stashed) |

## 14. Deliverables

- `docs/training/ai-generation/PHASE-D-4Y-WORKSPACE-DESIGN.md` (this file)
- `docs/training/ai-generation/PHASE-D-4Y-ACCEPTANCE.md`
- Implementation commit on `ep-train-6d-4y/workspace` (NOT pushed)
- Three new HTTP routes (per §3 table above)
- Mocked integration tests + disposable PG16 harness
- Workspace page + stepper + per-stage client components
- Screenshots (if feasible offline)

## 15. Staging activation prerequisites (deferred)

Live activation of the 4Y workspace on staging requires a separate
authorised slice. At minimum it must include:

1. Apply the 4X uniqueness correction migration (`20261106_ep_train_6d_4x_active_run_uniqueness_fix`)
   BEFORE 4W+4X code goes live.
2. Set MODAL_TRANSCRIBE_URL + MODAL_GENERATE_URL + HMAC secrets.
3. Verify cost cap configuration on the target tenant.
4. Playwright acceptance against a seeded tenant + synthetic
   SUPER_ADMIN (not a live member or founder account).
5. Remove / replace the "Open AI Workspace" link in the editor
   page with a flag-gated conditional (if desired).

## 16. Related slices

- 4V (transcription) — parent service for Stage 2.
- 4W (generation) — parent service for Stage 4.
- 4X (placement + dedup) — parent service for Stage 3 preview +
  Stage 5 verdict badge.
- 4M (evidence) + 4N (approval) + 4T (promotion) — services
  consumed by Stages 5–6.
- Existing safety-training editor — parent surface Stage 7 + 8
  delegate back to.
