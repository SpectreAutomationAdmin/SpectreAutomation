# EP-TRAIN-6C-10C — Validator Hardening · ACCEPTANCE

**Status:** OFFLINE ACCEPTANCE PASSED · Workstream A of the two-workstream
EP-TRAIN-6C-12 slice.
**Branch:** `ep-train-6c-10c/validator-hardening`
**Parent commit:** `accbb0c` (EP-TRAIN-6C-10B integrated pipeline)
**Scope:** add two new deterministic detectors to the authoritative
pipeline, preserving every existing guarantee. No GPU. No inference.
No staging deploy. No employee-facing changes.

---

## 1. Summary

Two detectors added to the hardened grounding validator that already
ships at `src/lib/training/ai-generation/`:

- **`ERR_UNSUPPORTED_NAMED_ENTITY_SUBJECT`** (hard fail). Fires when the
  authoritative surface (question stem / correct options / explanation)
  uses a *specific* role word (administrator, manager, supervisor,
  director, controller, CEO, CFO, COO, owner, foreman) as the subject
  of an obligation AND the same role word does not appear in any
  cited passage.
- **`FLAG_PRESCRIPTIVE_INSERTION`** (advisory). Fires when the
  authoritative surface introduces strict obligation language
  (`must / should / shall / required / mandatory / prohibited /
  forbidden / always / never`) and the cited passages contain NO
  obligation-adjacent language at all (strict OR broader — see
  §3.2 for the broader list).

Both were specified directly by the founder directive after
EP-TRAIN-6C-11 observed that Q6's "Administrators" substitution and
Q7's "should be applied in the workplace to maintain… reduce conflicts"
invention both escaped the 6C-10A validator.

### Combined regression

**35 / 35 Vitest cases PASS** (18 new in 6C-10C + 17 preserved from 6C-10B).

### Verdict changes under the hardened validator

| Fixture | Pre-6C-10C | Post-6C-10C | Reason |
|---------|-----------|-------------|--------|
| **Q1** criticism | REQUIRES_HUMAN_VERIFICATION | REQUIRES_HUMAN_VERIFICATION (unchanged) | auth has `must`; cited has "not to"/"best not to" → broader-obligation present → no advisory fires |
| **Q2** scholarship | REJECTED (year 2026) | REJECTED (unchanged) | existing year hard fail preserved |
| **Q3** safety | REJECTED (OSHA / insurance / policy-sniff) | REJECTED (unchanged) | existing three hard fails preserved; possessive "administrator's instructions" correctly NOT read as subject of obligation |
| **Q4** member framing | REQUIRES_HUMAN_VERIFICATION | REQUIRES_HUMAN_VERIFICATION (unchanged) | no strict modal in auth; no specific role in subject position |
| **Q5** no-phones | REQUIRES_HUMAN_VERIFICATION | REQUIRES_HUMAN_VERIFICATION (unchanged) | `allowed` is permissive (not strict); no specific role in subject position |
| **Q6** phone-discretion | REQUIRES_HUMAN_VERIFICATION (74.8-batch score 52/100) | **REJECTED** | `Administrators are allowed…` pattern matches; cited passages contain no "administrator" word → new hard fail |
| **Q7** negativity-principle | REQUIRES_HUMAN_VERIFICATION (score 62/100) | REQUIRES_HUMAN_VERIFICATION (now with `FLAG_PRESCRIPTIVE_INSERTION`) | auth has `should`; cited has none of `must/should/please/need to/make sure/…` → advisory fires |
| **Q8** parking | REQUIRES_HUMAN_VERIFICATION (score 96/100) | REQUIRES_HUMAN_VERIFICATION (unchanged) | cited has `please` + `make sure` (broader-obligation) → no advisory |

Exactly the directive §A3 expectation: Q6 hard-fails on provable
actor substitution; Q7 receives the prescriptive-insertion advisory;
Q2 and Q3 keep their existing rejections; the other candidates'
verdicts are preserved.

---

## 2. Exact validator changes

### 2.1 New hard-error code

```ts
// src/lib/training/ai-generation/grounding-validator.ts
export const VALIDATOR_ERRORS = Object.freeze({
  …
  UNSUPPORTED_REGULATORY_BODY:   "ERR_UNSUPPORTED_REGULATORY_BODY",
  UNSUPPORTED_INSURANCE_REFERENCE: "ERR_UNSUPPORTED_INSURANCE_REFERENCE",
  // --- NEW in 6C-10C ---
  UNSUPPORTED_NAMED_ENTITY_SUBJECT: "ERR_UNSUPPORTED_NAMED_ENTITY_SUBJECT",
} as const);
```

### 2.2 New advisory flag code

```ts
export const VALIDATOR_FLAGS = Object.freeze({
  …
  UNSUPPORTED_QUANTITY:    "FLAG_UNSUPPORTED_QUANTITY",
  AMBIGUOUS_FACTUAL_CLAIM: "FLAG_AMBIGUOUS_FACTUAL_CLAIM",
  // --- NEW in 6C-10C ---
  PRESCRIPTIVE_INSERTION:  "FLAG_PRESCRIPTIVE_INSERTION",
} as const);
```

### 2.3 Hit-list constants

```ts
export const SPECIFIC_SUBJECT_ROLES = [
  "administrator", "manager", "supervisor", "director", "controller",
  "ceo", "cfo", "coo", "owner", "foreman",
] as const;

const SUBJECT_PREDICATE_VERBS = [
  "are", "is", "should", "must", "may", "can", "will", "need",
  "have", "has", "do", "does", "allowed", "permitted", "required",
  "ought", "shall", "cannot",
] as const;

const STRICT_MODALS = [
  "must", "should", "shall", "required", "mandatory", "prohibited",
  "forbidden", "always", "never",
] as const;

const BROADER_OBLIGATION_LANGUAGE = [
  ...STRICT_MODALS,
  "ought", "ought to", "need to", "have to", "has to", "please",
  "make sure", "ensure", "obligated to", "banned",
  "shouldn't", "mustn't", "won't", "cannot", "can't",
  "best not to", "not to", "do not", "don't",
] as const;
```

### 2.4 §A1 subject-attribution detector

```ts
function extractSpecificSubjects(text: string): SubjectClaim[] {
  const rolesAlt = SPECIFIC_SUBJECT_ROLES.join("|");
  const verbsAlt = SUBJECT_PREDICATE_VERBS.join("|");
  // Negative lookahead `(?!'s)` keeps possessive forms like
  // "administrator's instructions" out of subject-of-obligation territory.
  const pattern = new RegExp(
    `\\b(${rolesAlt})(?!['’]s)s?\\s+(${verbsAlt})\\b`,
    "gi",
  );
  …
}

function specificSubjectSupported(claim: SubjectClaim, citedLower: string): boolean {
  // Role word must appear (singular or plural) somewhere in cited text.
  // Possessive forms still count as supporting evidence.
  return new RegExp(`\\b${claim.role}s?\\b`).test(citedLower);
}
```

Integrated in `validateFactualClaims(…)`:

```ts
for (const claim of extractSpecificSubjects(sections.authoritative)) {
  if (!specificSubjectSupported(claim, citedLower)) {
    fail(errors, VALIDATOR_ERRORS.UNSUPPORTED_NAMED_ENTITY_SUBJECT,
      `authoritative section assigns obligation to specific role "${claim.role}" not present in any cited passage`,
      { role: claim.role, raw: claim.raw, section: "authoritative" });
  }
}
```

### 2.5 §A2 prescriptive-insertion advisory

```ts
if (hasStrictModal(sections.authoritative) && !hasAnyBroaderObligationLanguage(citedText)) {
  flags.push(VALIDATOR_FLAGS.PRESCRIPTIVE_INSERTION);
}
```

### 2.6 Internal-export surface for tests

```ts
export const _internal = {
  …
  // 6C-10C additions
  extractSpecificSubjects, specificSubjectSupported,
  hasStrictModal, hasAnyBroaderObligationLanguage,
};
```

No type or behavioural change to:

- `TrainingQuestionDraftLiteV1` / `TrainingQuestionProposalV1` schemas
- `convertDraftToProposal` converter
- `validateTrainingQuestion` pipeline entry point (other than the two new findings it now surfaces)
- Any existing error code or advisory flag
- The structural / organisation / policy-sniff passes

---

## 3. Design decisions

### 3.1 Why §A1 hard-fails (not advisory)

Directive §A1 permits a hard fail when the contradiction is
*deterministically established*. The detector only fires when **all
three** of the following hold:

1. Authoritative surface contains a word from `SPECIFIC_SUBJECT_ROLES`
   (never generic terms like "staff" or "employees").
2. The role word is in the **subject** position — followed by a
   predicate verb from `SUBJECT_PREDICATE_VERBS`, not in possessive form.
3. The same role word does **not** appear (in any form) in any cited
   passage.

All three combined is a hard contradiction: the model made a specific-
role obligation claim that the cited material never made. There is no
legitimate paraphrase that produces this pattern. Hard fail is
defensible.

### 3.2 Why §A2 stays advisory (never hard)

Prescriptive language is inherently paraphrasable. "You need to X",
"You must X", "You should X", "Please X", and "Make sure you X" all
express obligation; the model is allowed to paraphrase them. The
advisory only fires when **the cited passages contain no obligation
language at all** — not even "please", "need to", "make sure", "best
not to", or "don't". That's the exact Q7 pattern (cited is a flat
declarative "Negativity breeds more negativity" with no obligation
marker) and it would be wrong to escalate it to a hard failure given
the extensive paraphrase space.

### 3.3 Why possessive forms are excluded

The Q3 regression protects a legitimate referential use:
> *"according to the administrator's instructions on staff orientation…"*

Here "administrator" refers to the **speaker of the orientation**, not
the policy's subject. The possessive lookahead `(?!['’]s)` keeps
this out of subject-of-obligation territory. The §A1 adversarial case
3 locks this behaviour in.

### 3.4 Specific vs generic roles

`SPECIFIC_SUBJECT_ROLES` intentionally omits "staff", "employee",
"employees", "worker", "workers", "team member". Those are generic
terms that legitimately encompass everyone and fit any "you" address.
If the model says "Staff are required to X", that's not a narrowing
attempt — it's a reasonable paraphrase of "You are required to X".
The §A1 adversarial case 4 locks this behaviour in.

---

## 4. Q1–Q8 replay results

### 4.1 Q1–Q3 (existing 6C-10B contract test)

Historical fixtures in `tests/training-ai-generation-grounding.test.ts`
replayed verbatim — 17 / 17 PASS, same verdicts as 6C-10B acceptance.

### 4.2 Q4–Q8 (new 6C-10C contract test)

Added inline fixtures in `tests/ep-train-6c10c-hardened-detectors.test.ts`
(§A3 — Q4–Q8 regression, 5 cases):

| Candidate | New-rule outcome | Verdict | Flags |
|-----------|------------------|---------|-------|
| **Q4** | neither new rule fires | REQUIRES_HUMAN_VERIFICATION | `SOURCE_ORG_MISMATCH`, `FLAG_UNSUPPORTED_ANSWER_WORDS` |
| **Q5** | neither new rule fires | REQUIRES_HUMAN_VERIFICATION | `FLAG_UNSUPPORTED_ANSWER_WORDS` |
| **Q6** | `ERR_UNSUPPORTED_NAMED_ENTITY_SUBJECT` fires on `role=administrator` | **REJECTED** | `FLAG_UNSUPPORTED_ANSWER_WORDS` (advisory flags still accumulate; verdict dominated by the hard error) |
| **Q7** | `FLAG_PRESCRIPTIVE_INSERTION` fires (cited has zero obligation markers) | REQUIRES_HUMAN_VERIFICATION | `FLAG_UNSUPPORTED_ANSWER_WORDS`, `FLAG_PRESCRIPTIVE_INSERTION` |
| **Q8** | neither new rule fires (cited has "please" + "make sure") | REQUIRES_HUMAN_VERIFICATION | `FLAG_UNSUPPORTED_ANSWER_WORDS` |

---

## 5. Regression test inventory

### 5.1 File: `tests/ep-train-6c10c-hardened-detectors.test.ts`

| Block | Case | Expectation | Result |
|-------|------|-------------|:------:|
| §A3 Q4–Q8 replay | Q4 member-experience framing | verdict unchanged | ✓ |
| | Q5 no-phones | verdict unchanged | ✓ |
| | Q6 phone-discretion | **flips to REJECTED** | ✓ |
| | Q7 negativity-principle | advisory added, verdict unchanged | ✓ |
| | Q8 parking-policy | verdict unchanged | ✓ |
| §A1 subject-attribution | source "you" → auth "Managers" | **REJECTED** | ✓ |
| | source "Administrators" → auth "Administrators" | no fire | ✓ |
| | possessive "administrator's instructions" | no fire | ✓ |
| | generic subject "Staff are required" | no fire | ✓ |
| | named-org "Silver Springs" not as obligation subject | no fire | ✓ |
| §A2 prescriptive-insertion | auth "should", cited "need to" (paraphrase) | no fire | ✓ |
| | auth "must", cited no obligation | advisory fires | ✓ |
| | auth "required", cited "please" (paraphrase) | no fire | ✓ |
| | auth "always", cited descriptive | advisory fires | ✓ |
| | auth no modal, cited "must" | no fire | ✓ |
| | advisory is additive | advisory + verdict + 0 errors | ✓ |
| §A3 existing protections | invented year still hard-fails | ✓ | ✓ |
| | subject + year both hard-fail (stacking) | ✓ | ✓ |

**18 / 18 PASS.**

### 5.2 File: `tests/training-ai-generation-grounding.test.ts` (unchanged)

**17 / 17 PASS.** Previously-accepted behaviour fully preserved.

### 5.3 Combined

**35 / 35 PASS.** Zero regressions. Zero new TypeScript errors in the
6C-10C scope (16 pre-existing errors in SIGNUP-2 / HR / e2e unrelated).

---

## 6. False-positive and false-negative analysis

### 6.1 §A1 false positives avoided

- Possessive forms (`administrator's instructions`) — covered.
- Generic-role subjects (`Staff are required`) — covered.
- Named-org mentions that are not obligation subjects (`Silver Springs values clarity`) — covered.
- Legitimate role matches (source explicitly addresses administrators → generated question keeps subject) — covered.

### 6.2 §A1 false negatives (known residual)

- A subject that **implies** role narrowing without naming it (e.g.
  "Only senior employees are required to X" where source addresses
  everyone). The word "senior" isn't in `SPECIFIC_SUBJECT_ROLES`. Would
  need an adjective-based heuristic; out of scope for this slice.
- Named-entity substitution for job titles outside the hit-list (e.g.
  "Receptionists", "Line cooks", "Lifeguards"). Out of hit-list → not
  detected. Mitigation: expand `SPECIFIC_SUBJECT_ROLES` as evidence
  from future pilots accumulates (data-only change; no code change
  needed).
- "The committee is required to…" — "committee" is a role-like word
  not in the hit-list. Out of scope.

### 6.3 §A2 false positives avoided

- Paraphrase from "need to" to "should" — covered (`need to` is in
  broader list).
- Paraphrase from "please" to "required" — covered.
- Legitimate "must" paraphrase of source "must" — covered (both are
  strict; cited has strict).

### 6.4 §A2 false negatives (known residual)

- A prescriptive insertion that uses an obligation marker **also**
  present in cited (even if applied to a different subject). Example:
  cited "Please sign in", auth "Please sign in and then please notify
  your supervisor (invented)". Advisory doesn't fire because broader
  obligation is present. Mitigation: future slices could add per-
  sentence pairing rather than whole-text check.
- An invented "purpose clause" ("to maintain positive environment")
  without any modal verb. If auth says "This principle reduces
  conflicts" without `should/must/…`, the §A2 strict-modal check
  doesn't trigger. Q7 happens to use `should be applied` so it fires;
  a quieter inventive phrasing would slip through.

---

## 7. Changed-file inventory

| File | Status | Insertions / Deletions |
|------|--------|-----------------------:|
| `src/lib/training/ai-generation/grounding-validator.ts` | modified | +106 / -1 |
| `tests/ep-train-6c10c-hardened-detectors.test.ts` | new | +286 |

No change to:

- `src/lib/training/ai-generation/types.ts`
- `src/lib/training/ai-generation/convert-draft-to-proposal.ts`
- `src/lib/training/ai-generation/pipeline.ts`
- `src/lib/training/ai-generation/index.ts`
- `tests/training-ai-generation-grounding.test.ts`
- Any other repo file

All changes are additive. Zero existing behaviour weakened, renamed,
or removed.

---

## 8. Security and integrity

| Asset | State |
|-------|-------|
| Course DRAFT state | unchanged (no Prisma writes) |
| Video SHA / transcript / grounding / authorization schemas | unchanged |
| SPECTRE-SEC-1 credentials | unchanged (no secret rotation) |
| Modal workspace spending cap | unchanged ($10 USD intact) |
| Modal apps | not deployed; not invoked (offline slice) |
| Fly deployment | none |
| Employee training surfaces | unchanged (no UI or API touched) |
| `staging-deploy/web1b1-framer-fidelity` HEAD | unchanged (`de8653f`) |
| 6C-10B commit `accbb0c` | unchanged |
| 6C-11 commit `a865fe4` | unchanged |

---

## 9. Mandatory STOP

- Preflight passed. ✓
- Zero blocking regressions. ✓
- `npm run typecheck` clean within 6C-10C scope (0 new errors). ✓
- 35 / 35 Vitest cases pass. ✓
- **STOPPING workstream A.**
- Not merging into Workstream B, into staging, or into main.
- Not advancing to the next phase.

**Founder acceptance standard** (directive closing paragraph):

> *"Improve detection of the known Q6/Q7 grounding defects…"*

Status: **met**. Q6 is now caught deterministically as a hard failure
on the `ERR_UNSUPPORTED_NAMED_ENTITY_SUBJECT` rule; Q7 raises
`FLAG_PRESCRIPTIVE_INSERTION` as an advisory that would reach a human
reviewer in the manager-facing UI delivered by Workstream B.
