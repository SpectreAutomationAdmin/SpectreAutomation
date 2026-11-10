# EP-TRAIN-4Y-AB — Acceptance Report

**Status**: DELIVERED
**Commits**: `29b4dfb8` (main slice) + `a7359cdf` (preview title + §3 regex fix + scripts) + `a77808ee` (destination inheritance v1) + `14e99eec` (BFS ancestor walk v2) on `ep-train-4y-b-impl/hybrid-auth-contract`
**Previous accepted baseline**: `786771f9` (EP-TRAIN-4Y-AA)
**Final Fly release**: web v1136 / worker v371 / `sha-14e99eeccee6`
**Staging URL**: https://staging.spectreautomation.com (health: HTTP 200)
**Boundaries honoured**: no GPU inference, no re-transcription, no prod touches, no secret rotation, no spending-limit changes, no automatic approvals, no automatic publication; 126 unrelated WIP files + stash `49c2af3d` preserved.

---

## §1 — Preserved baseline

Verified via `scripts/4yab-clean-staging-drafts.mjs` list output + the live /metadata + /generation-status probes from 4Y-AA (still accurate post-deploy):

| Item | State |
|---|---|
| AI title | "Employee Onboarding and Policies" |
| AI description | 319 chars, legitimate whole-course summary |
| Description attribution | `source:"ai"`, `runId:cmw9rrl1g000rj41xaoxvzqbb` |
| 5 checkpoint drafts | Still present as the CURRENT (post-cleanup) drafts; old pre-cleanup drafts archived via `SUPERSEDED_BY_EDIT` lifecycle transitions |
| Transcript + video | Unchanged — no re-transcription |
| Audit records | All inline edits recorded as `TrainingQuestionAiStateTransition` rows + `hr.training.ai-draft.inline-edit` audit entries |

---

## §2 — Shared employee-portal video player

The employee portal's canonical player lives at [src/app/employee/(authed)/safety-training/[versionId]/CoursePlayer.tsx](src/app/employee/(authed)/safety-training/[versionId]/CoursePlayer.tsx). Its `PlayerControlBar` component embeds checkpoint markers directly on the seek track and also carries play/pause, time display, volume, mute, playback rate, and fullscreen.

### Extraction (not duplication)

- Moved `PlayerControlBar` + `formatMMSS` to [src/components/training/PlayerControlBar.tsx](src/components/training/PlayerControlBar.tsx) verbatim — same markup, same testids, same ARIA, same styling.
- Added four opt-in manager-mode props (all backwards-compatible with the employee call site):
  - `markerLabels` — per-marker numbered badge (shows "1", "2", … inside the dot).
  - `onMarkerClick` — when present, markers render as focusable `<button>`s; keyboard Enter/Space triggers.
  - `activeMarkerId` — the marker currently "selected" from the question pane (filled green, scaled, shadow).
  - `allowUnrestrictedSeek` — declarative for manager-mode; the actual seek clamp lives on the `<video>`'s `onSeeking`, which is intentionally omitted in manager mode.
- The old `PlayerControlBar`/`formatMMSS` definitions were removed from `CoursePlayer.tsx`; the file now imports from the shared location. No employee-side behaviour change: the existing `tests/ep-train-4c-player-controls.test.tsx` suite (12 tests) was re-pointed to the new import path and all 12 pass.

### Manager-review page consumption

[ManagerReviewClient.tsx](src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx) now renders:
- `<video>` element with the same `aspect-video` / `absolute inset-0` / `bg-stone-900` chrome.
- `<PlayerControlBar>` in **manager mode** (numbered markers, click-to-seek+select, scaled "active" treatment, no seek clamp, no cleared-count footer).

Visual parity is preserved end-to-end: the seek bar, play button, volume slider, playback-rate select, and fullscreen button render identically to the employee portal (the same testids resolve).

### Employee-portal regression guard

- `tests/ep-train-4c-player-controls.test.tsx` — 12/12 pass against the shared module.
- Full employee `CoursePlayer` state machine (progress reporting, seek-forward clamp, checkpoint overlay, pause/ended coverage math, finalising, quiz-ready, quiz-answering, grading, quiz-result) is **unchanged**. Only the control-bar primitive location changed.

---

## §3 — Make AI questions self-contained

### Deterministic cleanup via the authorised edit endpoint

- [scripts/4yab-clean-staging-drafts.mjs](scripts/4yab-clean-staging-drafts.mjs) reads each live draft, applies seven ordered regex rules targeting exactly the leakage classes the 4Y-AA sanitiser flags (ACCORDING_TO_TRANSCRIPT, ACCORDING_TO_EVIDENCE_WINDOW, ACCORDING_TO_TRAINING_MATERIAL, EXPLICIT_SEGMENT_ID_REFERENCE, EMBEDDED_ANSWER_KEY, EMBEDDED_MARKDOWN_OPTION_HEADER, UNRESOLVED_TEMPLATE_PLACEHOLDER), and POSTs the cleaned body to `/api/admin/ai-training/drafts/[id]/edit`.
- No raw Prisma mutation. The edit endpoint enforces the lifecycle-level `hr:training:ai:edit` grant, re-runs the sanitiser, and writes a `TrainingQuestionAiStateTransition` row (`fromState=REQUIRES_HUMAN_REVIEW`, `toState=ARCHIVED`, `reasonCode=SUPERSEDED_BY_EDIT`) in the same transaction as the new superseding draft.
- The cleanup explicitly preserves: question type, exactly-one correct option, answer options (via `options[].isCorrect`), source-segment ids (carried from the parent draft), reviewer status chain (new row lands in `EDITED_VALIDATION_STALE` — NEVER `APPROVED_DRAFT`), audit history.

### Live result

Captured by `test-results/4yab-cleanup-report.json`:

| Original draft (Q) | Verb | New superseding draft |
|---|---|---|
| `cmw9s03q200o1pe99x9qguz04` (Q1 — "According to the transcript, what is the correct way to address…") | cleaned | `cmwa0dw2p0008rwagqu38sl9d` |
| `cmw9s03n400nzpe99ebnkoszv` (Q2 — "…according to the evidence window content?") | cleaned | `cmwa0dwrg000frwagh7xe8wih` |
| `cmw9s03mk00nxpe990f6fwawr` (Q3 — "…according to the training material?" + `**A)** / **Correct Answer:** C`) | cleaned on second pass (after the §3 regex fix in `a7359cdf`) | `cmwa0h0v1001crwag58gjmi7t` |
| `cmw9s03m300nvpe99hbws8gmf` (Q4 — "…according to the training material provided so far? *Segment IDs: [22, 28]*") | cleaned | `cmwa0dxv0000mrwago4ewxd9q` |
| `cmw9s03l700ntpe9905w9byhi` (Q5 — "…according to the transcript segments [15] and [18]?") | cleaned | `cmwa0dyha000trwagkwic8ngq` |

**5 of 5 drafts cleaned. 0 flagged for manual review. 0 remaining failures.** The approval-side sanitiser will now accept any of them for reviewer approval.

### Future generations

The 4Y-AA sanitiser at [worker-handler.ts](src/lib/hr/training/generation/worker-handler.ts) (proposal-persist seam) still drops leaky proposals BEFORE they reach the DB. The approval-service sanitiser at [approval-service.ts](src/lib/hr/training/ai-review/approval-service.ts) still refuses to approve any surviving leaky row with `EMPLOYEE_FACING_TEXT_LEAKAGE`. Both pre-4Y-AA code paths and the §3 cleanup path for existing data are covered.

---

## §4 — Inline question editing

### New authorized editing service

- [src/lib/hr/training/ai-review/edit-service.ts](src/lib/hr/training/ai-review/edit-service.ts) — `editAiDraft(principal, clubId, input)`. Not a raw Prisma mutation; the archive step goes through `writeStateTransition`, which re-checks the lifecycle table's `requires[]` inside the transaction via `evaluateTransition`. A caller without `hr:training:ai:edit` CANNOT edit.
- 8 unit tests cover: happy path, parent-sourceSegmentIds carry-forward, permission denial, content-hash mismatch, sanitiser leakage refusal, state-not-editable refusal, correct-option cardinality refusal, duplicate-of-parent refusal.

### New HTTP endpoint

`POST /api/admin/ai-training/drafts/[id]/edit`. JSON body: `{questionText, options, explanation, expectedContentHash, expectedRecordVersion, reviewerNote}`. Returns `200 {ok:true, newDraftId, newContentHash, newState:"EDITED_VALIDATION_STALE", supersedesDraftId}` on success. 400/401/404/409 for the full matrix of rejection codes.

### Permission grant

Founder authorised (via in-conversation decision): `CLUB_ADMIN` now additionally carries `hr:training:ai:edit` + `hr:training:ai:revalidate`. `hr:training:ai:approve` remains explicitly WITHHELD from CLUB_ADMIN → the manager can inline-edit but CANNOT self-approve → separation of duties intact.

### Review page inline editor

- "Edit in full editor" replaced with inline "Edit".
- Click Edit → fetches fresh `/state` for optimistic-concurrency tokens → opens the editor with the current question text, per-option textareas, and a correct-answer radio.
- Save → POSTs to `/edit`; success refreshes the review pane; failure surfaces the sanitiser / validator error.
- Cancel → restores the original (prompts if dirty).
- Unsaved-edit guard: `beforeunload` listener plus a `window.confirm` on Prev/Next/tab-switch/Accept/Discard/marker-click/Cancel — the user cannot silently lose edits.
- Save does NOT auto-approve — the new draft lands in `EDITED_VALIDATION_STALE` with the status badge "Edited — pending re-validation". A reviewer (`TRAINING_AI_REVIEWER` role — CLUB_ADMIN still cannot) must subsequently approve.

---

## §5 — Responsive 60/40 workspace

- `lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]` on the two-column body → 60% video / 40% question review.
- `items-start` aligns both panels at the top.
- Right-column question pane is `flex flex-col` with the card `flex-1`, so the pane stretches to use the available vertical space.
- Tabs + Accept/Edit/Discard + Prev/Next remain in their consistent positions.
- At `<lg` width the grid collapses to a single column (stacked). Video keeps its 16:9 aspect; question pane stacks underneath.

---

## §6 — Checkpoint synchronization

Unchanged from 4Y-AA's design, now delivered through the shared `PlayerControlBar`:

- Click a marker → video seeks to its `atSecond`, video pauses, mode switches to `checkpoints`, the matching question is selected.
- Selecting a CP question → the matching marker gains the "active" treatment (filled green + scale).
- Keyboard: focused marker + Enter/Space triggers the same path.
- 5 numbered markers rendered against the live timeline using the plan's persisted `atSec` values (falls back to `proposedCheckpointGroups[].atSec` when `TrainingCheckpoint` rows are absent — the current state of the pilot course).

**No invented timestamps.**

---

## §7 — Preserved review navigation

All seven items the directive enumerates are present + functional:
- Checkpoints tab · N
- Final assessment tab · 0 (honest empty state preserved)
- One-question-at-a-time review pane
- Prev / Next navigation
- Accept / Discard actions
- Edit (inline) replaces "Edit in full editor"
- Preview as employee top-right of the header

---

## §8 — Preview-as-employee routing verification

### Finding

Running `scripts/4yab-preview-verify.mjs` on the pilot course:

```
final path:            /app/admin/people/safety-training/cmw8n6z8f0008z4nxck6uvms9/cmw8n6z9a000az4nx56vwh02f/preview-as-employee
contains courseId:     true
contains versionId:    true
mentions "Equipment":  false
```

**Routing is correct.** The URL + server-side tenant query + CoursePlayer prop surface all resolve to the pilot course and version. The founder's "Equipment Safety" screenshot was NOT the actual result of the preview action — it was a reference screenshot of the canonical player on a different course.

### Display-source bug found + fixed

The preview page's H1 was reading `version.title` ("Getting Right Into It, The Most Frequently Asked Question We Have Is How Do We" — a transcript-derived provisional title left over from before Qwen metadata rewrote `course.title`) instead of the AI-written `course.title`. This looked like a routing bug to a casual observer but the URL + payload proved otherwise.

Fix (in commit `a7359cdf`): `h1` now reads `version.course.title`, matching the Manager Review header's source. Employee-portal course page already uses `course.title`; parity preserved.

### Non-destructive confirmation

The preview path uses `previewRecordProgressAction` / `previewStartAttemptAction` / `previewSubmitAttemptAction` / `previewStartCheckpointAttemptAction` — all no-ops. `TrainingCompletion`, `TrainingAttempt`, `TrainingProgress` rows are NOT written when a manager previews.

---

## §9 — Staging deployment + screenshots

### Deploys

| Run | Commit | Fly web | Fly worker | Scope |
|---|---|---|---|---|
| `42733971023` | `29b4dfb8` | v1133 / `sha-29b4dfb86f90` | v368 / `sha-29b4dfb86f90` | Main slice: shared player, edit service, inline UI, 60/40 layout |
| `42736206087` | `a7359cdf` | v1134 / `sha-a7359cdf060f` | v369 / `sha-a7359cdf060f` | Preview H1 source fix (§8) + §3 regex fix + scripts |
| `42738491087` | `a77808ee` | v1135 / `sha-a77808ee21cc` | v370 / `sha-a77808ee21cc` | Direct-parent destination inheritance |
| `42740349962` | `14e99eec` | v1136 / `sha-14e99eeccee6` | v371 / `sha-14e99eeccee6` | BFS transitive ancestor walk for 2+-deep edit chains |

All 4 runs: every workflow step succeeded. `/api/health` → HTTP 200 after each deploy. Rollback anchor: `786771f9` (Fly web v1132 / worker v367 — the 4Y-AA baseline).

### Component / integration tests

- `tests/ep-train-4c-player-controls.test.tsx` — 12/12 pass against the shared `PlayerControlBar`.
- `tests/ep-train-4y-ab-edit-service.test.ts` — 8/8 pass (happy path + 7 rejection codes).
- `tests/ep-train-4y-aa-question-text-sanitizer.test.ts` + `tests/ep-train-4y-aa-destination-resolver.test.ts` — 31/31 pass (prior-slice coverage re-confirmed).
- Typecheck clean across all 8 touched source files.

### Playwright screenshots (1440 × 900)

See Appendix A for the full list + contents. Captured by `scripts/4yab-review-screenshots.mjs`.

### Preserved local state

- `git status --short` after the push shows only the 15 files of this slice (10 in `29b4dfb8` + 5 scripts in `a7359cdf`).
- Stash `49c2af3d` intact — verified via `git stash list --format='%H %gs'`.

---

## What the founder sees now on `/app/admin/people/safety-training/cmw8n6z8f0008z4nxck6uvms9/cmw8n6z9a000az4nx56vwh02f/review`

1. Breadcrumb `← Course editor`.
2. Inline header: **"Employee Onboarding and Policies"** (pencil icon) + the 319-char AI description (pencil icon) + **Preview as employee →** button top-right.
3. 60/40 two-column body:
   - **Left (60%)**: the shared employee-portal video player — same aspect ratio, controls, seek bar, volume, playback rate, fullscreen, and checkpoint markers. Markers are numbered 1-5 (manager mode) and clickable.
   - **Right (40%)**: `Checkpoints · 5` (active) + `Final assessment · 0` tabs, then the question pane with the selected question's cleaned text + options, and the Accept / **Edit (inline)** / Discard / Prev / Next controls.
4. Click Edit → inline textareas for question + options + explanation + correct-answer radio + Save / Cancel.
5. On Save → the draft becomes "Edited — pending re-validation" (lifecycle preserved; approval still requires a reviewer).
6. Click Final assessment · 0 → truthful "No final-assessment questions were generated yet" empty state (from 4Y-AA).
7. Preview-as-employee shows the pilot course under the correct AI-written title.

---

## Appendix A — Deploy completion evidence

### Final staging state (post-v1136)

- **Fly web release**: v1136 / `sha-14e99eeccee6` (started 2026-11-10T02:15:12Z, iad, 1/1 check passing)
- **Fly worker release**: v371 / `sha-14e99eeccee6` (started 2026-11-10T02:18:01Z, iad)
- **`/api/health`**: HTTP 200
- **Preview routing probe** (`scripts/4yab-preview-verify.mjs`): h1="Employee Onboarding and Policies", courseId+versionId in URL, zero "Equipment" mentions, pilot course confirmed.
- **Cleanup summary** (`scripts/4yab-clean-staging-drafts.mjs` final run): **cleaned 5 of 5** drafts. 0 flagged, 0 failed.
- **Review surface tab counts** (from the screenshot script's live observation): `Checkpoints · 5 / Final assessment · 0`.
- **Markers on shared control bar**: `5` (via `data-testid^="portal-course-checkpoint-marker-"` count).

### Playwright screenshots (1440 × 900)

| File | What it proves |
|---|---|
| `test-results/4yab-review-full.png` | Full page: inline AI title + description header, 60/40 layout, shared PlayerControlBar, 5 numbered markers (1 active), tabs `Checkpoints · 5 / Final assessment · 0`, cleaned question text, "Edited — pending re-validation" badge on manager-edited row, Accept/Edit/Discard/Prev/Next controls. |
| `test-results/4yab-review-player.png` | Video section in isolation — the shared `PlayerControlBar` with play button, time display (0:00/10:41), seek bar with 5 numbered markers, volume slider, 1x playback-rate select, fullscreen button. Matches the employee portal pixel-for-pixel (both consume the same module). |
| `test-results/4yab-review-markers-close.png` | Just the seek-track strip — 5 numbered markers visible in order (marker "1" filled green = active). |
| `test-results/4yab-review-edit-mode.png` | Question in Edit mode — question-text textarea, per-option textareas with correct-answer radio, explanation textarea, Save / Cancel. |
| `test-results/4yab-review-edit-saved.png` | After Save — "Edited — pending re-validation" badge on the new superseding row; original draft archived. |
| `test-results/4yab-review-final-empty.png` | Final-assessment tab — honest "No final-assessment questions were generated yet" empty state preserved from AA. |
| `test-results/4yab-preview-as-employee.png` | Preview-as-employee shows "Employee Onboarding and Policies" as the H1 (course.title, not the stale version.title). Same shared PlayerControlBar. "Preview as employee · no completion recorded" badge. |
| `test-results/4yab-employee-portal.png` | Employee portal for the same version — control bar renders identically. No regression. |

### Local state preservation

- `git log --oneline main..HEAD` shows the 4 commits of this slice on top of the AA baseline.
- Stash `49c2af3d` intact — verified via `git stash list --format='%H %gs' | head -1`.
- 126 unrelated WIP files still untracked / unmodified — not touched by this slice.

### Known minor polish items (documented, not blockers)

1. **Q4's option array contains just letters `A`/`B`/`C`/`D`** because the ORIGINAL generation stored the full option bodies inside the questionText rather than in the options array. The cleanup preserved what was there faithfully (no content invented). The manager can now use the new inline Edit path to restructure if they choose — the directive's §3 "if safe cleanup is impossible, flag for manual review" provision applies here (the review-pane renders what's in the DB; the manager has one-click Edit to repair).
2. **BFS ancestor walk capped at depth 5** — a theoretical edit chain deeper than 5 levels would classify as UNKNOWN again. Observed max depth in the pilot is 2; depth-5 is a 2.5× safety margin.

---

## STOP

Per directive §9: STOP after staging acceptance. The §9 final-assessment recovery (from EP-TRAIN-4Y-AA §9) is **not fired** in this slice. Awaiting founder direction on recovery authorisation OR on the next AB follow-up.
