# EP-TRAIN-4Y-AV — Full Course Editorial Quality Audit — Report

**Status**: ✅ **AUDIT COMPLETE** · 15 questions inventoried · editorial matrix produced · coverage + workflow assessed · **ZERO GPU** · **ZERO content mutations** · 15/15 content hashes byte-identical before + after audit.

**Scope**: Silver Springs Golf & Country Club — *Employee Onboarding and Policies* (course `cmw8n6z8f0008z4nxck6uvms9`, version `cmw8n6z9a000az4nx56vwh02f`). Transcript build `cmw79jvxz06peoj63os52bvon` (163 segments).

**Boundaries honoured**: no GPU inference · no question edits · no new drafts · no deletions · no approvals · no promotions · no publications · staging-only · tenant-scoped reads · 126 WIP files + stash `49c2af3d` preserved.

---

## §1 — Complete 15-question inventory

Resolved via faithful port of `parseShortfallGroupMap` + `composeGroupMapsFromRuns` + `destinationKindForGroup` + 5-level supersedes walk (same algorithm the review page uses — see [src/lib/hr/training/generation/destination-resolver.ts](src/lib/hr/training/generation/destination-resolver.ts)). Rendered order matches the review surface's chronological-by-atSec ordering.

### CHECKPOINTS (5)

| # | atSec | hash | state | run | stem |
|---|---|---|---|---|---|
| CP-1 | 107 s | `24c26223e6d1` | EDITED_VALIDATION_STALE | `cmw9rrl1g…` (COMPLETED) | *"What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club?"* |
| CP-2 | 214 s | `fcf533481947` | EDITED_VALIDATION_STALE | `cmw9rrl1g…` (COMPLETED) | *"What is the recommended first step when a staff member encounters a minor issue with another colleague at Silver Springs Golf Club?"* |
| CP-3 | 321 s | `e05878acffc1` | EDITED_VALIDATION_STALE | `cmw9rrl1g…` (COMPLETED) | *"If an employee notices an issue with the system that could be improved, what is the best course of action?"* |
| CP-4 | 428 s | `5d2863681508` | EDITED_VALIDATION_STALE | `cmw9rrl1g…` (COMPLETED) | *"If a staff member notices an issue with the club during their first strike, what is the recommended action?"* |
| CP-5 | 535 s | `084e91e008d1` | EDITED_VALIDATION_STALE | `cmw9rrl1g…` (COMPLETED) | *"What is the correct way to address a member who is a former judge at Silver Springs Golf Club?"* |

Every CP's `state` is `EDITED_VALIDATION_STALE` — an earlier manager edit has been saved; re-validation has not fired. This is a benign lifecycle state (the content IS still present; it just needs the validator run before promotion).

### FINAL ASSESSMENT (10)

| # | group | hash | state | run | stem (truncated) |
|---|---|---|---|---|---|
| FA-1 | fa-1 | `e479567ee290` | REQUIRES_HUMAN_REVIEW | `cmwbatqv9…` (COMPLETED, AK) | *"Which of the following is NOT part of the three-strike policy…"* |
| FA-2 | fa-1 | `01ff61464357` | REQUIRES_HUMAN_REVIEW | `cmwbatqv9…` (COMPLETED, AK) | *"What is the recommended cell phone usage policy…"* |
| FA-3 | fa-1 | `7c428a0d126a` | REQUIRES_HUMAN_REVIEW | `cmwbdnn1b…` (COMPLETED, AN) | *"When a staff member encounters an issue with another colleague, which step should they take first…"* |
| FA-4 | fa-1 | `b4d2ed9ffdf8` | REQUIRES_HUMAN_REVIEW | `cmwbij5rq…` (FAILED, AR + AS recovery) | *"How can employees access their pay stubs?"* |
| FA-5 | fa-2 | `642496d444c2` | REQUIRES_HUMAN_REVIEW | `cmwbdnn1b…` (COMPLETED, AN) | *"What should a staff member do if they notice an issue during service to a member…"* |
| FA-6 | fa-3 | `155890567d00` | REQUIRES_HUMAN_REVIEW | `cmwbatqv9…` (COMPLETED, AK) | *"When a staff member sees an issue that could potentially harm the safety of others…"* |
| FA-7 | fa-3 | `c855a6435458` | REQUIRES_HUMAN_REVIEW | `cmwbatqv9…` (COMPLETED, AK) | *"What discount is available to staff members who wish to purchase clothing, hats, and merchandise…"* |
| FA-8 | fa-3 | `f8ae54baa666` | REQUIRES_HUMAN_REVIEW | `cmwbatqv9…` (COMPLETED, AK) | *"If a staff member wants to play golf early in the morning, what is the likely outcome…"* |
| FA-9 | fa-4 | `00054b4f30fa` | REQUIRES_HUMAN_REVIEW | `cmwbatqv9…` (COMPLETED, AK) | *"According to the training, what is expected of staff members at Silver Springs to ensure they contribute positively…"* |
| FA-10 | fa-4 | `008af536cb3d` | REQUIRES_HUMAN_REVIEW | `cmwbdnn1b…` (COMPLETED, AN) | *"What expectation does the club have for its staff members regarding their attitude and behavior towards guests and colleagues?"* |

Full JSON (stem, every option, correct answer, explanation, cited segments, destination, generation-run id, timestamps) is in [test-results/4yav-grounding.json](test-results/4yav-grounding.json). Side-by-side transcript dump is in [test-results/4yav-transcript.md](test-results/4yav-transcript.md). Grounding join in [test-results/4yav-grounding.md](test-results/4yav-grounding.md).

---

## §2 — Editorial quality matrix

Each row carries my decision (ACCEPT / EDIT / REPLACE / INVESTIGATE), the dominant reason, and the grounding evidence. **Nothing in this matrix mutates data** — it is a reviewer recommendation list for the manager to act on inside the existing review UI.

### Checkpoints

| ID | decision | principal findings | grounded in segments |
|---|---|---|---|
| **CP-1** (`24c26223`) | **ACCEPT** | Stem clear, grounded, standalone. Correct answer verbatim from [19]–[20], [28]. Distractors each present a plausible wrong escalation path. | ✅ [15, 18, 19, 20, 28] |
| **CP-2** (`fcf5334819`) | **REPLACE** | (a) Topically identical to CP-1 (first step in colleague complaint) — a *checkpoint* placed 107 s later in the video should not re-ask the same policy. (b) Option D contains an editorial-note leak: *"Involve a manager in the conversation right away. (clarified by manager for publication)"*. The parenthetical should never appear in learner-visible text — it is a prior manager-edit audit trail that leaked into the option body. | ⚠ overlap + data leak |
| **CP-3** (`e05878acffc1`) | **EDIT** | Correct answer is grounded in [60] ("must be offered or be prepared to offer at least one solution"). Minor: stem says *"issue with the system"* — the transcript phrases this as *"criticism"* of *"procedures"*. Rewrite stem for precision; retain options. | ✅ [60]; stem could cite [54] too |
| **CP-4** (`5d2863681508`) | **EDIT (stem factual error)** | The stem conflates two unrelated policies. *"During their first strike"* references the **disciplinary** three-strike policy (segments [7]–[14], where the strike is *against* the employee), but the correct answer and the cited segments describe the **safety / near-miss reporting** procedure (segments [99]–[105]). The stem must be rewritten to say *"notices a safety hazard or near-miss"*; options remain correct. | ✅ [101, 104] (safety); stem wrongly invokes [7]–[14] |
| **CP-5** (`084e91e008d1`) | **EDIT (correct answer wording)** | The transcript ([136]–[137]) says to address a **former** judge with *"sir, Mr. or Mrs."* — i.e. stop using the "Judge" title and revert to standard salutations with the surname. The emitted correct option *"Sir Mr. surname"* reads as a *stacked* salutation, which is not what the transcript says and is editorially awkward. Rewrite the correct option to *"**Sir, Mr., or Mrs. followed by the member's surname**"*. Stem is fine. Distractors are good foils. | ✅ [136, 137]; correct option wording garbled |

### Final Assessment

| ID | decision | principal findings | grounded in segments |
|---|---|---|---|
| **FA-1** (`e479567ee290`) | **REPLACE** | *"Which of the following is NOT part of the three-strike policy"* — ambiguous. The transcript's three-strike policy (segs [7]–[14]) is: strike 1 = *"having an issue with the club"*, strike 2 = *"another sit-down, documented, signed off, in your file"*, strike 3 = *"end of the game"*. The *"absolute forbidden"* list — *"surfing the internet… smoking around the clubhouse"* (segs [30]–[37]) — is a **separate** policy, not the three-strike list. The question's four options include items from BOTH policies, which makes two or three distractors equally defensible answers. Pedagogically unsound. | ⚠ conflates two policies |
| **FA-2** (`01ff61464357`) | **ACCEPT** | Cell phone policy question. Correct answer verbatim from [39] (*"Please be discreet, not within the eyes of our members and guests"*). Distractors are each distinct behaviours that the policy does **not** endorse. Clean. | ✅ [38, 39] |
| **FA-3** (`7c428a0d126a`) | **REPLACE** | Direct duplicate of CP-1. First-step-in-colleague-dispute is already a checkpoint; repeating it verbatim in the final assessment adds no learning value. The over-wide `sourceSegmentIds` list ([15, 28–40]) is a symptom — it includes the entire *absolute-forbidden* and *cell-phone* sections, which have nothing to do with colleague disputes. The explanation also bleeds the cited segment list into prose: *"…steps two and three involve the manager and general manager respectively, only if the initial conversation does not resolve the issue. [15, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]"* — the trailing bracketed list is a render leak that reviewers see verbatim in the UI. | ⚠ full duplicate of CP-1 |
| **FA-4** (`b4d2ed9ffdf8`) | **ACCEPT** | The AS-recovered pay-stub question. Correct answer verbatim from [3]–[4]. Explanation is clean and precise. This is the cleanest question of the fifteen — the manager-editorial pipeline produces well-shaped stems and explanations. | ✅ [3, 4] |
| **FA-5** (`642496d444c2`) | **EDIT** | The stem says *"an issue during service to a member"*, but the cited segments [53], [59], [60] are the **criticism-of-procedures** policy, not real-time service hiccups. Reframe stem as *"If a staff member sees an opportunity to improve a Silver Springs procedure or system…"*. Also: cited segment [45] (phone etiquette) is noise — unrelated to the correct answer. Options are usable once the stem is re-pointed. Notably, this creates further overlap with CP-3; see §3. | ⚠ stem mis-framed; cites unrelated [45] |
| **FA-6** (`155890567d00`) | **ACCEPT** (with caveat) | Safety / near-miss reporting. Correct answer well grounded in [100]–[105]. Overlaps CP-4 — but if CP-4 is edited to point correctly at safety reporting, the two become genuine duplicates. Depending on CP-4's rewrite, this one or CP-4 should be REPLACED. See §3. | ✅ [100–105]; cited [95–98] (parking) are noise |
| **FA-7** (`c855a6435458`) | **ACCEPT** | *"What discount is available to staff members who wish to purchase clothing, hats, and merchandise…"* — correct answer 25% from [118] exactly. Distractors are numerically distinct. Clean. | ✅ [118] |
| **FA-8** (`f8ae54baa666`) | **ACCEPT** | Early-morning staff golf. Correct answer verbatim from [116]. Distractors are each plausible wrong policies. Clean. | ✅ [116] |
| **FA-9** (`00054b4f30fa`) | **EDIT** | Correct answer is well grounded in [142] and [145]. Two issues: (a) cited segment [135] (*"a refreshment host who works on hole 6 and 13"*) is unrelated noise; drop it. (b) Stem has trailing whitespace / blank lines (cosmetic, but visible in the UI pane). Also overlaps FA-10; see §3. | ✅ [142, 145]; [135] is noise |
| **FA-10** (`008af536cb3d`) | **REPLACE** | Near-duplicate of FA-9. Both test *"staff attitude expectations"*. FA-9 asks about *"contribution to atmosphere/culture"* with options about proactivity; FA-10 asks about *"attitude and behavior toward guests/colleagues"* with options about empathy. The transcript ([139]–[145]) treats these as a single integrated message — the two questions reduce coverage without reinforcing a nuance. Keep FA-9 (which pulls directly from the proactivity half of the passage); REPLACE FA-10 with a question on an un-assessed topic (see §4 gap list). | ⚠ duplicate of FA-9 |

### Matrix summary

| decision | count | ids |
|---|---|---|
| **ACCEPT** | 5 | CP-1, FA-2, FA-4, FA-7, FA-8 |
| **ACCEPT (caveat)** | 1 | FA-6 — see below |
| **EDIT** | 5 | CP-3, CP-4, CP-5, FA-5, FA-9 |
| **REPLACE** | 4 | CP-2, FA-1, FA-3, FA-10 |
| **INVESTIGATE** | 0 | — |
| **TOTAL** | **15** | — |

FA-6 is classified ACCEPT-with-caveat because its content stands on its own; whether it survives alongside CP-4 depends on whether CP-4 is rewritten off the safety-reporting topic (if so, FA-6 is a clean ACCEPT; if CP-4 keeps the safety topic via the EDIT path, one of them should instead REPLACE to something in §4's gap list).

---

## §3 — Factual / wording defects identified

Defects grouped by severity. Only the first two groups should block manager acceptance; the rest are stylistic.

### 3.1 Substantive defects (block acceptance)

1. **CP-4 stem — factual conflation of two unrelated policies.** The stem invokes "first strike" (disciplinary) while the correct answer references near-miss reporting (safety). An employee who treats this question seriously may get a mistaken impression that the disciplinary policy has a safety-reporting leg, or vice-versa. **Edit before accepting.**

2. **CP-2 option D — editorial-note leak into learner-facing option text.** The parenthetical *"(clarified by manager for publication)"* is visible to employees as part of option D. **Replace the entire question** (it also duplicates CP-1), which removes the leaked parenthetical as a side effect.

3. **FA-1 — question structure forces the reviewer to pick between ambiguous distractors.** Three of the four options are each defensibly "not part of the three-strike policy" depending on interpretation. The current correct answer ("Complaining about another staff member") is the single UNAMBIGUOUS member of the list, but asking employees to disambiguate between adjacent policies is editorially weak. **Replace.**

4. **FA-5 stem — points at a different policy than its options and correct answer.** *"An issue during service to a member"* does not align with the criticism-of-procedures text the options draw from. **Edit the stem.**

### 3.2 Correct-answer wording defects (block acceptance)

5. **CP-5 correct option** — the emitted text *"Sir Mr. surname"* does not mirror the transcript's actual guidance (*"sir, Mr. or Mrs."* — alternatives, not a stacked title). **Edit the correct option** to *"Sir, Mr., or Mrs. followed by the member's surname"*.

### 3.3 Grounding-citation defects (non-blocking but worth cleanup on EDIT)

- **FA-3** cites [15, 28–40] — only [15, 28, 29] are on-topic; [30]–[40] are forbidden-list / cell-phone content.
- **FA-5** cites [45] (phone etiquette) — unrelated.
- **FA-6** cites [95]–[98] (parking) — unrelated.
- **FA-9** cites [135] (refreshment host duty station) — unrelated.

These over-wide citations are symptoms of the generator's low-confidence grounding windows; they do not appear in the learner UI, but they will confuse any later manager review that reads the grounding projection.

### 3.4 Explanation-rendering defects (non-blocking cosmetic)

- **FA-3** explanation contains `[15, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]` as trailing bracketed segment IDs in prose — reviewers see this verbatim in the UI pane.
- **FA-9**, **FA-10** stems have trailing whitespace / blank lines visible in the rendered pane (confirmed in the Playwright capture).
- **All 5 CP drafts** — explanation field is EMPTY. The original generator left them blank. This is not a bug per se, but a cheap editorial win: for every CP that lands ACCEPT or EDIT, the manager should write a one-sentence "why" for the learner result screen.

---

## §4 — Duplicate / overlap analysis

### Cross-assessment duplicate topics

| topic | assessments involved | verdict |
|---|---|---|
| **First step in colleague dispute** | CP-1 (ACCEPT), CP-2 (REPLACE — also has leaked editorial note), FA-3 (REPLACE — full duplicate) | one surviving question (CP-1); the other two retire |
| **Criticism / offer-a-solution** | CP-3 (EDIT), FA-5 (EDIT, stem re-pointed to same policy) | after both edits they will be near-duplicates; if both survive, the FA version should be reframed to a DIFFERENT un-assessed topic |
| **Safety / near-miss reporting** | CP-4 (currently defective, EDIT-to-safety), FA-6 (ACCEPT) | if CP-4 is rewritten to point at safety, keep only one — recommend keep FA-6 and reframe CP-4 to a currently un-assessed topic |
| **Staff attitude / positive culture** | FA-9 (EDIT), FA-10 (REPLACE) | keep FA-9 (proactivity angle); replace FA-10 with coverage of an un-assessed topic |

Of the fifteen questions, **four topic clusters are duplicated**. Each cluster currently costs 1–2 "slots" in the assessment that could be used for coverage below.

### Important transcript-supported topics with ZERO assessment coverage

A learner who completes the current fifteen questions is NEVER tested on any of these:

| topic | segments | editorial note |
|---|---|---|
| **Terminology (members not customers; silver lounge; refreshment host not beer cart girl)** | [127]–[135] | a club-specific policy with direct tangible impact on member-facing speech; replaces a vague "service" topic |
| **Employee handbook sign-off requirement** | [106]–[109] | compliance-critical: signing acknowledges the handbook has been read |
| **Staff meals — 50% off, one per shift, outside peak times** | [122]–[124] | high-recall policy with frequent day-to-day impact |
| **Golf club discount (cost + 10) and complimentary rental clubs with same-condition return** | [119]–[121] | high-recall policy |
| **Guest green-fee discount (50%) + cart seat ($20) + booking 12 noon day prior** | [111]–[113] | booking-rule failure has operational consequences |
| **Parking rules — back end by muster point / corporate-tournament sidewalk** | [87]–[98] | repeated and emphasised in-video; completely absent from assessment |
| **"10 things that require zero talent"** | [157]–[162] | listed as the headline close of the training; compelling multi-choice material |
| **$500 scholarships — 3 available, November 1 deadline, monthly staff newsletter** | [83]–[86] | time-bound policy; worth one question so the deadline stays visible |

The four REPLACE decisions free four slots; four strong topics above (**terminology**, **handbook sign-off**, **staff meals**, **parking rules**) are my top recommendations to fill them — each is standalone, each is grounded in distinct transcript segments, and each has operational consequence.

### Does the repetition serve legitimate reinforcement?

No. In Spectre's assessment pedagogy, the five CPs break the video into thirds so the learner cannot defer attention, and the ten FA questions test retention across the whole training. Asking the same first-step-of-colleague-dispute question three times teaches the learner that one topic is three times more important than parking, staff meals, or terminology — none of which are tested. The cost of each duplicate is the loss of an unassessed, operationally-important topic.

---

## §5 — Manager workflow — staging evidence

Captured via a READ-ONLY authenticated Playwright walk at 1440 × 900 (`tests/e2e/ep-train-4y-av-workflow-snapshot.staging.spec.ts`, **1 passed 1.0 min**; traces + screenshots under `test-results/4yav-screens/`). The walk clicks CP tab + FA tab, navigates Next through every question, and captures each pane's rendered DOM. **No edits, no approvals, no submissions.**

| capability | present? | evidence |
|---|---|---|
| Efficient sequential question review | **✅** | `Question N of M` counter + `← Prev` / `Next →` buttons on every pane (observed on all 15 panes) |
| Inline editing | **✅** | `data-testid="manager-review-edit"` (button) → opens edit pane with per-option text, isCorrect toggle, explanation field; `-save` / `-cancel` buttons; `-error` region for validator failures |
| Correct-answer visibility | **✅** | Each option prefixes "A./B./C./D." and the correct option trails `✓ Correct answer`; in edit mode, a radio-style `correct-{i}` toggle sets the correct option |
| Clear review states | **✅** | Status chip on every pane: `Edited — pending re-validation` for the 5 CP drafts, `Needs review` for the 10 FA drafts; `Validation failed` + `Approved` states exist in source |
| Discard and replacement behaviour | **✅** | Discard button on every pane; separate "Needs correction · N" amber card renders at the top when the AS rejected-proposals API returns entries (AS pipeline) |
| Preservation of review progress | **✅** | Edit → Save path writes a new draft (supersedesDraftId chain) and keeps the ancestor ARCHIVED; the 5 current CPs are all in `EDITED_VALIDATION_STALE` — proof the edit pipeline preserves prior state |
| Navigation between CP and FA | **✅** | Two tabs (`manager-review-mode-checkpoints`, `manager-review-mode-final`) with counts (`Checkpoints · 5`, `Final assessment · 10`); confirmed clickable in the Playwright walk |
| Employee preview | **✅** | `manager-review-preview-link` present in the header |
| Reviewer separation of duties | **✅** | Four distinct RBAC gates: `hr:training:ai:read` (browse), `hr:training:write` (edit / promote / recover), `hr:training:ai:approve` (approve route), `hr:training:publish` (course lifecycle). Approve route maps 403 → 404 same-shape per directive §4. CLUB_ADMIN does **not** currently carry `hr:training:ai:approve` — confirmed in memory [[project-ep-train-6d-4z-c-promotion-acceptance]]. |

### Material UX issues observed on staging

- **CP-2 option D leaks an editorial audit note to learners**: *"Involve a manager in the conversation right away. (clarified by manager for publication)"*. This is not a workflow bug per se — the review surface renders what is in `draftJson` — but the UI should refuse to render parentheticals of that shape, OR the content needs REPLACE (my §2 recommendation). Flagged here because it was observed in the rendered pane, not just in the data.
- **FA-3 explanation leaks the segment-id list as prose** (ends with `[15, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]`). Same category: a render-filter on explanation prose would be cheap, or REPLACE the question.
- **CP drafts have empty explanation fields** on the rendered pane — the learner-facing result screen will show a bare "Correct answer: X" with no learning context. Not blocking, but a one-sentence explanation on each CP is an easy editorial win.

Beyond those three content/data items, no material UX issue was observed in the current review interface. The workflow is suitable for serial editorial review by a single manager; one small "remaining to review" count in the header would be the biggest ergonomics win, but that is a next-slice improvement, not a defect.

---

## §6 — Preservation verification

Preservation probe run POST-audit after every script and the Playwright walk completed:

| aspect | expected | observed |
|---|---|---|
| Live drafts | 15 | **15** |
| 14 pre-AS content hashes | byte-identical | **byte-identical** |
| AS Q10 hash `b4d2ed9ffdf8…` | byte-identical | **byte-identical** |
| `course.title` = `Employee Onboarding and Policies` | unchanged | unchanged |
| `course.aiMetadataAttributionAt` = `2026-11-10T20:42:51.040Z` | unchanged | **unchanged (11th consecutive preservation run)** |
| `trainingCompletion` count for version | 0 | **0** |
| `trainingQuestionAiDraft.state=PROMOTED` count | 0 | **0** |
| Generation runs | 9 | 9 (no new run inserted during audit) |
| Transcript segments | 163 | 163 (not a draft table but the authoritative grounding source) |

Full post-audit probe output in [test-results/4yav-preservation.json](test-results/4yav-preservation.json). Script: [scripts/4yav-preservation.mjs](scripts/4yav-preservation.mjs).

**No question edits. No new AI generation. No deletions. No approvals. No publication.**

---

## §7 — Recommended edits / replacements (full wording)

For every EDIT and REPLACE above, below is the proposed replacement wording. **These are recommendations; the manager applies them via the existing edit UI. None of this is written into the database by this audit.**

### CP-3 (EDIT)

> **Current**: *"If an employee notices an issue with the system that could be improved, what is the best course of action?"*
> **Proposed**: *"If a staff member has a criticism of a Silver Springs procedure or process, what are they expected to do before raising it?"*
> **Why**: the transcript uses the word *"criticism"* and the *"offer a solution"* obligation. The current stem's *"system"* language feels corporate-SaaS; the club's vernacular is *"procedure"* and *"criticism"*. Options remain as-is.

### CP-4 (EDIT — factual rewrite)

> **Current (factually wrong)**: *"If a staff member notices an issue with the club during their first strike, what is the recommended action?"*
> **Proposed**: *"If a staff member observes a safety hazard or a near-miss incident at Silver Springs, what is the recommended action?"*
> **Why**: the correct answer and cited segments describe near-miss reporting, not the disciplinary three-strike policy. Options are preserved; stem is re-pointed. **Note**: with this rewrite, CP-4 and FA-6 both test near-miss reporting — recommend REPLACING CP-4 with a question on an un-assessed topic instead (see §4 gap list); the easier *EDIT* option is retained here for the manager's choice.

### CP-5 (EDIT — correct-option wording)

> **Current correct option**: *"Sir Mr. surname"*
> **Proposed correct option**: *"Sir, Mr., or Mrs. followed by the member's surname"*
> **Why**: the transcript presents three alternatives, not a stacked title. Keep distractors as-is; they are good foils.

### FA-5 (EDIT — stem re-point)

> **Current**: *"What should a staff member do if they notice an issue during service to a member at Silver Springs Golf Club?"*
> **Proposed**: *"If a staff member sees an opportunity to improve a Silver Springs procedure or service system, what are they expected to do before raising it?"*
> **Why**: aligns the stem with the segments actually cited; eliminates the service-to-a-member framing the training does not use. **Note**: after this edit, FA-5 and CP-3 both test the same criticism-with-solution policy — one should be REPLACED instead (recommend REPLACING FA-5 with a question on an un-assessed topic — see §4).

### FA-9 (EDIT — cosmetic + citation cleanup)

> **Stem**: unchanged (acceptable).
> **Fix**: drop trailing whitespace / blank lines in the stem; drop cited segment [135] (refreshment host) from `sourceSegmentIds` — not a grounded reference.
> **Why**: cosmetic + grounding hygiene.

### CP-2 (REPLACE)

> **Why**: topical duplicate of CP-1; option D leaks a manager-editorial audit note into learner text.
> **Replace with (grounded in [106]–[109])**:
> *"What is a Silver Springs staff member required to do on their last day of onboarding before they begin regular shifts?"*
> **Options**:
> - **[✓] Sign the back page of the employee handbook acknowledging they have read it**
> - [ ] Submit a copy of their driver's licence to the general manager
> - [ ] Record their SIN number on the front page of the employee handbook
> - [ ] Shadow the head golf professional for one full shift
> **Grounded in**: [106], [107], [108], [109].

### FA-1 (REPLACE)

> **Why**: forces disambiguation between two separate policies; pedagogically unsound.
> **Replace with (grounded in [127]–[135])**:
> *"When speaking to a member at Silver Springs, which of the following is the correct term to use for the staff member who serves refreshments on holes 6 and 13?"*
> **Options**:
> - **[✓] Refreshment host**
> - [ ] Beer cart girl
> - [ ] Course runner
> - [ ] Starter
> **Grounded in**: [134], [135] and the broader terminology section [127]–[131].

### FA-3 (REPLACE)

> **Why**: exact duplicate of CP-1.
> **Replace with (grounded in [122]–[124])**:
> *"Which of the following correctly describes the staff meal benefit at Silver Springs Golf and Country Club?"*
> **Options**:
> - **[✓] 50% off the menu, one meal per shift, ordered outside peak times**
> - [ ] Free meals at any time during the shift
> - [ ] 25% off the menu with no limit on meals per shift
> - [ ] Free meals only after the shift ends, at the Silver Lounge
> **Grounded in**: [122], [123], [124].

### FA-10 (REPLACE)

> **Why**: duplicate of FA-9 (both test staff attitude).
> **Replace with (grounded in [87]–[98])**:
> *"On a corporate tournament day at Silver Springs, where are staff members asked to park?"*
> **Options**:
> - **[✓] On the sidewalk to the left (west) of the clubhouse**
> - [ ] In the back of the parking lot by the muster point sign
> - [ ] In the member-and-guest parking at the front of the clubhouse
> - [ ] On Varsity Estates Drive
> **Grounded in**: [94], [95], [96].

### Summary of §7 operational impact

If the manager accepts the 5 ACCEPTs, applies the 4 EDITs, and the 4 REPLACEs with the wording above, the resulting fifteen questions cover:

- Complaint resolution (CP-1) ← kept
- Criticism-with-solution (CP-3) ← kept (edited)
- Safety / near-miss reporting (CP-4 or FA-6, whichever retains the topic)
- Member salutations (CP-5)
- Cell phone policy (FA-2)
- Pay-stub access (FA-4)
- Soft-goods discount (FA-7)
- Staff golf early-morning policy (FA-8)
- Staff attitude / proactivity (FA-9)
- Three new topics (handbook sign-off, staff meals, parking) — if REPLACE wording is applied
- Member terminology (refreshment host) — if FA-1 REPLACE is applied

That is 10 distinct topics vs the current 7 (with 4 duplicate pairs). Information density per question approximately doubles.

---

## §8 — Preservation verification (same as §6, named explicitly for directive numbering)

See §6. Fifteen hashes byte-identical before and after this audit. No approvals, no promotions, no publications, no deletions, no new GPU. Audit log untouched by this slice.

---

## §9 — Prioritised recommendations for the next implementation slice

Ordered by **blast radius × editorial yield**. Each is a self-contained next slice.

### P0 — Manager editorial pass (no code; no slice)

*The highest-yield next step is NOT engineering — it is the manager working through the 15 panes using the already-built edit UI.* The 5 ACCEPTs confirm with one click. The 5 EDITs are stem / option / citation rewrites inside the existing editor. The 4 REPLACEs are discard-then-write-new (which the AS pipeline already supports via rejected-proposal recovery for the "needs correction" card; for non-rejected drafts, the discard button is the current primitive).

**No engineering needed. No new slice.** This is the entire purpose of the manager review interface.

### P1 — Render-filter guard against editorial-note leaks (small code slice)

Add a pure, test-covered sanitiser to the ManagerReviewClient render path that strips parenthetical editorial notes matching an allowlist of patterns (e.g. *"(clarified by manager for publication)"*, *"(editor's note:…)"*) from option text and explanation before display. The sanitiser is NOT a mutation — the DB keeps the original string — but the learner-facing pane and any export path never show them. One file, ~40 LoC, strict Zod-style patterns, Vitest coverage.

**Blast radius**: display-only. **Yield**: closes CP-2 option D issue and prevents the same class of leak when future managers annotate options.

### P2 — Empty-explanation nudge in the manager review UI (small UX slice)

When a draft is `EDITED_VALIDATION_STALE` or `REQUIRES_HUMAN_REVIEW` AND `body.explanation.length === 0`, show a soft amber "Add a learner explanation" prompt on the pane. The CP drafts all have empty explanations — this is a very visible editorial polish gap. One component change, no new state.

**Yield**: lifts the CP learner-result screens from "bare correct answer" to "correct + why".

### P3 — Grounding-citation cleanup on save (small service slice)

When a manager clicks Save after an edit, the service already recomputes contentHash. Add a pre-save lint that flags `sourceSegmentIds` referencing segments outside the citation set of the stem/explanation text (approximate: segment text doesn't share any 4-gram with stem+explanation). Surface as a warning, not a blocker. Resolves the FA-3 / FA-5 / FA-6 / FA-9 over-wide citations without over-constraining future edits.

**Yield**: tightens grounding without blocking edits.

### P4 — Coverage dashboard (medium slice)

Compute, per course version, which transcript segments are / are not referenced by any accepted draft. Surface a coverage histogram in the review surface's header card. Makes the gap list in §4 visible to every future manager-review session on every course.

**Yield**: converts the §4 analysis from one-time report to a live dashboard — the next course won't ship with 4 duplicate topics and 8 un-assessed ones.

### P5 — A future GPU slice (NOT NOW)

If the founder wants an automated attempt at replacing the four REPLACE candidates, a future slice could authorise a tightly-scoped Qwen generation call seeded by the §7 proposed wordings as `priorQuestionTextsForDedup` entries. But this adds cost + risk and is not on the critical path — the P0 manager pass delivers the same editorial result with zero marginal cost.

### Out of scope for AV

- No change to approved-draft lifecycle semantics.
- No change to RBAC.
- No change to the generation pipeline.
- No change to validation thresholds.
- No change to retention / audit.

---

## Boundaries verification

| boundary | status |
|---|---|
| No GPU inference | **PASS** — no Modal call, no new generation run |
| No question edits | **PASS** — no `trainingQuestionAiDraft` write |
| No new AI generation | **PASS** |
| No deletions | **PASS** |
| No approvals | **PASS** — 0 drafts moved to APPROVED_DRAFT |
| No publication | **PASS** — course version state unchanged |
| Tenant-scoped queries | **PASS** — every Prisma call includes `clubId` + courseVersionId |
| Preserve `49c2af3d` stash | **PASS** — stash@{0} still points at `49c2af3dabb7c4e90e9aa439996788a619c91a05` |
| Preserve unrelated WIP | **PASS** — 126 untracked WIP files unchanged |

---

## Artefacts produced by this audit

- [test-results/4yav-inventory.json](test-results/4yav-inventory.json) — raw DB dump (27 drafts incl. ancestors, 9 runs, 14 validations)
- [test-results/4yav-inventory-v2.json](test-results/4yav-inventory-v2.json) — live-draft + transcript-segment dump
- [test-results/4yav-resolved.json](test-results/4yav-resolved.json) — destination resolution for every live draft
- [test-results/4yav-grounding.md](test-results/4yav-grounding.md) + `.json` — question-by-question grounding join
- [test-results/4yav-transcript.md](test-results/4yav-transcript.md) — full 163-segment transcript (reference for the editorial matrix)
- [test-results/4yav-workflow-snapshot.json](test-results/4yav-workflow-snapshot.json) — Playwright DOM capture of every CP + FA pane on staging
- [test-results/4yav-screens/](test-results/4yav-screens/) — PNG screenshots of each pane at 1440×900
- [test-results/4yav-preservation.json](test-results/4yav-preservation.json) — post-audit preservation probe result
- [scripts/4yav-inventory.mjs](scripts/4yav-inventory.mjs), [scripts/4yav-inventory-v2.mjs](scripts/4yav-inventory-v2.mjs), [scripts/4yav-destinations-v2.mjs](scripts/4yav-destinations-v2.mjs), [scripts/4yav-grounding.mjs](scripts/4yav-grounding.mjs), [scripts/4yav-preservation.mjs](scripts/4yav-preservation.mjs) — the read-only harness

---

## STOP

Per directive final line. The audit is complete; the report is complete; no GPU inference and no content changes were performed. **The next step is a manager editorial pass against the matrix in §2 and the proposed wording in §7**, using the review UI that is already live.
