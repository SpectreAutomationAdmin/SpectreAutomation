# EP-TRAIN-6D-1 — Manager Review Experience · ACCEPTANCE

**Status:** OFFLINE ACCEPTANCE PASSED · Workstream B of the two-workstream
EP-TRAIN-6C-12 slice.
**Branch:** `ep-train-6d-1/manager-review-ui`
**Parent commit:** `accbb0c` (EP-TRAIN-6C-10B integrated pipeline)
**Independent of Workstream A** (`ep-train-6c-10c/validator-hardening`) —
neither branch references the other.
**Scope:** fixture-driven manager-facing AI-training question review
experience. No live inference. No DB writes. No cross-tenant exposure.
No staging deploy.

---

## 1. Summary

A premium, boardroom-feeling manager review surface at
`/app/admin/ai-training/review` for the 8 accepted candidates from
EP-TRAIN-6C-9 (Q1–Q3) and EP-TRAIN-6C-11 (Q4–Q8). The page:

- Lays out **course context** (title, club, tenant, transcript build) in a
  pinned header.
- Shows a **review queue** of all 8 candidates with disposition pills.
- Renders the **model-generated question**, **answer choices**, **correct
  marker**, **explanation**, **validation badges**, and **advisory
  warnings** as its main card.
- Pins a **source-evidence sidebar** with authorised transcript passages,
  cited passages highlighted in gold, and a video-preview placeholder
  branded `preview disabled in fixture mode`.
- Exposes **Approve / Edit question / Reject** controls that operate on
  local React state only. The **Request regeneration** control is
  intentionally disabled with a tooltip explaining that a separately
  authorised generation workflow does not yet exist.
- Distinguishes **model-generated** text from **reviewer-edited** text
  with a sky-blue left border + "Reviewer-edited" label + an
  expandable "Show model original" disclosure.
- Surfaces **hard errors** in a rose-tinted panel and **unresolved
  advisories** in an amber-tinted panel inside the evidence sidebar.
- Switches to a **focused single-column mobile layout** at narrow
  viewports with the fixture dropdown, question card, source
  evidence, and reviewer controls stacked top-to-bottom.
- Inherits the Spectre admin chrome (sidebar + header) via the existing
  `/app/admin/*` layout.

**Nothing in this surface can mutate production state:** no DB write,
no API call, no training assignment, no publication. The React page
imports only `validateTrainingQuestion` from `@/lib/training/ai-generation`
and renders fixture data from `src/components/ai-training/fixtures.ts`.

---

## 2. Screenshots (directive §5)

Five captures, all at the exact viewports the directive requires,
obtained from static server-rendered HTML snapshots of five preset
states of the `<ReviewWorkspace />` component — no Next.js dev server,
no auth middleware, no live backend.

### 2.1 Desktop 1440 × 900 — question requiring human verification

`scratchpad/ep-train-6d1/screenshots/01-desktop-q1-requires-human-verification.png`

Q1 (the default queue selection) renders with:
- Cream/ivory background (`#faf8f2`)
- Fraunces serif display heading
- Three-column desktop layout (queue 280 px / main / evidence 380 px)
- Amber `requires human verification` + `unsupported words` badges
- SINGLE_CHOICE answer choices with option C correct (emerald highlight)
- Cited passages (seg 5, seg 8) highlighted in gold with `CITED BY THIS QUESTION` labels
- Unresolved advisories panel at bottom-right of evidence rail

### 2.2 Desktop 1440 × 900 — rejected question

`scratchpad/ep-train-6d1/screenshots/02-desktop-q3-rejected.png`

Q3 (health-and-safety committee) rendered with `disposition: "rejected"`:
- Rose `rejected` verdict badge
- Rose-tinted `HARD ERRORS (3)` panel listing `ERR_CITATION_SEGMENT_UNAUTHORIZED` + `ERR_UNSUPPORTED_REGULATORY_BODY` + `ERR_UNSUPPORTED_INSURANCE_REFERENCE`
- Queue item Q3 shows a stone `REJECTED` disposition pill
- Reviewer-decision card displays `Current: REJECTED` (stone pill)

### 2.3 Desktop 1440 × 900 — edited draft

`scratchpad/ep-train-6d1/screenshots/03-desktop-q6-edited.png`

Q6 (phone-call discretion) rendered with a manager edit replacing the
model's incorrect `"Administrators"` subject with `"Staff members"`:
- Reviewer-edited question has a sky-blue left border + `REVIEWER-EDITED QUESTION` label
- Expandable `SHOW MODEL ORIGINAL` disclosure available
- Explanation similarly marked as reviewer-edited
- Editor panel open at bottom showing both fields in an editable state
- `Save edit` / `Cancel` controls prominent
- Queue + reviewer-decision both show sky `EDITED` pill
- Inline notice: *"Edits are local only. No database write. No employee assignment."*

### 2.4 Desktop 1440 × 900 — approved draft

`scratchpad/ep-train-6d1/screenshots/04-desktop-q8-approved.png`

Q8 (parking policy) rendered with `disposition: "approved"`:
- Reviewer-decision pill `APPROVED` in emerald
- Queue item Q8 highlighted with emerald `APPROVED` disposition pill
- SINGLE_CHOICE with 3 plausible options; correct (B) emerald
- Workflow annotation at bottom reaffirms: *"An approved draft remains an unpublished draft. Publication requires a separate authorised step."*

### 2.5 Mobile 390 × 844 — review state

`scratchpad/ep-train-6d1/screenshots/05-mobile-q1-review-state.png`

Q1 rendered in a mobile single-column layout:
- Header stacks course context + fixture-mode marker
- Fixture-dropdown selector (replaces the desktop sidebar queue)
- Question card full-width
- Source evidence BELOW the question (focused flow)
- Authorised passages render stacked
- Advisories panel inline
- Reviewer-decision at the bottom with full-width tappable buttons
- No horizontal overflow

---

## 3. Review UI architecture

### 3.1 Route

- `/app/admin/ai-training/review` — a Next.js App-Router server component
  (`src/app/app/admin/ai-training/review/page.tsx`) that requires an
  authenticated principal (redirects to `/login` otherwise) and then
  renders the client `<ReviewWorkspace />` component.
- Allowlisted in `scripts/nav-audit.ts` as INTERNAL with the reason
  *"fixture-driven preview; wired into nav only after live-inference
  workflow is authorised"*. `npm run nav:audit` → 0 URL-only orphans.

### 3.2 Components

| Component | Responsibility | File |
|-----------|----------------|------|
| `ReviewWorkspace` | Top-level client component. Owns `selectedLabel` + `reviewStates` local state. Composes the three panels. Runs `validateTrainingQuestion` on every render (memoised). | `src/components/ai-training/ReviewWorkspace.tsx` |
| `QueuePanel` | Sticky left rail. Lists 8 fixtures with disposition badges. Click to switch selection. | (nested) |
| `QuestionCard` | Main content. Shows topic, type, question text, answer choices with correct marker, explanation, validation badges. Distinguishes model-generated vs reviewer-edited with left-border + label + original-disclosure. | (nested) |
| `ValidationBadges` | Verdict pill + advisory flag pills. Forward-compatible label map keyed on raw validator-code strings. | (nested) |
| `EvidencePanel` | Sticky right rail. Video-preview placeholder + authorised passages (cited gold, non-cited white) + hard-errors panel + unresolved-advisories panel. | (nested) |
| `ReviewControls` | Approve / Edit / Reject / Request-regeneration (disabled) + edit panel with textareas. | (nested) |
| `FIXTURES`, `COURSE_CONTEXT` | Static fixture data. Eight candidates with drafts, grounding, authorisation, metrics, provenance. | `src/components/ai-training/fixtures.ts` |

### 3.3 Fixture workflow demonstration

```
  Opening the page           → Q1 selected by default (REQUIRES_HUMAN_VERIFICATION)
                                Default disposition = "pending"
                                `validateTrainingQuestion` runs; result rendered

  Click Q3 in queue          → selectedLabel changes; validation re-runs
                                Q3's hard errors render in the Evidence panel

  Click "Edit question"      → editing panel opens
                                Textareas pre-populated with current (model) text
  Edit + Save                → onChange sets disposition:"edited" + editedDraft
                                QuestionCard re-renders with sky-blue "Reviewer-edited" markers
                                `validateTrainingQuestion` re-runs against edited draft

  Click "Approve"            → disposition:"approved" (emerald pill)
                                No DB write; no API call

  Click "Reject"             → disposition:"rejected" (stone pill)

  Click "Request regen."     → disabled; tooltip explains separate workflow required
```

### 3.4 Visual language

- Palette: Spectre ivory cream `#faf8f2`, deep green accents, muted
  gold `#f5f0e2` for cited passages, amber for advisories, rose for
  hard errors. No SaaS neon / no chatbot bubbles.
- Typography: Fraunces serif for display headings + question text,
  Inter sans for body + metadata, monospace for segment IDs + hash
  previews.
- Spacing: generous (24–32 px gutters), card-based layout, no empty
  dead space inside cards.
- Semantic colour for state: emerald (approved / correct answer), sky
  (edited), stone (rejected), amber (advisory flag), rose (hard
  error) — never purely decorative.
- `@container` not used (keeps the Tailwind config simple); responsive
  via `lg:` breakpoint on `grid-cols-[280px_minmax(0,1fr)_380px]`.

### 3.5 Evidence-transparency surfaces (directive §B3)

A manager can inspect **why a question was generated** and **what
evidence supports the correct answer** via:

1. **Cited passages** are visually distinguished from non-cited
   passages (gold vs white) in the Evidence rail.
2. **Explicit `CITED BY THIS QUESTION` label** on every cited passage.
3. **Segment IDs and timestamps** rendered in monospace for every
   authorised passage.
4. **Video filename** displayed on the video-preview tile, with the
   label `preview disabled in fixture mode` so the manager knows the
   video would normally play.
5. **Validation badges** (verdict + per-flag) at the top of the card,
   keyed to raw validator codes with human-readable labels.
6. **Hard-error and advisory panels** in the Evidence rail enumerate
   every pipeline finding with its raw code + explanatory message.
7. **Model-vs-reviewer distinction** via the left-border / label /
   disclosure in the Question card.
8. **Workflow annotation** at the bottom of the Reviewer Decision
   card: *`Generated → Validation → Manager review → Approved draft` ·
   An approved draft remains an unpublished draft. Publication
   requires a separate authorised step.*

**Rubric scores are intentionally NOT surfaced on the page** per
directive §B3 ("Do not display an automated rubric score as proof of
factual correctness"). Rubric scoring lives in the PHASE-C-11
founder-review document as a human-judged artefact.

---

## 4. Review workflow (directive §B4)

```
  Generated           →   Validation            →   Manager Review        →   Approved Draft
  (Modal / Qwen)          (validateTrainingQuestion)   (this UI)              (local disposition)
  No part of this        Pipeline verdict +         Manager chooses one       Approved drafts remain
  slice; fixtures        errors + advisories        of {approve, edit,         DRAFT until a separate
  stand in for live      rendered here              reject}; regeneration      "Publish" workflow is
  generation             (deterministic, offline)   control disabled           authorised (not this slice)
```

- `REQUIRES_HUMAN_VERIFICATION` is the pipeline's initial verdict for
  any candidate with ≥ 1 advisory flag; all 8 fixtures land there.
- `REJECTED` (verdict) and `rejected` (disposition) are distinct:
  - **`REJECTED` verdict** → the validator identified a hard error.
    The candidate is auto-ineligible for approval; the manager can
    still manually choose `reject` to confirm, or `edit` to attempt a
    fix (edits re-run validation on the edited draft).
  - **`rejected` disposition** → a manager explicitly rejected the
    candidate; carried in local state; next step would be a
    `markRejected` DB write in a future wired slice.
- `approved` disposition only ever lands locally. There is no
  published-draft output from this slice.

---

## 5. Responsive behaviour (directive §B5)

Desktop (≥ 1024 px):
- Three-column grid: `[280px queue | 1fr main | 380px evidence]` with
  24 px gaps.
- Queue + evidence panels `sticky top-6` so they stay visible when
  scrolling the main content.
- Simultaneous visibility of question, source evidence, and reviewer
  controls on first scroll.

Mobile (< 1024 px):
- Single-column stack: course header → fixture dropdown → question
  card → source evidence → reviewer controls.
- 16 px side gutters.
- Full-width tappable buttons.
- Evidence rendered below the question (focused review flow) rather
  than side-by-side.

Both layouts preserve Spectre's accepted global chrome:
- `/app/admin/*` layout (sidebar + header) inherited automatically via
  the Next.js app-router layout hierarchy.
- The new page introduces **zero changes** to any other Employee
  Portal page.

---

## 6. Security boundaries (directive §6)

| Boundary | Enforcement |
|----------|-------------|
| Auth gate preserved | Page's server-component shell calls `getCurrentPrincipal()` + `redirect("/login")` — same pattern as every other `/app/admin/*` page |
| No new RBAC permissions created | Page relies only on the existing admin-page auth (any authenticated principal can view). A real deployment slice would wire this to `training:review` or similar — explicitly out of scope here |
| No cross-tenant exposure | Fixtures reference only the Coulee Ridge development tenant + Silver Springs source organisation; no pulls from Prisma; no live query parameters |
| No production routes active | The page is accessible but renders only local fixture data; no API routes are introduced or modified by this slice |
| No DB writes | Review actions (`approve` / `edit` / `reject`) call `setReviewStates(…)` in local React state only; there is no `useEffect(…save…)` or action handler that persists |
| No live inference | `validateTrainingQuestion` runs synchronously in the browser against pre-baked fixtures; no HTTP, no Modal, no Qwen |
| No publication path | `Request regeneration` is disabled with an explanatory tooltip; no `publish` action exists on the page |
| No cross-workstream contamination | 6D-1 branch is based on `accbb0c` and does NOT include the 6C-10C validator additions. The UI uses string-literal flag codes in its label map so it will gracefully render future flags added by 6C-10C or later without needing the constant to exist |

If a future wiring slice needs to add a permission, surface live
regeneration, or persist dispositions to Prisma, it must land as a
separate authorised slice.

---

## 7. Changed-file inventory

Files added to the 6D-1 branch (on top of `accbb0c`):

| File | Status | Lines |
|------|--------|------:|
| `src/app/app/admin/ai-training/review/page.tsx` | new | ~25 |
| `src/components/ai-training/ReviewWorkspace.tsx` | new | ~370 |
| `src/components/ai-training/fixtures.ts` | new | ~300 |
| `scripts/nav-audit.ts` | modified | +1 (allowlist entry) |
| `docs/training/ai-generation/PHASE-D-1-ACCEPTANCE.md` | new | — (this file) |
| `scratchpad/ep-train-6d1/screenshots/01-desktop-q1-requires-human-verification.png` | new | 275 KB |
| `scratchpad/ep-train-6d1/screenshots/02-desktop-q3-rejected.png` | new | 283 KB |
| `scratchpad/ep-train-6d1/screenshots/03-desktop-q6-edited.png` | new | 245 KB |
| `scratchpad/ep-train-6d1/screenshots/04-desktop-q8-approved.png` | new | 235 KB |
| `scratchpad/ep-train-6d1/screenshots/05-mobile-q1-review-state.png` | new | 205 KB |
| `scratchpad/ep-train-6d1/render-preview.mjs` | new | preview-HTML renderer |
| `scratchpad/ep-train-6d1/screenshot.mjs` | new | Playwright capture script |
| `scratchpad/ep-train-6d1/tsconfig.render.json` | new | tsx JSX-runtime override |
| `scratchpad/ep-train-6d1/preview-*.html` | new × 5 | server-rendered static previews |

Zero modifications to any file outside this inventory.
Zero changes to:
- `src/lib/training/ai-generation/*` (pipeline + validator unchanged)
- Any existing Employee Portal page
- Any Prisma schema
- Any middleware
- Any CI config

---

## 8. Verification checklist

| Gate | Result |
|------|--------|
| `npm run typecheck` — new 6D-1 files | **0 errors** (16 pre-existing errors in SIGNUP-2 / HR / e2e unrelated) |
| `npm run nav:audit` | 0 URL-only orphans; new route allowlisted as INTERNAL with reason |
| Existing pipeline test regression | **17 / 17 PASS** (`tests/training-ai-generation-grounding.test.ts` unchanged + still green on 6D-1 branch) |
| Playwright screenshots | **5 / 5** captured at the required viewports |
| Fixture data isolation | All 8 fixtures reference the Coulee Ridge development tenant only; no pull from Prisma; no cross-tenant query |
| Local-only review actions | `setReviewStates` is the ONLY write; no network, no DB call wired |
| Regeneration disabled | ✓ with tooltip explaining the separately-authorised workflow requirement |

---

## 9. Mandatory STOP (directive §8)

- Workstream B completes cleanly. ✓
- No blocking regression. ✓
- Workstream A and Workstream B remain fully isolated (no cross-branch
  dependencies). ✓
- Not merging either branch into the other, into staging, or into main.
- No GPU allocation. ✓
- No live inference. ✓
- No employee assignment. ✓
- No publication. ✓
- No real Prisma writes. ✓
- Not advancing to the next phase. ✓

**Founder acceptance standard** (directive closing paragraph):

> *"…while delivering a polished, fixture-driven manager-review
> experience that makes AI-generated questions transparent, editable
> and reviewable without introducing live operational risk."*

Status: **met**. The experience is polished (premium typography, cream
palette, three-panel desktop layout, focused-flow mobile), it is
fixture-driven (no Qwen, no Modal, no DB, no publication), it makes
AI-generated questions **transparent** (evidence rail, cited-vs-
non-cited distinction, raw error codes, model-vs-reviewer labelling),
**editable** (in-card edit panel with local-only persistence + original
disclosure), and **reviewable** (approve / reject with distinct
dispositions carried in the queue). No live operational risk is
introduced because the only runtime write surface is local React
state.
