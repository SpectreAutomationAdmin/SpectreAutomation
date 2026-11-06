# EP-TRAIN-6D-4W — AI Question Generation + Assessment Composition — Acceptance

Status: **PAUSED AT §3 SCHEMA AUTHORIZATION GATE.** Per directive
§3: "If durable generation jobs, assessment plans or destination
metadata require schema changes, document the smallest additive
design and STOP for founder authorization before implementation. Do
not silently introduce new tables or columns."

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4w/question-generation` (design doc only; not pushed).

## 1. One-line summary

4W needs to orchestrate Qwen 2.5 7B Instruct AWQ on Modal into
grounded question candidates persisted as AI drafts, driven from a
shared course-level assessment plan. The existing
`TrainingQuestionAiGenerationRun` (from 4B) provides the
provider-identity + metering foundation but lacks lifecycle leases
+ assessment-plan storage + shortfall reporting. A minimal additive
column-level extension is required. **No code written. No migration
authored. No tests run. No Qwen / Modal call.**

## 2. Preflight findings (summary)

| Reference                                                   | Present on 4V baseline (`3361ed1e`)? |
| ----------------------------------------------------------- | :----------------------------------: |
| `TrainingQuestionAiGenerationRun` (4B)                      | ✓                                    |
| Validator pipeline (`src/lib/training/ai-generation`)        | ✓                                    |
| 4K transcript persistence                                   | ✓                                    |
| 4L grounding projection ingest services                     | ✓                                    |
| 4V transcription job lifecycle sidecar (pattern to mirror)  | ✓                                    |
| 4N approval governance                                      | ✓                                    |
| 4T promotion destination contract                           | ✓                                    |
| Qwen 2.5 / Modal generation prototype                       | ✗ (fixture-only metadata)             |
| LM Format Enforcer wiring                                   | ✗ (fixture-only metadata)             |
| Lifecycle intermediate states (QUEUED, RUNNING) on GenerationRun | ✗                                |
| Lease columns on GenerationRun                              | ✗                                    |
| Assessment-plan storage                                     | ✗                                    |
| Shortfall / partial-generation reporting                     | ✗                                    |

## 3. Recommended minimum additive design (Option C)

Extend `TrainingQuestionAiGenerationRun` with 6 nullable columns +
2 indexes:

- `queuedAt`, `startedAt` — DateTime nullable.
- `leaseToken` String, `leaseExpiresAt` DateTime — bounded lease
  (mirror of 4V shape).
- `attempts` Int @default(0), `maxAttempts` Int @default(2) —
  bounded retry budget.
- `assessmentPlanJson` String nullable — canonical JSON of the
  course-level plan (schema version
  `training-assessment-plan-v1`).
- `shortfallReasonJson` String nullable — canonical JSON of
  partial-generation reports.

`executionStatus` value space tightens to
`REQUESTED | QUEUED | RUNNING | COMPLETED | FAILED | CANCELLED`
(service-layer only; column shape unchanged).

Two new indexes: `(executionStatus, leaseExpiresAt)` for the sweeper,
`(clubId, executionStatus)` for admin listings.

Zero changes to any other entity. Full detail in
[PHASE-D-4W-GENERATION-DESIGN.md](PHASE-D-4W-GENERATION-DESIGN.md)
§§ 1–2.

## 4. Why not a brand-new table (two rejected alternatives)

- **Option A — new sidecar `TrainingQuestionAiGenerationJob`**
  mirroring 4V. Rejected because 4B's GenerationRun already carries
  the provider identity + metering + the `drafts` back-relation; a
  sidecar duplicates those and forces a two-row lookup to find a
  generation's plan + its drafts.
- **Option B — new sibling table `TrainingQuestionAiAssessmentPlan`**
  keyed to GenerationRun. Rejected (for 4W's scope): the plan is
  1:1 with a generation, created atomically with it, and is just
  structured JSON. A dedicated table for one-JSON-per-row buys
  nothing vs an additive nullable column.

## 5. What this slice would do AFTER authorization

1. Author migration `20261106_ep_train_6d_4w_generation_lifecycle/migration.sql`
   (SQLite) + PG mirror. Additive-only.
2. Update `TrainingQuestionAiGenerationRun` in both Prisma schemas.
3. Implement:
   - `src/lib/hr/training/generation/assessment-plan.ts` — pure
     plan builder.
   - `src/lib/hr/training/generation/generation-service.ts` —
     lifecycle service (request / markQueued / claim / complete /
     fail / cancel / sweep), cost-governance helpers.
   - `src/lib/hr/training/generation/modal-client.ts` — Modal
     `/generate` HTTPS client with bearer + HMAC + bounded timeout.
     Reuses `MODAL_SPECTRE_SHARED_TOKEN`; adds `MODAL_GENERATE_URL`.
   - `src/lib/hr/training/generation/worker-handler.ts` — claim →
     Modal → `pipeline.ts` validator → 4L draft persist → terminal.
4. Register queue kind `TRAINING_GENERATE_QUESTIONS` + dispatcher.
5. Admin API route `POST /api/admin/training/versions/[id]/generate`
   gated on existing `hr:training:write`.
6. Tests: directive §10's scenarios split across vitest contract
   (SQLite) + jsdom (if any UI leaked) + disposable-PG16
   integration.
7. Full 4B-4W regression + typecheck + nav audit + placeholder
   scan.
8. Commit on this branch. NO push. NO staging deploy.

## 6. What this slice CANNOT ship until authorization

- The migration file itself.
- Service + worker + Modal client (they key off the new columns).
- Admin API route (depends on the lifecycle service).
- Tests (depend on the service).

## 7. Awaiting founder response

The founder must EITHER:

- **(A)** Approve Option C (recommended): extend
  `TrainingQuestionAiGenerationRun` with 6 nullable columns + 2
  indexes. Reply "proceed with Option C" or equivalent.
- **(A')** Approve a different additive design (new sidecar table
  or alternative shape). Describe in reply.
- **(B)** Pause 4W and prioritise a different slice (4V-STAGE for
  real staging transcription activation, 4T-UI for the promotion
  admin button, OR 4X for automatic checkpoint placement).
- **(C)** Request additional preflight work (e.g. local Qwen spike
  outside 4W scope).

Until the founder picks A / A' / B / C, 4W remains in this
preflight state. No migration, service, worker handler, API route,
or test will land.

## 8. Directive §11 deliverables — status

| Deliverable                                | Status                                            |
| ------------------------------------------ | ------------------------------------------------- |
| `PHASE-D-4W-GENERATION-DESIGN.md`           | ✅ this commit                                     |
| `PHASE-D-4W-ACCEPTANCE.md`                  | ✅ this commit                                     |
| Implementation commit                       | ⏸ PAUSED pending schema authorisation              |
| Mock-provider contract tests                | ⏸ PAUSED (service does not exist yet)              |
| Disposable PostgreSQL integration evidence  | ⏸ PAUSED                                           |
| Assessment-plan schema + DTO documentation  | ✅ documented in design doc §3                      |
| Explicit 4X dependencies                    | ✅ documented in design doc §6                      |

## 9. STOP compliance (directive §12) — every boundary honoured

| Boundary                                 | Status                             |
| ---------------------------------------- | ---------------------------------- |
| No staging or production deployment      | HONOURED                           |
| No shared database migration             | HONOURED                           |
| No Modal/Qwen inference or GPU activation | HONOURED                           |
| No automatic checkpoint placement        | HONOURED — that's 4X                |
| No question approval or promotion        | HONOURED                            |
| No publication                           | HONOURED                            |
| No employee assignments                  | HONOURED                            |
| No historical candidate modification     | HONOURED                            |
| No permanent role grants                 | HONOURED                            |
| No unrelated UI changes                  | HONOURED                            |
| 126 unrelated WIP files preserved        | HONOURED — stashed at entry         |
| STOP for schema-change authorization     | **TRIGGERED — correct STOP cause**  |
