# EP-TRAIN-6D-4X — Automatic Knowledge-Checkpoint Placement — Design

Status: **IMPLEMENTATION COMPLETE — OFFLINE.**
Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4x/placement-and-dedup` (local commit; not pushed, not
deployed, no Modal/Qwen/GPU call).

## 1. Problem

4W's baseline placement (`buildBaselineAssessmentPlan`) divided the
video into equal intervals and dropped a checkpoint on each. It was
a deterministic placeholder; it did not respect topic boundaries,
pauses, or sentence integrity. §5 of the 4X directive requires the
system to propose checkpoints:

- *After the relevant instructional content has been presented.*
- *At natural topic boundaries or pauses.*
- *Without interrupting an incomplete sentence.*
- *With sufficient spacing for a usable employee experience.*
- *Within the actual video duration.*
- *With traceable segment IDs and timestamps.*
- *Without using excluded or unverified transcript segments.*
- *Each proposal must explain why that timestamp is appropriate.*

## 2. Approach

[src/lib/hr/training/generation/placement.ts](../../src/lib/hr/training/generation/placement.ts) implements
`buildTopicAwareAssessmentPlan` — a pure, deterministic function
that consumes transcript segments (with `startSec` + `endSec` +
`text`) and returns an `AssessmentPlanV1` whose
`proposedCheckpointGroups` and `topicBoundaries` fields are
populated from three independent boundary-detection signals.

The function is pure. Same input → same output. The service layer
calls it; the worker handler re-validates the plan it carries.

### 2.1 Signals

Each adjacent-segment pair is tested against three signals. Any one
signal is sufficient for a boundary; the rationale records which
signals fired.

| Signal | Rule | Threshold constant |
| ------ | ---- | ------------------ |
| `PAUSE` | `next.startSec - cur.endSec > PAUSE_SEC` | `PAUSE_SEC = 0.5` |
| `SENTENCE` | current text ends with `.` / `!` / `?` AND next text begins with uppercase | `SENTENCE_TERMINATORS = {".", "!", "?"}` |
| `DRIFT` | `1 - jaccard(prevWindow, nextWindow) > DRIFT_THRESHOLD` where each window is the token-set of `DRIFT_WINDOW` segments | `DRIFT_THRESHOLD = 0.55`, `DRIFT_WINDOW = 3` |

Tokens for DRIFT are lemma-normalised lowercased alphanumerics with
stopwords removed (same corpus as dedup).

### 2.2 Grouping into learning objectives

Contiguous eligible segments between detected boundaries form one
`AssessmentPlanLearningObjective`. The first LO's title is the
leading 120 characters of its first segment (deterministic, no LLM
call).

### 2.3 Placement constraints

Each LO proposes a candidate checkpoint at the `endSec` of its last
segment, then filtered by:

| Constraint | Rule | Constant |
| ---------- | ---- | -------- |
| Lead-in | `candidate.atSec >= MIN_LEAD_IN_SEC` | 30s |
| Tail | `candidate.atSec <= videoDurationSec - MIN_TAIL_SEC` | 10s |
| Spacing | `candidate.atSec - prevPlaced.atSec >= MIN_SPACING_SEC` | 15s |

A candidate rejected for spacing increments
`shortfalls["SPACING_FORCED_FEWER_CHECKPOINTS"]` so the final plan
reports why it has fewer checkpoints than LOs.

### 2.4 Rationale on every placement

Each placed checkpoint carries `rationale` naming the LO it closes +
the boundary signal(s) that chose its timestamp. Downstream review
UIs can surface the exact reason the system proposed each position.

### 2.5 Count split

Default 30 % / 70 % checkpoint / final allocation of
`targetTotalQuestions`. If the plan places `N` checkpoint groups but
the ideal checkpoint target is `K > N × 2`, the groups are each
assigned `≥ 1` question; the final absorbs any overflow. A group
whose rebalanced target drops to zero is culled.

Final-assessment coverage spans ALL LOs even those that didn't get a
checkpoint, so every topic is addressable from the final.

### 2.6 Rules version

Every placement decision carries `rulesVersion = "placement-v1"`.
Future threshold / signal changes bump the version. Persisted plans
carry the version implicitly (through the thresholds encoded in
their geometry).

## 3. Permanent Staff Orientation exclusion

`EXCLUDED_SEGMENT_INDICES = Object.freeze(new Set([16, 17]))` is
mirrored from `assessment-plan.ts`. Any segment in that set is
dropped from eligible segments BEFORE boundary detection — it never
contributes to a learning objective, never terminates one, and never
gets cited.

## 4. Fallback behaviour

### 4.1 No eligible segments

The plan still constructs with a single placeholder LO (`lo-1`,
title `"No eligible segments"`) and zero target questions. The
service rejects such a plan at REQUESTED time via the existing
`PLAN_INVALID` branch — there's nothing to generate against.

### 4.2 Video too short for lead-in + tail

If `videoDurationSec <= MIN_LEAD_IN_SEC + MIN_TAIL_SEC` (40s),
checkpoints are not placed. The plan still carries LOs + the full
target in the final assessment. Shortfall records
`DURATION_TOO_SHORT`.

### 4.3 Admin route fallback

The admin `/api/admin/training/versions/[id]/generate` route calls
`buildTopicAwareAssessmentPlan` first. If the topic-aware plan
produces zero LOs with any segments (pathological transcript), the
route falls back to the 4W `buildBaselineAssessmentPlan` so the
operator can still request a run. The fallback is logged implicitly
through the plan's `topicBoundaries` field being empty.

## 5. Tests

[tests/ep-train-6d4x-placement.test.ts](../../tests/ep-train-6d4x-placement.test.ts) — 13
contract tests covering:

- Boundary detection: pause, sentence, drift, no-signal (negative).
- Plan builder: count sum, min lead-in, min tail, min spacing,
  segment 16/17 exclusion, duration-too-short shortfall,
  no-eligible-segments shortfall, determinism, rationale naming.

## 6. STOP boundaries

- No new table. No new column. No new schema change.
- No new paid AI provider. No new embedding model. No persistent
  vector index.
- No Modal call. No GPU activation. No publication. No auto-approval.
- Staff Orientation pilot segment 16/17 exclusion preserved.
- 126 unrelated WIP files preserved.
- No deployment.
