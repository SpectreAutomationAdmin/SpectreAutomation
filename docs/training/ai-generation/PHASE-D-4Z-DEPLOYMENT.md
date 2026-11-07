# EP-TRAIN-6D-4Z — Deployment Evidence

**Status:** Controlled staging release, no live AI inference.
Deployment via DRH-1. Rollback anchor preserved.

## 1. Baseline

| Field                                   | Value                                                       |
|-----------------------------------------|-------------------------------------------------------------|
| Parent commit                           | `52cbc2bb` (accepted 4Y)                                   |
| 4Z branch                               | `ep-train-6d-4z/staging-acceptance`                        |
| 4Z commit (points at parent)            | `52cbc2bb20301a99bddf3d1364cd2faeee7e35a2`                 |
| Pre-deploy Fly release                  | **v1096** (image `sha-e49122690011`, created 2026-11-06)    |
| Pre-deploy staging app                  | `spectre-staging`                                           |
| Worker app                              | `spectre-staging-worker`                                    |
| DRH-1 workflow run                      | `42328042198` (triggered via `gh workflow run`)             |
| Deploy ref                              | `ep-train-6d-4z/staging-acceptance` @ `52cbc2bb`            |
| Rollback anchor                         | Fly v1096, image `sha-e49122690011`                        |

## 2. Rollback plan

If the deploy fails health verification, roll back by setting the image
tag back to the anchor:

```
flyctl releases rollback v1096 -a spectre-staging --yes
```

For the worker (only if deployed in this slice):

```
flyctl releases rollback <prior worker version> -a spectre-staging-worker --yes
```

## 3. Predeployment checks (§3 directive)

### Current staging DB state

Query against staging `_prisma_migrations` ledger (read-only, via
authenticated flyctl ssh console):

- 134 migrations applied
- Latest applied training-AI migration:
  `20261105_ep_train_6d_4k_transcript_evidence` (2026-11-06 15:05:56 UTC)
- 4Y-chain migrations ALREADY APPLIED on staging:
  - `20261104_ep_train_6d_4b_ai_review_persistence`
  - `20261105_ep_train_6d_4k_transcript_evidence`
- 4Y-chain migrations PENDING for this deploy:
  - `20261106_ep_train_6d_4t_ai_draft_promotion`
  - `20261106_ep_train_6d_4v_transcription_job`
  - `20261106_ep_train_6d_4w_generation_lifecycle`
  - `20261106_ep_train_6d_4x_active_run_uniqueness_fix`

### Existing AI tables present on staging (pre-deploy)

```
TrainingCourseVersion            TrainingTranscriptBuild
TrainingQuestionAiGenerationRun  TrainingTranscriptSegment
TrainingQuestionAiDraft          TrainingGroundingProjection
TrainingQuestionAiValidation
TrainingQuestionAiReview
TrainingQuestionAiStateTransition
TrainingQuestionAiOperationKey
```

- Pending deploy will ADD two tables (4T + 4V): `TrainingQuestionAiDraftPromotion`, `TrainingTranscriptionJob`.
- Pending deploy will ADD 9 nullable columns to `TrainingQuestionAiGenerationRun` (4W lifecycle).
- Pending deploy will CREATE then CORRECT one partial-unique index (4W creates, 4X drops+recreates) on the same table.

### Migration rehearsal (disposable PG16, `localhost:15441`)

Script: [scratchpad/ep-train-6d4z/migration-rehearsal.mjs](../../../scratchpad/ep-train-6d4z/migration-rehearsal.mjs).

Procedure:
1. `prisma db push` to materialise the final 4Y schema.
2. Revert the DB to the simulated "after-4K" state by dropping the two
   4T/4V tables, the nine 4W columns, and the three 4W/4X indexes.
3. Apply `20261106_ep_train_6d_4t_ai_draft_promotion` → 4V → 4W → 4X
   in alphabetical order (Prisma's natural order).
4. Verify the end state matches production expectations.

Result: **ALL CHECKS PASSED**

- 4T migration: 8 statements, ok.
- 4V migration: 8 statements, ok.
- 4W migration: 12 statements, ok.
- 4X migration: 2 statements, ok.
- **4X-corrected unique index present with the expected shape**:
  ```
  CREATE UNIQUE INDEX "TrainingQuestionAiGenerationRun_unique_live_run_key"
    ON public."TrainingQuestionAiGenerationRun" USING btree
    ("clubId", "courseVersionId", "resolvedTranscriptBuildId", "planIdentity")
    WHERE (("planIdentity" IS NOT NULL)
           AND ("executionStatus" = ANY (ARRAY['REQUESTED'::text, 'QUEUED'::text, 'RUNNING'::text])))
  ```
  Key has 4 columns (NOT 5), `executionStatus` is in the partial WHERE
  as the IN-list, not in the key — matches the 4X correction verbatim.
- 4V (`TrainingTranscriptionJob`) + 4T (`TrainingQuestionAiDraftPromotion`)
  tables present.
- 9 / 9 4W lifecycle columns present.
- 2 / 2 4W supporting indexes present (`_status_lease_idx`, `_club_status_idx`).

### 4X uniqueness verification against staging state

Current staging DB has NEITHER the 4W broken index nor the 4W columns
(no 4W migration applied yet). The deploy applies 4W (which creates
the broken index) and 4X (which drops + recreates the corrected
form) in the same `prisma migrate deploy` call. The intermediate
"broken index" state exists only within the deploy's transaction
window and is replaced before any application code runs against it.

Confirmed additive + ordered + backward-compatible:

- All new columns on `TrainingQuestionAiGenerationRun` are nullable
  with safe defaults (`attempts`/`maxAttempts` default to 0/2). Any
  pre-existing AI generation run row (there may be test fixtures
  from earlier slices) remains valid.
- The new unique-index-partial-WHERE excludes rows where
  `planIdentity IS NULL`, so pre-4W rows do NOT collide.
- 4T + 4V tables are created fresh — no existing rows to conflict.

## 4. Deployment path (§4 directive)

**DRH-1 via `.github/workflows/deploy-staging.yml`** (`workflow_dispatch`).

Not used:
- ❌ No local `flyctl deploy --local-only` (per DRH-1 retry policy).
- ❌ No `MODAL_GENERATE_URL` set.
- ❌ No `MODAL_TRANSCRIBE_URL` set.
- ❌ No GPU activation.

Dispatched via:
```
gh workflow run deploy-staging.yml \
  --ref ep-train-6d-4z/staging-acceptance \
  -f ref=ep-train-6d-4z/staging-acceptance \
  -f confirm=deploy
```

Run URL:
https://github.com/SpectreAutomationAdmin/SpectreAutomation/actions/runs/42328042198

### Deployment outcome

| Field                                 | Value                                               |
|---------------------------------------|-----------------------------------------------------|
| GitHub Actions run                    | 42328042198 (exit 0, all steps ✓)                   |
| Build conclusion                      | success                                              |
| Pushed image SHA                      | `sha-52cbc2bb2030`                                   |
| New Fly release (web)                 | **v1097** @ 2026-11-07T02:25:10Z                     |
| Worker rebuild + deploy?              | Yes — worker v333 @ 2026-11-07T02:31:15Z, same SHA   |
| Migration outcome (prisma migrate deploy) | 4/4 pending migrations applied successfully at 2026-11-07T02:25:33Z (4T → 4V → 4W → 4X in alphabetical order) |
| `/api/health` HTTP code post-deploy   | **200**                                              |
| Log scan errors within 10 min of release | Smoke step passed in CI; manual spot-check showed no 500s in worker or web logs during the subsequent fixture seeding + Playwright acceptance run |

## 5. Health verification (post-deploy)

```
curl -s -o /dev/null -w "%{http_code}\n" https://staging.spectreautomation.com/api/health
```

Expected: **200**. If non-200, roll back per §2.

## 6. Migration ledger — post-deploy state (verified on staging)

```
Last applied training-AI migrations (newest first):
  20261106_ep_train_6d_4x_active_run_uniqueness_fix (finished 2026-11-07T02:25:33.684Z)
  20261106_ep_train_6d_4w_generation_lifecycle     (finished 2026-11-07T02:25:33.583Z)
  20261106_ep_train_6d_4v_transcription_job        (finished 2026-11-07T02:25:33.485Z)
  20261106_ep_train_6d_4t_ai_draft_promotion       (finished 2026-11-07T02:25:33.376Z)
  20261105_ep_train_6d_4k_transcript_evidence       (previously applied)
  20261104_ep_train_6d_4b_ai_review_persistence     (previously applied)
```

Total migrations applied: **138** (was 134) — delta of 4.

Post-deploy verification queries (via `flyctl ssh console` + Prisma
parameterised reads only — no `$queryRawUnsafe` with string
interpolation; no user enumeration):

- `TrainingTranscriptionJob` table: **present** (4V).
- `TrainingQuestionAiDraftPromotion` table: **present** (4T).
- `TrainingQuestionAiGenerationRun` 4W lifecycle columns: **9/9 present**
  (`assessmentPlanJson`, `attempts`, `leaseExpiresAt`, `leaseToken`,
  `maxAttempts`, `planIdentity`, `queuedAt`, `shortfallReasonJson`,
  `startedAt`).
- `TrainingQuestionAiGenerationRun_unique_live_run_key` index:
  **present in 4X-corrected form** (key = 4 columns, status in
  partial WHERE as IN-list).

## 7. STOP boundaries (§11 confirmation)

| STOP                                 | Confirmed |
|--------------------------------------|-----------|
| No production deploy                 | ✅        |
| No live Modal / Qwen / Whisper       | ✅ (no env vars set) |
| No GPU activation                    | ✅        |
| No publication                       | ✅        |
| No employee assignments              | ✅        |
| No historical candidate backfill     | ✅        |
| No new permanent role grants         | ✅        |
| No unrelated UI redesign             | ✅        |
| 126 unrelated WIP files preserved    | ✅ (stashed) |

## 8. Related slices

- [PHASE-D-4Y-WORKSPACE-DESIGN.md](./PHASE-D-4Y-WORKSPACE-DESIGN.md)
- [PHASE-D-4Y-ACCEPTANCE.md](./PHASE-D-4Y-ACCEPTANCE.md)
- [PHASE-D-4X-PLACEMENT-DESIGN.md](./PHASE-D-4X-PLACEMENT-DESIGN.md)
- [PHASE-D-4W-GENERATION-DESIGN.md](./PHASE-D-4W-GENERATION-DESIGN.md)
- [PHASE-D-4V-TRANSCRIPTION-DESIGN.md](./PHASE-D-4V-TRANSCRIPTION-DESIGN.md)
- [PHASE-D-4T-PROMOTION-DESIGN.md](./PHASE-D-4T-PROMOTION-DESIGN.md)
