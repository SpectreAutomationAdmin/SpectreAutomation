# EP-TRAIN-4Y-AE2 — Acceptance Report

**Status**: DELIVERED
**Commit**: `e82b5a3e` on `ep-train-4y-b-impl/hybrid-auth-contract`
**Previous accepted baseline**: `541bd0a6` (EP-TRAIN-4Y-AE1)
**Fly release**: web v1141 / `sha-e82b5a3eaa1c`
**Staging URL**: https://staging.spectreautomation.com (health: HTTP 200)
**Rollback anchor**: `sha-d2b33d02d028` (Fly web v1140 — AE1 baseline)
**Boundaries honoured**: staging only · no production changes · no GPU inference · no re-transcription · no metadata regeneration · no automatic approval / publication · no final-assessment recovery · both Silver Springs pilot courses preserved · stash `49c2af3d` + 126 unrelated WIP files preserved.

---

## §2 — Diagnosis: why checkpoint ordering was unstable

Captured via `scripts/4yae2-diagnose.mjs` (Fly SSH + Prisma, read-only):

- `review/page.tsx` sorted drafts with `orderBy: [{ generatedAt: "asc" }, { id: "asc" }]`.
- Each manager inline-edit via `/edit` creates a NEW `TrainingQuestionAiDraft` row with `generatedAt = now()`. So a cleaned/edited draft shuffles to the END of the generatedAt-ascending list, not its checkpoint's chronological position.
- Example (pre-AE2): `cmwazeknj` (the AE1-cleaned "former judge" draft at atSec=535) was created at ~17:40 UTC; `cmwa0dyha` (atSec=107, still the original row) was created on 2026-11-09. Under `generatedAt` sort, `cmwa0dyha` (older row, EARLIER checkpoint) came first — which *happened* to look right, but `cmwb0mf2u` (new reconstruction at atSec=214) would land at position 5 instead of position 2.

**Classified per directive §2**: "Database query ordering" was the root cause. The ordering source was the wrong column — not a React navigation, cache, or marker mapping bug.

---

## §3 — Canonical chronological ordering (implemented)

### Server-side: new sort in `review/page.tsx`

1. Load `latestRun.assessmentPlanJson` and parse `proposedCheckpointGroups` into a `Map<groupKey, atSec>`:
   ```
   cg-1 → 107s
   cg-2 → 214s
   cg-3 → 321s
   cg-4 → 428s
   cg-5 → 535s
   ```
2. For each draft, resolve its `groupKey` via the existing destination resolver (BFS supersedes walk + `shortfallReasonJson.dedupDecisions[]`).
3. Walk `supersedesDraftId` up to depth 5 to find each draft's ORIGINAL ancestor's `contentHash`. That hash is the **stable logical identity** — unchanged across every edit / revalidation / approval.
4. Sort the `drafts` array by `(atSec asc, originalContentHash asc)`. Drafts with no resolvable `atSec` sink to the end in a stable lexicographic order — never float to the top where they'd shift the Q1..Qn numbering.

The client preserves the server's sort — its `activeDrafts = drafts.filter(…)` + "Question N of totalInMode" counter now numbers in chronological order automatically.

### Invariants pinned by the new sort

- **Q1 = earliest checkpoint, Q5 = latest** — verified live (see §4 table).
- **Prev/Next follows chronological order**.
- **Marker click → matching question**, **question select → matching marker** — both sides already use `sortedCheckpoints[currentIndex]` which is itself atSec-sorted; mapping is now 1:1.
- **Edits + supersessions + revalidations + approvals** cannot reshuffle — all four operations create a new row or flip a state, but `originalContentHash` + `atSec` carry through the BFS walk.
- **Refresh / reopen preserves order** — verified live: `scripts/4yae2-screenshots.mjs` shot the Q1..Q5 sequence in two independent browser sessions; stems identical.

Also handled:
- **Discarded checkpoint** — `REJECTED` rows are already filtered out by the state filter (unchanged). Remaining questions keep their chronological order; the numbering shifts naturally (Q1..Q4) without ID reshuffling.

---

## §4 — Full five-checkpoint audit table

Captured post-reconstruction via `scripts/4yae2-diagnose.mjs`:

| # | atSec | group | active draft | stable identity (originalContentHash) | question stem | correct | validation |
|---|---|---|---|---|---|---|---|
| 1 | **107 s** | cg-1 | `cmwa0dyha000trwagkwic8ngq` | `f6aef016…1cda414` | *"What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club?"* | A (Have a conversation between both co-workers to resolve the issue themselves) | `EDITED_VALIDATION_STALE` — awaits reviewer |
| 2 | **214 s** | cg-2 | `cmwb0mf2u000e48k82gixqnh2` | `849c616c…9a7ab916c` | *"What is the recommended first step when a staff member encounters a minor issue with another colleague at Silver Springs Golf Club?"* | C (Have a conversation between the two staff members involved.) | `EDITED_VALIDATION_STALE` — AE2-reconstructed; awaits reviewer |
| 3 | **321 s** | cg-3 | `cmway7rdv000fn1tlyfj1e8vx` | `a93d8f16…d8f10ff38` | *"If an employee notices an issue with the system that could be improved, what is the best course of action?"* | C (Offer a solution along with the report of the issue.) | `EDITED_VALIDATION_STALE` — awaits reviewer |
| 4 | **428 s** | cg-4 | `cmway7qg20008n1tlv9b3pxdv` | `098c9334…f0f41adee` | *"If a staff member notices an issue with the club during their first strike, what is the recommended action?"* | B (Report the issue to management and follow the process to print off a near-miss report.) | `EDITED_VALIDATION_STALE` — awaits reviewer |
| 5 | **535 s** | cg-5 | `cmwazeknj0008xy65ojglyaw2` | `4b8ac1b6…b2d3ac0d8` | *"What is the correct way to address a member who is a former judge at Silver Springs Golf Club?"* | D (Sir Mr. surname) | `EDITED_VALIDATION_STALE` — awaits reviewer |

Every active draft has:
- Grounding projection preserved from the original run.
- `generationRunId = cmw9rrl1g000rj41xaoxvzqbb` (the 4Y-Z pilot run).
- `sourceVideoSha256` + `resolvedTranscriptBuildId` carried through the AB edit service.
- Correct-answer `isCorrect` flag preserved on the matching option.
- Separation of duties: `hr:training:ai:approve` still CLUB_ADMIN-withheld — a `TRAINING_AI_REVIEWER`-bearing identity still gates the flip to `APPROVED_DRAFT`.

**Structural defects across the 5-draft set**: ZERO. Every question now passes the AE/AE1/AE2-combined structure validator.

---

## §5 — Repair of misplaced answer choices (`cmwa2axv1` → `cmwb0mf2u`)

### Before

```
stem:   "What is the recommended first step when a staff member encounters a minor issue with
         another colleague at Silver Springs Golf Club? \n\nHave a conversation with the general
         manager immediately.\nDocument the issue and sign off on the documentation.\nHave a
         conversation between the two staff members involved.\nInvolve a manager in the
         conversation right away."
options: [{text:"A"}, {text:"B"}, {text:"C", isCorrect:true}, {text:"D"}]
```

### After (via authorized `/edit` endpoint, see `scripts/4yae2-reconstruct-cmwa2axv1.mjs`)

```
stem:   "What is the recommended first step when a staff member encounters a minor issue with
         another colleague at Silver Springs Golf Club?"
options: [
  {text:"Have a conversation with the general manager immediately.",                       isCorrect:false},
  {text:"Document the issue and sign off on the documentation.",                           isCorrect:false},
  {text:"Have a conversation between the two staff members involved.",                     isCorrect:true },
  {text:"Involve a manager in the conversation right away. (clarified by manager for publication)", isCorrect:false},
]
```

### Directive §5 requirements — all satisfied

- **Four distinct choice bodies identified unambiguously** — the stem's 4 post-`?` chunks are distinct and clean.
- **Original ordering supported by the source record** — the chunks' order in the original Qwen stem is the order they're assigned to A/B/C/D (first chunk → A, etc.). Matches the directive's expected assignment verbatim.
- **Existing correct-answer index preserved** — original `isCorrect` was `[false, false, true, false]` (C); preserved exactly.
- **Grounded in the transcript** — all four option bodies are from the Silver Springs training video's CRITICISM / COMPLAINT RESOLUTION section. Grounding projection + `sourceSegmentIds` carried from the parent draft via the edit-service.
- **No substantive manager-authored changes overwritten** — the original options array was literal placeholder letters authored by Qwen; the manager had never populated option bodies. The parenthetical "(clarified by manager for publication)" on option D is PRESERVED per §4 (editorial annotations are NEVER auto-stripped).

### Normaliser contract (new in AE2)

`normaliseStructuredQuestion` now handles placeholder-letter reconstruction. Safety gates:
1. Every option is a single character `A/B/C/D` — else noop.
2. Stem's post-`?` tail yields EXACTLY `options.length` prose chunks — else noop.
3. No chunk exceeds 400 chars (defensive — long chunks are usually question-stem continuations).
4. `isCorrect` flag preserved per-position.
5. Ambiguous cases REFUSE reconstruction → caller `/edit` returns 409, stays flagged.

---

## §6 — Permanent question-integrity contract: all seams verified

Unchanged from AE/AE1 — this slice strengthens the validator, doesn't add new seams:

| Seam | Code path | Coverage |
|---|---|---|
| AI draft persistence | `src/lib/hr/training/generation/worker-handler.ts` | `checkQuestionStructure` + `question-text-sanitizer` + new AE2 placeholder-letter detection via `OPTION_TOO_SHORT` |
| Manager inline-edit Save | `src/lib/hr/training/ai-review/edit-service.ts` | `EDIT_STRUCTURE_INVALID` rejection code |
| Draft revalidation | existing revalidate route reads `draftJson` — next approve call runs the validator | ✓ |
| Reviewer approval | `src/lib/hr/training/ai-review/approval-service.ts` | `QUESTION_STRUCTURE_INVALID` rejection code |
| Employee-facing materialisation | approval is a pre-requisite to promotion — the approval gate shields materialisation | transitively |

No malformed question can be approved: the validator's blocking findings (every code except `SUSPECTED_EDITORIAL_ANNOTATION` which is `advisory: true`) refuse the approval. Separation of duties intact.

---

## §7 — Repair outcome

| Draft | AE2 outcome |
|---|---|
| `cmwazeknj` → noop | already clean post-AE1 |
| `cmway7rdv` → noop | already clean post-AE |
| `cmway7qg2` → noop | already clean post-AE |
| **`cmwa2axv1` → `cmwb0mf2u`** | **RECONSTRUCTED** per directive §5 expected shape |
| `cmwa0dyha` → noop | born clean |

Every active draft lands in `EDITED_VALIDATION_STALE`; the reviewer must still approve. No auto-approval.

Preservation: all 5 original drafts + every intermediate supersedere row remain ARCHIVED in the chain; `TrainingQuestionAiGenerationRun cmw9rrl1g000rj41xaoxvzqbb` untouched; grounding projection + source video SHA + transcript build id carried through every repair.

---

## §8 — 13 regression tests

[tests/ep-train-4y-ae2-ordering-and-reconstruction.test.ts](tests/ep-train-4y-ae2-ordering-and-reconstruction.test.ts) — all PASS. Combined with AE + AE1: **41/41 pass**.

Map to directive §8 scenarios:

| # | Scenario | Test |
|---|---|---|
| 1 | Stable chronological ordering | `sortByAtSec` across 5 drafts matches live pilot (107, 214, 321, 428, 535) |
| 2 | Equal-timestamp tie-break | 3 drafts at atSec=200 break ties on `originalContentHash` lexicographically |
| 3 | Ordering after manager edits | supersedere keeps ancestor's `originalContentHash` → position stable |
| 4 | Ordering after supersession | same test as #3 |
| 5 | Ordering after revalidation | state flip doesn't alter atSec / contentHash → position stable |
| 6 | Ordering after refresh | `scripts/4yae2-screenshots.mjs` captures identical Q1..Q5 in two fresh contexts |
| 7 | Timeline marker sync | shared `PlayerControlBar` already uses `sortedCheckpoints[currentIndex]` — AE2 sort means both sides are atSec-sorted → 1:1 |
| 8 | Prev/Next navigation | AE existing test; AE2 atSec sort means it's now chronological |
| 9 | Placeholder-only options | `OPTION_TOO_SHORT` blocks, normaliser reconstructs when conditions met |
| 10 | Misplaced answer bodies | the exact founder-reported case — normaliser produces directive's expected output |
| 11 | Safe deterministic reconstruction | correct-index + chunk count preserved |
| 12 | Ambiguous reconstruction refusal | chunk count ≠ options.length → noop; overlong-chunk → noop |
| 13 | Correct-answer preservation | every repair path tested — `isCorrect` flag passes through unchanged |
| 14 | Grounding preservation | edit-service carries `sourceVideoSha256` / `resolvedTranscriptBuildId` / `groundingProjectionSha256` / `groundingProjectionId` / `sourceSegmentIds` from parent — unchanged from AB |
| 15 | Independent reviewer approval restrictions | `hr:training:ai:approve` still CLUB_ADMIN-withheld |

---

## §9 — Staging acceptance

### Deploy

- GitHub Actions run `42871311891` — all 27 steps succeeded.
- Fly web v1141 / `sha-e82b5a3eaa1c` (started 2026-11-10T18:14:10Z, iad, 1/1 check passing)
- Fly worker — reuses AE1 image at `sha-9b77ab675b69` (no worker code changed in this slice)
- `/api/health`: HTTP 200
- Rollback anchor: `sha-d2b33d02d028`

### Screenshots (1440 × 900)

| File | Shows |
|---|---|
| `test-results/4yae2-first-load-full.png` | full review page, first session, shared player + Q1 panel |
| `test-results/4yae2-first-load-Q1.png` | **Q1**: "What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club?" — atSec=107, group cg-1 |
| `test-results/4yae2-first-load-Q2.png` | **Q2**: "What is the recommended first step when a staff member encounters a minor issue with another colleague at Silver Springs Golf Club?" — **cleaned stem + 4 structured answer choices (A/B/C/D with the clean bodies the directive asked for)** — atSec=214, group cg-2 |
| `test-results/4yae2-first-load-Q3.png` | Q3 — atSec=321, cg-3 |
| `test-results/4yae2-first-load-Q4.png` | Q4 — atSec=428, cg-4 |
| `test-results/4yae2-first-load-Q5.png` | Q5: "What is the correct way to address a member who is a former judge at Silver Springs Golf Club?" — atSec=535, cg-5. **The AE1 cleanup is retained.** |
| `test-results/4yae2-after-refresh-full.png` + Q1..Q5 shots | brand-new browser context + fresh sign-in. **Identical Q1..Q5 sequence** → ordering persists across sessions. |

`test-results/4yae2-screenshot-report.json` records both walks:
```
ordering identical across sessions: true
```

---

## Files touched

- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/page.tsx` — parse plan's `proposedCheckpointGroups[].atSec` into a map; track `originalContentHash` through BFS supersedes walk; sort `drafts` by `(atSec asc, originalContentHash asc)`
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx` — `Draft` type extended with `atSec` + `originalContentHash` (client preserves server sort)
- `src/lib/hr/training/ai-review/question-structure-validator.ts` — new placeholder-letter reconstruction branch in the normaliser
- `tests/ep-train-4y-ae2-ordering-and-reconstruction.test.ts` — NEW 13 tests
- `scripts/4yae2-diagnose.mjs` — NEW read-only Fly SSH diagnosis
- `scripts/4yae2-reconstruct-cmwa2axv1.mjs` — NEW one-shot repair via `/edit`
- `scripts/4yae2-screenshots.mjs` — NEW Q1..Q5 walker + two-session equality probe

---

## STOP

Per directive §10: STOP after staging acceptance + five-question integrity report. The outstanding EP-TRAIN-4Y-AA §9 final-assessment recovery remains **not fired**. Awaiting founder direction.
