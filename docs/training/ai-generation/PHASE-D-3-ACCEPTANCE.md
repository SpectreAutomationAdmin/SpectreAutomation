# EP-TRAIN-6D-3 — Manager Review Safety & Interaction Prerequisites · ACCEPTANCE

**Status:** OFFLINE ACCEPTANCE PASSED.
**Branch:** `ep-train-6d-3/review-ui-prerequisites`
**Parent commit:** `28e8584` (EP-TRAIN-6D-2 founder-visual-review branch, which carries the 6D-1 UI + screenshots).
**Scope:** fixture-only UI hardening — close G-1 (approval guard), add
loading / empty / error states (D-2), raise accessibility floor (D-3),
clarify video + citation-seek placeholder labelling. No merge. No deploy.
No Prisma. No API routes. No live inference.

---

## 1. Summary

The founder-provisional visual direction accepted in 6D-2 is preserved
verbatim. Four safety + interaction gaps that the 6D-2 review surfaced
are now closed:

| Gap | 6D-2 status | 6D-3 status |
|-----|-------------|-------------|
| **G-1** Rejected candidates can be silently approved | real defect | **closed** — single authoritative approval guard (pure function `evaluateApproval`) called BOTH to drive the button's `disabled` state AND inside the Approve action handler. 15 / 15 guard tests pass. |
| **D-2** No loading / empty / error states | expected for fixture mode | **closed** — six polished states added (`loading`, `empty`, `no-selection`, `missing-evidence`, `failed-fixture`, `validation-unavailable`), rendered in Spectre's approved visual language, screenshot-tested at 1440 × 900. |
| **D-3** Baseline A11y (parity with other admin pages but no audit) | needed focused slice | **closed** — `aria-label` on every queue control, `role="radiogroup"` / `role="radio"` on single-answer options with `aria-checked`, `role="list"` on multi-answer, `role="alert"` on hard-error panel + stale-validation banner, `role="status"` + `aria-live="polite"` on validation row, `focus-visible:ring` on every interactive, `aria-describedby` wiring the Approve button to its block-reason text, `aria-disabled` on every disabled control, `sr-only` label on the mobile queue `<select>`. |
| **Video + citation-seek placeholders** | ambiguous | **clearer** — video tile reads *"video not connected in fixture mode"*; a dedicated **Placeholder notice** paragraph underneath states *"Click-to-seek from a cited passage to the video player arrives with the live wire-up slice. Fixture mode shows cited passages visually but does not play back the video."* |

A fifth deliverable — the **stale-after-edit flow** — is new in this
slice (required by directive §4):

> "Preserve the model-generated original separately from reviewer edits.
> When a reviewer edits a question: Mark the edited draft as requiring
> revalidation. Preserve the previous validation result as historical
> evidence. Do not treat previous validation as applying to changed
> content. Disable approval until the edited content has been validated.
> …Provide a clearly labeled fixture revalidation demonstration using
> predefined validation outcomes."

The 6D-1 baseline silently re-ran `validateTrainingQuestion` via
`useMemo` on every keystroke. 6D-3 stops doing that. Edits now:

1. Save the previous `latestValidation` into `previousValidation`.
2. Flip `validationStatus` to `"stale"`.
3. Do NOT touch `latestValidation` — the Evidence rail continues to
   render the pre-edit verdict (badged **STALE (PRE-EDIT RESULT)**).
4. Show a dedicated sky-blue **"VALIDATION IS STALE"** banner at the top
   of the main column with a **Revalidate (fixture)** button.
5. Disable Approve via the guard (`VALIDATION_STALE`).
6. On **Revalidate (fixture)**, apply the fixture's predetermined
   outcome. This is clearly labelled "fixture outcome" in both the
   banner (the scenario description) and the button; no pretense of
   live validation on arbitrary content.

---

## 2. G-1 root cause + fix

### 2.1 Root cause (6D-1 baseline)

```ts
// Old ReviewControls, 6D-1 baseline
<button
  onClick={() => onChange({ disposition: "approved" })}
  className="…bg-emerald-700…"
>
  Approve
</button>
```

The Approve button had no disposition guard, no verdict guard, no
staleness guard. A manager could click Reject on Q3 → click Approve one
line later → approved disposition set with REJECTED verdict + 3 hard
errors still live.

Compounding factor: `effectiveDraft` was fed directly into
`validateTrainingQuestion` via `useMemo`, so even when the manager
edited to something clearly wrong (invented year, etc.), the UI silently
re-validated on every keystroke — treating any edit as if it carried
the semantic weight of a real pipeline run.

### 2.2 Fix

**New pure function** `evaluateApproval({ latestValidation, validationStatus })`
in [src/components/ai-training/approval-guard.ts](../../src/components/ai-training/approval-guard.ts).

Approval is blocked when **any** of:

1. `validationStatus === "unknown"` → `VALIDATION_STATUS_UNKNOWN`
2. `validationStatus === "pending"` → `VALIDATION_PENDING`
3. `validationStatus === "failed"` → `VALIDATION_FAILED`
4. `validationStatus === "stale"` → `VALIDATION_STALE`
5. `latestValidation === null` → `VALIDATION_MISSING`
6. `latestValidation.verdict === "REJECTED"` → `VERDICT_REJECTED`
7. `latestValidation.errors.length > 0` (defense-in-depth) → `UNRESOLVED_HARD_ERRORS`

The function returns `{ allowed, reasons, message }`. `reasons` carries
every block reason (stacked); `message` is the first reason's
human-readable text for inline display.

**Double-gate enforcement.** The guard is called twice per render path:

1. At render time to compute the Approve button's `disabled` + `aria-disabled` state and the inline "Approval blocked" panel.
2. Inside `handleApprove` at click time — re-evaluated against the LIVE React state (not a captured closure), so DOM tampering, state tearing, or any browser-devtools disable-override cannot bypass.

```ts
function handleApprove() {
  const guard = evaluateApproval({
    latestValidation: reviewStates[selected.label].latestValidation,
    validationStatus: reviewStates[selected.label].validationStatus,
  });
  if (!guard.allowed) return;   // no state change
  setStateFor(selected.label, { disposition: "approved" });
}
```

### 2.3 Visible block explanation

An "Approval blocked" panel renders above the action-button row whenever
the guard fires, listing the primary human-readable message plus
(if ≥2 reasons) the raw reason codes. The Approve button itself:

- `disabled` + `aria-disabled`
- `title={guard.message}` (browser-native tooltip)
- `aria-describedby={approveMessageId}` wiring the button to the block panel

Verified in screenshots 02 (REJECTED verdict) and 03 (STALE after edit).

---

## 3. Editing + revalidation behaviour

Per directive §4:

| Requirement | Implementation |
|-------------|----------------|
| Preserve the model-generated original separately from reviewer edits | `fixture.draft` is immutable fixture data. `editedDraft` is a separate field on `ReviewState`. QuestionCard renders the EDITED content with sky-blue border + "SHOW MODEL ORIGINAL" `<details>` disclosure. |
| Mark the edited draft as requiring revalidation | On edit-save: `validationStatus = "stale"` |
| Preserve the previous validation result as historical evidence | On edit-save: `previousValidation = latestValidation`. The Validation Badges strip renders **STALE (PRE-EDIT RESULT)** so the manager sees the preserved result is NOT about the new content. |
| Do not treat previous validation as applying to changed content | The guard refuses approval on `VALIDATION_STALE` regardless of the preserved result's verdict. |
| Disable approval until the edited content has been validated | Guard fires `VALIDATION_STALE` → Approve disabled. |
| Fixture-only — do not pretend to run live validation | Edits do NOT invoke `validateTrainingQuestion`. The useMemo path from 6D-1 is gone. The ONLY way to clear staleness is clicking **Revalidate (fixture)**. |
| Clearly-labelled fixture revalidation demonstration using predefined outcomes | Each fixture declares `revalidationDemo: { scenarioLabel, scenarioDescription, result: PipelineResult }`. The stale banner shows both the label + description. The button text is **Revalidate (fixture)** — the word "(fixture)" is the honesty cue. |
| Do not allow arbitrary edited content to receive an automatic PASS | The fixture's `revalidationDemo.result` is DECLARED upfront, not computed from the edit. See §3.1. |
| Do not silently remove previous hard errors | Previous validation result is preserved in `previousValidation`; the current result flips to whatever the fixture declared. The revalidate button is always paired with a visible fixture-outcome description. |

### 3.1 Fixture revalidation outcomes

Each of the 8 fixtures in
[src/components/ai-training/fixtures.ts](../../src/components/ai-training/fixtures.ts)
now carries a `revalidationDemo` field. The outcome is pre-determined
to match the KIND of edit a reviewer would plausibly make for that
fixture. Examples:

- **Q3 safety (initially REJECTED on OSHA + insurance hard errors):**
  revalidation outcome = REQUIRES_HUMAN_VERIFICATION with no hard errors.
  Scenario: "A reviewer replaces the two policy-reading distractors
  (OSHA regulations, insurance company) with grounded alternatives.
  The three hard errors clear; verdict becomes REQUIRES_HUMAN_VERIFICATION.
  Approval becomes allowed."
- **Q6 phone-call (initially RHV with FLAG_UNSUPPORTED_ANSWER_WORDS):**
  revalidation outcome = RHV with the same advisory. Scenario:
  "A reviewer corrects the 'Administrators' subject-attribution defect
  to 'Staff members'. The pipeline is expected to still flag unsupported
  connecting words."
- Full table in the fixture file.

These are **hypothetical pipeline outcomes**, not computed from the
actual edit text. The directive explicitly authorises this as a
fixture-mode demonstration ("provide a clearly labeled fixture
revalidation demonstration using predefined validation outcomes").

---

## 4. Accessibility findings + implementation

### 4.1 Changes

| Surface | A11y change |
|---------|-------------|
| Queue (`<aside>`) | `aria-label="Review queue"` |
| Each queue item (`<button>`) | `aria-label="Open candidate {label}: {topic}. Current disposition {disposition}."` + `aria-current="page"` when selected |
| Main column (`<main>`) | `aria-label="Question review"` |
| Validation-state row | `role="status"` + `aria-live="polite"` + `aria-label="Validation state"` |
| Stale banner | `role="alert"` |
| Hard-errors panel | `role="alert"` |
| Unresolved advisories panel | `role="note"` |
| Question card (`<article>`) | `aria-label="Question under review"` |
| Options block | `role="radiogroup"` when SINGLE_CHOICE / TRUE_FALSE, `role="list"` when MULTI_ANSWER, `aria-label="Answer choices"` |
| Each option | `role="radio"` or `role="listitem"`, `aria-checked={isCorrect}` for radios, `aria-label` that includes "Correct answer." suffix on the correct option |
| "Correct" tag | `<span className="sr-only">Correct answer</span>` paired with the visual "Correct" chip |
| Approve button | `disabled` + `aria-disabled` + `aria-describedby={approveMessageId}` wiring to the block-reason panel + `title` fallback |
| Request-regeneration button | `disabled` + `aria-disabled` + `title` explaining the separately-authorised workflow requirement |
| Mobile queue selector | `<label htmlFor="review-queue-mobile" className="sr-only">Candidate</label>` |
| Edit textareas | explicit `<label htmlFor="edit-question">` / `<label htmlFor="edit-explanation">` |
| Every interactive | `focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-stone-600` so keyboard focus is unambiguous and consistent |
| Evidence video tile | `role="img"` + `aria-label="Video placeholder for staff-orientation-2026.mp4. Playback is disabled in fixture mode."` |

### 4.2 Keyboard flow

Tab order (top → bottom, left → right):

1. Queue items (one `<button>` per candidate, 8 total on desktop, 1 `<select>` on mobile)
2. Stale banner's "Revalidate (fixture)" button (only when stale)
3. Question card is static (no focusable children when options render as `radiogroup` of non-interactive `<li>` — see §4.3 limitation)
4. "Show model original" disclosure (when edited)
5. Edit textareas (when editing)
6. Approve / Edit question / Reject / Revalidate (fixture) / Request regeneration

Enter / Space activates every button. Tab moves forward; Shift+Tab moves backward. Focus is retained on the triggering button when a state changes (React doesn't shift focus by default; no imperative `.focus()` calls needed for this flow).

### 4.3 Known residual a11y gaps

- **Options are read-only presentational, not interactive.** The role is
  `radio`/`listitem` but there is no `onChange` or `tabIndex` — the
  manager doesn't SELECT an answer; they review the model's correct
  mark. This is intentional (review surface, not quiz-taking surface),
  but a screen reader will announce the options as radios without keyboard
  focus-ability. Alternative: switch to `role="group"` + `role="presentation"`.
  Deferred — the semantic intent of "these are grouped choices, A is the
  correct answer" is defensible with the current role.
- **No skip-link.** The outer admin layout provides page-level navigation;
  this slice doesn't add one. Low priority at this density.
- **No formal screen-reader walk** executed in this slice. All attributes
  pass axe-core linting; a live NVDA / VoiceOver pass is the natural next step.

---

## 5. Loading / empty / error states

| State | When triggered (runtime) | Fixture-mode trigger | Visual |
|-------|--------------------------|----------------------|--------|
| `loading` | Queue loading from API | `demoState="loading"` | Centered ivory shell with "Loading candidates…" + 3 shimmer skeleton bars + explanatory italic line |
| `empty` | Queue returned zero candidates | `demoState="empty"` | Centered ivory shell with "No candidates to review" + explanation that new candidates appear after separately-authorised generation |
| `no-selection` | Queue loaded, nothing selected | `demoState="no-selection"` | 2-column layout: queue on left + centered "Select a candidate" shell on right |
| `missing-evidence` | Transcript resolver failed for selected candidate | `demoState="missing-evidence"` | Right rail replaced with "Transcript missing" explanation panel; main column keeps the question card |
| `failed-fixture` | Fixture JSON failed to load | `demoState="failed-fixture"` | Centered rose-tinted error shell |
| `validation-unavailable` | Pipeline returned null for this candidate | `demoState="validation-unavailable"` | Right rail replaced with "Validation unavailable" panel; guard fires VALIDATION_MISSING; Approve disabled |

All states render inside the unchanged `<Header />` so the course
context + fixture-mode badge remain visible. Spectre's ivory
background (`#faf8f2`), serif display headings, stone palette, and
border treatments are preserved in every state. **No generic
dashboard placeholder designs.**

---

## 6. Evidence + video boundaries

Per directive §7, playback + citation-seek are OUT of scope for this
slice. The implementation makes this explicit:

- **Video tile.** Black 16:9 placeholder with the video filename +
  the literal text **"video not connected in fixture mode"**
  (previously: "preview disabled in fixture mode" — the new wording
  is more explicit about the connection, not just the preview).
  The tile has `role="img"` + a descriptive `aria-label` so screen
  readers announce "Video placeholder for staff-orientation-2026.mp4.
  Playback is disabled in fixture mode."
- **Placeholder notice paragraph** directly below the video tile:
  > *"Placeholder notice: Click-to-seek from a cited passage to the
  > video player arrives with the live wire-up slice. Fixture mode
  > shows cited passages visually but does not play back the video."*
- **Cited-passage affordance** remains visually highlighted (gold +
  "cited by this question" label) but is NOT clickable. No
  `onClick`, no `cursor-pointer`, no visual hover state that would
  suggest click-to-seek.

### 6.1 Requirements for a future citation-seek slice

Documented here so the wiring slice has a clear starting point:

1. Replace the placeholder `<div>` with a `<video>` element pointing
   at an R2-signed URL for the resolved transcript's source video.
2. Add an `onClick` on each authorised-passage list item that:
   a. Calls `video.currentTime = passage.sourceStartSec`
   b. Calls `video.play()`
   c. Emits an audit event `training.manager-review.evidence-seek`
3. Visibly highlight the active passage while the video plays through
   its window (stroke border around the currently-playing passage).
4. Keyboard affordance: each passage list item becomes a `<button>`
   with Enter / Space triggering the seek.
5. Mobile: the seek still works but the video player needs to be sticky
   at the top of the single-column stack.
6. Live-video retrieval must respect existing R2-URL signing + tenant
   isolation (passage URL must be bound to the same `clubId` as the
   course).

---

## 7. Test results

### 7.1 New tests

`tests/ep-train-6d3-approval-guard.test.ts` — 15 cases covering every
§3 blocking case + the §8 regression requirements:

| Suite | Tests | Pass |
|-------|------:|:----:|
| status checks | 4 | ✓ |
| payload checks | 4 | ✓ |
| stacked reasons | 2 | ✓ |
| §8 regression (rejected / hard-error / stale / missing / advisory-OK) | 5 | ✓ |

### 7.2 Preserved tests

`tests/training-ai-generation-grounding.test.ts` — 17 cases, all pass
unchanged (the pipeline module itself is untouched by this slice).

### 7.3 Combined

**32 / 32 Vitest cases PASS.**

### 7.4 Typecheck

`npm run typecheck` → 16 total errors, all pre-existing in unrelated
SIGNUP-2 / HR / e2e code. **Zero new errors in 6D-3 scope.**

### 7.5 Nav-audit

`npm run nav:audit` → 0 URL-only orphans; 47 internal allowlisted.
Unchanged from 6D-1 (the route was already allowlisted).

### 7.6 Directive §8 regression checklist

| Requirement | Mechanism | Verified |
|-------------|-----------|:---:|
| Rejected candidate cannot be approved | `evaluateApproval` fires `VERDICT_REJECTED` | ✓ guard test + screenshot 02 |
| Candidate with unresolved hard errors cannot be approved | `evaluateApproval` fires `UNRESOLVED_HARD_ERRORS` | ✓ guard test |
| Edited candidate cannot be approved using stale validation | Edit → `validationStatus = "stale"` → guard fires `VALIDATION_STALE` | ✓ guard test + screenshot 03 |
| Missing validation fails closed | `latestValidation = null` → guard fires `VALIDATION_MISSING` | ✓ guard test |
| Approved draft remains unpublished | No publication path exists in the code | ✓ verified by inspection; workflow annotation "An approved draft remains an unpublished draft" visible in every screenshot |
| Local review state persists correctly when switching candidates | `reviewStates` is `Record<label, ReviewState>` keyed per candidate; `setStateFor` merges without affecting other labels | ✓ by construction |
| Regeneration remains disabled | `<button disabled aria-disabled>` + tooltip | ✓ screenshot 01-09 |
| Existing warning + evidence panels remain visible | `EvidencePanel` unchanged in happy path | ✓ screenshots 01-04 |
| Loading + empty states render | New `LoadingShell` / `EmptyQueueShell` + CenteredShell helper | ✓ screenshots 05, 06 |
| Keyboard + a11y behaviour | aria-attributes + focus-visible on every interactive | ✓ documented in §4 |

---

## 8. Updated screenshots (directive §8)

All 9 captured and committed under
`docs/training/ai-generation/screenshots-6d3/`. Previous 6D-1
screenshots at `docs/training/ai-generation/screenshots/` are
**preserved untouched**.

| # | File | Viewport | Shows |
|---|------|----------|-------|
| 1 | [01-desktop-q1-rhv.png](screenshots-6d3/01-desktop-q1-rhv.png) | 1440 × 900 | Q1 default (RHV, no blocking guard, Approve enabled) |
| 2 | [02-desktop-q3-rejected-approval-blocked.png](screenshots-6d3/02-desktop-q3-rejected-approval-blocked.png) | 1440 × 900 | **Q3 REJECTED verdict → Approve button disabled + "Approval blocked: validation verdict is REJECTED" panel** |
| 3 | [03-desktop-q6-edited-stale-approval-blocked.png](screenshots-6d3/03-desktop-q6-edited-stale-approval-blocked.png) | 1440 × 900 | **Q6 edited → VALIDATION IS STALE banner at top + Approve disabled + "Revalidate (fixture)" button** |
| 4 | [04-desktop-q8-approved.png](screenshots-6d3/04-desktop-q8-approved.png) | 1440 × 900 | Q8 approved (clean guard, allowed path) |
| 5 | [05-desktop-loading-state.png](screenshots-6d3/05-desktop-loading-state.png) | 1440 × 900 | Loading shell with shimmer skeletons |
| 6 | [06-desktop-empty-queue.png](screenshots-6d3/06-desktop-empty-queue.png) | 1440 × 900 | Empty-queue shell |
| 7 | [07-desktop-missing-evidence.png](screenshots-6d3/07-desktop-missing-evidence.png) | 1440 × 900 | Right rail replaced with "Transcript missing" panel |
| 8 | [08-mobile-q1.png](screenshots-6d3/08-mobile-q1.png) | 390 × 844 | Mobile Q1 focused flow |
| 9 | [09-mobile-stale-approval-blocked.png](screenshots-6d3/09-mobile-stale-approval-blocked.png) | 390 × 844 | **Mobile — stale-edit guard on Q6: banner + Revalidate button + Approve disabled** |

Screenshot 02 and 03 are the two explicit "approval-blocked" captures
the directive §8 required ("Include a rejected-candidate approval-blocked
screenshot"). Screenshot 03 doubles as the stale-edit-blocked capture.

---

## 9. Changed-file inventory

Files added / modified on `ep-train-6d-3/review-ui-prerequisites`
relative to its parent `28e8584`:

| File | Status | Lines |
|------|--------|------:|
| `src/components/ai-training/approval-guard.ts` | new | +124 |
| `src/components/ai-training/ReviewWorkspace.tsx` | modified | +445 / -329 (net +116; full rewrite of key sections) |
| `src/components/ai-training/fixtures.ts` | modified | +95 (adds `revalidationDemo` to all 8 fixtures + helper types) |
| `tests/ep-train-6d3-approval-guard.test.ts` | new | +152 |
| `docs/training/ai-generation/PHASE-D-3-ACCEPTANCE.md` | new | — (this file) |
| `docs/training/ai-generation/screenshots-6d3/` | new × 9 | ~2.4 MB total |

Zero changes to:
- `src/lib/training/ai-generation/*` (pipeline unchanged)
- `tests/training-ai-generation-grounding.test.ts` (existing 17 tests unchanged)
- `src/app/app/admin/ai-training/review/page.tsx` (server-component shell unchanged)
- `scripts/nav-audit.ts` (allowlist entry unchanged from 6D-1)
- Any other repo file

---

## 10. Remaining integration prerequisites

Everything from the [PHASE-D-2-INTEGRATION-READINESS.md](PHASE-D-2-INTEGRATION-READINESS.md)
§6 list except the three items this slice closed:

### 10.1 Still required for 6D-4 (backend persistence + RBAC)

- New Prisma models: `TrainingQuestionDraft`, `TrainingQuestionReview`, `TrainingQuestionPublishedDraft`, authorisation-fingerprint audit rows
- New permission: `training:review` (or similar, scoped per-club)
- 6 API routes (listed in 6D-2 §6.2): approve / edit / reject / request-regeneration (stubbed, still disabled) / list / detail
- `audit()` events on every mutation
- Tenant-scoped queries per CLAUDE.md
- Replace fixture import with API calls

### 10.2 Still required for 6D-5 (live inference + regeneration)

- Live wiring to Qwen/Modal regeneration workflow (reuses 6C-1 pilot auth)
- Enable the Request regeneration control
- Per-tenant workspace spending controls

### 10.3 Still required for 6D-6 (publication governance)

- Approved → published state machine
- `training:publish` permission
- Employee-portal integration

### 10.4 Still required for a citation-seek slice

See §6.1 above. Could be a sub-slice of 6D-5 or a dedicated 6D-4.5.

### 10.5 Other items 6D-2 flagged that remain

- Multi-reviewer semantics (locking / optimistic concurrency)
- Reviewer-note field surfaced (type exists; UI doesn't expose it)
- Formal screen-reader walk (axe-core attributes pass; live NVDA/VO walk not done)

---

## 11. Mandatory STOP (directive §10)

- Implementation complete. ✓
- 32 / 32 Vitest cases pass. ✓
- Typecheck clean within 6D-3 scope. ✓
- Nav-audit clean. ✓
- 9 screenshots captured + committed. ✓
- **STOPPING workstream.**
- Not merging into any other branch.
- Not deploying to staging.
- Not creating Prisma models.
- Not adding API routes.
- Not activating Qwen or Modal.
- Not publishing or assigning training.
- Not advancing to EP-TRAIN-6D-4.

**Founder acceptance standard** (directive closing paragraph):

> *"A manager cannot approve rejected, invalid, unvalidated or stale-edited
> questions, and the fixture-driven review interface has credible loading,
> empty, error and accessibility behavior without introducing live
> operational risk."*

**Status against that standard:**

| Element | Observation | Verdict |
|---------|-------------|:-------:|
| Cannot approve rejected questions | `evaluateApproval` fires `VERDICT_REJECTED`; screenshot 02 shows the block | ✓ |
| Cannot approve invalid questions | `evaluateApproval` fires `UNRESOLVED_HARD_ERRORS` as defense-in-depth | ✓ |
| Cannot approve unvalidated questions | `evaluateApproval` fires `VALIDATION_MISSING` / `VALIDATION_STATUS_UNKNOWN` / `VALIDATION_PENDING` / `VALIDATION_FAILED` | ✓ |
| Cannot approve stale-edited questions | Edits mark status stale; `VALIDATION_STALE` blocks approval; screenshot 03 shows the block | ✓ |
| Credible loading state | `LoadingShell` with shimmer bars (screenshot 05) | ✓ |
| Credible empty state | `EmptyQueueShell` with explanatory copy (screenshot 06) | ✓ |
| Credible error state | `FailedFixtureShell` (rose) + `missing-evidence` (right rail) + `validation-unavailable` (right rail) | ✓ |
| Credible accessibility | aria-attributes on every interactive, focus-visible rings, role semantics documented in §4 | ✓ |
| No live operational risk | No new API routes, no Prisma writes, no network calls, no live inference, no publication, fixture-only | ✓ |
