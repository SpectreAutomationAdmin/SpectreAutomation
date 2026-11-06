# EP-TRAIN-6D-4W — AI Question Generation + Assessment Composition — Design

Status: **IMPLEMENTATION COMPLETE — OFFLINE.** Founder authorized
Option C with 8 conditions on 2026-11-06. All 8 conditions
honored; see [PHASE-D-4W-ACCEPTANCE.md](PHASE-D-4W-ACCEPTANCE.md) §2
for the condition-by-condition mapping.

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4w/question-generation` (local commit; not pushed, not
deployed, not run live against Modal or any GPU).

## 1. Preflight findings

### 1.1 What the 4W directive references + what exists on the 4V baseline

| Referenced in §3 / §5 of directive                                      | Present on `3361ed1e` (4V baseline)? |
| ----------------------------------------------------------------------- | :----------------------------------: |
| Existing Qwen 2.5 / Modal generation prototype                          | ✗ (only fixtures reference the name) |
| LM Format Enforcer structured-output contract                           | ✗ (fixture metadata only)             |
| 4V transcription job lifecycle (sidecar)                                | ✓                                     |
| 4L grounding projection ingestion                                       | ✓                                     |
| 4K transcript schema                                                    | ✓                                     |
| AI validation pipeline (`src/lib/training/ai-generation/pipeline.ts`)   | ✓                                     |
| 4N approval governance                                                  | ✓                                     |
| 4T promotion destination contract                                       | ✓                                     |
| `TrainingQuestionAiGenerationRun` bookkeeping row (from 4B)             | ✓                                     |
| Durable lifecycle on the generation run (QUEUED/RUNNING/leases)         | ✗ — only REQUESTED/COMPLETED/FAILED/CANCELLED |
| Persisted assessment-plan storage                                        | ✗                                     |
| Shortfall / partial-generation reporting                                | ✗                                     |
| Exact-dedup registry (course-scoped)                                     | ✗ (content-hash unique exists per-draft but not per-run) |

### 1.2 Current `TrainingQuestionAiGenerationRun` shape (4B)

Already provides:

- Tenant + target: `clubId`, `courseId`, `courseVersionId`.
- Immutable binding: `pilotAuthorizationId`, `pilotAuthorizationFingerprint`, `sourceVideoSha256`, `resolvedTranscriptBuildId`, `groundingProjectionSha256`.
- Model provenance: `modelName`, `modelBackend`, `modelFormatEnforcer`, `modalAppIdentity`.
- Runtime: `requestedByUserId`, `requestedAt`, `completedAt`, `executionStatus`.
- Metering: `inferenceMs`, `promptTokenCount`, `outputTokenCount`, `gpuSeconds`.
- Back-relation: `drafts: TrainingQuestionAiDraft[]`.

Missing (required by 4W):

- Lifecycle intermediate states: `QUEUED`, `RUNNING`.
- `queuedAt`, `startedAt` timestamps.
- `leaseToken`, `leaseExpiresAt` for atomic worker claim (requirement §5 "no uncontrolled GPU concurrency").
- `attempts`, `maxAttempts` for bounded retry (§5).
- `assessmentPlanJson` to persist the shared plan (§4).
- `shortfallReasonJson` to persist "insufficient grounded material" reports (§7).
- Failure classification: the 4B row has `executionErrorCode` + `executionErrorMessage` which 4W can reuse unchanged.

### 1.3 Why a NEW table is the wrong shape here (and why we extend)

Three options evaluated:

- **Option A — brand-new sidecar `TrainingQuestionAiGenerationJob`** mirroring 4V's shape. REJECTED: the 4B GenerationRun ALREADY carries provider identity + metering + the `drafts` back-relation. A sidecar would duplicate those fields + create a two-row lookup to find a generation's plan + its drafts.
- **Option B — a separate `TrainingQuestionAiAssessmentPlan` sibling** keyed to the GenerationRun. REJECTED (for 4W's scope): the plan is 1:1 with a generation, created atomically with it, and is just structured JSON. A full table for one-JSON-per-row buys nothing vs an additive nullable column.
- **Option C — extend `TrainingQuestionAiGenerationRun` additively** (RECOMMENDED): add exactly the fields missing in §1.2 as nullable columns. Preserves every existing row verbatim (all 4B-era rows remain with the new columns NULL). Keeps lookup single-row. Mirrors how 4K extended `TrainingQuestionAiDraft` additively for the projection FK + verified-answer snapshot.

## 2. Minimum additive schema change (shipped offline)

As authorized, the Option C shape ships with one addition beyond the
original 6-column proposal: founder condition #5 ("concurrency
safety at the database boundary, not merely through application
checks") required a durable identity column + partial-unique index.
Added as `planIdentity` (SHA-256 of canonical plan JSON). Net:
**9 new fields + 1 partial-unique + 2 regular indexes.**

Added columns on `TrainingQuestionAiGenerationRun`:

```prisma
model TrainingQuestionAiGenerationRun {
  // … existing fields …

  // EP-TRAIN-6D-4W (2026-11-06) — lifecycle lease + plan storage.
  queuedAt                       DateTime?
  startedAt                      DateTime?

  // Bounded lease (mirror of 4V TrainingTranscriptionJob fields).
  // A worker claims the run by atomically writing (leaseToken,
  // leaseExpiresAt). The sweeper reclaims expired leases.
  leaseToken                     String?
  leaseExpiresAt                 DateTime?

  // Bounded retry budget. Service-layer enforced.
  attempts                       Int      @default(0)
  maxAttempts                    Int      @default(2)

  // Shared course-level assessment plan (§4). Canonical JSON built
  // at REQUESTED time + consumed by the worker. Schema version
  // "training-assessment-plan-v1". Nullable so 4B-era rows remain
  // valid.
  assessmentPlanJson             String?

  // Shortfall reporting (§7 — "If insufficient distinct grounded
  // material exists, generate fewer questions and report the
  // shortfall"). Canonical JSON of
  //   { targetCount, generatedCount, reason, segmentIdsConsidered }.
  shortfallReasonJson            String?

  // Plan identity (SHA-256 of canonical assessmentPlanJson). Backs
  // the partial-unique index that enforces "no duplicate active run
  // for the same (tenant, courseVersion, transcriptBuild, plan)" at
  // the DB boundary (founder condition #5).
  planIdentity                   String?
}
```

Also extend `executionStatus` value space from
`REQUESTED | COMPLETED | FAILED | CANCELLED` to include `QUEUED` +
`RUNNING`. No column-shape change (still `String`); the service-
layer whitelist tightens.

Index additions:

```prisma
  @@index([executionStatus, leaseExpiresAt])    // sweeper
  @@index([clubId, executionStatus])            // admin listing
  // Partial-unique prevents a second active (non-terminal) run for
  // the same plan while a run is REQUESTED/QUEUED/RUNNING. Pre-4W
  // rows have planIdentity NULL and are therefore excluded from the
  // uniqueness constraint.
  @@unique([clubId, courseVersionId, resolvedTranscriptBuildId, planIdentity, executionStatus])
```

In SQL (both SQLite + PG migrations):

```sql
CREATE UNIQUE INDEX "TrainingQuestionAiGenerationRun_planIdentity_active_unique"
  ON "TrainingQuestionAiGenerationRun"
  ("clubId", "courseVersionId", "resolvedTranscriptBuildId", "planIdentity", "executionStatus")
  WHERE "planIdentity" IS NOT NULL;
```

**Zero schema changes to any other entity.** `TrainingQuestionAiDraft`
rows persist unchanged via the existing `generationRunId` FK.

### 2.1 Migration safety

- SQLite migration: 6 `ALTER TABLE … ADD COLUMN` + 2 `CREATE INDEX`.
  All nullable or defaulted. Zero `DROP` / `TRUNCATE`.
- PG mirror: identical shape with `IF NOT EXISTS` guards on the
  indexes.
- Rollback: `ALTER TABLE … DROP COLUMN` × 6 + `DROP INDEX` × 2.
  Reversible; no existing data touched.
- Prisma migration will auto-apply via `prisma migrate deploy` in a
  future (separately-authorised) release.

## 3. Course-level assessment plan (§4)

`assessmentPlanJson` canonical shape:

```json
{
  "schemaVersion": "training-assessment-plan-v1",
  "courseVersionId": "<cuid>",
  "resolvedTranscriptBuildId": "<64-hex sha>",
  "learningObjectives": [
    { "id": "lo-1", "title": "...", "segmentIds": [0, 1, 4] }
  ],
  "topicBoundaries": [
    { "atSec": 30.5, "rationale": "topic transition — 'escalation policy' begins" }
  ],
  "eligibleSegmentIds": [0, 1, 2, 3, 4, 5, /* 16 + 17 EXCLUDED */ 18, 19],
  "proposedCheckpointGroups": [
    { "id": "cg-1", "atSec": 30, "learningObjectiveIds": ["lo-1"], "targetQuestionCount": 2 }
  ],
  "proposedFinalAssessment": {
    "targetQuestionCount": 5,
    "coverageLearningObjectiveIds": ["lo-1", "lo-2"]
  },
  "totalTargetQuestionCount": 7,
  "sourceEvidenceRequirements": {
    "mustCiteAtLeastOneSegmentPerQuestion": true,
    "excludedSegmentIndices": [16, 17]
  },
  "generatedAt": "<ISO>",
  "generatedByUserId": "<cuid|null>"
}
```

4W generates the plan deterministically from the transcript build
+ grounding projection + an operator-supplied intent (via the admin
route). The plan is MUTABLE after persistence (a future UI slice
lets the manager adjust counts / objectives before the worker
runs); 4W does NOT ship that UI — only the DTO.

Automatic topic-boundary detection stays rudimentary in 4W
(deterministic prompt-independent heuristics only). The sophisticated
placement + semantic dedup live in 4X.

## 4. Generation provider (§5)

A new `Modal /generate` client mirroring 4V's `Modal /transcribe`
shape:

```ts
POST <MODAL_GENERATE_URL>
Authorization: Bearer <MODAL_SPECTRE_SHARED_TOKEN>
Body: {
  requestId, modelVariant, promptSchemaVersion, systemPrompt,
  transcript, constraints: { proposalKind, maxQuestions,
  allowedQuestionTypes, jsonSchema }
}
Response: {
  schemaVersion: "training-proposals-v1",
  modelVariant: "qwen-2.5-7b-instruct-awq",
  proposals: [...],
  elapsedMs: { coldBoot, generate }
}
```

- Bearer auth via the same `MODAL_SPECTRE_SHARED_TOKEN` as 4V.
- HMAC-SHA-256 verification on the response.
- Bounded wall-clock via AbortController.
- Zero Modal call in offline scope — all tests mock `fetch`.

Secrets added to the environment surface:
- `MODAL_GENERATE_URL` (new, worker-side).
- Reuses `MODAL_SPECTRE_SHARED_TOKEN` (shared with 4V).

## 5. Worker handler flow (§5 + §6)

1. Claim the next QUEUED generation run via `claimNextGenerationRun`
   (same lease shape as 4V).
2. Load the assessment plan from the row.
3. For each `proposedCheckpointGroup` + the `proposedFinalAssessment`:
   - Build a prompt bounded to the eligible segments of that
     group/scope.
   - POST to Modal; verify HMAC; validate shape.
   - For each returned proposal:
     - Run the existing `pipeline.ts` validator with the
       grounding projection + authorization.
     - If `verdict !== REJECTED`, persist as a
       `TrainingQuestionAiDraft` (content hash enforces exact
       dedup within `(clubId, courseVersionId, contentHash)`).
     - If `verdict === REJECTED`, log + skip. Do NOT silently drop
       — a shortfall is recorded to `shortfallReasonJson`.
4. Write COMPLETED + metering fields on the run.

Cancellation safety: every mutation re-checks (state=RUNNING AND
leaseToken=expected). A cancelled run refuses COMPLETED writes.

## 6. Coordinated allocation + dedup (§7)

- Plan-time: the assessment plan pre-allocates question counts per
  checkpoint group + final assessment. No single question ever
  carries BOTH a `CHECKPOINT` and `FINAL_ASSESSMENT` placement.
- Draft-time: the existing
  `@@unique([clubId, courseVersionId, contentHash])` on
  `TrainingQuestionAiDraft` enforces exact-content dedup — if the
  model emits the identical question text / options / explanation /
  segment-ids combo for two different scope groups, only one draft
  row persists.
- Extension point for 4X semantic dedup: the generation run's
  `shortfallReasonJson` already carries `segmentIdsConsidered`; 4X
  will add a sibling `TrainingQuestionAiSemanticNeighbour` table or
  embedding columns on the draft. 4W does NOT ship any embedding
  code.

## 7. Transcript quality (§8)

- The grounding projection the worker uses is the one 4V's worker
  wrote. Projection sha is recomputed against the draft at approval
  time (4N), so a tampered projection is rejected downstream.
- Segment 16 + 17 remain in `EXCLUDED_SEGMENT_INDICES` at the 4L
  layer. 4W's assessment-plan builder reads this constant and
  excludes those indices from `eligibleSegmentIds` by construction.
- A run whose transcript build is missing / mismatched / empty is
  refused at REQUESTED time with a new `generation-rejection` code
  surfaced in `executionErrorCode`.

## 8. Human review integration (§9)

- Every generated draft lands in state `REQUIRES_HUMAN_REVIEW` (via
  the existing 4B lifecycle) or `VALIDATION_PENDING` depending on
  the validator verdict.
- Zero auto-approval. Zero auto-promotion. The 4N approval route +
  4T promotion bridge remain the ONLY paths to publishable
  questions.
- The eight historical EP-TRAIN-6D-4H candidates are NOT referenced
  by 4W; they have no `generationRun` and would not be selected by
  any 4W-authored query.

## 9. Service shape (post-authorization)

Files to be added once Option C is approved:

- `src/lib/hr/training/generation/assessment-plan.ts` — pure plan
  builder.
- `src/lib/hr/training/generation/generation-service.ts` — lifecycle
  service (request / markQueued / claim / complete / fail / cancel /
  sweep). Mirrors `transcription/job-service.ts` structure.
- `src/lib/hr/training/generation/modal-client.ts` — Modal
  `/generate` HTTPS client with bearer + HMAC + bounded timeout.
- `src/lib/hr/training/generation/worker-handler.ts` — claim →
  Modal → validator → 4L draft persist → terminal.
- Queue kind `TRAINING_GENERATE_QUESTIONS` registered in
  `src/lib/queue/index.ts` + dispatcher shim in
  `src/lib/queue/handlers.ts`.
- Admin API route `POST /api/admin/training/versions/[id]/generate`
  gated on existing `hr:training:write`.

Tests (post-authorization):
- `tests/ep-train-6d4w-plan-contract.test.ts` — assessment-plan
  builder scenarios (deterministic; no DB).
- `tests/ep-train-6d4w-generation-service.test.ts` — lifecycle.
- `tests/ep-train-6d4w-modal-client.test.ts` — bearer / HMAC /
  timeout / shape.
- `tests/ep-train-6d4w-worker-handler.test.ts` — mocked Modal +
  validator + 4L round-trip.
- `scratchpad/ep-train-6d4w/integration-test.ts` — PG16 harness
  (concurrent claims, cancellation race, cost cap, shortfall
  reporting).

## 10. STOP compliance (directive §12) — honoured

| Boundary                                 | Status   |
| ---------------------------------------- | -------- |
| No staging or production deployment      | HONOURED |
| No shared database migration             | HONOURED — migration not yet authored |
| No Modal/Qwen inference or GPU activation | HONOURED |
| No automatic checkpoint placement        | HONOURED — that's 4X                   |
| No question approval or promotion        | HONOURED                               |
| No publication                           | HONOURED                               |
| No employee assignments                  | HONOURED                               |
| No historical candidate modification     | HONOURED                               |
| No permanent role grants                 | HONOURED                               |
| No unrelated UI changes                  | HONOURED                               |
| 126 unrelated WIP files preserved        | HONOURED — stashed at entry             |
| STOP for schema-change authorization     | **TRIGGERED — correct STOP cause**       |

## 11. Request for founder authorization

**(A)** Approve Option C (recommended) — extend
`TrainingQuestionAiGenerationRun` with the 6 new nullable columns
+ 2 indexes. 4W implementation + tests then land in the next sub-
slice on this same branch.

**(A')** Approve a modified schema (new sibling table instead, or
plan stored in a separate table).

**(B)** Pause 4W entirely and prioritise 4V-STAGE / 4T-UI / 4X.

**(C)** Request additional preflight work (e.g. spike a Qwen
deployment locally outside 4W scope).

Until the founder picks A / A' / B / C, 4W remains in this
preflight state. No migration, service, worker handler, API route,
or test lands.
