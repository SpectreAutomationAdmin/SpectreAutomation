# EP-TRAIN-6D-4S — Workflow Gap Analysis

Status: Read-only. See [PHASE-D-4S-WORKFLOW-AUDIT.md](PHASE-D-4S-WORKFLOW-AUDIT.md)
for the primary findings. This file isolates every gap the founder's
desired workflow depends on, with sharpness about blast-radius +
pre-requisites.

## 1. Gap taxonomy

### Tier 1 — Blocks any AI-assisted course today

| ID   | Gap                                                                                       | Blast radius                          |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------- |
| G1.1 | No transcription provider integration (no Modal / faster-whisper / OpenAI Whisper caller) | Entire AI-assisted workflow           |
| G1.2 | No transcription worker job registered in `bin/worker.ts`                                 | Entire AI-assisted workflow           |
| G1.3 | `hr:training:transcription:write` held by no role                                        | 4L services unreachable from HTTP     |
| G1.4 | No AI question generator (Qwen / Anthropic / etc. caller for `TrainingQuestionDraftLiteV1`) | All AI-drafted questions              |
| G1.5 | No AI-draft → `TrainingQuestion` promotion path                                           | Even an APPROVED_DRAFT cannot be published |
| G1.6 | No HTTP endpoint to kick the pipeline off                                                 | Manager has nowhere to click "generate" |

### Tier 2 — Blocks the directive's specific functional requirements

| ID   | Gap                                                                                       | Blast radius                          |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------- |
| G2.1 | No automatic checkpoint-position chooser (content-aware topic analysis)                   | Q1 answer remains "no" permanently    |
| G2.2 | No link between a generated draft and the checkpoint `atSec` it was generated for         | Even hand-placed checkpoints can't be paired with AI drafts |
| G2.3 | No semantic deduplication (embeddings / cosine / minhash) for final-assessment composition | Q2 answer remains "no" permanently  |
| G2.4 | No exact-match dedup on `TrainingQuestion.prompt` within a version                        | Trivial copy-paste duplicates can still ship |

### Tier 3 — Operational robustness

| ID   | Gap                                                                                       | Blast radius                          |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------- |
| G3.1 | No narrow `TRAINING_AI_REVIEWER` role (4R used a Coulee-Ridge-scoped SUPER_ADMIN fallback) | Every acceptance window needs the fallback + mitigations |
| G3.2 | Historical 6D-4H candidates are permanently unapprovable (groundingProjectionId NULL)      | Requires a separate backfill slice (4O-style) |
| G3.3 | No "generate transcript for this course version" admin UI                                 | Managers have no entry point                             |
| G3.4 | No manager UX to re-run generation / regenerate / request-more-questions                  | Manager review surface is receive-only                    |
| G3.5 | No cost / rate-limit guardrails on any future inference call                              | Risk of runaway spend                                     |

### Tier 4 — Testing / observability

| ID   | Gap                                                                                       | Blast radius                          |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------- |
| G4.1 | Staging has no persistent synthetic fixture (4R teardown removed it)                      | Future acceptance windows must re-seed |
| G4.2 | No automated regression that fails if the 8 historical candidates are ever touched         | Silent historical drift risk          |
| G4.3 | Playwright baseline coverage is at 1440 + 390 only                                        | Larger / smaller viewports uncovered   |

## 2. Dependencies (topological order)

A viable end-to-end AI-assisted workflow requires these in order:

```
[G1.1] Transcription provider wiring
    ↓
[G1.2] Transcription worker job
    ↓
[G1.3] Grant hr:training:transcription:write to a worker-system role
    ↓
[G2.1] Automatic checkpoint placement (content-aware topic analysis)
    ↓
[G1.4] AI question generation (prompted at each placement + for final assessment)
    ↓
[G2.3/G2.4] Dedup before persistence
    ↓
[G1.5] APPROVED_DRAFT → TrainingQuestion promotion
    ↓
[G1.6] Admin UI entry: "Generate questions for this video"
```

Operational robustness (G3.1-G3.5) is parallel-trackable. Testing
(G4.*) backfills wherever appropriate.

## 3. What CAN be proven today without closing any Tier-1 gap

Everything downstream of an AI-approved draft:

- 4N approval transaction ✅ (proven on staging, EP-TRAIN-6D-4R).
- 4M evidence reader ✅ (proven).
- 4P dialog + eligibility matrix ✅ (proven).
- Checkpoint retry + required-to-proceed gate ✅ (existing).
- Final-assessment unlock + passing-score enforcement ✅ (existing).
- Course publication + assignment + obligations ✅ (existing).

What CAN'T be proven today because the pipeline is a dashed line:

- An approved AI draft becoming a live, employee-facing training
  question.
- A manager clicking "Generate from video" and seeing AI-produced
  candidates appear in the queue.
- A "final assessment is distinct from preceding checkpoints" claim
  because there is no composer.

## 4. Specific risk: AI-review → publication silent-disconnect

The 4R staging acceptance proved the 4N approval TRANSACTION, but
the approved draft never flows to a publishable question. This is
easy to misread as "the AI pipeline works end-to-end" because the
server-side state transition fires cleanly. **The audit's bluntest
finding is that the approval workflow and the authoring/publication
workflow are parallel universes with no bridge.** The gap is exactly
one promotion function: given an `APPROVED_DRAFT`, copy its content
into a new `TrainingQuestion` row linked to the target
`TrainingCourseVersion`, with `checkpointId` set if the placement
was `CHECKPOINT` or null for `FINAL_ASSESSMENT`.

## 5. Specific risk: semantic dedup is a non-trivial build

"Semantic deduplication" does NOT exist as a half-built thing. Any
implementation requires at least:

- An embedding provider (the project already has `@anthropic-ai/sdk`
  optional; Anthropic's embeddings surface is not production-grade —
  OpenAI / Cohere / BGE via Modal is the realistic candidate).
- A storage dimension for the vectors (pgvector or a sidecar
  per-draft `embeddingJson`).
- A threshold policy for "semantically equivalent" that doesn't
  false-positive on material variance.
- A corpus scope: "all preceding checkpoints in this version" is
  easy; "all questions ever asked in this club" or "across all
  versions of this course" are decisions the founder must make.

The directive's framing — "different questions MAY assess the same
learning objective if they test materially different knowledge or
application" — explicitly requires a classifier, not a dumb edit-
distance check.

## 6. Specific risk: content-aware checkpoint placement

Choosing `atSec` positions that line up with topical shifts in a
video requires:

- Transcript segmentation at semantic boundaries (not Whisper's
  default fixed-window segments, which are speech-rate driven).
- A "topic break detection" layer (BERTopic, a simpler
  TF-IDF-against-sliding-window, or an LLM-prompted boundary
  classifier).
- A minimum-spacing policy (the schema already enforces 1 s, but
  the chooser likely wants 60-180 s minimum intervals so the player
  isn't a death-by-pop-quiz).
- A maximum count per video (so a 60-minute video doesn't produce
  30 checkpoints).

Off-the-shelf fastest option: prompt an LLM with the transcript +
ask it for 3-5 time ranges where a learner should check their
understanding. That's the simplest Tier-1 build but still a build.

## 7. Specific risk: Silver Springs source organization

The directive calls out: "Preserve the video's actual Silver Springs
source organization even though it resides in the Coulee Ridge
development tenant." The staging data model already surfaces this:
the 4M evidence reader detects `SOURCE_ORG_MISMATCH` flags in the
grounding projection and the 4P workspace renders a "Source-
organisation mismatch" banner ([PersistedReviewWorkspace.tsx](src/components/ai-training/PersistedReviewWorkspace.tsx)).

Any Tier-1 implementation that re-processes the Staff Orientation
video must preserve the Silver Springs organisational references in
the segment bodies AND propagate `sourceOrgMismatch: ["Silver
Springs"]` on every passage into the `TrainingGroundingProjection`.
Otherwise the post-approval reviewer loses the organisational-
mismatch signal that currently fires on the 8 historical
candidates.

## 8. What the 4R staging acceptance DID vs DID NOT prove

Proven:

- A draft in `REQUIRES_HUMAN_REVIEW` with valid evidence can be
  approved by a human reviewer end-to-end on real staging.
- CLUB_ADMIN is locked out via a 404 same-shape.
- Historical candidates are refused (reason
  `HISTORICAL_EVIDENCE_UNAVAILABLE`).
- Approved draft's verified-answer snapshot is durable + reader-
  authenticated.

NOT proven (because the components don't exist yet):

- That an AI model can produce a draft that reaches
  `REQUIRES_HUMAN_REVIEW` from a real video + transcript.
- That AI-approved drafts turn into employee-facing training
  questions.
- That checkpoint positions are chosen intelligently.
- That the final assessment is distinct from the checkpoints.
- That the pipeline fails safely when transcription quality is
  poor (we have no transcription path to fail from).

## 9. Non-regression invariants

The following invariants MUST hold through any future slice sequence:

- The 8 historical EP-TRAIN-6D-4H candidates on Coulee Ridge remain
  byte-identical (`groundingProjectionId: null`,
  `modelSelectedAnswerSnapshotJson: null`, `state` unchanged).
- The 4N approval route continues to refuse requests that mismatch
  `expectedContentHash`, `expectedValidationId`, or
  `expectedRecordVersion`.
- CLUB_ADMIN never gains `hr:training:ai:approve` as part of a
  catalogue-level change.
- `hr:training:transcription:write` continues to NOT be held by any
  human-assigned role (worker-system identities only).
- The publish gate continues to validate option integrity + checkpoint
  spacing on every course version.
- Playwright coverage matrix (1440 + 390) is maintained or expanded.
