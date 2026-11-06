# EP-TRAIN-6D-4W — AI Question Generation + Assessment Composition — Acceptance

Status: **READY FOR FOUNDER REVIEW. OFFLINE IMPLEMENTATION COMPLETE.**
Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4w/question-generation` (local commit; not pushed, not deployed).

## 1. One-line summary

4W orchestrates Qwen 2.5 7B Instruct AWQ on Modal into grounded
question candidates persisted as AI drafts, driven from a shared,
versioned, immutable-after-start course-level assessment plan. Every
candidate flows through the existing 4N approval workflow as an
unapproved draft. No automatic approval. No automatic promotion. No
automatic publication. No Modal / Qwen / GPU call during offline
implementation or testing. Zero changes outside the generation
service. **Not deployed; not pushed.**

## 2. Founder authorization — Option C

Founder authorized Option C with 8 conditions on 2026-11-06. Every
condition is honored in this slice:

| # | Condition                                                                              | Where enforced                                                                                                  |
| - | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1 | Preserve existing 4B rows                                                              | Additive migration only; `planIdentity` partial-unique index predicated `WHERE planIdentity IS NOT NULL`.       |
| 2 | Durable lifecycle with atomic claim + bounded leases + lease renewal + stale recovery  | `claimNextGenerationRun` (updateMany-guard), `renewGenerationLease`, `sweepStaleGenerationLeases`, 2 attempts.  |
| 3 | Status model distinguishes QUEUED / RUNNING / COMPLETED / FAILED / CANCELLED           | `GenerationState` type in `generation-service.ts`; `executionStatus` column already supports; services enforce. |
| 4 | `assessmentPlanJson` is versioned, validated, immutable after generation begins        | `ASSESSMENT_PLAN_SCHEMA_VERSION = "training-assessment-plan-v1"`, `validateAssessmentPlan`, plan frozen at REQUESTED. |
| 5 | DB-boundary concurrency safety for duplicate active runs                               | 7-column partial-unique index `(clubId, courseVersionId, resolvedTranscriptBuildId, planIdentity, executionStatus) WHERE planIdentity IS NOT NULL`. P2002 race arm returns the existing run. |
| 6 | Preserve $10 USD Modal Spend Limit                                                     | No billing change. `DEFAULT_DAILY_USD_MICROS = 10 × 1e6`, per-tenant 24h rollup rejects `COST_CAP_EXCEEDED` before Modal is called. |
| 7 | Drafts enter human review as unapproved; no auto-approval / promotion / publication    | `handleGenerateJob` writes drafts with `state = "REQUIRES_HUMAN_REVIEW"` directly into 4L/4N tables; no 4T sidecar touch. |
| 8 | Additive mirrored SQLite/PG migrations; disposable PG16 testing only                   | `prisma/migrations/20261106_ep_train_6d_4w_generation_lifecycle/` + PG mirror. PG16 harness ran against disposable Docker port 15439; container torn down. |

Additional preserved constraints:
- Staff Orientation pilot segment 16/17 exclusion: mirrored in
  `EXCLUDED_SEGMENT_INDICES = Object.freeze(new Set([16, 17]))` in
  `assessment-plan.ts`, cross-enforced by `validateAssessmentPlan` +
  worker-handler defense in depth (drops proposals citing excluded
  segments).
- 8 historical EP-TRAIN-6D-4H candidates byte-identical (no touch).
- 126 unrelated WIP files stashed at entry; restored at exit.

## 3. Deliverables (directive §11)

| Deliverable                                | Status                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `PHASE-D-4W-GENERATION-DESIGN.md`           | ✅ updated to implementation-complete                                               |
| `PHASE-D-4W-ACCEPTANCE.md`                  | ✅ this file                                                                        |
| Implementation commit                       | ✅ local on `ep-train-6d-4w/question-generation`                                    |
| Mock-provider contract tests                | ✅ 44/44 Vitest (12 plan + 20 service + 7 modal client + 5 worker handler)          |
| Disposable PostgreSQL integration evidence  | ✅ 6/6 scenarios PASS, container torn down                                          |
| Assessment-plan schema + DTO documentation  | ✅ `assessment-plan.ts` (`AssessmentPlanV1` interface + validator + hash)           |
| Explicit 4X dependencies                    | ✅ design doc §6 — baseline plan uses deterministic even-interval placement; 4X replaces that one function |

## 4. Files added

| Path                                                                              | Purpose                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `prisma/migrations/20261106_ep_train_6d_4w_generation_lifecycle/migration.sql`     | SQLite additive migration                               |
| `prisma-postgres/migrations/20261106_ep_train_6d_4w_generation_lifecycle/migration.sql` | PG mirror (`IF NOT EXISTS` guards)                 |
| `src/lib/hr/training/generation/assessment-plan.ts`                                | Plan contract, validator, canonical hash, baseline builder |
| `src/lib/hr/training/generation/generation-service.ts`                             | Request → QUEUE → claim → complete/fail/cancel/sweep    |
| `src/lib/hr/training/generation/modal-client.ts`                                   | Modal `/generate` HTTPS client (bearer + HMAC + bounded timeout) |
| `src/lib/hr/training/generation/worker-handler.ts`                                 | Group loop → validator → draft persist → terminal      |
| `src/app/api/admin/training/versions/[id]/generate/route.ts`                       | Admin API — `hr:training:write` gated                   |
| `tests/ep-train-6d4w-assessment-plan.test.ts`                                      | 12 tests                                                |
| `tests/ep-train-6d4w-generation-service.test.ts`                                   | 20 tests                                                |
| `tests/ep-train-6d4w-modal-client.test.ts`                                         | 7 tests                                                 |
| `tests/ep-train-6d4w-worker-handler.test.ts`                                       | 5 tests                                                 |

## 5. Files modified

| Path                                | Change                                                              |
| ----------------------------------- | ------------------------------------------------------------------- |
| `prisma/schema.prisma`               | +9 fields + 2 indexes on `TrainingQuestionAiGenerationRun`          |
| `prisma-postgres/schema.prisma`      | Mirror of SQLite schema change                                      |
| `src/lib/queue/index.ts`             | `TRAINING_GENERATE_QUESTIONS` added to `JobKind` union              |
| `src/lib/queue/handlers.ts`          | Dispatcher dynamic-imports `handleGenerateJob`                      |

## 6. Test evidence

### 6.1 Vitest contract tests (SQLite) — 44/44 PASS

- `tests/ep-train-6d4w-assessment-plan.test.ts` — 12/12
- `tests/ep-train-6d4w-generation-service.test.ts` — 20/20
- `tests/ep-train-6d4w-modal-client.test.ts` — 7/7
- `tests/ep-train-6d4w-worker-handler.test.ts` — 5/5

### 6.2 Full 4B–4W regression — 292/292 PASS (269.55s)

21 test files across 4B through 4W. Zero regression on the 8
historical EP-TRAIN-6D-4H candidates. Zero regression on 4N approval
flow. Zero regression on 4T promotion bridge.

### 6.3 Disposable PG16 integration — 6/6 PASS

Container `spectre-pg-6d4w` on port 15439, image
`postgres:16-alpine`, torn down post-run.

| # | Scenario                                                                           | Result |
| - | ---------------------------------------------------------------------------------- | ------ |
| T1 | Happy path end-to-end on PG (mocked Modal + mocked segments) → COMPLETED + drafts | PASS   |
| T2 | Duplicate `planIdentity` returns the same run (DB-boundary idempotency)            | PASS   |
| T3 | Cross-tenant refused (VERSION_NOT_FOUND / 404)                                     | PASS   |
| T4 | Cancellation mid-flight: CANCELLED terminal, late `recordGenerationCompleted` refused | PASS   |
| T5 | Stale-lease sweep reclaims expired RUNNING → QUEUED                                | PASS   |
| T6 | Daily cost cap refusal (COST_CAP_EXCEEDED before Modal call)                       | PASS   |

Result JSON archived at
`scratchpad/ep-train-6d4w/integration-test-result.json` (local only;
not committed).

### 6.4 Typecheck + placeholder scan

- `npm run typecheck` — CLEAN against all 4W files
- `npm run scan:placeholders` — CLEAN

## 7. What this slice does NOT do (unchanged from directive)

- No live Modal / Qwen inference. `callModalGenerate` is fully
  implemented but is never called outside tests (all tests inject a
  mocked `fetchImpl`). `MODAL_GENERATE_URL` is not set in any
  deployed environment.
- No GPU activation. No billing change.
- No automatic approval, promotion, or publication of any generated
  question. Every draft lands in `REQUIRES_HUMAN_REVIEW`.
- No change to the 8 historical candidates.
- No change to any surface outside the generation service.
- No staging or production deployment. Local branch commit only.
- No role grants.

## 8. STOP compliance (directive §12) — every boundary honoured

| Boundary                                 | Status                                              |
| ---------------------------------------- | --------------------------------------------------- |
| No staging or production deployment      | HONOURED — local commit only                        |
| No shared database migration             | HONOURED — additive mirrored migration, not pushed  |
| No Modal/Qwen inference or GPU activation | HONOURED — mocked `fetchImpl` in every test        |
| No automatic checkpoint placement        | HONOURED — baseline plan is deterministic; 4X replaces it |
| No question approval or promotion        | HONOURED — drafts land REQUIRES_HUMAN_REVIEW        |
| No publication                           | HONOURED                                            |
| No employee assignments                  | HONOURED                                            |
| No historical candidate modification     | HONOURED — 8 rows untouched                         |
| No permanent role grants                 | HONOURED                                            |
| No unrelated UI changes                  | HONOURED                                            |
| 126 unrelated WIP files preserved        | HONOURED — stashed at entry, to be restored at exit |
| STOP for schema-change authorization     | CLEARED — founder authorized Option C on 2026-11-06 |

## 9. Awaiting founder action

- **(A)** Review this acceptance + the implementation-complete design
  doc. Approve to proceed to the next slice (4W-UI to expose the
  generate button in admin, or 4X automatic checkpoint placement).
- **(B)** Request additional offline work before authorizing any
  staging activation (live Modal credentials, live Qwen deployment,
  live transcription pipeline wiring).
- **(C)** Flag a defect — the slice does not deploy or run live
  against Modal, so the only verifiable surface right now is the
  code + the test suite + the PG16 harness; a founder-triggered live
  activation would be a separate authorized slice.
