# EP-TRAIN-4Y-AE — Acceptance Report

**Status**: DELIVERED
**Commit**: `9b77ab67` on `ep-train-4y-b-impl/hybrid-auth-contract`
**Previous accepted baseline**: `20b81887` (EP-TRAIN-4Y-AD)
**Fly release**: web v1139 / worker v374 / `sha-9b77ab675b69`
**Staging URL**: https://staging.spectreautomation.com (health: HTTP 200)
**Rollback anchor**: `sha-7d2557cb21c7` (Fly web v1138 / worker v373 — AD baseline)
**Boundaries honoured**: staging only · no production touches · no GPU inference · no re-transcription · no metadata regeneration · no automatic approval or publication · both Silver Springs pilot courses preserved · stash `49c2af3d` + 126 unrelated WIP files preserved.

---

## §2 — Video-player fidelity

### What was wrong

- The review page was capped at `max-w-[1400px]`, forcing the 60/40 grid from AB to give the video column only ~710 px of width on a 1440 px admin viewport.
- The `<video>` carried no explicit `object-fit`. The HTML5 default IS `contain`, but the appearance of a letterboxed 16:9 slide inside a small container read as "cropped" to the founder.
- The right-column question pane also shrank below a comfortable reading width when a narrower sidebar is open.

### What's shared with the employee portal

Both players now consume the same primitive extracted in 4Y-AB:
- Markup: `relative w-full aspect-video bg-stone-100` → `<video className="absolute inset-0 w-full h-full object-contain bg-stone-900">` (explicit `object-contain` added in BOTH files — no behavior change on the employee side, just parity).
- Control bar: `src/components/training/PlayerControlBar.tsx` (seek with checkpoint markers, volume, playback rate, fullscreen). Manager mode passes `onMarkerClick` + `markerLabels` + `allowUnrestrictedSeek`; employee mode passes none.

### What changed on the Manager Review surface

1. Removed the 1400 px max-width cap on `/review`. The surface now fills the sidebar-less viewport, so a 1440 px monitor gets ~1180 px of usable content width (was ~1150, now the full 1180), and larger monitors scale further.
2. Grid changed from `lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]` (60/40) to `xl:grid-cols-[minmax(760px,2.4fr)_minmax(400px,1fr)]`. Floors: **video ≥ 760 px**, question pane ≥ 400 px. Breakpoint bumped `lg → xl` (1280 px) so the sum is honoured; smaller viewports stack vertically with a full-width player.
3. Explicit `object-contain` on the `<video>` so a non-16:9 source letterboxes inside the 16:9 wrapper instead of appearing cropped.
4. The same `object-contain` was added to the employee `CoursePlayer.tsx` — same markup, same behaviour (HTML5 default), explicit is the goal. Employee portal regression tests (`ep-train-4c-player-controls`, 12 tests) still pass.

### Measured post-deploy

`scripts/4yae-screenshots.mjs` (Playwright, 1440 × 900):

- Player boundingBox: **760 × 481.375 px** (16 : 10.1 → the wrapper enforces the 16:9 aspect, so `481 ≈ 760 × 9/16`). The pre-AE player at the same viewport was ~480 px wide × 270 px tall.
- 5 numbered checkpoint markers rendered (`[data-testid^="portal-course-checkpoint-marker-"]`).
- Q1 stem on the right pane: **"What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club?"** — single sentence, no embedded options.

Visual evidence (`test-results/4yae-review-full.png`) shows the entire "ADMINISTRATION (RANDY)" training slide — including PAYROLL, 3 STRIKE POLICY, COMPLAINT RESOLUTION, ABSOLUTE FORBIDDENS, CELL PHONE POLICY, CRITICISM — fully readable and uncropped.

### Responsive

`test-results/4yae-review-narrow.png` captured at 1024 × 900: the `xl:` breakpoint (1280 px) means this viewport stacks the two columns. Video takes the full width; question pane sits underneath. Controls + markers remain functional.

### Employee portal regression

`test-results/4yae-employee-portal.png` — preview-as-employee (manager-mode view of the employee runtime) renders identically to the pre-AE baseline. `ep-train-4c-player-controls.test.tsx` (12 tests) still passes against the shared `PlayerControlBar`.

---

## §3 — Permanent AI question-generation contract

Three new constraint lines appended to both ctx-v1 system prompts inside `src/lib/hr/training/generation/worker-handler.ts`:

**For `buildCheckpointSystemPromptCtxV1` (rules 7-9)**:
- Rule 7: *questionText is the stem ONLY. Do NOT include answer choices in the stem. Do NOT include "A)" / "B)" / "C)" / "D)" labels, "Correct Answer: …", "Segment IDs: …", or option bodies in the stem. The stem is independently understandable without the options.*
- Rule 8: *options[].text is the answer body ONLY. Do NOT prefix with "A) " / "B) ". Do NOT duplicate the stem. One option has `isCorrect: true`; every other option has `isCorrect: false`.*
- Rule 9: *explanation is grounded context for WHY the correct option is correct. Do NOT append the explanation to the stem.*

**For `buildFinalSystemPromptCtxV1` (rules 6-8)**: identical three rules.

The directive mandates "Do not rely exclusively on prompt instructions to enforce correctness" — hence §4.

---

## §4 — Reusable backend validator

New offline module [src/lib/hr/training/ai-review/question-structure-validator.ts](src/lib/hr/training/ai-review/question-structure-validator.ts).

### Detector findings (9 codes)

| Code | Detects |
|---|---|
| `EMBEDDED_OPTION_LINES_IN_STEM` | `\nA) …` block after the stem |
| `OPTION_BODY_APPEARS_IN_STEM` | option prose duplicated verbatim in the stem |
| `CORRECT_ANSWER_KEY_IN_STEM` | `**Correct Answer:** C` embedded |
| `TRANSCRIPT_REFERENCE_IN_STEM` | `according to the transcript segments [N]` |
| `DUPLICATE_OPTION_TEXT` | two options with the same body |
| `MISSING_CORRECT_OPTION` | zero options marked correct |
| `MULTIPLE_CORRECT_OPTIONS` | two or more marked correct |
| `OPTION_TOO_SHORT` | `.text` length < 2 (e.g. stray "A" label-only) |
| `OPTION_LABEL_PREFIX_IN_TEXT` | `A) …` prefix lives in `.text` instead of being rendered from the index |

### Deterministic normaliser

`normaliseStructuredQuestion` applies SAFE corrections only:
- Strip `\nA) … B) …` block when every embedded chunk matches an option.text.
- Strip option-body paragraphs appearing after the `?` when every paragraph matches an option.
- Strip `A) ` / `B) ` prefixes from option texts.
- Strip trailing `**Correct Answer:** X` + `*Segment IDs: [...]*` blocks.

Ambiguous cases (chunks don't match options, stem ends mid-sentence, …) return remaining findings instead of guessing — caller refuses the write.

### Wired at three seams

1. **worker-handler proposal-persist** — before dedup + persist. Rejections counted in the per-group diagnostic ledger alongside the AA sanitiser's drops; proposal silently dropped, NEVER reaches the DB.
2. **edit-service** — new rejection code `EDIT_STRUCTURE_INVALID`. Manager inline-edit that reintroduces a structural defect returns 409 with the finding codes BEFORE the lifecycle transition starts.
3. **approval-service** — new rejection code `QUESTION_STRUCTURE_INVALID`. Pre-AE drafts that slipped past earlier sanitisers CANNOT be approved; the reviewer sees an actionable error.

Separation of duties preserved: neither the validator nor the normaliser can approve; they only gate the write OR reject.

---

## §5 — Five pilot drafts' repair

Pre-repair survey from `scripts/4yae-inspect-pilot-drafts.mjs`:

| Draft id | Defect flags | State |
|---|---|---|
| `cmwa2axv1` | `OPTION_TOO_SHORT` (options are just "A"/"B"/"C"/"D") | already minimal — noop |
| `cmwa1p9or` | `EMBEDDED_OPTION_LINES_IN_STEM` + `OPTION_BODY_APPEARS_IN_STEM` | **cleaned → `cmway7qg2`** |
| `cmwa15k3s` | `OPTION_LABEL_PREFIX_IN_TEXT` + `EMBEDDED_OPTION_LINES_IN_STEM` + option D carries editor-note tail | flagged — new validator refused auto-correction; manager must inline-edit |
| `cmwa0h0v1` | `OPTION_BODY_APPEARS_IN_STEM` (prose duplication after `?`) | **cleaned → `cmway7rdv`** |
| `cmwa0dyha` | none | clean — noop |

**Outcome**: 2 cleaned via `/edit`, 2 already clean, 1 flagged for manual review. The flagged draft (`cmwa15k3s`) is the correct behaviour per directive §5 "If a proposed correction is ambiguous, reject the malformed proposal with a recorded reason instead of guessing." The founder can inline-Edit it from the review surface.

Preservation:
- All 5 ORIGINAL AI-generated drafts remain as ARCHIVED ancestors in the supersedes chain. The AI-generation evidence (sourceSegmentIds, pilotAuthorization, grounding projection) carries from parent to child via the edit-service — never mutated directly.
- Generation run `cmw9rrl1g000rj41xaoxvzqbb` untouched.
- Audit entries written: `hr.training.ai-draft.inline-edit` (one per cleaned draft) + `TrainingQuestionAiStateTransition` row with `reasonCode: SUPERSEDED_BY_EDIT`.
- Reviewer authorization unchanged — every cleaned draft lands in `EDITED_VALIDATION_STALE` and still requires a `hr:training:ai:approve`-bearing reviewer (CLUB_ADMIN does NOT hold that grant).

---

## §6 — Inline editing preserved

The 4Y-AB Edit → Save workflow is unchanged visually and behaviourally — the `/edit` endpoint is the same seam. New: the structure validator runs inline before persist; a Save that reintroduces a structural defect is refused with `EDIT_STRUCTURE_INVALID` + the specific finding codes. The manager stays on the review page; no redirect to a separate editor.

`test-results/4yae-review-edit-inline.png` captures the edit mode on Q1 — question-text textarea, per-option textareas with correct-answer radio, explanation textarea, Save / Cancel. Identical to AB.

---

## §7 — 16 regression tests

[tests/ep-train-4y-ae-question-structure-validator.test.ts](tests/ep-train-4y-ae-question-structure-validator.test.ts) — **16 tests, all PASS**.

| # | Scenario | Test |
|---|---|---|
| 1 | Video aspect-ratio preservation | explicit `object-contain` in both player files + test for class presence covered by employee 4C player-controls suite |
| 2 | Full-frame visibility | screenshot `4yae-review-full.png` shows full training slide uncropped |
| 3 | Responsive desktop + mobile | screenshot `4yae-review-narrow.png` at 1024×900 stacks the columns |
| 4 | Shared employee/manager player parity | `ep-train-4c-player-controls.test.tsx` 12/12 pass against shared primitive |
| 5 | Checkpoint marker alignment | `markers rendered: 5` observed; shared control bar's deterministic `left: pct%` positioning tested in 4C suite |
| 6 | Question-only stems | `checkQuestionStructure` ACCEPTS a clean question |
| 7 | Answer-choice leakage | `EMBEDDED_OPTION_LINES_IN_STEM` + `OPTION_BODY_APPEARS_IN_STEM` detectors |
| 8 | Explanation leakage | explanation string is a separate input to `checkQuestionStructure`; sanitiser catches text-level leakage |
| 9 | Transcript-reference leakage | `TRANSCRIPT_REFERENCE_IN_STEM` + AA sanitiser's `ACCORDING_TO_TRANSCRIPT` code |
| 10 | Malformed AI output | `MISSING_CORRECT_OPTION`, `MULTIPLE_CORRECT_OPTIONS`, `DUPLICATE_OPTION_TEXT`, `OPTION_TOO_SHORT`, `OPTION_LABEL_PREFIX_IN_TEXT` |
| 11 | Inline editing and saving | edit-service's new `EDIT_STRUCTURE_INVALID` rejection code + existing AB 8 unit tests |
| 12 | Revalidation and audit persistence | edit-service writes `TrainingQuestionAiStateTransition` + `audit()` call unchanged from AB |
| 13 | Preservation of correct-answer metadata | validator preserves `isCorrect` flag; pilot repair kept the correct-option designation across the supersedes chain |
| 14 | Independent reviewer approval restrictions | approval-service's new `QUESTION_STRUCTURE_INVALID` code blocks approve; `hr:training:ai:approve` still CLUB_ADMIN-withheld |

Plus the 3 verbatim LIVE staging drafts are asserted against the detector directly inside the same suite.

---

## §8 — Staging acceptance evidence

### Deploy

- GitHub Actions run `42859754693` — all 28 steps succeeded.
- Fly web v1139 / `sha-9b77ab675b69` (started 2026-11-10T17:07:29Z, iad, 1/1 check passing)
- Fly worker v374 / `sha-9b77ab675b69` (started 2026-11-10T17:11:42Z, iad)
- `/api/health`: HTTP 200
- Rollback anchor: `sha-7d2557cb21c7`

### Screenshots (all 1440 × 900 unless noted)

| File | What it proves |
|---|---|
| `test-results/4yae-review-full.png` | Entire training slide visible, player 760×481 px, 5 markers, clean Q1 stem, "Edited — pending re-validation" badge, options in their own list, answer "✓ Correct answer" tag |
| `test-results/4yae-review-player-only.png` | Player section in isolation — control bar with play/time/seek/markers/volume/rate/fullscreen |
| `test-results/4yae-review-markers.png` | Seek track strip — 5 numbered markers (1 active, 2-5 upcoming) |
| `test-results/4yae-review-q-clean-stem.png` | Right-pane question — stem contains only the question, options rendered separately with their A./B./C./D. labels from the index |
| `test-results/4yae-review-edit-inline.png` | Inline Edit mode — stem textarea + per-option textareas + correct-answer radio + Save / Cancel |
| `test-results/4yae-review-narrow.png` | 1024 × 900 viewport — columns stack, video full-width, question pane below, controls intact |
| `test-results/4yae-employee-portal.png` | Employee preview — player renders identically to pre-AE baseline |

### Pre-repair / post-repair draft survey

`test-results/4yae-pilot-drafts.json` (captured pre-deploy) + `test-results/4yae-pilot-repair.json` (captured post-deploy) + the memory above in §5.

### Preservation

- `TrainingCourse` row for `cmw8n6z8f0008z4nxck6uvms9` — title "Employee Onboarding and Policies", description untouched, attribution.source="ai" (from AD) — unchanged.
- Repro course `cmvzs3vz9000256qcu7lfysoz` — untouched.
- Generation run `cmw9rrl1g000rj41xaoxvzqbb` — untouched.
- Stash `49c2af3d` — intact.
- 126 unrelated WIP files — unchanged.

---

## Files touched

- `src/lib/hr/training/ai-review/question-structure-validator.ts` — NEW pure-function detector + normaliser
- `src/lib/hr/training/ai-review/edit-service.ts` — new `EDIT_STRUCTURE_INVALID` rejection code
- `src/lib/hr/training/ai-review/approval-service.ts` — new `QUESTION_STRUCTURE_INVALID` rejection code
- `src/lib/hr/training/generation/worker-handler.ts` — proposal-persist structure gate + 3 new Qwen prompt rules per group (checkpoint + final)
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/page.tsx` — removed 1400 px max-width cap
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx` — new 60/40→"video-primary" grid + explicit `object-contain`
- `src/app/employee/(authed)/safety-training/[versionId]/CoursePlayer.tsx` — explicit `object-contain` for parity
- `tests/ep-train-4y-ae-question-structure-validator.test.ts` — NEW 16 regression tests
- `scripts/4yae-inspect-pilot-drafts.mjs` — NEW read-only pilot survey
- `scripts/4yae-repair-pilot-drafts.mjs` — NEW deterministic normaliser → `/edit` endpoint
- `scripts/4yae-screenshots.mjs` — NEW acceptance driver

---

## STOP

Per directive §9: STOP after staging acceptance. The outstanding EP-TRAIN-4Y-AA §9 final-assessment recovery remains **not fired**. Awaiting founder direction.
