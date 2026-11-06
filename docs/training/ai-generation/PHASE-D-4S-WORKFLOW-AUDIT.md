# EP-TRAIN-6D-4S — AI-Assisted Course Generation Workflow Audit

Status: **READ-ONLY audit.** No code modified; no deployment; no
inference run; no training records touched. Author: Claude (Opus 4.7).
Date: 2026-11-06. Branch: `ep-train-6d-4s/workflow-audit` (docs only,
not pushed).

## 1. Answers to the two founder questions

### Q1 — Does Spectre automatically determine appropriate knowledge-checkpoint positions within a training video and generate grounded questions for those checkpoints?

**No.**

- No transcription caller exists on staging or in `src/`. The 4L
  ingest services (`persistTranscriptBuild`, `persistTranscriptSegments`,
  `persistGroundingProjection`) are implemented but their only callers
  are vitest + the 4R manual fixture script.
  Enumerated by `grep -r persistTranscriptBuild src/` → zero
  non-ingest-file source hits.
- No Modal / Qwen / Whisper / faster-whisper integration code anywhere
  in `src/`. Only `@anthropic-ai/sdk` is wired, and only for AP-
  intelligence (invoice extraction) + commentary generation — not for
  training questions.
- No "automatic checkpoint placement" service. Checkpoints are created
  via [createCheckpoint](src/lib/hr/training/checkpoints.ts) which
  requires an admin `principal` with `hr:training:write` and an
  explicit `atSecond` input. The 1-second-spacing rule is enforced on
  write, but position selection is 100 % manual.
- The AI-generation data model has a `CheckpointPlacement { kind:
  "CHECKPOINT", atSec: number }` and `FinalAssessmentPlacement`
  ([types.ts:43-52](src/lib/training/ai-generation/types.ts#L43-L52)),
  but these are INPUT fields to the validator pipeline — the model
  does not choose them. The grounding validator is a validator, not a
  generator.
- The 8 historical EP-TRAIN-6D-4H candidates on staging came from a
  pilot DATA import (fixture placeholders — `fixture-q1`...`fixture-q8`
  in `groundingProjectionSha256`), NOT a live inference run.
- The 4R synthetic candidate was hand-authored + inserted via raw
  Prisma writes.

### Q2 — Does Spectre automatically generate a final knowledge assessment containing distinct, non-repeating questions, including semantic deduplication against all preceding checkpoints?

**No.**

- No semantic-similarity function exists: zero references to
  `embedding`, `cosine`, `vector`, `semanticDedup`, `similarity` under
  `src/lib/hr/training/` or `src/lib/training/ai-generation/`
  (confirmed via grep).
- No exact-match deduplication at the course-authoring layer either:
  [questions.ts](src/lib/hr/training/questions.ts) allows duplicate
  `prompt` text under distinct `id`s. The only uniqueness constraint
  on `TrainingQuestionAiDraft` is
  `@@unique([clubId, courseVersionId, contentHash])` — identical
  content hashes collide to one row, but a human reviewer paraphrase
  is NOT caught.
- No "final-assessment composer": the publish gate only enforces that
  IF `requiresKnowledgeTest=true` on the version, THEN at least one
  question must exist with `checkpointId = null` ([courses.ts:295-300](
  src/lib/hr/training/courses.ts#L295-L300)). The gate does not score,
  rank, dedupe, or balance questions across checkpoints vs final
  assessment.
- There is no code path that promotes an AI-approved draft
  (`TrainingQuestionAiDraft.state = APPROVED_DRAFT`) into a
  `TrainingQuestion` row that can be published. The two systems are
  **entirely disconnected** today.

## 2. Capability matrix

Legend: ✅ IMPLEMENTED AND CONNECTED · ⚠ IMPLEMENTED BUT NOT CONNECTED
· ◐ PARTIALLY IMPLEMENTED · ✗ NOT IMPLEMENTED.

| # | Capability                                            | Status | Evidence (file / func / test)                                                                        |
| :-: | ---------------------------------------------------- | :----: | ---------------------------------------------------------------------------------------------------- |
| 1 | Video upload + course creation                        | ✅     | [video.ts](src/lib/hr/training/video.ts) `uploadTrainingVideo` — admin flow via POST [/api/hr/training/versions/[id]/video](src/app/api/hr/training/versions/[id]/video/route.ts). Tests: [hr-2c-b6-acceptance.local.spec.ts](tests/e2e/hr-2c-b6-acceptance.local.spec.ts), various. **Known staging gap: historical `videoDurationSec = null` repair utility exists.** |
| 2 | Video transcription                                   | ✗      | No transcription caller anywhere. Modal/Qwen/Whisper integration does not exist. [ingest.ts](src/lib/hr/training/transcription/ingest.ts) can **persist** transcript rows if handed them, but nothing hands them.                                                                                                                                                                   |
| 3 | Transcript segmentation + topic analysis              | ✗      | The `TrainingTranscriptSegment` schema supports hand-authored segments (indices + text + timestamps). No automated segmentation. No topic-analysis algorithm.                                                                                                                                                                                                                             |
| 4 | AI question generation                                | ✗      | [ai-generation/pipeline.ts](src/lib/training/ai-generation/pipeline.ts) is a **validator**, not a generator. It converts a model-produced `TrainingQuestionDraftLiteV1` → `TrainingQuestionProposalV1` + runs the grounding check. No code produces the draft. No Modal app, no OpenAI/Anthropic/Qwen caller for training questions.                                                   |
| 5 | Automatic checkpoint placement                        | ✗      | No service that ingests transcript topics + chooses `atSecond` positions. All checkpoints are created manually via [createCheckpoint](src/lib/hr/training/checkpoints.ts) with an explicit `atSecond`.                                                                                                                                                                                       |
| 6 | Assignment of generated questions to checkpoint markers | ✗   | `TrainingQuestion.checkpointId` FK exists + is validated at publish time. Manual admin UI binds questions to checkpoints. NO automated binder.                                                                                                                                                                                                                                              |
| 7 | Final-assessment question generation                  | ✗      | No composer. The publish gate only counts: `requiresKnowledgeTest → ≥1 final question with checkpointId NULL`.                                                                                                                                                                                                                                                                                 |
| 8 | Exact question deduplication (within a course)        | ◐      | `TrainingQuestionAiDraft` carries `@@unique([clubId, courseVersionId, contentHash])` — identical canonical content collapses. `TrainingQuestion` (the publishable entity) has NO uniqueness constraint on `prompt`. The AI-review → publishable promotion gap means even the AI-side exact-dedup does not reach the published surface.                                                            |
| 9 | Semantic question deduplication                       | ✗      | Zero embedding / cosine / similarity logic. Zero code path considers paraphrase overlap.                                                                                                                                                                                                                                                                                                      |
| 10 | Source-grounding + factual validation                 | ✅     | [pipeline.ts](src/lib/training/ai-generation/pipeline.ts) + [grounding-validator.ts](src/lib/training/ai-generation/grounding-validator.ts) + [convert-draft-to-proposal.ts](src/lib/training/ai-generation/convert-draft-to-proposal.ts). Verdicts: GROUNDED / REQUIRES_HUMAN_VERIFICATION / REJECTED. Tests under [tests/](tests/) ep-train-6c-10b-*. Consumed by the 4D read service that surfaces persisted validation rows. |
| 11 | Manager review + human approval                       | ✅     | [persisted/page.tsx](src/app/app/admin/ai-training/review/persisted/page.tsx) (4D UI) + [approval-service.ts](src/lib/hr/training/ai-review/approval-service.ts) (4N) + [ApprovalDialog.tsx](src/components/ai-training/ApprovalDialog.tsx) (4P). Proven end-to-end on staging in EP-TRAIN-6D-4R. |
| 12 | Checkpoint retry + passing requirements               | ✅     | [attempts.ts](src/lib/hr/training/attempts.ts) `recordCheckpointAttempt` + `getPlayerState`. Per-checkpoint `maxRetries` (default 3) + `requiredToProceed` flag. Final-assessment unlock gated on all required checkpoints cleared + ≥80 % video watched (`VIDEO_COMPLETION_THRESHOLD_PERCENT`).                                                                                                 |
| 13 | Final-assessment passing requirements                 | ✅     | `TrainingCourseVersion.passingScore` (0-100, default 80) + `retakesAllowed`. Enforced by [attempts.ts:788-791](src/lib/hr/training/attempts.ts#L788-L791).                                                                                                                                                                                                                                       |
| 14 | Employee playback + checkpoint enforcement            | ✅     | [attempts.ts](src/lib/hr/training/attempts.ts) `recordVideoProgress` (monotonic, no "seek-to-end" cheat) + `getPlayerState`. [video/route.ts](src/app/api/hr/training/versions/[id]/video/route.ts) authenticated streaming + HTTP Range for seek. Employee-portal applicability resolver in [applicability.ts](src/lib/hr/training/applicability.ts).                                                   |
| 15 | Course publication                                    | ✅     | [courses.ts](src/lib/hr/training/courses.ts) `publishDraft` + `checkPublishReadiness`. Requires `hr:training:publish`. Validates title + video + duration + per-question option integrity + checkpoint position bounds + 1-s spacing.                                                                                                                                                             |
| 16 | Course assignment to employees                        | ✅     | [applicability.ts](src/lib/hr/training/applicability.ts) resolves via `appliesToAll` / `appliesToDeptIds` / `appliesToPositionIds` / explicit `TrainingAssignment`. [obligations.ts](src/lib/hr/training/obligations.ts) issues `TrainingObligation` rows. Compliance via [compliance-resolver.ts](src/lib/hr/training/compliance-resolver.ts).                                                            |
| 17 | AI draft → published TrainingQuestion promotion       | ✗      | NO code path. `TrainingQuestion.aiDraftId` column does not exist. The AI-review table family and the course-authoring table family are **parallel universes**.                                                                                                                                                                                                                                |
| 18 | Transcription worker / job                            | ✗      | [bin/worker.ts](bin/worker.ts) registers queue handlers for mailbox-sync + work-intake + timesheet-approval + signup-sweeper. **No training job.**                                                                                                                                                                                                                                              |

## 3. End-to-end workflow diagram (today)

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │  ACTUAL CURRENT WORKFLOW — what happens when a manager uploads a new   │
 │  training video today (2026-11-06)                                     │
 └────────────────────────────────────────────────────────────────────────┘

 (1) Manager: Create Course                   ✅
     POST  /app/admin/people/safety-training/new
     src/lib/hr/training/courses.ts :: createCourse (hr:training:write)
     → TrainingCourse + TrainingCourseVersion (version=1, state=DRAFT)

 (2) Manager: Upload video                    ✅
     POST /api/hr/training/versions/[id]/video
     uploadTrainingVideo → R2 object + videoSha256 + videoDurationSec
     via server-side ffprobe (EP-TRAIN-4E).

 (3) ??? TRANSCRIPTION                        ✗  NOTHING HAPPENS
     No worker enqueues a transcription job.
     No Modal/Whisper endpoint is contacted.
     TrainingTranscriptBuild / Segment rows are NEVER created.

 (4) ??? TOPIC ANALYSIS + CHECKPOINT PLACEMENT ✗ NOTHING HAPPENS

 (5) ??? AI QUESTION GENERATION               ✗  NOTHING HAPPENS
     No Qwen prompt is issued; no draft lands in
     TrainingQuestionAiDraft.

 (6) Manager: HAND-AUTHOR checkpoints          ✅
     src/lib/hr/training/checkpoints.ts :: createCheckpoint
     (atSecond chosen by hand)

 (7) Manager: HAND-AUTHOR questions            ✅
     src/lib/hr/training/questions.ts :: createQuestion /
     attachOption / linkCheckpoint
     (prompt + options + correct marker all typed by admin)

 (8) Manager: Set passingScore + requiresKnowledgeTest ✅
     courses.ts :: updateDraft

 (9) Manager: Publish                          ✅
     courses.ts :: publishDraft
     checkPublishReadiness validates everything.
     Prior PUBLISHED version → RETIRED. currentVersionId updated.

 (10) Assignment                               ✅
     obligations.ts issues TrainingObligation rows for every employee
     whose department / position / explicit assignment matches.

 (11) Employee watches                         ✅
     Authenticated /api/hr/training/versions/[id]/video streams
     with HTTP Range. recordVideoProgress is monotonic.
     recordCheckpointAttempt enforces maxRetries + required gate.
     Final-assessment unlock requires all required checkpoints cleared
     + ≥80 % watched.

 (12) Completion                               ✅
     TrainingCompletion row satisfies the obligation.
     Compliance-resolver reports eligibility.


 ┌────────────────────────────────────────────────────────────────────────┐
 │  PARALLEL AI-REVIEW UNIVERSE (EP-TRAIN-6D-4B..4P)                      │
 │  Exists on staging today but is DISCONNECTED from the published course │
 │  authoring flow above. The approval endpoint promotes a draft to       │
 │  APPROVED_DRAFT state — but nothing reads APPROVED_DRAFT to publish.   │
 └────────────────────────────────────────────────────────────────────────┘

 AI-review model:
    TrainingQuestionAiGenerationRun (bookkeeping)
      ↓
    TrainingTranscriptBuild + TrainingTranscriptSegment + TrainingGroundingProjection  (4K)
      ↓
    TrainingQuestionAiDraft (immutable draft + content hash)
      ↓
    TrainingQuestionAiValidation (verdict + verifiedCorrectAnswerSnapshotJson)
      ↓
    TrainingQuestionAiReview (reviewer decision)
      ↓
    TrainingQuestionAiStateTransition (lifecycle audit)

 AI-review path PROVEN on staging (4R acceptance 2026-11-06):
   - Fixture draft created via raw-Prisma analogue of 4L services.
   - 4D read service renders queue + detail + validation + evidence.
   - 4M evidence reader classifies authentic / historical / integrity-failure.
   - 4N approval service writes verifiedCorrectAnswerSnapshotJson + bumps
     draft state to APPROVED_DRAFT atomically.
   - 4P dialog + eligibility matrix gate the browser experience.

 AI-review path HAS NO EXIT:
   - APPROVED_DRAFT state is a terminal in the AI schema.
   - No code reads APPROVED_DRAFT and writes a TrainingQuestion row.
   - A published TrainingCourseVersion today ignores the AI-review tables
     entirely.
```

## 4. Validation surface audit

| Validation                                                 | Code path                                                                                            | Status    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------- |
| Grounding validator (drafts must cite only authorised segments) | [grounding-validator.ts](src/lib/training/ai-generation/grounding-validator.ts) :: `validateProposal` | ✅ (code) |
| Pipeline fail-closed verdict                                | [pipeline.ts](src/lib/training/ai-generation/pipeline.ts)                                            | ✅ (code) |
| Content-hash binding (draft ↔ validation)                   | [approval-service.ts](src/lib/hr/training/ai-review/approval-service.ts) :: `expectedContentHash`     | ✅        |
| Verified-answer snapshot integrity (hash + validation + option) | [verified-answer-reader.ts](src/lib/hr/training/ai-review/verified-answer-reader.ts) :: `resolveVerifiedAnswer` | ✅ |
| Evidence integrity (projection sha256 recomputed)           | [evidence-reader.ts](src/lib/hr/training/ai-review/evidence-reader.ts)                                | ✅        |
| Publish-time per-question option integrity                  | [courses.ts](src/lib/hr/training/courses.ts) :: `checkPublishReadiness`                               | ✅        |
| Publish-time checkpoint position + spacing                   | [courses.ts](src/lib/hr/training/courses.ts) :: `checkPublishReadiness`                               | ✅        |
| Final-assessment dedup                                      | —                                                                                                    | ✗         |
| Semantic-similarity dedup                                   | —                                                                                                    | ✗         |
| Passing-score threshold                                     | [attempts.ts](src/lib/hr/training/attempts.ts):788-791                                                | ✅        |

## 5. Test coverage by capability

| Capability                                   | Unit tests      | Disposable-PG | Staging E2E proven |
| -------------------------------------------- | :-------------: | :-----------: | :----------------: |
| Video upload                                 | ✅ (hr-2c-b)   | —             | ✅ (prior slices)  |
| Course publish readiness                     | ✅             | —             | ✅ (HR-2C)         |
| Checkpoint authoring (manual)                | ✅             | —             | ✅ (EP-TRAIN-3)    |
| Question authoring (manual)                  | ✅             | —             | ✅                 |
| Grounding validator                          | ✅ (6C-10B)    | —             | not needed (pure)  |
| AI-review read service                       | ✅ (6D-4D)     | ✅ (6D-4D)    | ✅ (6D-4I)         |
| 4L transcription-ingest services             | ✅ (6D-4L)     | ✅ (6D-4L)    | ✗ — never called in prod |
| 4M evidence reader                           | ✅ (6D-4M)     | ✅ (4R integration) | ✅ (6D-4R)       |
| 4N approval service                          | ✅ (6D-4N)     | ✅ (4N + 4R)  | ✅ (6D-4R)         |
| 4P approval dialog + eligibility             | ✅ (6D-4P)     | ✅ (4P)       | ✅ (6D-4R)         |
| Checkpoint retry + required gate             | ✅ (EP-TRAIN-3)| —             | existing          |
| Employee playback + progress                 | ✅             | —             | existing          |
| Course assignment + obligations              | ✅ (EP-TRAIN-5A..C) | —        | existing          |
| **Automatic checkpoint placement**           | ✗              | ✗             | ✗                 |
| **Automatic question generation**            | ✗              | ✗             | ✗                 |
| **Semantic deduplication**                   | ✗              | ✗             | ✗                 |
| **AI draft → published question promotion**  | ✗              | ✗             | ✗                 |
| **Transcription worker job**                 | ✗              | ✗             | ✗                 |

## 6. Permission boundaries + publication blockers

Permission summary for the end-to-end workflow:

| Action                                   | Permission                       | Current role grants                               |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------- |
| Create course / version                  | `hr:training:write`              | SUPER_ADMIN, CLUB_ADMIN                           |
| Upload video                             | `hr:training:write`              | SUPER_ADMIN, CLUB_ADMIN                           |
| Author questions + checkpoints           | `hr:training:write`              | SUPER_ADMIN, CLUB_ADMIN                           |
| Publish course                           | `hr:training:publish`            | SUPER_ADMIN, CLUB_ADMIN                           |
| Assign (TrainingAssignment)              | `hr:training:assign`             | SUPER_ADMIN, CLUB_ADMIN, GENERAL_MANAGER          |
| View AI-review workspace                 | `hr:training:ai:read`            | SUPER_ADMIN, CLUB_ADMIN                           |
| Approve AI draft                         | `hr:training:ai:approve`         | **SUPER_ADMIN ONLY**                              |
| Ingest transcript evidence (4L)          | `hr:training:transcription:write`| **nobody** (deliberately withheld per 4L §permissions) |
| Stream video (admin)                     | `hr:training:read`               | SUPER_ADMIN, CLUB_ADMIN, GENERAL_MANAGER, ...     |
| Stream video (employee)                  | portal session + applicability   | employees with matching dept/position/assignment  |

**Publication blockers for an AI-authored course today:**

1. No code path promotes `APPROVED_DRAFT` into a `TrainingQuestion`.
   CLUB_ADMIN would have to re-type the approved question into the
   manual authoring UI — defeating the purpose of AI review.
2. `hr:training:transcription:write` is held by NO role. Even the 4L
   services cannot be called from an authenticated request.
3. No worker handler registered for a transcription job.
4. No API route that accepts a transcription request.

## 7. Framework for the recommended implementation sequence

See [PHASE-D-4S-GAP-ANALYSIS.md](PHASE-D-4S-GAP-ANALYSIS.md) for the
gap taxonomy, and [PHASE-D-4S-ACCEPTANCE.md](PHASE-D-4S-ACCEPTANCE.md)
for the recommended smallest-next-slice sequence.

## 8. STOP compliance (directive §Mandatory STOP)

| Boundary                                 | Status   |
| ---------------------------------------- | -------- |
| No deployment                            | HONOURED |
| No code implementation                   | HONOURED — docs only |
| No Modal/Qwen/Whisper inference          | HONOURED |
| No worker activation                     | HONOURED |
| No publication                           | HONOURED |
| No employee assignments                  | HONOURED |
| No permission changes                    | HONOURED |
| No existing training records modified    | HONOURED — 8 historical candidates confirmed untouched by 4R teardown invariant check |
| Preserve 126 unrelated WIP files         | HONOURED — stashed at entry |
