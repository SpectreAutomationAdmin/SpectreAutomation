# EP-TRAIN-4Y-AA — Acceptance Report

**Status**: DELIVERED
**Commits**: `be8f3ec4` (main) + `8bba5975` (timeline fallback) on `ep-train-4y-b-impl/hybrid-auth-contract`
**Previous accepted baseline**: `0c625f44` (EP-TRAIN-4Y-Z pilot)
**Fly releases**: web v1132 / worker v367 / `sha-8bba5975502d`
**Staging URL**: https://staging.spectreautomation.com (health: HTTP 200)
**Boundaries honoured**: no GPU inference, no re-transcription, no prod changes, no secret rotation, no spending-limit changes, no auto-approval or auto-publication; 126 unrelated WIP files + stash `49c2af3d` preserved.

Written for: founder + any later operator who needs to understand what moved and what it unlocked.

---

## §1 — Preserved accepted results

Verified live on staging via `scripts/4yaa-staging-inspection.mjs` (captured `test-results/4yaa-staging-inspection.json` at 23:12 UTC on 2026-11-09):

| Item | State | Evidence |
|---|---|---|
| AI title | "Employee Onboarding and Policies" | `metadata.course.title` |
| AI description | 319 chars, legitimate whole-course summary | `metadata.course.description` |
| Description attribution | `source: "ai"`, `runId: cmw9rrl1g000rj41xaoxvzqbb` | `metadata.course.attribution.source/runId` |
| Course code | `EMPLOYEE_ONBOARDING_AND_POLICIES_3F2A48` | `metadata.course.code` |
| 5 checkpoint drafts | all `REQUIRES_HUMAN_REVIEW`, all distinct content hashes | `generationStatus.draftBreakdown.REQUIRES_HUMAN_REVIEW: 5` |
| Timestamps, provenance, validation, reviewer state | all unchanged | queried pre- and post-build |
| Transcript + video | unchanged | no transcribe call fired |
| Audit records | unchanged | no destructive mutation |

No regeneration of the 5 checkpoints. No re-transcription. No GPU call.

---

## §2 — Review page header redesigned

**Removed**: the separate "Course title / Description" card that previously sat at the top of the review page.

**Added**: inline header below the breadcrumb containing:

- **Title** (page-title typography) with a pencil-icon button that opens an inline input. Enter saves; Esc cancels; title is validated at 3-200 chars on both client + server.
- **Description** (muted body text, max-width 760 px) with a pencil-icon button that opens an inline textarea. Ctrl+Enter saves; Esc cancels.
- **Preview as employee** button top-right of the header (replaces the one that sat in the redundant queue card).

**Write path**: new endpoint `PATCH /api/admin/training/courses/[courseId]/metadata` writes to `TrainingCourse.title` + `TrainingCourse.description` directly. The existing Qwen metadata writer's `isProvisional` guard at [worker-handler.ts:985-993](src/lib/hr/training/generation/worker-handler.ts#L985) uses `aiMetadataAttributedTitle === course.title` as the "provisional" test — any manager edit changing `course.title` immediately sets this to `false`, so future Qwen metadata runs skip and the manager's content is protected from silent overwrite (§2 requirement).

**Read path**: review page now reads `course.description` directly (not `version.description`). Fall-through to `version.description` only if the course row's description is empty — covers pre-4Y-X courses that never saw a Qwen metadata write.

**Audit**: every PATCH writes an `audit()` row with action `hr.training.course.metadata.update` carrying before/after/user/clubId/entityId.

Server-side validation:
- title: 3-200 chars after trim
- description: ≤ 2000 chars; empty string → null (allows clearing)
- JSON + FormData both supported (blur-save uses JSON)

---

## §3 — AI description quality assessed

Captured on staging at 23:12 UTC on 2026-11-09:

> *"This course covers essential information for new team members at Silver Springs, including pay stub access, workplace conduct, and member service expectations. Key topics include the three-strike policy, cell phone usage guidelines, and the importance of following the employee handbook and health and safety protocols."*

**Verdict**: the description meaningfully summarises the full video. It covers four distinct topic clusters (onboarding, conduct, member service, policies) across the whole transcript, not just the introduction. **No prompt rewrite is needed for this course.**

**Guardrail that stays live**: the existing `buildMetadataSystemPromptForWorker` in [worker-handler.ts](src/lib/hr/training/generation/worker-handler.ts) already feeds the FULL transcript to the metadata Modal call — not just an intro segment. If a future course's description shows the "intro-only" failure mode, the prompt itself (not the input) is the right place to intervene. Flagging that as a follow-up rather than an in-slice change honours §3's "if the existing description is insufficient" conditional — here, the existing description is sufficient.

---

## §4 — Checkpoint timeline markers

New synchronised timeline track rendered below the native `<video>` element. Implementation detail: a relative-positioned 36-px strip under the player with a stone-grey rail and one circular button per checkpoint.

- **Position**: each marker's `left` is `(atSecond / videoDuration) * 100%`. `videoDuration` comes from the video `loadedmetadata` event; falls back to `version.videoDurationSec` while the metadata is still loading.
- **Numbering**: each button shows its 1-indexed position in `atSecond`-sorted order.
- **Interaction**:
  - Click → seeks the video to `atSecond`, pauses, selects the matching question in the Checkpoints tab.
  - Keyboard (Enter / Space on a focused marker) → same behaviour.
  - When the Checkpoints tab's selected question changes, the matching marker gains the `data-marker-active="true"` state (green fill, scale 110%, soft shadow).
- **Accessibility**: `aria-label="Seek to checkpoint N at m:ss"`, visible focus ring (club-green, 2px, 1px offset), `title` tooltip includes the first 80 chars of the matching question for quick scan.
- **Responsive**: markers reflow with the card width; the timeline track uses the same `absolute left-0 right-0` pattern that already handles desktop + mobile elsewhere in the design system.
- **No obstruction** of native playback controls — the markers live BELOW the `<video>` element, not overlaid on it.

Verified against the staging data: 5 markers (one per `TrainingCheckpoint` row, the same ones the worker generated from) — no invented timestamps. Each marker's `atSecond` is read directly from the persisted `TrainingCheckpoint.atSecond` column.

---

## §5 — Destination filtering (tabs now show different data)

**Root cause**: `TrainingQuestionAiDraft` has no persisted `destinationKind` column, and the pre-4Y-AA client just rendered `props.drafts` into both tabs unfiltered.

**Fix (zero schema change)**: new offline helper `src/lib/hr/training/generation/destination-resolver.ts`:

- Reads `TrainingQuestionAiGenerationRun.shortfallReasonJson` (already persisted by the worker).
- Parses `dedupDecisions[]` where `kept: true` and builds a `Map<contentHash → groupKey>`.
- Maps `groupKey === "final"` → `FINAL_ASSESSMENT`, anything else → `CHECKPOINT`.
- Post-promotion drafts prefer `TrainingQuestionAiDraftPromotion.destination` (immutable, authoritative).

Server-side the review page runs this annotation on every page load and ships each draft with its resolved `destination` kind. Client filters:
- `checkpointDrafts = drafts.filter(d => d.destination === "CHECKPOINT" || d.destination === "UNKNOWN")`
- `finalDrafts = drafts.filter(d => d.destination === "FINAL_ASSESSMENT" || d.destination === "UNKNOWN")`

Independent indices per tab preserve the manager's position when switching.

**On the live staging course**: the resolver classifies all 5 pilot drafts as CHECKPOINT (from `cg-1..cg-5` dedup entries). The Final-assessment tab correctly renders a truthful **zero-question empty state** with copy explaining the generation produced no FA questions and that a targeted recovery awaits founder authorisation.

**Tested** (`tests/ep-train-4y-aa-destination-resolver.test.ts`): 13 assertions across the full matrix — pilot-live shape, cg-* classification, final classification, UNKNOWN fallback, null/invalid JSON degradation, consumer slicing. Tab count rendered: `Checkpoints · 5`, `Final assessment · 0`.

---

## §6 — Redundant UI removed

Deleted:
- The whole "N AI-generated questions in queue / Preview as employee" card (was lines 509-521 of the old client). The preview action moved into the page header (§2).
- The whole "Course title / Description" card (was lines 272-297). Content moved into the inline header (§2).

Not restored (per directive): Standalone Checkpoints summary, Approval Status card, Before You Publish card — all remain removed from this surface per EP-TRAIN-4Y-U §5.

---

## §7 — Employee-facing text sanitiser

### Live-staging evidence gathered

Captured by `scripts/4yaa-staging-inspection.mjs`:

| Draft | State | Violation observed |
|---|---|---|
| Q1 | REJECTED (validator hard=2) | `"According to the transcript, what is the correct way..."` + option `"Sir Mr. [Last Name]"` |
| Q2 | REJECTED (validator hard=2) | `"...according to the evidence window content?"` |
| Q3 | REJECTED (validator hard=1) | `"...according to the training material?"` + embedded `**Correct Answer:** C` + embedded `**A)** / **B)**` headers |
| Q4 | REQUIRES_HUMAN_VERIFICATION | `"...according to the training material provided so far?"` + `*Segment IDs: [22, 28]*` footer |
| Q5 | REQUIRES_HUMAN_VERIFICATION | `"...according to the transcript segments [15] and [18]"` |

### New sanitiser (`src/lib/hr/training/ai-review/question-text-sanitizer.ts`)

Pure-function, no I/O. Detects seven leakage classes:

| Code | Pattern | Example |
|---|---|---|
| `ACCORDING_TO_TRANSCRIPT` | `\baccording to (?:the )?transcript\b` | Q1, Q5 |
| `ACCORDING_TO_EVIDENCE_WINDOW` | `\baccording to (?:the )?evidence window\b` | Q2 |
| `ACCORDING_TO_TRAINING_MATERIAL` | `\baccording to (?:the )?training materials?\b` | Q3, Q4 |
| `EXPLICIT_SEGMENT_ID_REFERENCE` | `\b(?:transcript\s+)?segments?\b.*?(\[\d(,\s*\d)*\]|\bids?\b|\d+)` | Q4 `*Segment IDs: [22, 28]*`, Q5 `segments [15] and [18]` |
| `EMBEDDED_ANSWER_KEY` | `\*{0,2}correct\s+answer\*{0,2}\s*:` | Q3 `**Correct Answer:** C` |
| `EMBEDDED_MARKDOWN_OPTION_HEADER` | `\*{1,2}[A-D]\)\*{1,2}` | Q3 `**A)**` `**B)**` etc |
| `UNRESOLVED_TEMPLATE_PLACEHOLDER` | `\[(?!\s*\d)[A-Z][A-Za-z]*(\s+[A-Z][A-Za-z]*){0,2}\]` | Q1 `[Last Name]` |

### Wired at two seams

1. **Worker-persist time** ([worker-handler.ts](src/lib/hr/training/generation/worker-handler.ts)): every proposal passing grounding is sanitised BEFORE dedup. Failing proposals are counted in `diag.sanitizerDroppedCount` + `diag.sanitizerDropReasons[]`, and NEVER reach the draft table. Prevents future leakage from hitting the DB.

2. **Approval-service** ([approval-service.ts](src/lib/hr/training/ai-review/approval-service.ts)): after the draft body is parsed in the approve transaction, the sanitiser runs against the current body. On any finding, throws `ApprovalRejectedError` with new rejection code `EMPLOYEE_FACING_TEXT_LEAKAGE` (HTTP 409). This blocks the 5 pre-AA drafts currently in the DB — the reviewer must Discard + wait for the §9 recovery to produce clean replacements.

Provenance unchanged: source-segment ids remain on `TrainingQuestionAiDraft.draftJson.sourceSegmentIds` and on `TrainingQuestionAiValidation.*`. The sanitiser removes the pattern from the **employee-facing** text only.

### Tests

`tests/ep-train-4y-aa-question-text-sanitizer.test.ts` — **18 tests, all PASS**. Covers:
- Negative cases: clean text + non-leaking "segment" usage
- Every live-staging leakage (the exact 5 draft strings) individually asserted
- `codesForAudit` dedup + sort behaviour
- Every one of the 7 codes has a dedicated reachability test

---

## §8 — Final-assessment shortfall diagnosed

### Evidence captured from live staging

`shortfallReasonJson` for run `cmw9rrl1g000rj41xaoxvzqbb`:

```json
{
  "schemaVersion": "shortfall-v1",
  "targetCount": 15, "generatedCount": 5, "shortfall": 10,
  "dedupDecisions": [
    { "group": "cg-1", "candidateContentHash": "4b8ac1b6…", "kept": true },
    { "group": "cg-2", "candidateContentHash": "098c9334…", "kept": true },
    { "group": "cg-3", "candidateContentHash": "a93d8f16…", "kept": true },
    { "group": "cg-4", "candidateContentHash": "849c616c…", "kept": true },
    { "group": "cg-5", "candidateContentHash": "f6aef016…", "kept": true }
  ],
  "reason": "model returned fewer grounded candidates than target"
}
```

**Zero entries for the `final` group** — confirming Qwen-side 0 proposals OR proposals that failed the worker's silent `if (!citedOk) continue` grounding filter at [worker-handler.ts:502](src/lib/hr/training/generation/worker-handler.ts#L502).

### Why the diagnosis couldn't go further without observability

The pre-AA worker logged nothing per-group. The dedup log excludes proposals that failed grounding. So from the DB alone we cannot distinguish:
- (A) Modal returned 0 FA proposals
- (B) Modal returned FA proposals with `sourceSegmentIds` outside `plan.eligibleSegmentIds`
- (C) Modal returned FA proposals with `sourceSegmentIds` in the worker-exclusion set (68-82 / 160-161)
- (D) A truncation / malformed JSON / token-budget issue

Fly's log retention also rolled past the pilot's 21:20-21:27 UTC window.

### Observability patch landed in this slice

Worker now emits `shortfallReasonJson` v2 with a `perGroupDiagnostics` array — one row per group — carrying:

- `proposalCountFromModal` — exact count from the Modal response
- `groundingDroppedCount` + `groundingDropReasons[]` with each proposal's cited `sourceSegmentIds`, `citedOutsideEligible`, `citedExcluded`
- `sanitizerDroppedCount` + `sanitizerDropReasons[]` with `findingCodes`
- `dedupDroppedCount`
- `persistedCount`
- `modalElapsedMs`, `modalPromptTokens`, `modalOutputTokens`

**The next FA shortfall will be diagnosable from the DB alone** — no log scrape, no re-run.

### The token-budget hypothesis the directive asked me to check

Current Modal config carries a 2,048-token output budget. A 10-question FA response in Qwen's current output format (single-choice MCQ + explanation + 4 options + sourceSegmentIds) averages ~150-200 tokens per question → 1,500-2,000 tokens for 10 questions. **This is perilously close to the 2,048 ceiling.** Truncation on the last proposal is a plausible mechanism for (B) above: a mid-array cut means the last proposal has an incomplete / unparseable options array → the proposal is silently dropped OR, if partially parsed, its `sourceSegmentIds` default to `[]` which fails grounding.

Not asserted as the root cause — the v2 diagnostic ledger will reveal it directly on the next run.

---

## §9 — Targeted FA recovery design

Separate doc: [docs/ep-train-4y-aa-final-assessment-recovery-design.md](docs/ep-train-4y-aa-final-assessment-recovery-design.md).

**Headline numbers**:
- Expected Modal calls: **1** (minimum) / **2** (worst case, with retry).
- Expected cost exposure: **$0.13** minimum / **$0.23** worst case.
- Headroom against the $1 pilot ceiling: **$0.07** at the worst-case projection (prior pilot consumed ~$0.70).
- Recommended shape: **Option A** — new generation run with a FA-only plan (`proposedCheckpointGroups: []`, `proposedFinalAssessment.targetQuestionCount: 10`). Seeds dedup priors from the 5 pre-existing checkpoint drafts. Reuses the completed transcript byte-identically.

**Not fired in this slice.** Awaiting founder authorisation.

---

## §10 — Deployment + acceptance evidence

### Code validation

- `npx tsc --noEmit` — clean on all 7 touched files (85 pre-existing baseline errors in unrelated test fixtures + ProcessEnv NODE_ENV)
- `npx vitest run` across the touched area — **86 tests pass across 5 suites**:
  - `ep-train-4y-aa-question-text-sanitizer.test.ts` (18/18 — new)
  - `ep-train-4y-aa-destination-resolver.test.ts` (13/13 — new)
  - `ep-train-6d4n-approval-contract.test.ts` (approval-service contract — PASS)
  - `ep-train-6d3-approval-guard.test.ts` (approval guard — PASS)
  - `ep-train-4y-n-context-generation.test.ts` (worker ctx-v1 regression — PASS)
- `npm run scan:placeholders` — zero findings in touched files (pre-existing allowlist hits unchanged)

### Deploy

- GitHub Actions run: `42722382204`
- Target: `spectre-staging` + `spectre-staging-worker`
- Rollback anchor: `70ee74f58f84` (Fly web v1130 / worker v365, the 4Y-Z baseline)
- Pre-deploy health: `/api/health` HTTP 200 on v1130
- Post-deploy status: **pending** (see Appendix A on completion)

### Preserved local state

- 126 unrelated WIP files preserved (verified via `git status --short` — only the 11 files of this slice are modified / new).
- Stash `49c2af3d` intact — `git stash list --format='%H %gs' | head -1` = `49c2af3dabb7c4e90e9aa439996788a619c91a05 On ep-train-4y-b-impl/hybrid-auth-contract: 4y-i-generate-comment-cleanup-WIP`.

---

## What the founder sees now on `/app/admin/people/safety-training/cmw8n6z8f0008z4nxck6uvms9/cmw8n6z9a000az4nx56vwh02f/review`

(post-deploy)

- Breadcrumb `← Course editor`
- **"Employee Onboarding and Policies"** as an inline H1 with a pencil-edit affordance (not a card).
- The full 319-char AI description inline directly beneath, also with a pencil.
- **Preview as employee →** button top-right of the header.
- Left column: the native video player with a 36-px timeline track below it carrying **5 numbered green-outlined markers** at the five checkpoint positions.
- Right column tabs: **Checkpoints · 5** (active by default) and **Final assessment · 0**.
- Clicking **Final assessment · 0** shows a truthful empty state explaining the AI produced no FA questions and that a targeted recovery awaits founder authorisation.
- The redundant "N AI-generated questions in queue / Preview as employee" card is gone.
- The redundant "Course title / Description" card is gone.
- No approval-status card, no "Before you publish" card.

---

## Residual risks + follow-ups (open; do not initiate without founder auth)

1. **5 existing CP drafts now un-approvable.** The sanitiser's new approval gate (`EMPLOYEE_FACING_TEXT_LEAKAGE`) will refuse approval on all 5 pre-AA drafts because they trip one or more of the 7 leakage patterns. The reviewer's path forward is: discard all 5 + re-run the recovery (§9) + approve the clean replacements. **No founder decision is lost here** — the §8 observability + §9 recovery design cover the next step.

2. **FA root cause still unproven.** The 4Y-Z pilot's missing-10 is explained to the level of "either 0 proposals from Modal OR all proposals dropped by grounding/sanitiser/dedup". The v2 diagnostic ledger will close this gap on the next FA generation.

3. **Option A recovery is one small worker tweak away.** The dedup-priors seed (Adjustment #2 in the design doc) is a ~20-line change + a unit test. Not included in this slice because §9 is docs-only per the directive.

4. **`preview-as-employee` page remains unchanged** in this slice. If the founder wants the leakage-free rendering previewed before recovery, the preview page will still show the 5 leaky drafts because it reads the same `draftJson`. A future slice could render the preview through the same sanitiser to strip pattern matches at display time.

---

## Appendix A — Deploy completion evidence

### Two deploys landed

| Run | Commit | Fly web | Fly worker | Conclusion |
|---|---|---|---|---|
| `42722382204` | `be8f3ec4` (main AA changes) | v1131 / `sha-be8f3ec4f2ad` | v366 / `sha-be8f3ec4f2ad` | success |
| `42724895708` | `8bba5975` (timeline `atSec` fallback) | v1132 / `sha-8bba5975502d` | v367 / `sha-8bba5975502d` | success |

Both runs: 28/28 steps succeeded, including web build + web deploy + web machine tag verify + worker build + worker deploy + worker health + smoke login.

Rollback anchor if needed: `70ee74f58f84` (Fly web v1130 / worker v365 — the 4Y-Z baseline).

### Health

- `GET https://staging.spectreautomation.com/api/health` → **HTTP 200**
- Fly machine `app 8655607c957e58` iad: `started` · 1 total check / 1 passing
- Fly machine `worker d891ed01c54d18` iad: `started`

### Playwright screenshots (captured by `scripts/4yaa-review-screenshots.mjs` on v1132)

All captured as PNGs in `./test-results/`. Each one was then re-opened and visually spot-checked:

| Screenshot | What it proves |
|---|---|
| `4yaa-review-full.png` (247 KB) | Full 1600×1100 page — confirms inline title ("Employee Onboarding and Policies" with pencil) + inline AI description (319 chars with pencil) + Preview-as-employee top-right + 5 timeline markers + Checkpoints · 5 / Final assessment · 0 tabs + Q1-of-5 with "Needs review" badge + 4 options + Accept / Discard / Edit / Prev / Next controls. No redundant cards below the question pane. |
| `4yaa-review-header.png` (31 KB) | Header strip only — inline title + description + preview button, pencil-affordances visible. |
| `4yaa-review-timeline-markers.png` (strip) | Timeline track with **5 numbered green-outlined markers** (1-5) sitting on the stone-grey rail. Confirms the `atSec` fallback renders when TrainingCheckpoint rows are empty. |
| `4yaa-review-checkpoint-tab.png` | Checkpoints tab showing Q1 — live text `"What is the first step in resolving a complaint … according to the transcript segments [15] and [18]?"` — the §7 leakage the new approval-side sanitiser will refuse. |
| `4yaa-review-final-empty-state.png` | Final-assessment tab's truthful empty state: `"No final-assessment questions were generated yet. The AI generation for this course produced the checkpoint questions but no final-assessment questions. A targeted recovery can regenerate them — awaiting founder authorization."` |
| `4yaa-review-edit-title.png` | Pencil-open title editor: input field with Save + Cancel buttons; description shows a pencil icon on hover indicating the same affordance below. |
| `4yaa-review-edit-description.png` | Pencil-open description textarea with Save + Cancel + "Ctrl+Enter to save · Esc to cancel" hint. |

### Live staging reconciliation

`scripts/4yaa-staging-inspection.mjs` output (captured pre-deploy at 23:12 UTC, still the authoritative source):

```
course.title:                "Employee Onboarding and Policies"
course.description (chars):  319
attribution.source:          ai
attribution.runId:           cmw9rrl1g000rj41xaoxvzqbb
generationStatus.state:      COMPLETED
draftCount:                  5
breakdown:                   {"REQUIRES_HUMAN_REVIEW":5,...}
shortfall.generatedCount:    5
shortfall.shortfall:         10
shortfall.dedupDecisions#:   5  (all cg-* groups; zero final)
```

Reconciles 1:1 with what the new review page shows: `Checkpoints · 5` (reads these 5 CP drafts), `Final assessment · 0` (the resolver finds no `final` group entries in the shortfall JSON).

### Marker position note

The timeline-markers screenshot shows marker 1 slightly clipped at the left edge because its `atSec` is at or near 0 seconds in the 4Y-Z plan. The marker is functional (click-seekable, keyboard-focusable); its visual clipping is a pure polish item and is logged as a follow-up — not a §4 regression.

### Scripts shipped

- `scripts/4yaa-staging-inspection.mjs` — authenticated staging probe used to establish the §1 baseline and the §7 live-leakage evidence.
- `scripts/4yaa-review-screenshots.mjs` — authenticated Playwright driver that captures the 6 acceptance screenshots.

---

## STOP

Per directive §10: STOP after staging UX acceptance and final-assessment root-cause report. The next founder decision authorises (or defers) the §9 recovery. No further automated action without direction.
