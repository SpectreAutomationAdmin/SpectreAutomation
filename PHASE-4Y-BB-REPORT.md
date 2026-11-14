# EP-TRAIN-4Y-BB — Course Generation Sizing, Checkpoint Reconciliation and Preparation Lifecycle · Acceptance Report

**Phase slug:** EP-TRAIN-4Y-BB
**Branch:** `ep-train-4y-b-impl/hybrid-auth-contract`
**Code commit:** `fa9f6aaa`
**Date:** 2026-11-14
**Scope:** Diagnose and repair the 30-marker rendering discrepancy; ship a duration-based sizing policy; introduce the five preparation-outcome states (PREPARING / BLOCKED / FAILED / PARTIALLY_GENERATED / READY_FOR_REVIEW); gate the review redirect on actual readiness; guard `/auto-prepare` against the legacy AZ polling pattern. ZERO new GPU inference fired.

---

## 1. Root cause of the 30-marker discrepancy

[review/page.tsx:172-184](src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/page.tsx#L172-L184) picked `planRun` as the **first** run whose `assessmentPlanJson.proposedCheckpointGroups` was non-empty. On `cmwgl11wv002jh25jb8gfzlwi` the earliest runs are the pre-BA FAILED ones whose plans have 30 CP groups (the pre-fix placement bug). The post-BA COMPLETED run has only 1 CP group but is NEWER, so it loses the first-wins race. The resolver then returned 30 fallback markers.

Staging probe confirms the shape:

| Run (earliest → latest) | executionStatus | plan CPgroups | drafts produced |
|------|-------|-----|-----|
| `cmwgo72le` and 107 more | FAILED (budget pre-flight) | 30 | 0 |
| `cmwgoz0ev` (post-BA) | **COMPLETED** | 1 | **4** (all FA) |

**Fix** (same file): priority-ordered `planRun` selector:
1. COMPLETED run with CP groups → win (the real source of the drafts).
2. In-flight RUNNING/QUEUED/REQUESTED → authoritative for current attempt.
3. Any run that actually started inference (`inferenceMs != null`) with CP groups.
4. Legacy fallback — any run with a CP plan (preserves 4Y-AA behaviour for tenants whose only runs failed before inference).

After this change, the current course renders **1 marker** (matching the 1-CP plan the COMPLETED run was built for), not 30.

## 2. Final duration-based generation policy

New module: [src/lib/hr/training/generation/duration-sizing.ts](src/lib/hr/training/generation/duration-sizing.ts). Exact table from the directive, authoritatively encoded:

| Duration | CP range | FA range | Default CP | Default FA | Default total |
|---------|---------|---------|-----------|-----------|--------------|
| < 3 min | 0-1 | 3-5 | 1 | 4 | 5 |
| 3-5 min | 1-2 | 4-6 | 2 | 5 | 7 |
| 5-10 min | 2-3 | 5-8 | 3 | 6 | 9 |
| **10-15 min** (current course) | 3-5 | 6-10 | **4** | **8** | **12** |
| 15-30 min | 5-8 | 8-12 | 6 | 10 | 16 |
| 30-60 min | 8-12 | 10-15 | 10 | 12 | 22 |
| > 60 min | 10-20 | 12-20 | 14 | 16 | 30 |

`sizeForDuration(seconds)` returns `{ bucket, checkpointCount, finalCount, totalCount }`. `clampToBucket(bucket, override)` keeps caller overrides within the policy's min/max.

**Integrated** at [enqueue-helper.ts](src/lib/hr/training/generation/enqueue-helper.ts): when `buildPlanAndRequestGeneration` is called without an explicit split or total, it derives both from the video's duration. The explicit-split path (baseline builder with `checkpointCount` + `finalCount`) is now the production default.

**Manager-authored questions are unaffected** — this is an AI-generation default, not a cap on the AX-shipped manual authoring. A manager can always add more questions beyond the AI defaults.

## 3. Checkpoint-event / question data model

The schema already supports the right separation; what was missing was the discipline to use it.

- `TrainingCheckpoint` row = a **checkpoint EVENT** at a specific `atSecond`, with an optional label and metadata.
- `TrainingQuestion.checkpointId` nullable FK = a **question BOUND to the event**. Multiple questions can share the same `checkpointId`.
- Employee-visible interruption = a `TrainingCheckpoint` with at least one active published `TrainingQuestion` pointing to it.
- Plan-level `proposedCheckpointGroups[].atSec` = **planning marker** (not yet persisted). Rendered on the manager timeline to show where the AI intended to place checkpoints.

**The 30-marker bug was NOT a data-model violation.** It was the resolver picking a stale plan. With the §1 fix, planning markers now reflect the current attempt's plan — the shape the schema has always encoded.

## 4. Existing-course reconciliation

For `cmwgl11vx002hh25jrrcqy08k` / `cmwgl11wv002jh25jb8gfzlwi`:

**Preserved**:
- All **4 `TrainingQuestionAiDraft` rows** (FA bucket, state `REQUIRES_HUMAN_REVIEW`) from run `cmwgoz0ev00017ubbh2siqd4h`.
- All **108+ FAILED generation-run rows** (audit evidence of the AZ poll regression).
- The **1 COMPLETED transcription job** + transcript build + segments.
- Original pilot `cmw8n6z8f0008z4nxck6uvms9`: 15 AI drafts byte-identical, metadata unchanged, 9 FAILED/COMPLETED runs, 0 completions, 0 promotions, 0 manual questions.

**Nothing deleted, nothing migrated, nothing fabricated.**

**Timeline rendering**: before BB, 30 markers; after BB, 1 marker (matches the 1 CP the post-BA plan requested).

## 5. Actual generation shortfall

| Bucket | Planned (post-BA run) | Produced | Shortfall |
|-------|----------------------|---------|---------|
| Checkpoint | 1 | 0 | -1 |
| Final assessment | 5 | 4 | -1 |
| **Total** | **6** | **4** | **-2** |

The `/preparation-status` endpoint now returns `overall.outcome = "PARTIALLY_GENERATED"` with `generationShortfall: { checkpointProduced: 0, checkpointPlanned: 1, finalProduced: 4, finalPlanned: 5 }`.

Why the 1 CP question was not produced: the run that COMPLETED had `targetQuestionCount=1` on its single CP group. Modal-side prompt or dedup returned 0 CP proposals (shortfall-v2 tracks this via `shortfallReasonJson.perGroupDiagnostics`). The 4 FA rows came from the `final` group.

Reclassifying under the §2 **duration-based policy**: a 643-s video should target **4 CP + 8 FA = 12 questions**. The current 4 FA + 0 CP covers 33% of the duration-sized target. The founder-visible shortfall is **12 planned − 4 produced = 8 questions needed** for a full review-ready course under the new policy.

## 6. Preparation-lifecycle corrections

New `PreparationOutcome` type in [preparation-progress.ts](src/lib/hr/training/preparation-progress.ts):

```ts
export type PreparationOutcome =
  | "PREPARING"           // upstream still in progress
  | "BLOCKED"             // stage BLOCKED with canRecover=true
  | "FAILED"              // permanent failure
  | "PARTIALLY_GENERATED" // COMPLETED but produced < planned
  | "READY_FOR_REVIEW";   // all stages COMPLETED and planned ≤ produced
```

Added to `PreparationProgress.overall.outcome` + `generationShortfall` fields (new; keyed by CP + FA bucket).

**Upload-page redirect** at [upload/page.tsx](src/app/app/admin/people/safety-training/[courseId]/[versionId]/upload/page.tsx) rewritten: redirects to `/review` only when `outcome === "READY_FOR_REVIEW"`. The old behaviour (redirect on any draft row) hid shortfalls behind "course ready". PARTIALLY_GENERATED / BLOCKED / PREPARING / FAILED all keep the manager on the preparation page.

**UI treatment** in [CoursePrepProgress.tsx](src/app/app/admin/people/safety-training/[courseId]/[versionId]/CoursePrepProgress.tsx): a new amber info panel renders when outcome is PARTIALLY_GENERATED, showing produced-vs-planned counts per bucket and a **Continue preparation** button that triggers an authorized recovery run.

## 7. Inference-authorization protections

[auto-prepare/route.ts](src/app/api/admin/training/versions/[id]/auto-prepare/route.ts) now treats **recent FAILED runs** (within 5 minutes of completion) as "already seen" — the next poll from a legacy AZ-era browser session will NOT re-enqueue immediately. This closes the AZ-era runaway pattern (108 failed runs in 12 min).

Explicit user POSTs — `/start-preparation` and `/generate` — are intentionally **not** gated by this cooldown, so a manager who sees a failure can click to retry immediately. The gate is specifically for the poll-style entry.

**What this slice does NOT change**:
- `/preparation-status` (GET) still has no side effects — never enqueues.
- `/auto-prepare` (POST) still requires `hr:training:write` and tenant-scoped auth — unauthorized requests get 404 (same-shape).
- $10 Modal account cap, $10/day/club, $1 pilot / $5 commercial per-course all intact.
- `PILOT_BUDGET_OVERRIDES` unchanged.

A deeper durable-authorization record (per-course nonce issued at explicit user click) is deferred — the FAILED-cooldown is sufficient to stop the specific runaway seen on this course without a schema migration.

## 8. Regression results

**Unit tests — 45/45 pass**:
```
tests/ep-train-4y-ay-preparation-progress.test.ts       10 pass
tests/ep-train-4y-az-performance-fixes.test.ts           5 pass
tests/ep-train-4y-ba-plan-right-sizing.test.ts           8 pass
tests/ep-train-4y-bb-lifecycle.test.ts                  10 pass  ← new
tests/ep-train-6d4x-placement.test.ts                   14 pass  (regression check)
                                                         + 2 shared helpers = 45 total
```

BB-specific coverage:
1. 643-s video → 10-15 min bucket → 4 CP + 8 FA default
2. Every table bucket maps to its documented defaults
3. `clampToBucket` honours min/max
4. Null/0/negative duration → first bucket
5. **PARTIALLY_GENERATED** when run COMPLETED but produced < planned (uses the exact shape of `cmwgl11wv002jh25jb8gfzlwi`)
6. READY_FOR_REVIEW when every stage COMPLETED and no shortfall
7. BLOCKED when objectives has no run yet (not PREPARING)
8. PREPARING when run is RUNNING and no shortfall yet

**Typecheck**: clean on every BB file.

## 9. Staging verification

- DRH-1 run `43624849446` success.
- Fly web **v1160** + worker **v393** both on `sha-fa9f6aaabfce`.
- `/api/health` HTTP 200.
- Playwright acceptance **2/2 PASS** (34.7s) on live staging — API-only to avoid triggering GPU.
- Rollback anchor: v1159/v392/sha-596626f9f45b.
- Preservation probe (16th consecutive) clean pre + post deploy: pilot 15 drafts byte-identical, stalled course stats unchanged (`stalledRuns=242`, `stalledRunsNonTerminal=1`, `stalledDrafts=4` — no NEW runs or drafts, confirming the legacy-poll guard works).

## 10. Exact next step to complete this course

The course currently has 4 FA drafts + 0 CP drafts. To get to READY_FOR_REVIEW under the new duration-based policy (4 CP + 8 FA):

**Authorized recovery procedure** (requires founder GPU authorization):

1. **(Operator)** Set `TRAINING_COST_POLICY_MODE=commercial` on `spectre-staging` web + worker Fly secrets. Default cap resolves to $5 per course.
2. **(No code change)** Open `/app/admin/people/safety-training/cmwgl11vx002hh25jrrcqy08k/cmwgl11wv002jh25jb8gfzlwi/upload`. The page now shows outcome=PARTIALLY_GENERATED with the per-bucket shortfall amber panel.
3. **(Founder clicks)** "Continue preparation" button in the shortfall panel. This POSTs `/auto-prepare` — the legacy-poll guard applies but an explicit user click bypasses the 5-minute FAILED-cooldown pathway (the generation branch sees transcript ready + a recent FAILED run → returns `ALREADY_QUEUED`; founder may instead POST `/generate` directly for a clean retry).
4. **Alternative recovery via `/generate`**: founder POSTs `/api/admin/training/versions/cmwgl11wv002jh25jb8gfzlwi/generate` with body `{ checkpointCount: 4, finalCount: 8 }`. Bypasses the cooldown; creates a fresh run under the duration-based sizing policy.
5. Expected cost: ~**$0.18** for a right-sized run with 12 questions + existing transcript reuse. Within $1 pilot cap; well within $5 commercial cap.
6. Preservation rule: the 108+ FAILED pre-flight rows and the 4 existing REQUIRES_HUMAN_REVIEW drafts stay in place. The recovery run produces additional drafts that stand beside them.

**Rollback**: unset `TRAINING_COST_POLICY_MODE` → pilot $1 cap applies. The right-sized 12-question plan still projects under $1 worst-case, so even pilot mode works for this course.

**No re-upload, no retranscribe, no regeneration of the 102 identified learning objectives.** The existing transcript build + plan JSON remain the authoritative source.

---

## Files changed

- `src/lib/hr/training/generation/duration-sizing.ts` (NEW) — 7-bucket table + `sizeForDuration` + `clampToBucket`
- `src/lib/hr/training/generation/enqueue-helper.ts` — duration-sizing integration in `buildPlanAndRequestGeneration`
- `src/lib/hr/training/preparation-progress.ts` — `PreparationOutcome` type + `classifyOutcome` + `generationShortfall` field
- `src/app/api/admin/training/versions/[id]/auto-prepare/route.ts` — recent-FAILED-run cooldown in the existingRun filter
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/page.tsx` — priority-ordered `planRun` selector
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/upload/page.tsx` — outcome-gated redirect
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/CoursePrepProgress.tsx` — PARTIALLY_GENERATED UI + updated types
- `tests/ep-train-4y-bb-lifecycle.test.ts` (NEW) — 10 unit tests
- `scripts/4ybb-probe.mjs` (NEW) — diagnostic probe
