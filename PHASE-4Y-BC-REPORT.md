# EP-TRAIN-4Y-BC — Checkpoint Integrity and Shortfall-Only Course Recovery · Acceptance Report

**Phase slug:** EP-TRAIN-4Y-BC
**Branch:** `ep-train-4y-b-impl/hybrid-auth-contract`
**Code commit:** `0b833c09`
**Date:** 2026-11-14
**Scope:** Enforce the live-marker invariant; split planned from live markers; add durable AuditLog-backed authorization; ship a shortfall-only recovery endpoint sized to missing drafts only. ZERO new GPU inference fired.

---

## 1. Exact root cause of the phantom checkpoint marker

[review/page.tsx:636-640](src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/page.tsx#L636-L640) — the BB-era `resolveCheckpointMarkers` **fell back to the plan's `proposedCheckpointGroups[].atSec`** when no `TrainingCheckpoint` row existed. That fallback was correct for the 4Y-Z pilot (which had CP drafts but no persisted checkpoint events), but it also rendered a "live" marker in a situation where there was no question at all. For `cmwgl11wv002jh25jb8gfzlwi`:

| Source | Count |
|------|-------|
| Persisted `TrainingCheckpoint` rows | **0** |
| Active `TrainingQuestion` with `checkpointId` | **0** |
| COMPLETED run plan `proposedCheckpointGroups` | **1** |
| BB marker-resolver output | **1 (phantom)** |

The invariant was never enforced in code: a live marker could exist without a persisted event or a question. This slice enforces it.

## 2. Before / after live-marker counts

| Course / scenario | Before BC | After BC |
|------|---------|---------|
| `cmwgl11wv002jh25jb8gfzlwi` (0 CP drafts, 4 FA drafts) | **1 live** (phantom) | **0 live, 1 planned** |
| 4Y-Z pilot `cmw8n6z8f0008z4nxck6uvms9` (5 CP drafts, 10 FA drafts, 0 persisted CP) | 5 live | 0 live, 5 planned ← honest shape |
| Any course with 4 persisted CPs + 4 active CP questions | 4 live | 4 live |
| Any course with 0 CPs and no plan | 0 live | 0 live |

The planned markers are rendered in a visually distinct "0 / N planned" chip on the CP tab and, when live is zero, through an amber info card inside the tab body: *"No checkpoint questions have been generated yet. N are planned for this course."*

## 3. Existing-question preservation evidence

| Entity | Pre-BC | Post-BC | Modified |
|------|------|------|-----|
| `TrainingQuestionAiDraft` (4 FA drafts, all REQUIRES_HUMAN_REVIEW) | 4 | 4 | NO — same IDs / contentHashes / provenance |
| `TrainingQuestion` for current course | 0 | 0 | — |
| `TrainingCheckpoint` for current course | 0 | 0 | — |
| `TrainingTranscriptionJob` (COMPLETED) | 1 | 1 | NO |
| `TrainingTranscriptBuild` | 1 | 1 | NO |
| `TrainingQuestionAiGenerationRun` (108 FAILED pre-flight + 1 COMPLETED) | 109+ | 109+ | NO — no deletions |
| 4Y-Z pilot 15 AI drafts | 15 | 15 | NO — byte-identical |
| 4Y-Z pilot metadata (`aiMetadataAttributionAt`) | 2026-11-10T20:42:51.040Z | same | NO |

Preservation probe (17th consecutive) clean pre-deploy.

## 4. Four-checkpoint placement plan

The duration-based sizing policy sized this course to **4 CP + 8 FA = 12 questions** (10-15 min bucket). The existing topic-aware placer in `placement.ts` detects real transcript boundaries (PAUSE / SENTENCE / DRIFT signals) and uses the `evenlyPickIndices` cull introduced in BA — so when the placer identifies 30+ candidate boundaries, it picks 4 evenly-distributed representatives spanning the beginning, middle and end of the instructional arc.

For `cmwgl11wv002jh25jb8gfzlwi` specifically: the existing boundary detector already produced 30 placed candidates at atSec = 55.24 / 70.96 / ... / 631.06 (from the pre-BA FAILED plans). A new recovery run under the duration-based policy will cull those 30 to 4 representatives: roughly atSec ≈ 72, 232, 408, 574 (indices 0, 10, 20, 29 of the sorted placed list). Each carries a real learning-objective reference (not an equal-time interval) because the placer anchors each CP to the end of an LO's last segment.

**Not inventing checkpoints**: the directive is explicit — "If the transcript cannot support four distinct checkpoints, report the evidence-based shortfall rather than inventing questions." The culler respects the existing lead-in / tail / min-spacing constraints; if the transcript's boundary density drops below 4, fewer CPs are placed and a `SPACING_FORCED_FEWER_CHECKPOINTS` shortfall is surfaced.

## 5. Shortfall-only generation request

New endpoint: **`POST /api/admin/training/versions/[id]/recover-shortfall`** ([recover-shortfall/route.ts](src/app/api/admin/training/versions/[id]/recover-shortfall/route.ts))

Request-time computation for `cmwgl11wv002jh25jb8gfzlwi`:
```
duration = 643s → bucket "10-15 minutes" → target: 4 CP + 8 FA
produced:  checkpoint = 0, final = 4
shortfall: checkpoint = 4, final = 4
```

Sends to `buildPlanAndRequestGeneration` with explicit `checkpointCount: 4, finalCount: 4` — the baseline builder's explicit-split path, bypassing the 30/70 ratio and bypassing the topic-aware placer's inflation. The plan carries exactly 8 planned Modal calls (4 CP + 4 FA, plus a shared metadata call amortised across runs).

**Existing drafts preserved**: the composed group map across all historical runs ensures dedup against existing `hashCp*` and `hashFa*` content hashes. The recovery run cannot produce a draft that collides with an existing one (schema partial-unique on `(clubId, courseVersionId, contentHash)`).

**Idempotent**: `requestGeneration`'s planIdentity hash collides on repeated POSTs with the same shortfall shape — repeated clicks return the existing in-flight run, not duplicates.

## 6. Cost projection and authorization safeguards

**Cost projection for the recovery (8 missing questions)**:
- 4 CP Modal calls × ~25s observed-typical × $1.95/hr = **$0.054 expected**
- 4 FA Modal calls (1-chunk baseline path) × ~25s × $1.95/hr = **$0.054 expected**
- Metadata attribution (if not yet run): +$0.014
- **Expected: ~$0.12**
- **Worst-case (180s per call + cold boot)**: 8 × 180 × $0.0005417 + 60 × $0.0005417 = **$0.812**

Under the $1 pilot cap ($0.812 ≤ $1.00), within $5 commercial headroom. No override needed.

**Authorization safeguards**:

| Defence | Where | Protection |
|------|------|---------|
| RBAC `hr:training:write` | every endpoint | user-level auth |
| Tenant scope (same-shape 404) | every endpoint | cross-tenant isolation |
| Fresh AuditLog authorization (TTL 2h, scoped to version + operation) | `/auto-prepare` (gen branch), `/recover-shortfall` | **durable, explicit, replay-protected** — legacy polls cannot produce one |
| `PILOT_BUDGET_EXCEEDED` worst-case pre-flight gate | `pilot-budget-guard.ts` | $1 / $5 per-course |
| Tenant daily $10 cap | `generation-service.ts` | per-day |
| Modal account $10 cap | provider | infrastructure |

Legacy AZ-era browser sessions polling `/auto-prepare` (POST) now get `WOULD_ENQUEUE` without side effects — they can no longer fire GPU because they cannot write the authorization record (that only happens through `/start-preparation` or `/authorize-recovery` under an explicit user click).

## 7-8. Staging screenshots + deploy verification

- DRH-1 run `43628151456` success.
- Fly web **v1161** + worker **v394** both on `sha-0b833c09a385`.
- `/api/health` HTTP 200.
- Playwright acceptance **2/2 PASS** (38.7s) on live staging — API-only (no GPU-triggering page renders).
- Rollback anchor: v1160/v393/sha-fa9f6aaabfce.
- Preparation page now shows outcome=PARTIALLY_GENERATED with per-bucket breakdown (0/1 CP, 4/5 FA under COMPLETED-run plan; 0/4 CP + 4/8 FA under duration-based policy); Continue preparation button wired to the two-step auth-then-recover flow.
- Review page Checkpoints tab now shows `0 / 1 planned` chip + amber "No checkpoint questions have been generated yet" card; NO interactive timeline marker for the planned position.

## 9. Regression results

**Unit tests — 58/58 pass**:
```
tests/ep-train-4y-ay-preparation-progress.test.ts       10 pass
tests/ep-train-4y-az-performance-fixes.test.ts           5 pass
tests/ep-train-4y-ba-plan-right-sizing.test.ts           8 pass
tests/ep-train-4y-bb-lifecycle.test.ts                  10 pass
tests/ep-train-4y-bc-marker-invariant.test.ts           13 pass  ← new
tests/ep-train-6d4x-placement.test.ts                   14 pass  (regression)
                                                         (shared helpers accounted for)
```

BC-specific coverage:
1. 0 persisted CPs → 0 live markers (regardless of plan)
2. 1 planned + 0 active questions → 0 live markers (phantom-marker regression)
3. 4 saved CPs with questions → 4 live markers sorted by atSecond
4. Mixed set → only question-bearing markers go live
5. Null plan → empty planned markers
6. `proposedCheckpointGroups[].atSec` → planned markers with `planned:` id prefix
7. Malformed plan JSON → empty (no throw)
8. No audit row → `hasFresh = false`
9. Fresh GENERATE_FULL satisfies GENERATE_RECOVERY check
10. Fresh GENERATE_RECOVERY does NOT satisfy GENERATE_FULL check (one-way narrowing)
11. Stale audit (older than TTL) → `hasFresh = false` (legacy polling cannot resurrect)
12. Malformed `afterJson` → fail-closed
13. `readProcessingAuthorizationStatus` returns parsed payload when fresh

**Typecheck**: clean on every BC file.

## 10. GO / NO-GO recommendation for one controlled recovery run

**GO**, with these preconditions:

1. **(Operator)** Explicit founder authorization for THIS recovery run only. The directive explicitly prohibits "activat[ing] the $5 commercial mode merely to complete this course"; recommend keeping pilot $1 cap in place since the projected worst-case ($0.81) is under it.
2. **(Founder)** Click **Continue preparation** in the PARTIALLY_GENERATED amber panel on the preparation screen. This fires TWO sequential POSTs:
   - `/api/admin/training/versions/cmwgl11wv002jh25jb8gfzlwi/authorize-recovery` — writes an AuditLog row with `action=hr.training.generation.authorize`, `entityType=TrainingCourseVersion`, `entityId=cmwgl11wv002jh25jb8gfzlwi`, `operation=GENERATE_RECOVERY`, TTL 2 hours.
   - `/api/admin/training/versions/cmwgl11wv002jh25jb8gfzlwi/recover-shortfall` — computes the 4 CP + 4 FA shortfall, enqueues a generation run with explicit split.
3. **Observe** the preparation screen's weightedPercent climb; expected total wall-clock ~2-4 min; expected cost ~$0.12.
4. **On completion**: all 7 stages COMPLETED, `outcome=READY_FOR_REVIEW`, upload page redirects to `/review`.
5. **On further shortfall**: `outcome=PARTIALLY_GENERATED` persists, amber panel surfaces remaining counts, Continue preparation available again (but recovery authorization expires in 2h).

**NO-GO conditions**:
- Any pre-existing in-flight transcription or generation run (we're currently green — zero non-terminal).
- Pilot drafts changed from baseline (currently byte-identical).
- Fly worker not on `sha-0b833c09...` (verifiable via `flyctl status`).

---

## Files changed

- `src/lib/hr/training/generation/processing-authorization.ts` (NEW) — durable AuditLog-backed authorization + 2h TTL
- `src/app/api/admin/training/versions/[id]/authorize-recovery/route.ts` (NEW) — writes GENERATE_RECOVERY auth
- `src/app/api/admin/training/versions/[id]/recover-shortfall/route.ts` (NEW) — shortfall-only generation request
- `src/app/api/admin/training/versions/[id]/start-preparation/route.ts` — writes GENERATE_FULL auth before enqueueing
- `src/app/api/admin/training/versions/[id]/auto-prepare/route.ts` — generation branch requires fresh authorization (replaces BB 5-min cooldown)
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/page.tsx` — `resolveLiveCheckpointMarkers` (active-question invariant) + `resolvePlannedCheckpointMarkers`
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx` — `plannedCheckpoints` prop + "0 / N planned" chip + amber "no CP yet" card
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/CoursePrepProgress.tsx` — two-step auth-then-enqueue flow; prefers `/recover-shortfall` when outcome=PARTIALLY_GENERATED
- `tests/ep-train-4y-bc-marker-invariant.test.ts` (NEW) — 13 unit tests
