# EP-TRAIN-6D-4X — Semantic Duplicate Detection — Design

Status: **IMPLEMENTATION COMPLETE — OFFLINE.**
Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4x/placement-and-dedup` (local commit; not pushed, not
deployed).

## 1. Problem

§6 of the 4X directive requires the final assessment never to
contain a question that exactly or semantically duplicates a prior
checkpoint question. Enforcement must cover:

- Exact duplicate detection.
- Normalised-text duplicate detection.
- Semantic equivalence detection.
- Cross-destination duplicate screening.
- Duplicate screening within the final assessment itself.
- Duplicate screening across all checkpoint groups.

§7 imposes architectural constraints:

- Deterministic + testable + explainable.
- No new paid AI provider.
- Not a new embedding model.
- Not a persistent vector index.
- Not a new schema.
- Multi-signal — cosine similarity ALONE is never cited as proof
  two questions are equivalent.
- Versioned thresholds or rules.
- Conservative handling of uncertain matches.

## 2. Architecture (deterministic, no new schema)

[src/lib/hr/training/generation/dedup.ts](../../src/lib/hr/training/generation/dedup.ts) implements
a four-verdict classifier (`EXACT_DUP` / `PARAPHRASE_DUP` /
`TOPIC_CANDIDATE` / `DISTINCT`) over a 5-signal evidence vector:

| Signal | Computation |
| ------ | ----------- |
| `normalizedMatch` | lowercased + punctuation-stripped + whitespace-collapsed question text equality |
| `shingleJaccard` | Jaccard on the union of 1-, 2- and 3-gram shingles over lemma-normalised, stopword-filtered tokens |
| `optionJaccard` | Jaccard on the option-set token universe (all options' tokens) |
| `answerTokenJaccard` | Jaccard on the correct-answer-only token universe |
| `explanationJaccard` | Jaccard on the explanation token universe |

Thresholds (all versioned under `DEDUP_RULES_VERSION = "dedup-v1"`):

| Constant | Value |
| -------- | ----- |
| `EXACT_SHINGLE` | 1.0 (not used directly — normalized match beats it) |
| `PARAPHRASE_SHINGLE` | 0.55 |
| `PARAPHRASE_OPTION_OVERLAP` | 0.5 |
| `PARAPHRASE_ANSWER_OVERLAP` | 0.6 |
| `PARAPHRASE_EXPLANATION` | 0.5 |
| `TOPIC_CANDIDATE_SHINGLE` | 0.3 |

### 2.1 Decision logic

```
if (normalizedMatch) → EXACT_DUP
else if (shingleJaccard ≥ PARAPHRASE_SHINGLE
         AND (optionJaccard ≥ PARAPHRASE_OPTION_OVERLAP
              OR answerTokenJaccard ≥ PARAPHRASE_ANSWER_OVERLAP
              OR explanationJaccard ≥ PARAPHRASE_EXPLANATION))
                                                   → PARAPHRASE_DUP
else if (shingleJaccard ≥ TOPIC_CANDIDATE_SHINGLE) → TOPIC_CANDIDATE
else                                               → DISTINCT
```

The `AND` on shingle plus ANY of three corroborating signals is the
multi-signal requirement: pure textual similarity is never
sufficient to declare paraphrase. Two questions with similar
phrasing but different correct answers, different option sets AND
different explanations degrade to `TOPIC_CANDIDATE` or `DISTINCT`.

### 2.2 Lemma + token universe

Tokens are:
1. Lowercased.
2. Punctuation stripped.
3. Whitespace collapsed.
4. Stopword filtered (closed ~80-word list).
5. Lemma-reduced via deterministic suffix-stripping (`-s` / `-es` /
   `-ed` / `-ing` / `-ly` / `-ies`). Not a full Porter stemmer —
   lightweight on purpose; trips the common
   English inflections that defeat raw-string matching
   (reports ↔ reporting ↔ reported all → `report`).

### 2.3 Shingles

`multiShingles(text)` returns the union of:
- 1-grams: `1:<lemma>` — lexical content
- 2-grams: `2:<lemma> <lemma>` — local word order
- 3-grams: `3:<lemma> <lemma> <lemma>` — phrase-level order

Prefixes keep the sets disjoint so Jaccard combines three order
scales into one score.

### 2.4 Candidate fingerprint

`candidateFingerprint(c)` is SHA-256 of the canonical (normalised +
option-order-sorted) body. Used as a stable id for logging. Not a
dedup verdict on its own (it's a strict equality test).

## 3. Verdict semantics

| Verdict | Worker action | Shortfall log entry | Manager UI (future) |
| ------- | ------------- | ------------------- | ------------------- |
| `EXACT_DUP` | **drop** candidate | records `kept: false` | n/a — never persisted |
| `PARAPHRASE_DUP` | **drop** candidate | records `kept: false` | n/a — never persisted |
| `TOPIC_CANDIDATE` | **keep** candidate | records `kept: true` + the decision | manager sees warning + priorId cross-reference |
| `DISTINCT` | **keep** candidate | records `kept: true` + the decision | no warning |

`TOPIC_CANDIDATE` is advisory — the system does not drop the
candidate. Per §8, the eventual manager workflow surfaces the
warning so the manager can review and replace if needed.

## 4. Worker integration

[src/lib/hr/training/generation/worker-handler.ts](../../src/lib/hr/training/generation/worker-handler.ts) accumulates
a `priors` list as it processes checkpoint groups + the final group.
Every candidate (after passing the plan-eligibility check) is
evaluated against ALL priors from earlier-processed groups. Priors
carry `destination: "<group-id>"` so
`DedupDecision.againstPriorDestination` records which group the
shared question came from — this supports §6 "cross-destination
duplicate screening."

The dedup log is persisted on the generation run's
`shortfallReasonJson` with:

```json
{
  "schemaVersion": "shortfall-v1",
  "targetCount": 6,
  "generatedCount": 4,
  "shortfall": 1,
  "dedupDropCount": 1,
  "dedupRulesVersion": "dedup-v1",
  "dedupDecisions": [
    { "group": "cg-1", "candidateContentHash": "…", "kept": true,
      "decision": { "verdict": "DISTINCT", … } },
    { "group": "final", "candidateContentHash": "…", "kept": false,
      "decision": { "verdict": "EXACT_DUP", "againstPriorId": "…",
                     "againstPriorDestination": "cg-1",
                     "evidence": { "normalizedMatch": true, … } } }
  ],
  "reason": "duplicates dropped by dedup pipeline"
}
```

This is additive to the existing `shortfallReasonJson` field (4W).
No new schema.

## 5. Tests

[tests/ep-train-6d4x-dedup.test.ts](../../tests/ep-train-6d4x-dedup.test.ts) — 12
contract tests covering:

- Rules version stability.
- Normalisation + fingerprint determinism (option order
  independence).
- Pairwise: EXACT_DUP, PARAPHRASE_DUP, TOPIC_CANDIDATE, DISTINCT,
  shingle-alone-insufficient (§7 "cosine alone never proves
  equivalence" analogue).
- Multi-prior: strictest verdict wins, empty-priors returns
  DISTINCT, cross-destination screening (final vs checkpoint).

[tests/ep-train-6d4x-worker-integration.test.ts](../../tests/ep-train-6d4x-worker-integration.test.ts) — 3
end-to-end scenarios:

- X1 happy path with the topic-aware plan builder.
- X2 duplicate proposals dropped + decision log persisted.
- X3 excluded segments (16/17) dropped BEFORE dedup runs (defense
  in depth).

## 6. STOP boundaries

- No new paid AI provider.
- No new embedding model.
- No persistent vector index.
- No new schema change (uses existing `shortfallReasonJson`).
- No automatic question approval or promotion.
- No publication.
- Cross-tenant isolation unchanged (dedup runs within a single
  `generationRun`, so comparison never crosses tenants).
- Modal call count unchanged (dedup runs after Modal responses, not
  during; no extra Modal round-trip).
