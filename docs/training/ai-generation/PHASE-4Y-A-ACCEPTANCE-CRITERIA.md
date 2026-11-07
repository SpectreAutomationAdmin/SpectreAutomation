# EP-TRAIN-4Y-A — Live AI Pilot Acceptance Criteria

**Status:** READ-ONLY PROPOSAL (2026-11-07). Awaits founder
ratification (G.D).
**Scope:** directive §7. Objective, measurable acceptance criteria
for the EP-TRAIN-4Y-A pilot's transcription, question quality,
checkpoint placement, duplicate screening, and human-review
discipline.
**Companion docs:**
- [PHASE-4Y-A-LIVE-AI-PREFLIGHT.md](PHASE-4Y-A-LIVE-AI-PREFLIGHT.md)
- [PHASE-4Y-A-PILOT-PLAN.md](PHASE-4Y-A-PILOT-PLAN.md)

**Prior-art baseline**: EP-TRAIN-6C-11 § 6 produced a 74.8/100
average rubric score across 5 candidates on the same Silver
Springs source video. The thresholds below are informed by that
baseline — not calibrated to beat it, but calibrated so failing
them is a REAL regression.

---

## 1. Transcript accuracy (§7 item 1)

Reference: hand-transcript authored by the pilot operator against
the Silver Springs Staff Orientation audio. The hand-transcript is
written BEFORE Modal is invoked, so it is independent ground truth.

| Dimension | Metric | Threshold | Measurement |
|-----------|--------|----------:|-------------|
| Overall word-error-rate (WER) | `jiwer.wer(hand, model)` | **≤ 12 %** | Lower-case + punctuation-stripped comparison, token-level |
| Overall character-error-rate (CER) | `jiwer.cer(hand, model)` | **≤ 8 %** | Same normalisation |
| Segment timestamp accuracy | Median `|hand.startSec − model.startSec|` across aligned segments | **≤ 2 s** | Aligned via lexical overlap on text windows |
| Segment boundary F1 | F1 score on segment boundaries within ±1.5 s tolerance | **≥ 0.80** | — |
| SHA parity | `audioSha256` from Modal = `videoSha256` from DB | **MUST MATCH** | Exact string equality (hex) |
| Excluded segment 16/17 handling | 0 grounding citations reference segments 16 or 17 | **MUST BE 0** | Enforced by `EXCLUDED_SEGMENT_INDICES` across 4L/4W/4M; violation is a code defect |

**Non-blocking observational metrics (captured for 6C-11 comparison):**

- Segment-index-map stability vs 6C-7 baseline (`0549c7e34b8c81129ee138a7a8c6fffab4e8d0ac061ea2c833f4d5056daaa0d6`).
- Confidence-score distribution (`avgConfidence` per segment).

---

## 2. Grounding evidence (§7 item 2)

| Dimension | Metric | Threshold | Measurement |
|-----------|--------|----------:|-------------|
| Grounding fidelity | % of proposals where every `sourceSegmentIds[]` entry refers to a transcript segment that EXISTS in the build | **100 %** (hard requirement) | Validator enforces; failure = `MODAL_BODY_INVALID` TERMINAL |
| Answer-in-source | % of proposals where the correct option's claim appears verbatim OR as a close paraphrase in the cited segments | **≥ 80 %** | Human review per proposal (reviewer rubric) |
| Source-segment coverage per proposal | Mean count of `sourceSegmentIds[]` per proposal | **≥ 1, ≤ 5** | Fewer than 1 = ungrounded; more than 5 = diluted |
| Advisory flag `FLAG_UNSUPPORTED_ANSWER_WORDS` per proposal | Mean | **≤ 3** (6C-11 baseline: 5/5 proposals had this flag) | Pipeline logs; see 6C-11 § 5.2 |

---

## 3. Factual correctness (§7 item 3)

| Dimension | Metric | Threshold | Measurement |
|-----------|--------|----------:|-------------|
| Invented years / dates / money / percentages / durations / regulatory bodies / insurance references | Count of such fabrications across all surviving drafts | **0** | Factual-claim detector (per 6C-10A); 6C-11 observed 0 across 5 candidates |
| Material factual errors (attribution confusion, invented prescriptions, etc.) | Count across surviving drafts | **≤ 1 per 6 drafts** (6C-11 baseline: 1 Q6 attribution error + 1 Q7 invented interpretation = 2/5) | Human review per rubric; reviewer MUST reject these in Phase D |
| Reviewer-rejection rate (approved-draft rate = 1 − rejection-rate) | Rejections per 10 proposals | **≤ 3** (i.e. ≥ 70 % approvable after review) | Observed in Phase D; 6C-11 did not promote any (5/5 REQUIRES_HUMAN_VERIFICATION) |

---

## 4. Source-organisation preservation (§7 item 4)

| Dimension | Metric | Threshold | Measurement |
|-----------|--------|----------:|-------------|
| Prompt-side identity | Any transformation of "Silver Springs" to another org in the generated question text / explanation / options | **0 occurrences** | Simple regex check on every draft; `SOURCE_ORG_MISMATCH` advisory flag populated by 6C-10A detector; 6C-11 had 1/5 rate (Q4 cited a passage with Silver Springs in it, which is NOT a mismatch — a mismatch is Silver Springs → Coulee Ridge or any rewrite) |
| Transcript-side identity | "Silver Springs" verbatim retention in cited segments (if present in the source transcript) | **100 %** (bytes preserved; Modal must not paraphrase the org name) | Comparison against hand-transcript |
| Coulee Ridge contamination | Any proposal mentioning Coulee Ridge | **0 occurrences** | Simple regex; Silver Springs is the source, Coulee Ridge is unrelated |

---

## 5. Checkpoint placement (§7 item 5)

| Dimension | Metric | Threshold | Measurement |
|-----------|--------|----------:|-------------|
| Checkpoint timestamp vs natural topic boundary | Median `|checkpoint.atSec − closest_boundary.atSec|` | **≤ 5 s** | Compared against operator-labelled boundaries in the hand-transcript |
| Minimum content length before first checkpoint | `firstCheckpoint.atSec` | **≥ 15 s** | Protects against premature checkpoints |
| Maximum fraction of video before last checkpoint | `lastCheckpoint.atSec / videoDuration` | **≤ 0.90** | Leaves room for the final-assessment surface |
| Checkpoint-density | Checkpoint count / min of video | **1-3 per min** | Too few = thin; too many = fatiguing |
| Checkpoint placed inside excluded segment (16, 17) | Count | **0** | Enforced by 4W placement service |

---

## 6. Natural topic boundaries (§7 item 6)

| Dimension | Metric | Threshold | Measurement |
|-----------|--------|----------:|-------------|
| Boundary rationale non-empty | `plan.boundaries[i].rationale.length` | **≥ 20 chars** | Topic-aware placement produces explicit rationale |
| Boundary within instructional content | Boundary falls after the first substantive sentence of a passage | **100 %** | Reviewer rubric: inspect each boundary |
| Boundary respects speaker turn | Boundary does not fall mid-sentence | **100 %** | Reviewer rubric |

---

## 7. Question quality — rubric (§7 items 7 + 8)

Same 6-criteria weighting as EP-TRAIN-6C-11 §6, with per-criterion
pilot thresholds. Scored manually by the designated reviewer in
Phase F.

| Criterion | Weight | Pilot threshold (average) | 6C-11 baseline |
|-----------|-------:|---------------------------:|---------------:|
| Factual accuracy | 25 | ≥ 19 (76 %) | 19.0 |
| Correct-answer verifiability | 20 | ≥ 16 (80 %) | 16.4 |
| Grounding + attribution | 20 | ≥ 16 (80 %) | 16.6 |
| Distractor quality | 15 | ≥ 7 (47 %) | 6.6 |
| Question clarity | 10 | ≥ 7 (70 %) | 7.2 |
| Relevance | 10 | ≥ 8 (80 %) | 9.0 |
| **Total / 100 (average across drafts)** | — | **≥ 70** | **74.8** |

### 7.1 Per-draft gates

- **Minimum passing score per draft**: 60 / 100. Any draft < 60
  MUST be rejected or substantially rewritten; it does NOT
  automatically disqualify the pilot (6C-11 Q6 scored 52 and the
  pilot still succeeded as a controlled study), but a count of
  such drafts > 1 in a 6-draft pilot is a signal to rerun with
  prompt-level tuning.
- **Minimum passing score per candidate on Grounding+Attribution**:
  **15 / 20**. Below this, the question is ungrounded and MUST be
  rejected.

### 7.2 Editorial disposition distribution target

| Disposition | Target | 6C-11 baseline |
|-------------|-------:|---------------:|
| Minor copy-editing | ≥ 40 % | 2 / 5 = 40 % |
| Substantial rewriting | ≤ 60 % | 3 / 5 = 60 % |
| Complete rejection | ≤ 20 % | 0 / 5 = 0 % |
| No copy-editing (publishable as-is) | ≥ 0 % (accept 0 in a 6-draft pilot) | 0 / 5 |

### 7.3 Final-assessment question quality (distinct from checkpoint)

Final-assessment questions sample across the WHOLE transcript.
Additional threshold:

- Topic coverage: final-assessment drafts span ≥ 60 % of the
  non-excluded transcript segments (measured as union of
  `sourceSegmentIds[]` across all final drafts / count of
  non-excluded segments).

### 7.4 Checkpoint question quality (distinct from final)

Checkpoint questions sample from THE CHECKPOINT'S SEGMENT WINDOW
ONLY. Additional threshold:

- Every checkpoint draft's `sourceSegmentIds[]` subset ⊆ the
  checkpoint's eligible segments (enforced by 4W validator).
- No checkpoint question draws from segments that occur AFTER the
  checkpoint's `atSec` (temporal no-leak).

---

## 8. Cross-assessment duplicate detection (§7 item 9)

**Explicit distinction between lexical and semantic uniqueness.**

### 8.1 Lexical dedup (automated — 4X)

| Dimension | Metric | Threshold | Measurement |
|-----------|--------|----------:|-------------|
| 4X lexical dedup verdict stability | On a rerun with the same transcript, the same duplicate decisions | **100 %** | Deterministic; verify by running dedup twice |
| Lexical near-duplicate rejection rate | Rejections across ~12 proposals | **≥ 10 %** (expect 1-2 near-dupes per run) | 4X logs |
| Lexical exact-duplicate rejection rate | Rejections | **≥ 0 %** (may be 0 if the model varies enough) | 4X logs |

### 8.2 Semantic dedup (human — 4N approval)

| Dimension | Metric | Threshold | Measurement |
|-----------|--------|----------:|-------------|
| Reviewer-detected semantic duplicates across the full draft set (6-12 drafts) | Count | **Report honestly; no automatic pass/fail threshold** — this is the human judgement gate | Reviewer rubric adds a "SEMANTIC_DUP_WITH_DRAFT_<id>" flag per draft |

**The pilot MUST NOT claim semantic uniqueness from 4X's lexical
classifier alone.** Any marketing / founder-facing statement about
"deduped questions" must be explicit about the lexical boundary.

---

## 9. Human review discipline (§7 item 10)

| Dimension | Metric | Threshold | Measurement |
|-----------|--------|----------:|-------------|
| Every draft gets a reviewer action | Reviewer-action-count per draft | **= 1** (approve or reject; no draft left unreviewed) | DB: every `TrainingQuestionAiDraft` row where the pilot wrote it has a corresponding `TrainingQuestionAiReview` row |
| Reviewer attestation present | Every approval carries the attestation flag | **100 %** | `TrainingQuestionAiReview.attestationFlag = true` (service enforces) |
| Reviewer independence | Reviewer's `User.id` ≠ Admin operator's `User.id` ≠ founder's `User.id` | **MUST** | Attribution verification per 4Z-F pattern |
| `validatorSource = "integrated-pipeline"` on every validation | — | **100 %** | 4N guard enforces (`VALIDATION_SOURCE_INVALID` rejection); anything else is a pilot-fixture bug |
| Reviewer time per draft | Median seconds between dialog open and approval click | **≥ 60 s** | Captured via `TrainingQuestionAiReview.createdAt − dialogOpenedAt` (if measurable) OR operator timing notes; too-fast review suggests rubber-stamping |

---

## 10. Unsupported factual assertions (§7 item 11)

| Dimension | Metric | Threshold | Measurement |
|-----------|--------|----------:|-------------|
| Hallucination rejection rate (on the adversarial-fake-answer subset authored by the operator) | % of fabricated proposals correctly rejected by `answer-in-source` + grounding validator | **≥ 95 %** | Operator authors 3 adversarial inputs (per EP-TRAIN-6A-2 §D.2) as "red-team" prompts before Phase C |
| Unsupported prescriptive language (Q7-style "should" statements not in source) | Count across drafts | **≤ 1 per 6 drafts** | Reviewer rubric adds a flag; 6C-11 Q7 is the pattern to catch |
| Contradiction rate (two options marked "correct" with contradictory evidence) | Count across all drafts | **≤ 1 per 20 proposals** | Validator detects some; reviewer catches rest |

---

## 11. Question-count shortfalls (§7 item 12)

| Dimension | Metric | Threshold | Measurement |
|-----------|--------|----------:|-------------|
| Requested `targetTotalQuestions` | Set by operator at Phase C.1 | **6** (recommended for first pilot) | — |
| Surviving drafts after 4X lexical dedup | — | **≥ 4** (two shortfall allowed on first pilot) | 4X logs |
| Surviving drafts after 4N reviewer approval | — | **≥ 3** (further 1-draft shortfall allowed) | DB count |
| Promoted questions at Phase E | — | **≥ 3** (acceptance minimum) | DB count |
| **Shortfall report**: if surviving < 3, document which stage shed drafts and why | Operator writes in acceptance doc | **MUST** | — |

---

## 12. Lexical ≠ semantic — the mandatory-caveat statement

Every founder-facing summary of the pilot MUST include a verbatim
line:

> "Spectre's duplicate-detection layer (EP-TRAIN-6D-4X) is lexical.
> It does not prove semantic equivalence. All claims of question
> uniqueness are gated by human review at EP-TRAIN-6D-4N, not by
> automated dedup."

Omitting this line from the acceptance deliverable is a §7
violation.

---

## 13. Acceptance decision matrix

| Scenario | Decision |
|----------|----------|
| All thresholds met; rubric ≥ 70; promotion works; attribution clean | **ACCEPTED** — pilot ready for founder review; next slice can propose production readiness |
| Rubric 60-70; 1-2 drafts needing substantial rewrite; promotion works; attribution clean | **CONDITIONAL ACCEPTED** — document patterns; recommend prompt-tuning before a second pilot |
| Rubric < 60; OR attribution leaks founder in any row; OR grounding violations | **REJECTED** — surface root cause; pilot does NOT progress to a second run |
| Pilot aborted during Phase C due to Modal failure | **BLOCKED** — report Modal failure modes; no decision on question quality |
| Spend-cap or Modal account-limit tripped | **BLOCKED** — report cost evidence; pilot halted mid-run |

---

## 14. Required final-response fields (for the acceptance deliverable)

The pilot's acceptance report MUST include:

1. Actual-vs-threshold table for §1 (transcription) — 6 metrics.
2. Actual-vs-threshold table for §2 (grounding) — 4 metrics.
3. Actual-vs-threshold table for §3 (factual correctness) — 3 metrics.
4. Zero-contamination report for §4 (source-organisation).
5. Checkpoint-placement evidence for §5 — 5 metrics + boundary labels.
6. Boundary-rationale table for §6.
7. **Rubric table** (per-candidate, 6 criteria, matching 6C-11 §6 shape).
8. Editorial-disposition distribution (§7.2).
9. Lexical dedup counts (§8.1) + semantic-dup reviewer flags (§8.2).
10. Reviewer-discipline verification (§9) — attribution + attestation + independence.
11. Hallucination-rejection results on the 3 adversarial inputs (§10).
12. Shortfall report (§11) — target vs actual, per stage.
13. The mandatory-caveat line (§12) verbatim.
14. Acceptance decision per §13.
15. Modal cost table (metered + billed + cap utilisation) + zero-GPU verification (`modal container list`).
16. Cleanup verification (0 rows in each of the 10 pilot tables).
17. Historical preservation (Marc + 9 Chris completions unchanged; Coulee Ridge untouched).

**End of acceptance criteria.**
