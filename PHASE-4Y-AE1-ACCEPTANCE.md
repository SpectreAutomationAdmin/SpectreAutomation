# EP-TRAIN-4Y-AE1 — Acceptance Report

**Status**: DELIVERED
**Commit**: `d2b33d02` on `ep-train-4y-b-impl/hybrid-auth-contract`
**Previous accepted baseline**: `133fe53c` (EP-TRAIN-4Y-AE)
**Fly release**: web v1140 / `sha-d2b33d02d028`
**Staging URL**: https://staging.spectreautomation.com (health: HTTP 200)
**Rollback anchor**: `sha-9b77ab675b69` (Fly web v1139 — AE baseline)
**Boundaries honoured**: staging only · no production touches · no GPU inference · no re-transcription · no metadata regeneration · no automatic approvals or publication · both Silver Springs pilot courses preserved · stash `49c2af3d` + 126 unrelated WIP files preserved.

---

## §2 — Diagnosis: why the AE normaliser left `cmwa15k3s` untouched

Two distinct AE-era normaliser gaps combined on the founder-reported draft:

1. **`optionTextsLower` threshold too strict.** The AE `everyChunkMatchesAnOption` check used `ot.length > 10`. For `cmwa15k3s`, the two shortest options were:
   - `"Mr. Judge"` → length **9** → excluded
   - `"Judge Sir"` → length **9** → excluded

   With 2 of 4 options invisible to the matcher, the `every chunk matches an option` check evaluated `false`, so the normaliser refused to cut the stem.

2. **`EMBEDDED_OPTION_LINE_RX` required a newline.** Any founder-generated variant that lived on the SAME line as the question mark (`"…golf club? A) Mr. Judge B) Judge Sir …"`) wouldn't match at all.

The validator WAS seeing the defect — `embeddedOptionLinesInStem` was `true` in the pre-AE1 inspection — but the DISPLAY path (the Manager Review surface) renders the persisted `draftJson` as-is. The validator surfaces a 409 on write but the page continued rendering the already-persisted leaky stem. Classified per the directive §2 shortlist: **"The validator correctly flagged the question but the review UI continued displaying the malformed draft."**

Also verified: no subsequent manager edit re-introduced the content (the AE repair pass FLAGGED `cmwa15k3s` and refused to Save; the pre-AE AB cleanup pass left the inline block intact). The review page IS loading the latest active draft via the AB-era supersedes chain + 4Y-AB BFS destination resolver.

---

## §3 — Strengthened normaliser

Three changes in `src/lib/hr/training/ai-review/question-structure-validator.ts`:

### Threshold lowered 10 → 3

```ts
const chunkMatchesAnOption = (c: string): boolean => {
  const cl = c.toLowerCase();
  return optionTextsLower.some((ot) => {
    if (ot.length < 3) return false;
    // Three containment forms — covers truncated chunks + option
    // bodies with editorial tails appended.
    if (cl.startsWith(ot)) return true;
    if (ot.startsWith(cl.slice(0, Math.min(ot.length, cl.length)))) return true;
    if (cl.includes(ot)) return true;
    return false;
  });
};
```

Covers `"Mr. Judge"` (9) / `"Judge Sir"` (9). Floor of 3 still prevents false-positive single-letter matches (e.g. matching `"A"` as a substring of `"manager"`).

### Unified split regex — newline OR space prefix

```ts
const UNIFIED_OPTION_SPLIT_RX =
  /(?:\n|^|\s)(?:[*_]{0,2})([A-Da-d])(?:[*_]{0,2})\s*[)\].:]\s+/g;
```

Previous AE regex required `\n|^`. AE1's adds `\s` so inline sequences match.

### New blocking finding `INLINE_OPTION_SEQUENCE_IN_STEM`

```ts
const INLINE_OPTION_SEQUENCE_RX =
  /\s(?:[*_]{0,2})A(?:[*_]{0,2})\s*[)\].:]\s+.+?\s(?:[*_]{0,2})B(?:[*_]{0,2})\s*[)\].:]\s+/;
```

Requires AT LEAST TWO consecutive letter-prefixed chunks on the same line as the stem. A lone `"(see A)"` won't trip it.

Boundary handling is unchanged from AE: the normaliser cuts at the first chunk match and only if every chunk matches an option. Ambiguous cases still refuse — no guessing, no boundary-based splitting at the question mark alone.

---

## §4 — Editorial annotations handled separately

New advisory finding `SUSPECTED_EDITORIAL_ANNOTATION`.

```ts
const EDITORIAL_ANNOTATION_RX =
  /\(\s*(?:clarified|clarification|revised|edited|per manager|per founder|for publication|note:|note by)[^)]*\)/i;
```

Keyword-anchored — matches `"(clarified by manager for publication)"`, `"(revised per founder)"`, `"(editor's note: …)"`. A legitimate parenthetical like `"(if the member is unresponsive, call the on-duty manager)"` is NOT matched.

Finding is marked `advisory: true`. The validator's `ok` now reflects only BLOCKING findings:

```ts
const blocking = findings.filter((f) => f.advisory !== true);
return { ok: blocking.length === 0, findings };
```

So:
- A question whose ONLY issue is a suspected editorial annotation is **approvable** — the manager sees the finding in audit / future review UI but is not forced to remove it (parentheticals can be legitimate).
- A question with a structural defect AND an editorial annotation stays blocked by the structural defect.

The annotation is **never auto-stripped** — the directive §4 is explicit: "Do not automatically strip arbitrary parenthetical content."

---

## §5 — Pilot repair re-run

`scripts/4yae-repair-pilot-drafts.mjs` re-run against live staging:

| Draft (current active) | Prior state | AE1 outcome |
|---|---|---|
| `cmway7rdv` | clean (AE repaired) | noop — already clean |
| `cmway7qg2` | clean (AE repaired) | noop — already clean |
| `cmwa2axv1` | options are single letters `A/B/C/D`; option bodies live in stem as prose paragraphs | noop — cannot be deterministically corrected without inventing option bodies (directive §5: "report the exact remaining issue rather than marking it fixed") |
| **`cmwa15k3s`** → **`cmwazeknj`** | `"…golf club? \n\nA) Mr. Judge\nB) Judge Sir\nC) Mr. Former Judge\nD) Sir Mr. surname (clarified by manager for publication)"` + options carried `A) / B) / C) / D) ` prefixes | **cleaned** — stem reduced to the single question; options stripped to clean bodies; correct-answer designation preserved |
| `cmwa0dyha` | clean (born clean) | noop — already clean |

**Outcome**: 1 cleaned, 4 noop, 0 failed, 0 flagged for manual edit.

### `cmwa2axv1` — the remaining ambiguous case (report, don't guess)

This draft was generated with the option bodies inlined in the stem as prose paragraphs (not labelled `A) B) C) D)`), and the options array stores only the single letters `"A" / "B" / "C" / "D"`. There's no deterministic way to extract the option bodies back out of the stem into the array without:
- guessing paragraph boundaries (ambiguous),
- inventing which paragraph maps to which letter (would require knowledge the validator doesn't have),
- possibly misaligning the correct-answer designation.

Per directive §5: **"For any ambiguous question, report the exact remaining issue rather than marking it fixed."** The approval guard's new `QUESTION_STRUCTURE_INVALID` code will refuse to approve this row — a reviewer attempting to Accept will see a 409 with finding codes `["OPTION_TOO_SHORT"]`. The manager must inline-Edit to populate the options.

### Preservation

- All 5 original draft rows remain ARCHIVED in the supersedes chain (never mutated).
- `TrainingQuestionAiGenerationRun cmw9rrl1g000rj41xaoxvzqbb` untouched.
- AD-restored course metadata untouched.
- Audit entries written: `hr.training.ai-draft.inline-edit` on `cmwazeknj` + `TrainingQuestionAiStateTransition` row with `reasonCode: SUPERSEDED_BY_EDIT`.

---

## §6 — Validator applied at every seam

| Seam | File | AE1 strengthening live? |
|---|---|---|
| AI-draft persistence (worker proposal loop) | `src/lib/hr/training/generation/worker-handler.ts` | ✓ imports the shared validator; new findings surface in the per-group diagnostic |
| Manager inline-edit Save | `src/lib/hr/training/ai-review/edit-service.ts` | ✓ `EDIT_STRUCTURE_INVALID` rejection code |
| Draft revalidation (/revalidate) | existing path reads the same `draftJson`; the validator check fires at the next approve attempt | ✓ |
| Independent reviewer approval | `src/lib/hr/training/ai-review/approval-service.ts` | ✓ `QUESTION_STRUCTURE_INVALID` rejection code |
| Employee-facing materialisation | approval is a pre-requisite to promotion → the approval gate shields materialisation | ✓ transitively |

No new seams were introduced — all five are the AE-era wiring with the strengthened detector + normaliser now behind them.

**Separation of duties** unchanged: `hr:training:ai:approve` remains withheld from CLUB_ADMIN (founder). A reviewer with the role is still required to flip any cleaned draft from `EDITED_VALIDATION_STALE` → `APPROVED_DRAFT`.

---

## §7 — Regression tests

[tests/ep-train-4y-ae1-answer-leak.test.ts](tests/ep-train-4y-ae1-answer-leak.test.ts) — 12 new tests pinning the AE1 contract. Combined with AE: **28/28 pass**.

Headline scenarios (directive §7):
1. ✓ **The exact founder-reported question** is flagged with `EMBEDDED_OPTION_LINES_IN_STEM` + `OPTION_LABEL_PREFIX_IN_TEXT`.
2. ✓ **The normaliser produces the exact expected stem**: `"What is the correct way to address a member who is a former judge at Silver Springs Golf Club?"`.
3. ✓ Option prefixes `A) ` / `B) ` stripped; correct-answer designation preserved.
4. ✓ **Editorial-note parenthetical is ADVISORY** — `ok` stays `true` for an otherwise-clean question carrying `"(clarified by manager for publication)"`.
5. ✓ Inline (same-line) option sequence detected AND stripped.
6. ✓ Legitimate multi-sentence questions pass unchanged — stem is NOT split at the question mark alone.
7. ✓ Correct-answer `isCorrect` flag never inferred or mutated by the normaliser.
8. ✓ Ambiguous cases (chunks don't match any option) refuse auto-correction; remaining findings surface.
9. ✓ The 3 already-clean pilot drafts stay clean (`cmway7rdv`, `cmway7qg2`, `cmwa0dyha`).

---

## §8 — Staging acceptance

### Deploy

- GitHub Actions run `42865683442` — all 27 workflow steps succeeded.
- Fly web v1140 / `sha-d2b33d02d028` (started 2026-11-10T17:40:50Z, iad, 1/1 check passing)
- Fly worker — reuses the AE worker image at `sha-9b77ab675b69` (no worker code changed in this slice).
- `/api/health`: HTTP 200
- Rollback anchor: `sha-9b77ab675b69`

### The founder-reported question (screenshot)

[`test-results/4yae1-former-judge-q.png`](test-results/4yae1-former-judge-q.png) — captured in a fresh browser context, 1440 × 900, after navigating to the `cmwazeknj` draft (the superseder of the AE1-cleaned `cmwa15k3s`):

```
Question 5 of 5                                      [Edited — pending re-validation]

What is the correct way to address a member who is a former judge at Silver Springs Golf Club?

A. Mr. Judge
B. Judge Sir
C. Mr. Former Judge
D. Sir Mr. surname     ✓ Correct answer

[Accept] [Edit] [Discard]                                        [← Prev] [Next →]
```

Exactly the founder's expected shape:
- single-sentence stem, no inline options, no editorial note
- four answer choices in their own A/B/C/D rows
- correct answer marked on D
- `"Edited — pending re-validation"` badge — the lifecycle flow lands the new row in `EDITED_VALIDATION_STALE` and still needs a reviewer to approve.

### Other four questions — answer-choice leakage check

From the post-deploy `scripts/4yae-inspect-pilot-drafts.mjs` run:

| Draft | Stem (first 120 chars) | Leakage? |
|---|---|---|
| `cmwazeknj` (Q5) | "What is the correct way to address a member who is a former judge at Silver Springs Golf Club?" | **no** |
| `cmwa0dyha` (Q1) | "What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club?" | **no** |
| `cmway7qg2` (Q3) | "If a staff member notices an issue with the club during their first strike, what is the recommended action?" | **no** |
| `cmway7rdv` (Q4) | "If an employee notices an issue with the system that could be improved, what is the best course of action?" | **no** |
| `cmwa2axv1` (Q2) | "What is the recommended first step when a staff member encounters a minor issue with another colleague at Silver Springs Golf Club? \n\nHave a conversation with the general manager immediately.\nDocument…" | **options array is `["A","B","C","D"]` — single letters; option bodies live in the stem as prose paragraphs.** The approval guard refuses with `QUESTION_STRUCTURE_INVALID` + `OPTION_TOO_SHORT`. Reporting per directive §5 — the manager must inline-Edit to populate option bodies; normaliser cannot invent content. |

### Preserved

- Both Silver Springs pilot courses (`cmw8n6z8f0008z4nxck6uvms9` + `cmvzs3vz9000256qcu7lfysoz`) untouched.
- Generation run `cmw9rrl1g000rj41xaoxvzqbb` untouched.
- AD-restored course metadata (title "Employee Onboarding and Policies") untouched.
- All 5 original draft rows archived (not mutated) in the supersedes chain.
- `stash 49c2af3d` + 126 unrelated WIP files intact.

---

## Files touched

- `src/lib/hr/training/ai-review/question-structure-validator.ts` — threshold 10→3, unified split regex, new `INLINE_OPTION_SEQUENCE_IN_STEM` blocking finding, new `SUSPECTED_EDITORIAL_ANNOTATION` advisory finding, `ok` reflects blocking only
- `tests/ep-train-4y-ae1-answer-leak.test.ts` — NEW 12 regression tests
- `scripts/4yae1-screenshot-q2.mjs` — NEW walker that captures the specific "former judge" draft after advancing through the review

---

## STOP

Per directive §9: STOP after staging acceptance. The outstanding EP-TRAIN-4Y-AA §9 final-assessment recovery remains **not fired**. Awaiting founder direction.
