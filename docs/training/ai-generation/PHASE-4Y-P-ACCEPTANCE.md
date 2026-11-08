# EP-TRAIN-4Y-P (Slice 1) — Provenance Repair + Canonical Editor Integration

**Status:** ✅ **ACCEPTED (slice 1 of a multi-slice directive — see §2 for deferred items)**
**Date:** 2026-11-08
**Branch / commit:** `ep-train-4y-b-impl/hybrid-auth-contract` @ `3e88820f`
**Staging deploy branch:** `staging-deploy/4yp-provenance-repair-and-editor-integration`
**Staging Fly releases:** web **v1108** / worker **v344** / image `sha-3e88820ff5c0`
**Modal deploys:** `spectre-training-generate` **v6** (unchanged from 4Y-N)

**No new inference.** The 51 persisted drafts (37 4Y-N + 6 4Y-M +
8 historical) are not rewritten by this slice — the backfill only
adds `TrainingGroundingProjection` + `TrainingQuestionAiValidation`
rows and sets each draft's `groundingProjectionId` FK; draft content,
`contentHash`, state and `generatedAt` are untouched.

---

## §1 Why this slice

4Y-O proved two code-level blockers:

1. The worker never created `TrainingQuestionAiValidation` rows —
   every modern-pipeline draft stayed `VALIDATION_ROW_MISSING`.
2. The worker never linked `groundingProjectionId` — the evidence
   reader classified 4Y-N drafts as `historical-unavailable`,
   surfacing the misleading *"imported from the EP-TRAIN-6C pilot"*
   banner on actually-4Y-N content.

Both are fixed in this slice.

---

## §2 Scope — what shipped vs deferred

### Shipped in slice 1 (this commit)
- **§6 forward-fix** — `worker-handler.ts` now creates a
  `TrainingGroundingProjection` row + a `TrainingQuestionAiValidation`
  row per draft on every future run.
- **§6 backfill service + API** — same code path is reusable as
  `backfillRunProvenance(runId)` and surfaced via `POST
  /api/admin/training/backfill-run-provenance`. Idempotent at both
  the projection and per-draft layer.
- **§4 / §5 editor integration (minimum)** — new
  `AiSuggestionsPanel` server component rendered in the canonical
  `/app/admin/people/safety-training/<cId>/<vId>` editor.
- **§2 legacy AI Workspace de-emphasised** — the primary editor
  link to `/ai-workspace` is downgraded from a full-weight
  underlined CTA to a muted 11-px "Legacy AI workspace" affordance.

### Deferred (follow-up slices will each need separate founder auth)
- §3 auto-start AI pipeline on video upload (idempotent via
  `videoSha256`). The code path exists via `POST /generate`; the
  hook into `VideoUploader`'s completion handler is a UX design +
  implementation item.
- §7 wiring the Reject / Edit / Revalidate stubs in
  `PersistedReviewWorkspace`. The lifecycle supports
  `REVIEWER_REJECTED` (lifecycle.ts:63) but no route emits it yet.
- §9 preview-as-employee flow. The employee runtime requires an
  `EmployeePortalPrincipal`; a disposable admin → preview-principal
  bridge is a non-trivial impersonation service.
- TimelineEditor + QuizEditor refactor to embed AI drafts INLINE on
  the video timeline (vs the current "list + navigate" approach).

---

## §3 §6 repair — live evidence

### 3.1 worker-handler.ts forward-fix
Before the draft-persist loop, the worker now calls
`materialiseGroundingProjection` (idempotent upsert on
`(clubId, courseVersionId, sha256)`). Each draft is then persisted
with `groundingProjectionId` bound to the new row id. After all
drafts persist, the worker synthesises a `PilotAuthorizationV1` from
the run's recorded identity + calls `materialiseValidationForDraft`
per draft. Safe-fallthrough: if either materialisation fails, the
run still COMPLETES (matches pre-4Y-P behaviour for that draft only).

### 3.2 Backfill against 4Y-N — PASS
```
POST /api/admin/training/backfill-run-provenance
     { "runId": "cmw81ns5c0007am48fco9zxwa" }
```
| Field | Value |
|---|---|
| projectionRowId | `cmw84xbdq0007lflo2en6m2z6` |
| projectionSha256 | `23718b8e49fe1ddc3994bfd198ae7a0bcd0162ef10cdc51334eda9f575789115` |
| draftsProcessed | **37** |
| draftsAlreadyBound | 0 (first run) |
| validationsCreated | **37** |
| Verdict distribution | `{"REJECTED": 37}` — see §3.5 |
| Errors | 0 |

### 3.3 Backfill against 4Y-M — PASS
```
POST /api/admin/training/backfill-run-provenance
     { "runId": "cmw79mrgj000v2tas9oi2caq4" }
```
| Field | Value |
|---|---|
| projectionRowId | `cmw84xbdq0007lflo2en6m2z6` (SAME row — both runs share the video + transcript + eligible-segments) |
| projectionSha256 | `23718b8e49fe…` (same) |
| draftsProcessed | **6** |
| draftsAlreadyBound | 0 |
| validationsCreated | **6** |
| Verdict distribution | `{"REJECTED": 6}` |
| Errors | 0 |

### 3.4 Idempotency — PASS
Replay of the 4Y-N call:
```json
{ "draftsProcessed": 0, "draftsAlreadyBound": 37, "validationsCreated": 0 }
```
Second invocation is a no-op. Safe to re-call.

### 3.5 Verdict = REJECTED is a TRUTHFUL safety signal
All 43 validations returned `REJECTED` at the `CONVERT` stage with
error code **`ERR_CONVERT_SEGMENT_PENDING_REVIEW`**:
> *"draft cites segment N that carries pending-review flag(s)"*

This is not a slice failure — it is the 6C-10B converter correctly
refusing to ground questions on transcript segments whose Whisper
confidence marked them `pendingReview`. Pre-4Y-P the entire
validation layer was silent; drafts were implicitly "unvalidated"
but the UI couldn't say WHY. 4Y-P exposes the real reason.

Follow-up work (deferred, needs founder authorisation):
- Either clear `pendingReview` flags on the orientation transcript
  segments (requires a dedicated transcript review surface), OR
- Extend the approver workflow to let a reviewer attest to evidence
  and override the `pendingReview` gate.

Both are legitimate follow-up slices. For 4Y-P purposes, the §6
repair is PROVEN: artefacts exist, evidence-reader classification
flipped, and the reviewer-eligibility gate's blockers have shifted
from "silent historical-unavailable" to "explicit validation errors
visible in the UI."

Sample draft + error pair captured live from staging:
```
draft cmw823mnj009nuakplpldsti7
  questionText: "What is the recommended action if a team member
                 encounters an issue with the club according to the…"
  options:   [{"text":"Enforce the three-strike policy","isCorrect":false},
              {"text":"Have a sit-down to resolve the issue","isCorrect":true}]
  sourceSegmentIds: [9]
  verdict: REJECTED / stage: CONVERT
  validator: 6c-10b source integrated-pipeline
  error: ERR_CONVERT_SEGMENT_PENDING_REVIEW
         — draft cites segment 9 that carries pending-review flag(s)
```

### 3.6 Evidence-reader classification flipped — PASS
Playwright navigated into one 4Y-N draft via the canonical editor →
persisted-review surface. After backfill:
```
HISTORICAL_BANNER_PRESENT_AFTER_BACKFILL: false
```
The *"HISTORICAL EVIDENCE UNAVAILABLE — This candidate was imported
from the EP-TRAIN-6C pilot"* banner that 4Y-O documented is GONE.
Evidence reader follows the `authentic` branch because
`draft.groundingProjectionId` is now non-null.

---

## §4 §4 + §5 canonical editor integration

### 4.1 AiSuggestionsPanel observed in screenshot
At 1600×1100 the canonical editor
(`/app/admin/people/safety-training/<cId>/<vId>`) now renders
(top → bottom):
1. **Course content** (form with title / description / passing-score / toggles)
2. **Who needs to complete this?**
3. **Training video** (`VideoUploader` with the 10m42s orientation video)
4. **AI-assisted authoring** ← _new in 4Y-P_ with four state tiles:

| Tile | Live value (captured from Playwright run) |
|---|---|
| Transcript | **READY · 163 segments** · `faster-whisper · Nov 8, 3:17 AM` |
| Latest generation run | **COMPLETED · 37 drafts** · `cmw81ns5c0007am48fco…` |
| Drafts awaiting review | **48 pending** (0 approved · 3 rejected) |
| Provenance | **43/51 projection · 51/51 validated** · "No draft promoted yet" |

Followed by a `<details>` toggle "Review 48 pending AI-generated
questions" that expands to a list of per-draft rows, each with an
"Open review" link into the existing persisted-review surface.

5. **Interactive checkpoints** (empty — awaits the manager authoring)
6. **Final assessment** (empty — awaits the manager authoring)
7. **Publish** (readiness panel correctly flags *"Final assessment
   requires at least one active question"*)

### 4.2 Legacy AI Workspace link de-emphasised
The former bold `Open AI workspace →` CTA in the version-header is
replaced with a muted 11-px underlined `Legacy AI workspace`
affordance (the editor header now reads `Legacy AI workspace`
followed by the `Draft v1` state badge, right-aligned).

### 4.3 Screenshots
- [test-results/4yp-01-canonical-editor-with-ai-panel.png](../../../test-results/4yp-01-canonical-editor-with-ai-panel.png)
- [test-results/4yp-02-canonical-editor-ai-panel-detail.png](../../../test-results/4yp-02-canonical-editor-ai-panel-detail.png)
- [test-results/4yp-03-canonical-editor-ai-pending-expanded.png](../../../test-results/4yp-03-canonical-editor-ai-pending-expanded.png)
- [test-results/4yp-04-persisted-review-after-backfill.png](../../../test-results/4yp-04-persisted-review-after-backfill.png)
- [test-results/4yp-05-canonical-editor-mobile.png](../../../test-results/4yp-05-canonical-editor-mobile.png)

### 4.4 Mobile responsive
390 × 844 viewport: the four state tiles stack vertically (1-col
grid), the pending-draft list remains readable, and the editor's
existing responsive behaviour is unchanged.

---

## §5 Tests + validation

- `tests/ep-train-4yc-worker-handlers.test.ts` — **13/13 PASS** with
  the new mocks for `trainingGroundingProjection.upsert`,
  `trainingQuestionAiValidation.create`,
  `trainingQuestionAiDraft.findUnique` + `.update`.
- Pre-existing suites: **75/75 PASS** across `6d4w-generation-service`,
  `6d4m-evidence-reader-contract`, `6d4w-assessment-plan`,
  `4y-n-context-generation`.
- Typecheck: clean on all touched production files.
- DRH-1 deploy run `42506245284` — **SUCCESS**, web v1108 / worker
  v344 / sha-3e88820ff5c0, `/api/health` → 200.
- Playwright `tests/e2e/ep-train-4y-p-acceptance.staging.spec.ts` —
  **1 passed in 1.1m**.

---

## §6 Four-axis classification — AFTER slice 1

| Axis | Before 4Y-P | After 4Y-P slice 1 |
|---|---|---|
| AI generation | ACCEPTED (per 4Y-N) | ACCEPTED (unchanged) |
| Human review | BLOCKED (`VALIDATION_ROW_MISSING` + `HISTORICAL_EVIDENCE_UNAVAILABLE`) | **UNBLOCKED structurally** — both artefacts now exist; the current eligibility blocker is `VALIDATION_HAS_HARD_ERRORS` (truthful + visible), not silent missing data |
| Course assembly | BLOCKED downstream | Still gated on reviewer action + editor-authored checkpoints |
| Employee preview | BLOCKED (no preview-as-employee flow) | Still BLOCKED — deferred to a follow-up slice |
| Founder-testable | PARTIAL (discovery required navigating off the canonical editor) | **IMPROVED** — AI state + per-draft discovery is inline in the canonical editor; the manager no longer needs to open the Legacy AI Workspace for discovery |

The structural blockers to review (missing validation + missing
projection) are repaired. The remaining blocker to approval is now
semantic (the orientation video's transcript segments carry
`pendingReview` flags from Whisper), which is a legitimate
reviewer-attestation / transcript-review decision — not a code gap.

---

## §7 STOP compliance

- ✓ No new Whisper or Qwen inference (Modal v6 unchanged)
- ✓ No production changes
- ✓ No deletion or modification of historical AI drafts (the 8 historical
  rows had pre-existing validations + remain with null `groundingProjectionId`
  — correct, they were from a different pilot era)
- ✓ No rewriting of the accepted transcript (segments immutable)
- ✓ No automatic approval of generated questions (all drafts remain
  `REQUIRES_HUMAN_REVIEW`; all validations are REJECTED by the
  deterministic converter — that's TRUTHFUL, not a skip)
- ✓ No bulk promotion
- ✓ No publication
- ✓ No employee assignments
- ✓ No Modal spend-limit changes ($10 UNCHANGED)
- ✓ No unrelated UI redesign
- ✓ 126 WIP files preserved
- ✓ Stash `49c2af3d` untouched

---

## §8 Founder-testable staging URL

`https://staging.spectreautomation.com/app/admin/people/safety-training/cmvzs3vz9000256qcu7lfysoz/cmvzs3w05000456qcgfgps7gy`

The canonical editor now shows the AI-assisted authoring panel
inline. The manager no longer needs to open a separate AI Workspace
to discover transcript state, run state, or pending AI-generated
drafts. Clicking "Review N pending AI-generated questions" expands
an inline list; each row's "Open review" link opens the persisted-
review surface with the full question + evidence + approve controls.

---

## §9 Follow-up slices (each needs separate founder authorisation)

1. **§3 auto-start AI pipeline on video upload.** Hook into
   `VideoUploader` server action completion: dispatch transcribe
   via BG queue, then on transcript COMPLETED dispatch generate.
   Key-off `videoSha256` for idempotency so a refresh / retry can't
   double-run inference.
2. **§7 wire Reject / Edit / Revalidate stubs.** Lifecycle supports
   `REVIEWER_REJECTED`; need a route (`POST .../reject`) + a
   dedicated `rejectDraft` service method with audit. Edit requires
   a draft-content-update route that writes a new `TrainingQuestionAiDraft`
   row with a `supersedesDraftId` link (the schema already supports
   this).
3. **§3.5 clear `pendingReview` flags on the Silver Springs
   orientation transcript segments** OR add a reviewer-attestation
   override path. Without one of these, no 4Y-N / 4Y-M draft can
   pass the converter and reach `GROUNDED`.
4. **§9 preview-as-employee flow.** Admin-side bridge that boots
   the employee runtime with a disposable preview-principal that
   doesn't record completions.
5. **TimelineEditor + QuizEditor refactor** to embed AI-proposed
   checkpoints directly on the timeline + AI-proposed final-assessment
   questions directly in the assessment section, vs the current
   AiSuggestionsPanel list.

Each of these is a legitimate, self-contained slice. Slice 1
(4Y-P) was deliberately scoped to the unlockers (§6 repair + editor
integration MVP) so subsequent slices have a stable baseline to
build on.
