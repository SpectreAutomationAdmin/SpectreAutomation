# EP-TRAIN-6D-2 — Integration Readiness Assessment

Written for: founder review.

**Status:** READY FOR REVIEW · **not an approval to merge or deploy**
**Scope:** Inspect `ep-train-6c-10c/validator-hardening` (`0ed305c`) and
`ep-train-6d-1/manager-review-ui` (`d826ce3`) without merging them.
Report the mechanical compatibility + what wiring work a real
integration would still need.
**No merge. No deploy. No GPU. No database mutation.**

---

## 1. Headline

**Mechanical integration is clean.** The two branches touch disjoint
file sets, share a clean 3-way merge-base, and produce a conflict-free
tree under `git merge-tree`. TypeScript composes without additional
work. The UI is already forward-compatible with the new validator
codes (string-literal label map).

**Product integration is a separate question.** Even a clean merge
does not deliver a wired, auditable, multi-tenant manager-review
surface. See §7 for the real work that's still required.

---

## 2. Branch inventory

| Branch | Tip | Parent-of-tip | Role |
|--------|-----|---------------|------|
| `ep-train-6c-10b/hardened-validator-integration` | `accbb0c` | `de8653f` | Shared base for both workstreams |
| `ep-train-6c-10c/validator-hardening` (**A**) | `0ed305c` | `accbb0c` | Adds `ERR_UNSUPPORTED_NAMED_ENTITY_SUBJECT` + `FLAG_PRESCRIPTIVE_INSERTION` |
| `ep-train-6d-1/manager-review-ui` (**B**) | `d826ce3` | `8674a2a` (parent `accbb0c`) | Adds fixture-driven manager review page + 5 screenshots |
| `ep-train-6d-2/founder-visual-acceptance` (**this slice**) | current | `d826ce3` | Review-only; adds `PHASE-D-2-*.md` only |

**Shared base commit:** `accbb0c` (EP-TRAIN-6C-10B integrated pipeline).
Confirmed via `git merge-base ep-train-6c-10c/validator-hardening ep-train-6d-1/manager-review-ui`.

---

## 3. Changed-file inventory

### 3.1 Workstream A (`0ed305c` vs `accbb0c`) — 3 files

| File | Status | Lines |
|------|--------|------:|
| `src/lib/training/ai-generation/grounding-validator.ts` | modified | +126 |
| `tests/ep-train-6c10c-hardened-detectors.test.ts` | new | +444 |
| `docs/training/ai-generation/PHASE-C-10C-ACCEPTANCE.md` | new | +393 |

### 3.2 Workstream B (`d826ce3` vs `accbb0c`) — 10 files

| File | Status | Lines |
|------|--------|------:|
| `src/app/app/admin/ai-training/review/page.tsx` | new | +25 |
| `src/components/ai-training/ReviewWorkspace.tsx` | new | +509 |
| `src/components/ai-training/fixtures.ts` | new | +297 |
| `scripts/nav-audit.ts` | modified | +1 |
| `docs/training/ai-generation/PHASE-D-1-ACCEPTANCE.md` | new | +362 |
| `docs/training/ai-generation/screenshots/01-…png` through `05-…png` | new | 5 files, 1.24 MB total |

### 3.3 Overlap

```
docs/training/ai-generation/PHASE-C-10C-ACCEPTANCE.md     [A only]
docs/training/ai-generation/PHASE-D-1-ACCEPTANCE.md       [B only]
src/lib/training/ai-generation/grounding-validator.ts     [A only]
tests/ep-train-6c10c-hardened-detectors.test.ts           [A only]
src/app/app/admin/ai-training/review/page.tsx             [B only]
src/components/ai-training/ReviewWorkspace.tsx            [B only]
src/components/ai-training/fixtures.ts                    [B only]
scripts/nav-audit.ts                                      [B only]
docs/training/ai-generation/screenshots/…                 [B only]
```

**File overlap: zero.** Confirmed via `comm -12 <(A_FILES_SORTED) <(B_FILES_SORTED)`.

---

## 4. Mechanical merge analysis

### 4.1 Dry-run merge-tree

```bash
git merge-tree --write-tree \
  ep-train-6c-10c/validator-hardening \
  ep-train-6d-1/manager-review-ui
# → a0e75f544da2254b7a6e045dfd1423251f1a285a  (tree SHA)
# → exit code 0
# → no "CONFLICT" marker lines emitted
```

**Clean three-way merge. No conflicts.** The resulting tree SHA is
deterministic and can be verified by running the command above.

### 4.2 Import compatibility

**UI imports from the pipeline module:**

```ts
// src/components/ai-training/ReviewWorkspace.tsx
import {
  validateTrainingQuestion,
  type PipelineResult,
  type TrainingQuestionDraftLiteV1,
} from "@/lib/training/ai-generation";
```

```ts
// src/components/ai-training/fixtures.ts
import type {
  GroundingPassage,
  GroundingProjection,
  PilotAuthorizationV1,
  TrainingQuestionDraftLiteV1,
} from "@/lib/training/ai-generation";
```

**All six imports exist in `@/lib/training/ai-generation` on the shared
base commit `accbb0c`.** Workstream A does not rename, remove, or alter
the signature of any of them. Workstream A only **adds** two new
constants (`ERR_UNSUPPORTED_NAMED_ENTITY_SUBJECT` + `FLAG_PRESCRIPTIVE_INSERTION`)
to the existing `VALIDATOR_ERRORS` / `VALIDATOR_FLAGS` frozen objects
plus internal helper functions.

**UI does not reference A's new constants by symbol.** The
`ValidationBadges` component maps validator flag codes to human-readable
labels via a `Record<string, string>` keyed on raw code strings:

```ts
const flagLabels: Record<string, string> = {
  FLAG_UNSUPPORTED_ANSWER_WORDS: "Unsupported words",
  SOURCE_ORG_MISMATCH: "Source-org mismatch",
  FLAG_PRESCRIPTIVE_INSERTION: "Prescriptive insertion",  // ← already present
  ...
};
```

This was deliberately added in EP-TRAIN-6D-1 as forward-compatibility:
even without Workstream A merged, the label shows up in the UI with a
polished display when A's advisory ever fires. After the merge, the
flow is: A emits `FLAG_PRESCRIPTIVE_INSERTION` → pipeline returns it in
`result.flags` → UI matches the string in its `flagLabels` map → renders
"Prescriptive insertion" pill. No code change needed.

Similarly for A's hard error: UI's `EvidencePanel` renders ALL errors
with `e.code` + `e.message`, so the new `ERR_UNSUPPORTED_NAMED_ENTITY_SUBJECT`
would display with its raw code (no polished label — which is acceptable
for a hard error; the manager sees the explanatory message).

### 4.3 TypeScript compatibility

- `grounding-validator.ts` in A only adds exports (`SPECIFIC_SUBJECT_ROLES`,
  new entries in two `Object.freeze` constants, new helper functions).
- Existing type signatures (`ValidatorResult`, `ValidatorError`,
  `ValidatorWarning`, `Verdict`, `ValidateProposalInput`) are **unchanged**.
- `index.ts` re-exports in B rely on types from `types.ts` + the
  pipeline + `grounding-validator`'s `VALIDATOR_ERRORS` /
  `VALIDATOR_FLAGS` / `Verdict` / `ValidatorResult`. None of these
  re-exports are removed or renamed by A.
- A's `_internal` export gains new members (`extractSpecificSubjects`,
  `specificSubjectSupported`, `hasStrictModal`,
  `hasAnyBroaderObligationLanguage`); B does not reference `_internal`.

**On the merged tree, `npm run typecheck` should produce exactly the
16 pre-existing errors seen on both branches today — no new errors.**
I did not run the typecheck on a locally merged tree (per directive §8
"do not merge branches"); the above is a static analysis.

### 4.4 Test compatibility

- A's new test file `tests/ep-train-6c10c-hardened-detectors.test.ts`
  imports only from `@/lib/training/ai-generation` — no UI dependency.
- B's existing `tests/training-ai-generation-grounding.test.ts` (shipped
  in `accbb0c`) is unchanged on A and remains green.
- There is no test file on B that touches A's new detectors (B's
  `ValidationBadges` is purely presentational).

**On the merged tree, the combined test count would be:**

| Suite | Pass count |
|-------|-----------:|
| `tests/training-ai-generation-grounding.test.ts` (base) | 17 |
| `tests/ep-train-6c10c-hardened-detectors.test.ts` (A) | 18 |
| **Total** | **35** |

(Verified independently on each branch: A alone = 35 pass in both
files; B alone = 17 pass in the single existing file.)

### 4.5 Nav-audit compatibility

- B modifies `scripts/nav-audit.ts` by adding one line to
  `INTERNAL_ALLOWLIST`. A does not touch `scripts/nav-audit.ts`. No
  merge conflict. On the merged tree `npm run nav:audit` still shows
  0 URL-only orphans + 47 internal routes.

---

## 5. What works out-of-the-box on a merged tree

Assuming a clean merge of A + B onto a new integration branch:

1. **Pipeline + validator** produce the enhanced verdicts: Q6 flips
   to REJECTED, Q7 gains `FLAG_PRESCRIPTIVE_INSERTION`.
2. **Manager review UI** picks up the new hard-error code
   (`ERR_UNSUPPORTED_NAMED_ENTITY_SUBJECT`) in its Evidence panel's
   Hard Errors list, and the new advisory
   (`FLAG_PRESCRIPTIVE_INSERTION`) in its ValidationBadges pills (with
   the already-present "Prescriptive insertion" label).
3. **Fixture Q6** renders with the REJECTED verdict badge + the
   hard-error panel listing the subject-attribution error. This changes
   screenshot 03 but does NOT break anything — the UI renders the new
   verdict + error correctly.
4. **Fixture Q7** renders with a second advisory pill alongside
   `FLAG_UNSUPPORTED_ANSWER_WORDS`.
5. **The 35 combined tests** all pass.
6. **`npm run typecheck`** emits the 16 pre-existing errors (unchanged
   from both branches).
7. **`npm run nav:audit`** is clean.

---

## 6. What does NOT work out-of-the-box

The clean merge produces a *functional preview*, not a *production
surface*. The following are still required, in rough order:

### 6.1 Required RBAC integration

- **No new permission is wired.** The page relies only on the generic
  admin auth (`getCurrentPrincipal() + redirect("/login")`).
- A real deployment needs a new permission like `training:review` or
  `training:approve`, and the page must call `hasPermission(…)` before
  rendering.

### 6.2 Required API contracts

Not implemented in either branch:

- `POST /api/admin/ai-training/questions/[id]/approve` → records manager approval.
- `POST /api/admin/ai-training/questions/[id]/edit` → persists reviewer edits.
- `POST /api/admin/ai-training/questions/[id]/reject` → records rejection.
- `POST /api/admin/ai-training/questions/[id]/request-regeneration` → fires a new generation job (requires a separately authorised generation workflow).
- `GET  /api/admin/ai-training/questions` → lists pending candidates.
- `GET  /api/admin/ai-training/questions/[id]` → loads a single candidate.

All six routes need `requirePermission(…)` + `audit()` + tenant scope.

### 6.3 Required database models

The current `prisma/schema.prisma` has no model for:

- `TrainingQuestionDraft` (persisted model output + pipeline verdict snapshot).
- `TrainingQuestionReview` (manager action rows: approve / edit / reject with user + timestamp).
- `TrainingQuestionPublishedDraft` (post-approval, pre-publication state).
- Authorisation-fingerprint audit trail (so the pilot authorisation that generated a candidate is traceable).

A Prisma migration is required. The migration must preserve existing
training infrastructure (`src/lib/training/index.ts` Phase 13E
sandbox-mode tables are unrelated and untouched).

### 6.4 Required tenant-isolation controls

- Fixtures are hard-coded to the Coulee Ridge development tenant.
- Production routes must scope every query by `clubId` using the
  existing `tenantWhere` / `tenantScope` / `assertTenantOwned`
  helpers per CLAUDE.md.
- Pipeline results must never leak across tenants — the current
  `validateTrainingQuestion` function is tenant-agnostic by design (it
  takes grounding + authorisation as inputs; the caller is responsible
  for tenant-correct inputs). Call sites in API routes MUST enforce
  tenant scope.

### 6.5 Required audit events

- `audit(principal, { action: "training.question.approve", entityType: "TrainingQuestionDraft", entityId })`
- Same for `edit`, `reject`, `request-regeneration`, `publish`.
- Also for the hidden `rejected-→-approved-override` case (if G-1 from the visual review is not blocked outright).

### 6.6 Required publication governance

- Separately authorised publication slice.
- Approved drafts must remain `DRAFT` state until an explicit publish step.
- Published training questions become visible to employees — a separate
  permission, a separate workflow, and a separate `audit()` surface.

### 6.7 Documented gaps carried from the visual review

See [PHASE-D-2-FOUNDER-VISUAL-REVIEW.md](PHASE-D-2-FOUNDER-VISUAL-REVIEW.md#3-design-evaluation-directive-§3) §3:

- **D-1** — video player + citation seek are placeholders.
- **D-2** — loading + empty states missing.
- **D-3** — baseline A11y (no worse than other admin pages, but no
  formal audit).
- **G-1** — rejected→approved guard is missing in the UI.

Any of these could block or complicate integration; all are deferrable
to a focused slice.

---

## 7. Proposed integration sequence

**Not an authorisation.** A proposal only — the founder authorises or
revises it.

### Sequence option A — strict prerequisites first

```
EP-TRAIN-6D-3   Review-UI wiring prerequisites (still pre-production)
                - Add rejected→approved guard (G-1)
                - Add loading + empty states (D-2)
                - Add minimum A11y (role/aria-label/role=radiogroup on A/B/C/D)
                - Keep fixtures static
                - Branch from a NEW integration branch that merges A + B
                - Acceptance: visual re-check + accessibility walkthrough

EP-TRAIN-6D-4   Backend persistence + RBAC
                - Prisma migration for TrainingQuestionDraft + TrainingQuestionReview
                - training:review permission
                - 6 API routes with audit() + tenant scope
                - Replace fixture import with API calls
                - Acceptance: staging deploy (NOT this slice)

EP-TRAIN-6D-5   Live inference wiring + regeneration
                - Enable the regeneration control
                - Connect to a separately-authorised Qwen/Modal workflow
                - Credentialed per-call authorisation (reuse 6C-1 pilot auth)
                - Acceptance: live inference on staging with founder in attendance

EP-TRAIN-6D-6   Publication governance
                - Approved-draft → published-question state machine
                - Separate training:publish permission
                - Employee-portal integration (separate directive)
```

### Sequence option B — ship the merged preview first, defer everything

```
EP-TRAIN-6D-3   Merge-only integration (preview deployable)
                - Clean merge of A + B onto a new integration branch
                - Verify 35/35 tests pass
                - Fix the one UI side-effect: screenshot 03 (Q6) will show REJECTED
                  instead of REQUIRES_HUMAN_VERIFICATION after A's detector fires.
                  Re-capture that screenshot for the docs.
                - No API wiring, no persistence, no RBAC, no audit
                - Acceptance: founder visual acceptance of the new verdict outcome

EP-TRAIN-6D-4   Wiring + persistence (all of 6.1–6.6 together)
                - Risk: larger slice, more surface area for review
```

### My recommendation

**Sequence option A.** 6D-3 is small (3 UI changes, no backend) and
closes the two sharpest gaps identified in the visual review. 6D-4
remains a separate, scoped slice that the founder can authorise after
seeing 6D-3 in action.

---

## 8. Mechanical integration cost summary

| Item | Cost estimate |
|------|---------------|
| Merge A + B onto a new integration branch | < 15 min (clean merge-tree already confirmed) |
| Re-run `npm run typecheck` | ~1 min |
| Re-run the 35-test suite | ~20 sec |
| Re-capture screenshot 03 (Q6 now REJECTED) | ~5 min (same `render-preview.mjs` / `screenshot.mjs` already works) |
| Update PHASE-D-1 acceptance screenshot reference | < 5 min |
| **Total mechanical merge work** | **~30 min** |

The remaining work (§6.1–§6.6) is substantial and is estimated per-slice
inside §7's sequence proposals, not totalled here.

---

## 9. Required-reading summary for the founder

Before authorising any next slice:

1. **This document** — integration-readiness.
2. **[PHASE-D-2-FOUNDER-VISUAL-REVIEW.md](PHASE-D-2-FOUNDER-VISUAL-REVIEW.md)** — visual acceptance package with the 5 screenshots + the 2 gaps + G-1.
3. **[PHASE-C-10C-ACCEPTANCE.md](PHASE-C-10C-ACCEPTANCE.md)** (on branch `ep-train-6c-10c/validator-hardening`) — what A's additions do.
4. **[PHASE-D-1-ACCEPTANCE.md](PHASE-D-1-ACCEPTANCE.md)** — what B's UI does.

---

## 10. Mandatory STOP (directive §8)

- Two reports delivered. ✓
- Zero merge executed. ✓
- Zero deploy. ✓
- Zero new question generated. ✓
- Zero publication / assignment. ✓
- No live inference. ✓
- Technical acceptance has not been promoted to founder visual acceptance. ✓
- No next slice started. ✓

**STOPPING.** Awaiting founder decision on §7 sequence choice and on
the three founder-decision questions in
[PHASE-D-2-FOUNDER-VISUAL-REVIEW.md §9](PHASE-D-2-FOUNDER-VISUAL-REVIEW.md#9-founder-decision).
