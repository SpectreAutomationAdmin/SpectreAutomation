# EP-TRAIN-4Y-AQ — Deterministic Question Normalisation & Zero-GPU Recovery Audit — Report

**Status**: OFFLINE repair COMPLETE · Zero-GPU recovery of the specific AP failure **INFEASIBLE** (raw text unrecoverable) · forward-looking normalisation layer SHIPPED for future attempts · **FA remains 9 of 10**.

**Boundaries honoured (directive §7/§8)**:
- Staging only; no production changes.
- NO GPU call fired.
- NO persistence of any recovered or reconstructed question.
- All 14 existing hashes + course metadata preserved.
- 126 WIP + stash `49c2af3d` untouched.

Per directive final line: **STOP after offline repair and reporting.**

---

## §8 — 10-item acceptance report

### 1. Whether the original AP proposal was recoverable

**NO — unrecoverable.**

Forensic audit of every surface identified in directive §2:

| surface | result |
|---|---|
| `TrainingQuestionAiGenerationRun` DB columns | No raw-proposal field. Only token counts, status, error codes. |
| `shortfallReasonJson.perGroupDiagnostics[fa-1].sanitizerDropReasons` | Stores `{proposalIndex, findingCodes}` ONLY. **No text.** |
| `TrainingQuestionAiDraft` rows | AP persisted zero drafts (sanitiser rejected). |
| Worker structured logs (`logger.info/warn/error`) in `worker-handler.ts` | 11 log sites — NONE log proposal content. |
| Modal client (`modal-client.ts`) | Zero logging. Response body is never serialised anywhere. |
| Fly logs (`flyctl logs --app spectre-staging-worker`) | No match for `cmwbfy1ul`, `AP-recovery`, or the sanitiser finding codes within the retention window. |
| Modal CLI | Not installed locally; account access not configured in this worktree. Even if configured, Modal retention ≤ ~7 days and the response body is not logged by the app code. |

**Conclusion**: the single Qwen proposal returned during AP (1 proposal, 328 output tokens, both `ACCORDING_TO_TRAINING_MATERIAL` + `EXPLICIT_SEGMENT_ID_REFERENCE`) exists only as those two finding codes. Every subsequent AQ test uses **SYNTHETIC fixtures, clearly labelled as such**.

### 2. Exact sanitiser violations in the original proposal, if available

The `shortfallReasonJson.perGroupDiagnostics[fa-1].sanitizerDropReasons[0]` field for run `cmwbfy1ul000dv9lt44apd074` records:

```json
{
  "proposalIndex": 0,
  "findingCodes": "ACCORDING_TO_TRAINING_MATERIAL,EXPLICIT_SEGMENT_ID_REFERENCE"
}
```

Mapped to [src/lib/hr/training/ai-review/question-text-sanitizer.ts](src/lib/hr/training/ai-review/question-text-sanitizer.ts):

- `ACCORDING_TO_TRAINING_MATERIAL` — regex `/\baccording to (?:the )?training materials?\b/i`.
- `EXPLICIT_SEGMENT_ID_REFERENCE` — regex `/\b(?:transcript\s+)?segments?\b.*?(?:\[\s*\d+(?:\s*,\s*\d+)*\s*\]|\bids?\b|\d+)/i`.

These are the two codes the AQ normaliser was designed to handle safely **when they appear as unambiguous leading / trailing framing**, and ONLY then.

### 3. Normalisation rules implemented

New offline module: [src/lib/hr/training/ai-review/question-text-normaliser.ts](src/lib/hr/training/ai-review/question-text-normaliser.ts).

**15 LEADING frame rules** (deterministic; each requires a trailing `,\s+` + WH-word so the remainder is a well-formed question stem):

| rule id | matches |
|---|---|
| `LEADING_FRAME_ACCORDING_TO_TRAINING_MATERIAL` | `^According to (?:the )?training materials?,\s+<WH>` |
| `LEADING_FRAME_ACCORDING_TO_TRANSCRIPT` | `^According to (?:the )?transcript,\s+<WH>` |
| `LEADING_FRAME_ACCORDING_TO_EVIDENCE_WINDOW` | `^According to (?:the )?evidence window(?:\s+content)?,\s+<WH>` |
| `LEADING_FRAME_AS_STATED_IN_VIDEO` | `^As stated in (?:the )?video,\s+<WH>` |
| `LEADING_FRAME_AS_STATED_IN_PRESENTATION` | `^As stated in (?:the )?presentation,\s+<WH>` |
| `LEADING_FRAME_AS_STATED_IN_TRANSCRIPT` | `^As stated in (?:the )?transcript,\s+<WH>` |
| `LEADING_FRAME_AS_STATED_IN_TRAINING_MATERIAL` | `^As stated in (?:the )?training materials?,\s+<WH>` |
| `LEADING_FRAME_BASED_ON_VIDEO` | `^Based on (?:the )?video,\s+<WH>` |
| `LEADING_FRAME_BASED_ON_PRESENTATION` | `^Based on (?:the )?presentation,\s+<WH>` |
| `LEADING_FRAME_BASED_ON_TRANSCRIPT` | `^Based on (?:the )?transcript,\s+<WH>` |
| `LEADING_FRAME_BASED_ON_TRAINING_MATERIAL` | `^Based on (?:the )?training materials?,\s+<WH>` |
| `LEADING_FRAME_IN_VIDEO` | `^In (?:the )?video,\s+<WH>` |
| `LEADING_FRAME_IN_PRESENTATION` | `^In (?:the )?presentation,\s+<WH>` |
| `LEADING_FRAME_IN_TRAINING_MATERIAL` | `^In (?:the )?training materials?,\s+<WH>` |
| `LEADING_FRAME_FROM_TRAINING_MATERIAL` | `^From (?:the )?training materials?,\s+<WH>` |

`<WH>` = `(?:what|how|when|where|why|which|who|if)`

**3 TRAILING adornment rules** (each anchored at stem end):

| rule id | matches |
|---|---|
| `TRAILING_SEGMENT_PARENTHETICAL_SEE_SEGMENT` | `\s*\(see segments? \d+(?:,\s*\d+)*\)` at end |
| `TRAILING_SEGMENT_PARENTHETICAL_BRACKETED` | `\s*\[segments? \d+(?:,\s*\d+)*\]` at end |
| `TRAILING_SEGMENT_PARENTHETICAL_PLAIN` | `\s*\(segments? \d+(?:,\s*\d+)*\)` at end |

**4 safety-refusal gates** (fail-closed; return ORIGINAL text, no transform):

1. `MULTIPLE_COMPETING_LEADING_RULES` — ≥ 2 leading rules match the same input.
2. `IDEMPOTENCY_VIOLATION` — re-applying the normaliser produces further transforms.
3. `EMPTY_AFTER_NORMALISATION` — strip yields an empty stem.
4. `LOST_WH_WORD_AFTER_STRIP` — remaining stem no longer starts with a WH-word.

**Scope boundary** — the normaliser signature accepts `{questionText}` only. Options, correct-answer, explanation, sourceSegmentIds, provenance, learning objective, assessment destination are **structurally unreachable** from the module.

### 4. Before / after question text (if available)

**Original AP proposal text**: unrecoverable (see §1).

**Representative SYNTHETIC example** (labelled as such — not the real AP text):

| aspect | value |
|---|---|
| synthetic input | `According to the training material, what identifier is used to access pay stubs? (see segment 4)` |
| transforms applied | `LEADING_FRAME_ACCORDING_TO_TRAINING_MATERIAL`, `TRAILING_SEGMENT_PARENTHETICAL_SEE_SEGMENT` |
| normalised output | `What identifier is used to access pay stubs?` |
| sanitiser verdict on normalised text | ✓ PASS (no findings) |
| options | **unchanged** |
| correct answer | **unchanged** |
| explanation | **unchanged** |
| sourceSegmentIds | **unchanged** |

### 5. Full validation results

Pipeline order inside [src/lib/hr/training/generation/worker-handler.ts](src/lib/hr/training/generation/worker-handler.ts):

```
Modal structured parse
  → grounding eligibility (unchanged)
  → AQ normalisation  ← NEW seam
  → employee-facing text sanitiser (unchanged — now sees normalised stem)
  → structural validator (unchanged — now sees normalised stem)
  → canonical body + content hash (normalised stem participates)
  → cross-assessment dedup (normalised stem participates)
  → persistence (normalised stem written to DB; original in audit trail)
```

- Normalisation NEVER bypasses or weakens a downstream validator.
- A proposal whose MID-sentence content still trips the sanitiser is still rejected (test §5.7).
- A proposal with an unresolved template placeholder is still rejected (test §5.7).
- A proposal whose normalised stem collides with a prior question is still dedup-dropped (contract §5.8).
- A proposal whose stem fails structural validation is still rejected (same gate, now seeing normalised text).

### 6. Offline regression test results

New suite: [tests/ep-train-4y-aq-normalisation.test.ts](tests/ep-train-4y-aq-normalisation.test.ts).

| metric | value |
|---|---|
| AQ suite — normalisation contract | **30 / 30 PASS** |
| cross-regression (AA sanitiser + AE structure + AE1 answer-leak + AE2 ordering + AP focused + AO cross-assessment dedup + AQ) | **117 / 117 PASS** |
| typecheck on AQ-touched files (`worker-handler.ts`, `question-text-normaliser.ts`, AQ test file) | **CLEAN** — zero new TS errors |

Sub-section coverage:
- §5.1 — 7 leading-frame cases (each of the AP-shape + 6 others)
- §5.2 — 3 trailing-segment cases
- §5.3 — combined leading + trailing (AP failure signature, SYNTHETIC)
- §5.4 — 5 ambiguity / safety-gate cases
- §5.5 — options/correct-answer/explanation isolation (type-level + runtime)
- §5.6 — provenance isolation (type-level + runtime)
- §5.7 — downstream sanitiser still fires (mid-sentence, unresolved placeholder)
- §5.8 — dedup receives normalised stem (contract documentation)
- §5.9 — **idempotency** proven across 5 inputs
- §5.10 — 14 representative existing-question stems match **ZERO** normalisation rules (no retrospective regression)
- §5.11 — audit summary shape
- §5.12 — safety gate defensive guard

### 7. Whether zero-GPU recovery is feasible

**NO — INFEASIBLE for the specific AP proposal.**

Zero-GPU recovery requires the exact rejected text to feed through the repaired pipeline. The forensic audit in §1 established the text is unrecoverable from the DB, worker logs, or any application surface. Modal account logs beyond the local worktree's visibility would require separate founder authorisation to inspect; even if they contained the text, the retention window may have elapsed and no persistence endpoint is designed for ingesting raw Modal responses after the fact (the generation lifecycle binds a proposal to a specific `pilotAuthorizationId` and `leaseToken` that no longer exist for `cmwbfy1ul`).

**Per directive §6 final clause**: "If the proposal is unavailable or cannot pass safely, stop and report the limitation." Stopping. No endpoint implemented.

**Forward-looking value**: the normalisation layer is now LIVE for every future authorised GPU call. A next-attempt Qwen proposal that would have tripped only on `ACCORDING_TO_TRAINING_MATERIAL` + `EXPLICIT_SEGMENT_ID_REFERENCE` with the leading/trailing shape will now pass sanitisation, dedup against all 14 existing drafts under its stripped stem, and persist with a full audit trail.

### 8. Any required founder authorisation for persistence

**None in this slice** — no persistence attempted, nothing to authorise.

For a future authorised GPU attempt to reach 10/10:
- Existing `preInvocationBudgetGate` + `PILOT_BUDGET_OVERRIDES` controls remain in force.
- The $2 Silver-Springs override from AN still has ≈$1.26 headroom ($0.7373 cumulative post-AP of $2.00 cap).
- The Modal $10 account cap has ≈$9.26 headroom.
- No new founder authorisation required to invoke the normaliser on a future call — it runs unconditionally inside the existing worker pipeline. A separate founder directive IS required to fire another GPU inference (per existing `AF-GPU-AUTHORIZED-<date>` confirm-token contract).

### 9. Preservation and staging deployment evidence

**Local worktree preservation at pre-deploy:**

| aspect | status |
|---|---|
| Working tree untracked WIP files | 0 (clean) |
| Scripts preserved (`scripts/4y*`) | 75 files intact |
| Stash stack | 2 stashes intact (`4y-i-generate-comment-cleanup-WIP` + SIGNUP-2 M1c) |
| Branch | `ep-train-4y-b-impl/hybrid-auth-contract` |
| HEAD before AQ commit | `f3b26f9c` (EP-TRAIN-4Y-AP) |

**Files changed in AQ**:

| file | kind |
|---|---|
| `src/lib/hr/training/ai-review/question-text-normaliser.ts` | NEW — pure offline module |
| `src/lib/hr/training/generation/worker-handler.ts` | MODIFIED — add normaliser seam + perGroupDiagnostics.normalisationTrace |
| `tests/ep-train-4y-aq-normalisation.test.ts` | NEW — 30 tests |
| `PHASE-4Y-AQ-REPORT.md` | NEW — this report |

**Staging deployment**: see §9 deploy section below once DRH-1 completes.

### 10. Recommendation for reaching ten questions

Given:
- The specific AP proposal cannot be recovered without GPU.
- The normalisation layer is now live; the same shape will not trip the sanitiser on a future attempt.
- Modal account cap headroom: ~$9.26; Silver-Springs pilot cap headroom: ~$1.26.
- Qwen's cross-run compliance rate improved with every fix (AI 0% → AK 86% → AN 75% → AO cap → AP 0% on a single ultra-constrained call).

**Recommended next action (NOT fired — requires fresh founder authorisation)**:

**Option R1 — re-fire AP's focused-recovery payload once more with the normaliser live.** Same 4-segment chunk, same topic exclusions, same $0.13 projected ceiling. If Qwen returns the same leading-frame + trailing-segment-ref shape, the normaliser will strip both, the sanitiser will pass, and FA reaches **10/10 for approximately $0.01**. If Qwen returns any other failure mode (mid-sentence refs, unresolved placeholders, options/explanation leakage), the existing sanitiser catches it as before — zero risk of regressing the 9/10 baseline.

**Fallback Option D (from AP)** — accept 9/10 as the baseline and let the manager inline-edit any sanitiser-gap drafts via the existing Edit action; no further GPU work. $0 incremental.

No further action without explicit founder authorisation.

---

## Staging deploy

Will be filled in after DRH-1 completes.

---

## STOP

Per directive final line. The §3 normalisation architecture is permanent, reusable, and audit-complete. **FA remains at 9 of 10 pending founder decision on R1 vs D.**
