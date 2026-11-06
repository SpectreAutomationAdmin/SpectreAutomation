# EP-TRAIN-6D-4X — Placement + Dedup + Uniqueness Correction — Acceptance

Status: **READY FOR FOUNDER REVIEW. OFFLINE IMPLEMENTATION COMPLETE.**
Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4x/placement-and-dedup` (local commit; not pushed, not
deployed, not run live against Modal/Qwen/any GPU).

## 1. One-line summary

4X delivers three things atop the accepted 4W baseline:

1. **§4 active-run uniqueness correction** — the 4W partial-unique
   index had `executionStatus` in the key, which permitted two live
   rows (one REQUESTED + one QUEUED) with the same plan identity.
   The corrected index moves status into the partial WHERE and
   restricts it to the non-terminal set `('REQUESTED', 'QUEUED',
   'RUNNING')`. Proved bug + proved fix on disposable PG16.
2. **§5 automatic topic-aware checkpoint placement** —
   deterministic three-signal boundary detector (PAUSE + SENTENCE +
   DRIFT) grouped into learning objectives, each closing with a
   checkpoint subject to lead-in / tail / spacing constraints. Every
   placement carries a rationale naming the boundary signal(s) that
   chose its timestamp.
3. **§6 semantic duplicate detection** — deterministic multi-signal
   classifier (normalised match + 1/2/3-gram shingle Jaccard +
   option overlap + correct-answer overlap + explanation overlap)
   over lemma-normalised tokens. Four verdicts: `EXACT_DUP`,
   `PARAPHRASE_DUP`, `TOPIC_CANDIDATE` (advisory), `DISTINCT`.
   Cross-destination screening + within-group screening. Every
   decision logged to the run's `shortfallReasonJson` for manager
   review.

## 2. Mandatory preflight (directive §3)

| Reference | Verified on 4W baseline (`850c9bc6`)? |
| --------- | :-----------------------------------: |
| `TrainingQuestionAiGenerationRun` lifecycle + lease | ✓ |
| Shared assessment plan (`training-assessment-plan-v1`) | ✓ |
| Candidate destination metadata | ✓ |
| 4M evidence reader + 4L ingest | ✓ |
| Transcript segments carry `startSec` + `endSec` + `text` | ✓ |
| Final-assessment scoring | ✓ (via 4L draft `state`) |
| Publication readiness rules | ✓ (unchanged — 4T sidecar) |
| 4W partial-unique index — permits active-state coexistence? | **✗ — defect confirmed** |

**No additional schema change required** beyond the §4 correction
itself. Placement + dedup are additive to existing structures:
placement writes to the existing `assessmentPlanJson` field (via
`buildTopicAwareAssessmentPlan`); dedup writes decisions into the
existing `shortfallReasonJson` field.

## 3. §4 uniqueness correction

### 3.1 The defect

4W's partial-unique index:

```sql
CREATE UNIQUE INDEX … ON TrainingQuestionAiGenerationRun (
  "clubId", "courseVersionId", "resolvedTranscriptBuildId",
  "planIdentity", "executionStatus"
) WHERE "planIdentity" IS NOT NULL;
```

Because `executionStatus` is part of the key, two rows with the same
identity but different statuses (e.g. one REQUESTED + one QUEUED)
have different index tuples and do not collide. That weakens founder
condition #5.

### 3.2 The correction

[prisma/migrations/20261106_ep_train_6d_4x_active_run_uniqueness_fix/migration.sql](../../prisma/migrations/20261106_ep_train_6d_4x_active_run_uniqueness_fix/migration.sql) +
PG mirror:

```sql
DROP INDEX IF EXISTS "TrainingQuestionAiGenerationRun_unique_live_run_key";
CREATE UNIQUE INDEX "TrainingQuestionAiGenerationRun_unique_live_run_key"
    ON "TrainingQuestionAiGenerationRun" (
      "clubId", "courseVersionId", "resolvedTranscriptBuildId", "planIdentity"
    )
    WHERE "planIdentity" IS NOT NULL
      AND "executionStatus" IN ('REQUESTED', 'QUEUED', 'RUNNING');
```

Status moves to the partial `WHERE` as an IN-list over the three
non-terminal states. Any two active rows with the same identity now
collide. Terminal rows (COMPLETED/FAILED/CANCELLED) remain
unrestricted as history.

### 3.3 PG16 evidence

Disposable `postgres:16-alpine` on port 15440. Container torn down
post-run. 8/8 scenarios PASS:

| # | Scenario | Pre-correction | Post-correction |
| - | -------- | :------------: | :-------------: |
| U1 | REQUESTED + QUEUED (same identity), both inserted | ALLOWED — bug confirmed | — |
| U2a | Second REQUESTED row rejected | — | 23505 |
| U2b | REQUESTED + QUEUED rejected | — | 23505 |
| U2c | REQUESTED + RUNNING rejected | — | 23505 |
| U3a | COMPLETED + new REQUESTED allowed | — | ALLOWED |
| U3b | CANCELLED + new REQUESTED allowed | — | ALLOWED |
| U3c | FAILED + new REQUESTED allowed | — | ALLOWED |
| U4 | Different `planIdentity` values independent | — | ALLOWED |

See `scratchpad/ep-train-6d4x/uniqueness-harness-result.json` (local
only; not committed).

## 4. §5 automatic checkpoint placement

See [PHASE-D-4X-PLACEMENT-DESIGN.md](PHASE-D-4X-PLACEMENT-DESIGN.md).

- Three signals: PAUSE (gap > 0.5s), SENTENCE (`.` / `!` / `?` + capitalised next), DRIFT (token-set Jaccard drift > 0.55 across ±3-segment windows).
- Placement constraints: lead-in 30s, tail 10s, spacing 15s.
- Rationale on every placement.
- Exclusion: segments 16 + 17 permanently filtered.
- Fallback: when topic-aware produces zero-eligible, the admin route falls back to 4W's baseline builder.

## 5. §6 semantic dedup

See [PHASE-D-4X-DEDUP-DESIGN.md](PHASE-D-4X-DEDUP-DESIGN.md).

- Four verdicts: `EXACT_DUP`, `PARAPHRASE_DUP`, `TOPIC_CANDIDATE`, `DISTINCT`.
- Multi-signal — pure shingle similarity ALONE never trips PARAPHRASE.
- Lemma + 1/2/3-gram shingles for robust paraphrase detection.
- Cross-destination screening across all plan groups.
- Rules version `dedup-v1` recorded on every decision.
- Decisions persisted on the run's `shortfallReasonJson` for manager review.

## 6. §7 architecture compliance

| §7 requirement | Design decision |
| -------------- | --------------- |
| Deterministic + testable | Pure functions. Same input → same output. 25 contract tests. |
| Explainable | Every decision carries `evidence` (5 numeric signals) + `explanation` (human-readable reason) + `rulesVersion`. |
| No new paid AI provider | Zero new provider. Modal client unchanged. |
| No new embedding model | Zero embeddings. Pure lexical + shingles. |
| No persistent vector index | Zero index. Dedup runs in-memory per generation run. |
| No new schema | Zero schema change for dedup. Decisions ride on existing `shortfallReasonJson`. |
| Multi-signal | 5 signals combined; shingle AND (option OR answer OR explanation). |
| Versioned thresholds | `DEDUP_RULES_VERSION = "dedup-v1"` stamped on every decision. |
| Conservative | PARAPHRASE requires corroboration; standalone similarity is at most TOPIC_CANDIDATE. |

## 7. §8 human review + editability

- Checkpoint positions and question allocation remain proposals.
- Drafts land `state = REQUIRES_HUMAN_REVIEW` (unchanged from 4W).
- Dedup decisions persist on the run; the manager UI (future slice)
  reads them to display warnings on TOPIC_CANDIDATE drafts.
- No auto-approval. No auto-promotion. No auto-publication.

## 8. §9 quality + safety preserved

| Property | Preserved |
| -------- | --------- |
| Source-video identity (`sourceVideoSha256`) | ✓ |
| Tenant + course-version isolation | ✓ (dedup runs inside one `generationRun`) |
| Immutable evidence hashes | ✓ (4L hashes unchanged) |
| Source-org mismatch warnings | ✓ (4L unchanged) |
| Transcript segment exclusions | ✓ (EXCLUDED_SEGMENT_INDICES mirrored across modules) |
| 4N approval governance | ✓ (unchanged) |
| 4T promotion integrity | ✓ (unchanged) |
| 8 historical candidates | ✓ (untouched) |
| 126 unrelated WIP files | ✓ (stashed on entry, restored on exit) |

## 9. Files added

| Path | Purpose |
| ---- | ------- |
| `prisma/migrations/20261106_ep_train_6d_4x_active_run_uniqueness_fix/migration.sql` | SQLite uniqueness correction |
| `prisma-postgres/migrations/20261106_ep_train_6d_4x_active_run_uniqueness_fix/migration.sql` | PG mirror |
| `src/lib/hr/training/generation/placement.ts` | Topic-aware placement builder |
| `src/lib/hr/training/generation/dedup.ts` | Multi-signal dedup classifier |
| `tests/ep-train-6d4x-placement.test.ts` | 13 contract tests |
| `tests/ep-train-6d4x-dedup.test.ts` | 12 contract tests |
| `tests/ep-train-6d4x-worker-integration.test.ts` | 3 integration tests |
| `docs/training/ai-generation/PHASE-D-4X-PLACEMENT-DESIGN.md` | Design |
| `docs/training/ai-generation/PHASE-D-4X-DEDUP-DESIGN.md` | Design |
| `docs/training/ai-generation/PHASE-D-4X-ACCEPTANCE.md` | This file |

## 10. Files modified

| Path | Change |
| ---- | ------ |
| `src/lib/hr/training/generation/worker-handler.ts` | Wire dedup into the proposal loop + extend shortfall JSON |
| `src/app/api/admin/training/versions/[id]/generate/route.ts` | Default to topic-aware plan; fall back to baseline when zero-eligible |

## 11. Test evidence

- **Full 4B–4X regression: 301/301 PASS across 22 test files** (256.85s).
- **4X suite: 28/28 PASS** (13 placement + 12 dedup + 3 worker-integration).
- **4W baseline: 44/44 PASS** (unchanged).
- **PG16 uniqueness harness: 8/8 PASS** (U1 bug confirmed + U2a-c correction + U3a-c history + U4 identity independence).
- **Scoped typecheck**: clean for every 4X file.
- **Placeholder scan**: no new hits (pre-existing allowlisted-only output).

## 12. STOP compliance (directive §12)

| Boundary | Status |
| -------- | ------ |
| No staging or production deployment | HONOURED — local commit only |
| No shared database migration | HONOURED — additive mirrored migration, not pushed |
| No Modal/Qwen inference or GPU activation | HONOURED — mocked `fetchImpl` in every test |
| No automatic question approval or promotion | HONOURED |
| No publication | HONOURED |
| No employee assignments | HONOURED |
| No historical candidate modification | HONOURED — 8 rows untouched |
| No role grants | HONOURED |
| No unrelated UI changes | HONOURED |
| 126 unrelated WIP files preserved | HONOURED |

## 13. Proposed staging activation sequence

The 4X slice does not deploy. The proposed sequence for a future
authorized activation:

1. **Review** this acceptance + the two design docs.
2. **Authorize** push of `ep-train-6d-4x/placement-and-dedup` to
   origin (currently unpushed).
3. **Authorize** the `20261106_ep_train_6d_4x_active_run_uniqueness_fix`
   migration for staging. It is additive-only (DROP INDEX + CREATE
   INDEX); no data touched.
4. **Deploy staging** with the new migration + 4W/4X code.
5. **Live verification** (manager workflow, placement rationale
   surface, dedup warnings) remains a separate manager-UX slice
   per directive §8.
6. **Modal/Qwen activation** remains a separate authorized slice —
   `MODAL_GENERATE_URL` is still not set in any environment.

## 14. Unresolved manager-UX integration (§11)

- Surface `rationale` from each placed checkpoint in the manager
  review UI.
- Surface `TOPIC_CANDIDATE` warnings keyed by `candidateContentHash`
  → `shortfallReasonJson.dedupDecisions`.
- Surface §4 uniqueness collisions (idempotent-replay) to the
  operator as "existing run returned" rather than silent success.
- Manager-moveable checkpoint markers (plan revision workflow per
  §8).
- Manager-triggered regeneration of a single rejected question.

These are explicit next-slice candidates for the manager workflow,
NOT part of 4X.

## 15. Awaiting founder action

- **(A)** Accept this slice offline. Authorize next slice (either
  staging activation of 4W + 4X together, OR the manager-UX surface
  per §14).
- **(B)** Request a different signal in dedup / placement
  (e.g. stronger paraphrase detection via explicit named entities,
  or a stricter PAUSE threshold).
- **(C)** Flag a defect. The slice does not deploy, so verification
  is limited to the code + the tests + the PG16 harness. Live
  manager behavior is a separate slice.
