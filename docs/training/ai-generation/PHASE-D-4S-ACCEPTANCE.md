# EP-TRAIN-6D-4S — Audit Acceptance + Recommended Implementation Sequence

Status: READ-ONLY audit complete. Awaiting founder direction on the
recommended next slice. No code implemented. No deployment executed.

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4s/workflow-audit` (docs only, not pushed).

## 1. One-page summary

**Both founder questions answered: NO.**

- **Q1 (automatic checkpoint placement + grounded generation):** NOT
  IMPLEMENTED. No transcription caller, no generator, no checkpoint
  placer.
- **Q2 (final-assessment composer + semantic dedup):** NOT IMPLEMENTED.
  No composer, no embedding / cosine / similarity logic.

**What the EP-TRAIN-6D-4B..4P series SHIPPED:**

The validator + persistence + manager-review + approval + evidence-
reader + reviewer-UX layers are production-quality, tested end-to-end
on staging (EP-TRAIN-6D-4R v1096 / sha-e49122690011). These are the
DOWNSTREAM half of the pipeline.

**What is MISSING:**

The UPSTREAM half: a real transcription pipeline, a real question
generator, automatic checkpoint placement, dedup, and a promotion
path that turns `APPROVED_DRAFT` into a publishable
`TrainingQuestion`.

**The AI-review tables and the course-authoring tables are parallel
universes today.** This is the single most load-bearing finding.

## 2. Recommended smallest implementation sequence

The directive asks for "the smallest sequence of implementation
slices necessary to complete the workflow" with a founder-operated
staging acceptance journey using the existing Staff Orientation
video.

### Recommended 5-slice sequence

Each slice is small enough to review + accept independently.

#### Slice 4T — AI draft → publishable question PROMOTION path (highest leverage)

**Why first:** closes the parallel-universe gap. Does not require
any inference provider. Lets the founder use TODAY's 4R staging
baseline to demonstrate the entire workflow by hand-seeding a draft
+ clicking Approve + then seeing it appear as a publishable
question.

**Scope:**
- Add `TrainingQuestion.sourceAiDraftId: String?` column (nullable
  FK). Additive migration.
- New service `promoteApprovedDraftToQuestion(principal, draftId,
  checkpointId | null)` that:
  - Refuses unless draft state is `APPROVED_DRAFT` + the target
    version is `DRAFT`.
  - Copies question + options from the draft's canonical body.
  - Links back via `sourceAiDraftId`.
  - Writes an audit row.
- New admin button in the persisted review workspace: "Add to
  draft version" (visible only when the draft is approved AND a
  draft version exists on the same course).
- Vitest + jsdom contract tests + PG16 integration test.
- No new RBAC permission (uses existing `hr:training:write`).

**Proves on staging:** approved draft → appears in course authoring
UI → `publishDraft` works. End-to-end from approval to publication.

#### Slice 4U — Narrow `TRAINING_AI_REVIEWER` role

**Why early:** removes the need for the Coulee-Ridge-scoped
SUPER_ADMIN fallback in every future acceptance window.

**Scope:**
- Add `TRAINING_AI_REVIEWER` to `src/lib/permissions.ts` catalogue,
  carrying exactly: `hr:training:read + hr:training:ai:read +
  hr:training:ai:approve`.
- `scripts/sync-rbac.ts` picks it up automatically on release_command.
- No grant to existing users.
- Documentation update in the RBAC inventory.

**Proves on staging:** a reviewer identity can approve without
holding a SUPER_ADMIN role on any tenant.

#### Slice 4V — Transcription provider + worker (first content-aware build)

**Why third:** without transcription, there is no grounding
projection, which means nothing to feed a generator. Must land
before any generator.

**Scope options** (founder picks ONE):

1. **Modal-hosted faster-whisper** — fastest to productionize, but
   requires signing up for Modal + provisioning GPU.
2. **OpenAI Whisper API** — simplest + dirt cheap, but sends audio
   out of the Spectre tenant to OpenAI.
3. **Local Python worker on the Fly worker machine** — no third-
   party, but adds a Python runtime + ffmpeg to the Docker image.

**Scope (shared):**
- New worker job handler `TRAINING_TRANSCRIBE` registered in
  `src/lib/queue/handlers`.
- New admin button on a DRAFT version: "Transcribe this video".
  Enqueues the job.
- Job handler:
  - Downloads the MP4 from R2 using the existing authenticated
    pipeline.
  - Runs the chosen transcriber.
  - Calls `persistTranscriptBuild` + `persistTranscriptSegments`
    with `hr:training:transcription:write` held by a worker-system
    role (new worker-internal role, never assigned to humans).
  - Preserves `sourceOrgMismatch: ["Silver Springs"]` flags where
    the transcript mentions Silver Springs by name, per 4S gap
    analysis §7.
- Vitest contract + PG16 integration test + Playwright acceptance.

**Proves on staging:** the founder uploads the Staff Orientation
video + clicks "Transcribe" + sees `TrainingTranscriptBuild` +
3-N segments created with real text + timestamps.

#### Slice 4W — Grounding projection + manual-position question generator

**Why fourth:** generation CAN happen without checkpoint-position
intelligence — just prompt the LLM for N questions per transcript.
Automatic placement is a separate slice.

**Scope:**
- New worker job `TRAINING_GENERATE_QUESTIONS` that:
  - Reads a `TrainingTranscriptBuild` + segments.
  - Builds a canonical grounding projection (one passage per
    segment, or coalesced).
  - Prompts a chosen LLM (Anthropic via `@anthropic-ai/sdk` already
    wired, OR Qwen via Modal) for N candidate questions grounded in
    those passages.
  - Each candidate flows through
    `src/lib/training/ai-generation/pipeline.ts`'s validator.
  - Persists only those that pass to `TrainingQuestionAiDraft` for
    manager review.
- Manager admin UI: "Generate N questions for this course version".
- Exact-match dedup on `(clubId, courseVersionId, contentHash)` is
  already enforced by the 4K `@@unique` constraint — a prompted
  paraphrase that produces the same canonical body collapses. No
  new code needed for this layer.
- Vitest + PG16 integration + Playwright acceptance that drives the
  full "upload → transcribe → generate → approve → promote" chain.

**Proves on staging:** the founder clicks "Generate" + sees drafts
appear in the review queue + approves some + promotes them via 4T
into the draft version.

#### Slice 4X — Automatic checkpoint placement + semantic dedup

**Why fifth:** highest complexity + highest optionality.

**Scope:**
- New service `chooseCheckpointPositions(buildId, { min=60s, max=5 })`
  returns a list of `{ atSec, rationale }` using one of:
  - LLM-prompted "where would you check understanding" with
    transcript + segment-timing feedback.
  - Topic-change detection (TF-IDF window, or BERTopic / embeddings).
- Semantic dedup via embeddings against:
  - Prior checkpoint questions in the same version.
  - Final-assessment composer when building the final list.
- Both operate on the `TrainingQuestionAiDraft` buffer BEFORE
  reviewer approval. The 4K + 4N invariants remain untouched.

**Proves on staging:** generating questions for a video chooses 3-5
sensible checkpoint positions + the final assessment excludes
semantic duplicates of checkpoint questions.

### Staging acceptance journey the founder could run after 4T + 4V + 4W (earliest viable journey)

```
1. Founder (as SUPER_ADMIN or TRAINING_AI_REVIEWER if 4U is in)
   navigates to the Coulee Ridge Staff Orientation DRAFT version.
2. Clicks "Transcribe this video" (new 4V button).
   → worker enqueues + runs → TrainingTranscriptBuild + Segments appear.
3. Clicks "Generate questions" (new 4W button).
   → worker enqueues + runs → ~5-10 TrainingQuestionAiDrafts land
     in state REQUIRES_HUMAN_REVIEW.
4. Reviews each in the persisted review workspace.
   → 4D read service + 4M evidence reader + 4N approval already work.
5. For each approved draft, clicks "Add to draft version" (new 4T).
   → TrainingQuestion row appears in the authoring UI.
6. Manually places checkpoints (until 4X lands) + binds the
   approved questions to them.
7. Clicks Publish.
   → checkPublishReadiness + publishDraft + assignment flows all
     already work.
```

**This is the smallest functional end-to-end a founder can
experience.**

## 3. Non-recommended alternatives (why they're worse)

- **"Just build it all in one slice"** — fails the Spectre slice-
  size principle. A single PR containing transcription + generation +
  promotion + dedup + checkpoint placement + UX would be unreviewable.
- **"Start with semantic dedup"** — lowest leverage until a generator
  exists. There's nothing to dedupe against today.
- **"Start with automatic checkpoint placement"** — same as above;
  depends on transcription + generation existing first.
- **"Skip the promotion path and have managers re-type"** — defeats
  the point of the AI-review pipeline. The parallel-universe gap
  must close.

## 4. Operational guardrails that must land alongside Tier-1

Regardless of which Tier-1 slice runs first, the following must be
part of the first inference-touching slice:

1. **Rate limiting + cost guardrails.** A `TRAINING_GENERATE_REQUEST`
   rate limiter per club + per day. A per-call token-budget cap.
2. **Fail-safely on poor input.** A transcript with <100 words
   worth of segments must refuse to generate. The 4K schema already
   expresses the 16/17 EXCLUDED_SEGMENT_INDICES policy; this slice
   extends to a minimum-material-content threshold.
3. **Never publish without human approval.** The publish gate must
   be extended to refuse publishing a `TrainingQuestion` whose
   `sourceAiDraftId` points at a draft that is NOT in state
   `APPROVED_DRAFT`.
4. **Audit every inference call.** `audit()` row with model id,
   token counts, provider name — NOT the prompt body (that's
   sensitive club data).
5. **Preserve the 8 historical candidates.** Every slice runs the
   same "couleeDrafts = 8" invariant check at Phase A + Phase F.

## 5. Deliverable summary

Three documents produced in this audit:

- [PHASE-D-4S-WORKFLOW-AUDIT.md](PHASE-D-4S-WORKFLOW-AUDIT.md) —
  18-capability matrix + end-to-end workflow diagram + validation
  surface audit + test-coverage matrix + permission boundaries.
- [PHASE-D-4S-GAP-ANALYSIS.md](PHASE-D-4S-GAP-ANALYSIS.md) — gap
  taxonomy tiers + dependency graph + risk notes on each Tier-1 gap
  + Silver Springs preservation requirement + non-regression
  invariants.
- This file — recommended smallest implementation sequence
  (Slices 4T → 4U → 4V → 4W → 4X) + rejected alternatives +
  operational guardrails.

## 6. Awaiting founder direction

The founder should pick one of these paths:

- **(A)** Approve the 5-slice sequence as-written (4T → 4U → 4V →
  4W → 4X) and authorise beginning with 4T. Nothing lands on
  staging without per-slice sign-off.
- **(B)** Re-prioritise: for example, "do 4V (transcription) first
  so I can see transcript data on staging before I commit to a
  generator." This is reasonable; the audit does not depend on 4T
  being first.
- **(C)** Reject the sequence and specify a different functional
  goal. The audit's capability matrix is objective; any new
  sequence must still close Tier-1 gaps.

4S is purely diagnostic. It ships zero production code, zero
migrations, zero deploys, zero role grants, zero inference calls.

## 7. STOP compliance

All directive STOP boundaries honoured:

| Boundary                                 | Status   |
| ---------------------------------------- | -------- |
| No deployment or code implementation     | HONOURED |
| No Modal/Qwen inference                  | HONOURED |
| No worker activation                     | HONOURED |
| No course publication                    | HONOURED |
| No employee assignments                  | HONOURED |
| No permission changes                    | HONOURED |
| No historical candidate modification     | HONOURED — 8 drafts verified byte-identical after 4R |
| 126 unrelated WIP files preserved        | HONOURED — stashed at entry |

Await founder authorisation before any 4T/4U/4V/4W/4X slice begins.
