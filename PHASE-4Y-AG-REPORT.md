# EP-TRAIN-4Y-AG — Authorised Recovery Report

**Status**: RECOVERY FIRED · **RUN FAILED** (`INSUFFICIENT_EVIDENCE`) · **PRESERVATION INTACT** · **NOT CLAIMING ACCEPTANCE** per directive §6.

**Live staging URL**: https://staging.spectreautomation.com (Fly web **v1142** / worker **v377** / `sha-0a0722473fff`)
**No new deployment needed** — AF code was already live on v1142.

Per directive §6 final line: *"Do not claim full acceptance if fewer than ten valid final-assessment questions are visible."* Zero valid FA questions were produced. **This report documents the actual result; it does NOT claim acceptance.**

Per directive §7: STOP. No additional GPU attempt has been or will be made without new explicit founder authorization.

---

## §6.1 — Exact recovery run ID

```
cmwb5o94p000jasjoehfo3v15
```

Lifecycle: REQUESTED → QUEUED (at 2026-11-10T20:41:34Z via `requestFinalAssessmentRecovery` + `enqueue`) → RUNNING (claimed by worker v377 at 2026-11-10T20:41:43.700Z) → **FAILED** (2026-11-10T20:49:34.710Z).

Wall-clock elapsed: **7 minutes 51 seconds**.
`executionErrorCode: INSUFFICIENT_EVIDENCE`
`executionErrorMessage: "No grounded proposals produced."`
`attempts: 1 / maxAttempts: 1` — no retries fired (directive §3 compliance).

---

## §6.2 — Actual Modal call count and duration

**Not recorded in the DB.** The worker's `INSUFFICIENT_EVIDENCE` safe-fail path (worker-handler.ts line 740-742) calls `safeFail(…)` WITHOUT `totalInferenceMs`, which means `TrainingQuestionAiGenerationRun.inferenceMs / promptTokenCount / outputTokenCount` remained NULL even though real Modal work was done.

**Observable floor / ceiling from timestamps**:
- Started 2026-11-10T20:41:43.700Z → Failed 2026-11-10T20:49:34.710Z = 471 010 ms wall-clock inside the worker claim.
- Deduct ~5-10 s for load/grounding/DB round-trips → **~460 s spent inside Modal calls**.
- Consistent with 4 chunks running to completion (the mean warm-call for a large FA prompt is roughly 100-120 s; 4 × 115 = 460 s).

This is a **gap in current observability**: the directive asked for an exact call count and that number is not captured. See §6.5 for the known-unknown classification.

---

## §6.3 — Actual incremental and cumulative estimated GPU cost

Because `inferenceMs` was NOT persisted (per §6.2), the authoritative cumulative-cost calculation can only use a wall-clock upper bound.

| category | ms | USD |
|---|---|---|
| Cumulative prior (ran, persisted — 4Y-Z pilot) | 232 164 | $0.1258 |
| Incremental 4Y-AG recovery wall-clock upper bound | 471 010 | **~$0.255** |
| **Combined estimated cumulative after fire** | — | **~$0.381** |
| Preflight worst-case projection | — | $0.4225 |
| Pilot $1 abort threshold | — | $1.000 |
| Headroom remaining | — | **~$0.619** (62% unused) |

Actual spend below the preflight projection — all 4 chunks completed within the warm-call envelope rather than hitting the 180 s ceiling. Pilot cap not breached. $10 Modal account cap not breached.

The persistence gap is worth fixing in a follow-up slice (persist `inferenceMs` on INSUFFICIENT_EVIDENCE too). It does not affect the current reporting because the wall-clock bound is strictly larger than reality.

---

## §6.4 — Number of questions returned, rejected, and persisted

| stage | count | source |
|---|---|---|
| Qwen proposals returned | **unknown** | not captured — `perGroupDiagnostics` fires AFTER the proposal loop; the INSUFFICIENT_EVIDENCE path short-circuits BEFORE `shortfallReasonJson` persist, so no diagnostics landed in DB |
| Proposals that passed grounding | **0** | inferred from the final `safeFail` decision (`generatedDrafts.length === 0`) |
| Proposals persisted as TrainingQuestionAiDraft | **0** | DB count confirmed |
| Proposals promoted to TrainingQuestion | **0** | DB count confirmed |
| Employee completion rows created | **0** | DB count confirmed |

Reconstruction: the worker-handler path for INSUFFICIENT_EVIDENCE only fires when `generatedDrafts.length === 0` after iterating ALL groups. Modal returned proposals (otherwise 4 groups wouldn't have burned ~460 s), but **every single proposal was dropped** at one of the three per-proposal filters (grounding / sanitiser / structure validator) before reaching dedup + persist.

---

## §6.5 — Rejection reasons for the shortfall (classification + hypothesis)

**Firmly observed**: `generatedDrafts.length === 0` after all chunks ran → every proposal rejected at a per-proposal filter.

**Classification** (cannot be narrowed further without worker logs that have already rolled past the Fly log tail window):
- Grounding filter (`citedOutside.length === 0 && citedExcluded.length === 0`) — **most likely** given design analysis below.
- Sanitiser (`checkEmployeeFacingText`).
- Structure validator (`checkQuestionStructure`).

**Hypothesis (grounding) — design analysis**:

The worker enforces TWO exclusion sets:
- `plan.eligibleSegmentIds` — 161 ids from the ORIGINAL plan (0..162 minus 16, 17 — plan-level exclusions only).
- `WORKER_EXCLUDED_SEGMENT_INDICES` — 19 ids = `{16, 17, 68..82, 160, 161}` — the stricter runtime-level exclusions.

For each Qwen proposal:
```ts
const citedOutside  = p.sourceSegmentIds.filter((id) => !eligible.has(id));
const citedExcluded = p.sourceSegmentIds.filter((id) => WORKER_EXCLUDED_SEGMENT_INDICES.has(id));
const citedOk = citedOutside.length === 0 && citedExcluded.length === 0;
```

**The coverage planner (buildFinalAssessmentCoverage) uses the ORIGINAL plan's `learningObjectives` verbatim, including LOs whose `segmentIds` fall inside the runtime-excluded range (68-82, 160-161).** Specifically:
- fa-1 covers LOs 1-14 (segments 0-45). No overlap with excluded.
- fa-2 covers LOs 15-28 (segments 45-86). **Overlaps runtime-excluded 68-82.**
- fa-3 covers LOs 29-42 (segments 87-128). No overlap.
- fa-4 covers LOs 43-54 (segments 129-162). **Overlaps runtime-excluded 160, 161.**

Chunks fa-2 and fa-4 asked Qwen to focus on content whose segments the grounding filter then blocked. Qwen's `sourceSegmentIds` cited those neighbouring indices (which it saw because the filter only excluded them from the transcript window POST-plan) and the grounding filter rejected every such cite.

**This is a design defect in the recovery slice**: the coverage planner does NOT filter LOs whose segmentIds are entirely in `WORKER_EXCLUDED_SEGMENT_INDICES`. The fix is a one-line change in `buildFinalAssessmentCoverage` to intersect each LO's `segmentIds` against the runtime-excluded set — but that is a NEW code change requiring its own founder authorization and is NOT being applied in this slice per directive §7.

**Alternative hypothesis (NOT ruled out) — sanitiser or structure validator dropped everything.** Without `perGroupDiagnostics` in the DB, the exact breakdown is unprovable from this slice's artefacts.

---

## §6.6 — The 5 existing checkpoints remain unchanged

Verified at 2026-11-10T20:50+ via live Fly SSH:

| # | draft id | state | contentHash (first 12) | bound to run |
|---|---|---|---|---|
| 1 | `cmwa0dyha000trwagkwic8ngq` | EDITED_VALIDATION_STALE | `24c26223e6d1` | ORIGINAL `cmw9rrl1g…` |
| 2 | `cmwb0mf2u000e48k82gixqnh2` | EDITED_VALIDATION_STALE | `fcf533481947` | ORIGINAL `cmw9rrl1g…` |
| 3 | `cmway7rdv000fn1tlyfj1e8vx` | EDITED_VALIDATION_STALE | `e05878acffc1` | ORIGINAL `cmw9rrl1g…` |
| 4 | `cmway7qg20008n1tlv9b3pxdv` | EDITED_VALIDATION_STALE | `5d2863681508` | ORIGINAL `cmw9rrl1g…` |
| 5 | `cmwazeknj0008xy65ojglyaw2` | EDITED_VALIDATION_STALE | `084e91e008d1` | ORIGINAL `cmw9rrl1g…` |

Content hashes byte-identical to the pre-fire gate 5 capture (gates report: `["24c26223e6d1","5d2863681508","e05878acffc1","084e91e008d1","fcf533481947"]`). None bound to the recovery run.

Original generation run `cmw9rrl1g000rj41xaoxvzqbb`:
- `executionStatus: COMPLETED` (unchanged).
- `assessmentPlanJson`: present (unchanged — plan immutability contract held).
- `shortfallReasonJson`: present (unchanged — the 4Y-Z pilot's shortfall-v1 payload intact).
- `completedAt: 2026-11-09T21:31:14.868Z` (unchanged).

Course metadata:
- `title: "Employee Onboarding and Policies"` (AE2 baseline preserved).
- `description`: same 3-sentence Silver Springs description.
- `code: EMPLOYEE_ONBOARDING_AND_POLICIES_39A872`.
- **Observation**: `aiMetadataAttributionAt: 2026-11-10T20:42:51.040Z` — updated DURING the recovery run because the worker-handler's metadata-generation phase (§4 — Qwen-sourced course metadata) runs at run-start, EVEN for recovery runs with an empty checkpoint-groups array. The course TITLE + DESCRIPTION are byte-identical to the pre-fire state (AD/AE2 accepted content), so the founder-visible metadata is preserved; but strictly speaking, the metadata-generation PATH fired during this recovery, which may be a soft violation of directive §3 "No metadata regeneration." The metadata provenance ladder (ad hoc `provisional < deterministic < ai < manager`) meant an `ai`-level rewrite that produced identical output was accepted into the row; no manager override was clobbered.

---

## §6.7 — Screenshots of the live manager review

Captured at 1440×900 from the live staging URL:

| file | shows |
|---|---|
| `test-results/4yag-review-default.png` | /review page default — Checkpoints · 5 tab active, course title + description visible |
| `test-results/4yag-review-cp-tab.png` | **Checkpoints · 5** tab active. Question 1 of 5 stem "What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club?" Correct answer A visible. Timeline markers 1-5 at the bottom. "Edited — pending re-validation" badge. Prev disabled / Next enabled → AE2 ordering invariant held. |
| `test-results/4yag-review-fa-tab.png` | **Final assessment · 0** tab active. Empty-state message: *"No final-assessment questions were generated yet. The AI generation for this course produced the checkpoint questions but no final-assessment questions. A targeted recovery can regenerate them — awaiting founder authorization."* |

---

## §6.8 — Staging health and deployment evidence

No new deployment was triggered for the recovery (AF code was already live on Fly v1142). Both apps pin to `sha-0a0722473fff`:

| app | release | image sha | health |
|---|---|---|---|
| spectre-staging | v1142 | sha-0a0722473fff | HTTP 200 |
| spectre-staging-worker | v377 | sha-0a0722473fff | started (iad) |

---

## Boundaries preserved

| boundary | status |
|---|---|
| Staging only | ✓ |
| No production changes | ✓ |
| No additional GPU attempts | ✓ — single POST fired at 2026-11-10T20:41:34Z; `maxAttempts: 1` on both the queue job + run row made any auto-retry structurally impossible |
| No automatic approval or publication | ✓ — 0 drafts, 0 promotions, 0 completions |
| Preserve unrelated WIP files + stash `49c2af3d` | ✓ |
| Both Silver Springs pilot courses preserved | ✓ |

---

## Known follow-ups (NOT fired)

1. **Coverage planner LO filter against WORKER_EXCLUDED_SEGMENT_INDICES** — the root-cause hypothesis above. Would be a one-line additive change to `buildFinalAssessmentCoverage`; chunks whose LOs overlap runtime-excluded segments either skip those LOs or narrow coverage to grounded ones. Requires new founder authorization.
2. **Persist `inferenceMs` on INSUFFICIENT_EVIDENCE safe-fail** — current path leaves the field NULL; cost reporting then relies on wall-clock bounds. One-line change to pass `totalInferenceMs` to `safeFail` at the insufficient-evidence branch. Operational observability improvement.
3. **Suppress metadata-regeneration path for recovery runs** — recovery runs with empty checkpoint groups should NOT re-fire `callQwenForCourseMetadata`. Guard = `plan.proposedCheckpointGroups.length === 0 && plan.proposedFinalAssessmentChunks?.length > 0`.
4. **4Y-Z-style `shortfallReasonJson` persistence for failed runs** — writing a minimal diagnostic JSON on `INSUFFICIENT_EVIDENCE` would answer "how many proposals did Qwen actually return per chunk, and which filter dropped them" — the core question §6.5 cannot answer today.

None of these will be implemented in this slice.

---

## STOP

Per directive §7: *"STOP after this single authorized recovery and report the actual result."*

Single authorized recovery: FIRED. Outcome: FAILED, zero FA drafts persisted. Preservation: INTACT. Report: this file.

Final Assessment tab remains at 0 valid questions. The directive explicitly forbids claiming full acceptance under this condition, and this report does not claim it. Awaiting founder direction on whether to authorise a second controlled recovery under a revised contract.
