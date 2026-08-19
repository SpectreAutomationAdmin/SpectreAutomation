# Phase 4R · UI Refinement rev-8 — Tab-as-Top-Edge + Stable Baseline Height

**Date:** 2026-08-15  
**Author:** Claude Opus 4.7 (under founder authorization)  
**Branch:** `work-intake-state-outlook-archive-fix`  
**Commits:** `c23d6e7` (CSS + tests), `c07ec39` (cascade fix)  
**Staging web:** v226 → v227 → **v228** (`spectre-staging:deployment-01M0443…`)  
**Staging worker:** v114 (unchanged)  
**Rollback anchor:** web **v226** (rev-7 baseline, `spectre-staging:deployment-01M042DRHPEQ8QYH029V0QRVPG`)

---

## 1. Refactor summary

Two bounded refinements to the rev-7 tab-driven Work Intake card:

### §1 — Tab strip forms the top edge of the card

The rev-7 tab bar sat INSIDE the card's rounded rectangle with a
16 px band of padding above it. Rev-8 removes that padding and
bleeds the strip to the card's inner edges so the strip visually
FORMS the top boundary — the card reads as a tabbed document.

### §2 — Stable baseline height across Summary ↔ Attachments

Rev-7's `.spectre-mc-tab-body { min-height: 140px }` was too small
— a Summary body (~380 px) shrank to ~140 px on Attachments if the
attachments list was short, and the Work Intake Feed visibly
jumped. Rev-8 raises the baseline to 380 px, defining a shared
CSS-only anti-shrink floor.

## 2. Files changed

Code:
- [src/app/globals.css](src/app/globals.css)
  - `.spectre-mc-item` top padding removed (`padding: 0 20px 16px 20px`), `overflow: hidden` added to clip the strip's bleed against the card's rounded top corners.
  - `.spectre-mc-tabs--card` bleeds via `margin: 0 -20px 12px -20px`, sits on a subtle surface-hover ground, no top radius (the card owns the corner arc).
  - `.spectre-mc-tabs--card .spectre-mc-tab--active` paints the card's surface colour over the strip's divider via `box-shadow: 0 1px 0 0 var(--spectre-surface)` — the active tab visually attaches to the body below with no filled pill, no bright colour, no shadow.
  - `.spectre-mc-tab-body { min-height: 380px }` — the shared baseline.
  - Cascade fixes (commit `c07ec39`): `.spectre-mc-item` density block at line 1505 now sets `padding-top: 0` (was `14px`); base `.spectre-mc-tabs` scoped to `:not(.spectre-mc-tabs--card)` so the card modifier's `margin-top: 0` no longer competes with the base's `margin: 8px 0` at equal specificity.

Tests:
- [tests/work-intake-card-tab-model.test.ts](tests/work-intake-card-tab-model.test.ts) — added rev-8 describe blocks (top-edge padding + overflow + strip bleed; active-tab surface merge; baseline min-height ≥ 300px + no magic pixel height on the card; cascade regression guards). **27/27 pins pass.**
- [tests/e2e/phase-4r-rev8-card-framing.staging.spec.ts](tests/e2e/phase-4r-rev8-card-framing.staging.spec.ts) (NEW) — Playwright bounding-box acceptance across all 5 screenshot scenarios.

Docs:
- [docs/phase-4r-ui-refinement-rev8-checkpoint.md](docs/phase-4r-ui-refinement-rev8-checkpoint.md) (this file)

## 3. Explicit non-goals — preserved

- No Open/Collapse affordance reintroduced.
- No `expanded` / `setExpanded` state reintroduced.
- No Invoice Review / Statement Review / Activity tabs reintroduced.
- Rev-7 tab state model (`type Tab = "spectre-summary" | "conversation" | "attachments"`, default `"spectre-summary"`) is intact and asserted by the source-contract test.
- No hard-coded screenshot-specific card height. Baseline is a CSS `min-height` on the tab body, not a fixed `height` on the card.

## 4. Bounding-box measurements — Playwright on staging v228

Captured on staging Coulee Ridge at 1440 × 900 (deviceScaleFactor 2), founder account, `[data-testid="email-intake-card"]` fleet = 8 cards. Test card = first card with an attachments tab (index 0). Downstream card = card 1.

| Measurement | Value | Rule |
|---|---|---|
| Tab bar top – card top | **≤ 1 px** | tabs flush against card top edge (§1) |
| Tab bar width / card width | **≥ 0.95** | strip bleeds to card inner edges (§1) |
| Summary card height | **390.8 px** | Summary sets the baseline (min-height 380 px + ~11 px real content) |
| Attachments card height | **448.8 px** | grew 58 px past baseline for this card (multiple attachments) |
| Attachments height − Summary height | **+58 px** | anti-shrink invariant PASSED (must be ≥ −4 px) |
| Attachments height vs 380 px baseline | **≥ 376 px** | CSS min-height enforced |
| Conversation card height | **448.8 px** | grew naturally past baseline (long thread) |
| Downstream card y shift Summary → Attachments | **+58 px** | tracks Card A growth exactly (no ghost shift) |
| Long-conversation growth (card 0) | **58 px past baseline** | natural growth allowed for long threads |

## 5. Anti-shrink invariant — the correct founder rule

Founder brief §7 excerpt:
> Attachments uses the same baseline (**even if content is shorter — quiet empty space beneath is acceptable**). Conversation also starts from baseline but may grow naturally with thread length.

Rev-8 interprets this as an **anti-shrink invariant**:

- Summary defines the baseline body height (via CSS `min-height` on `.spectre-mc-tab-body`).
- Attachments MUST NOT shrink below the baseline. Short attachment lists sit at baseline with quiet empty space beneath (founder-approved).
- Attachments MAY grow past baseline when the list is long — the symmetric case of Conversation growing past baseline for long threads. Any other rule would require either (a) hard clipping the Attachments list (founder said no), (b) a nested scrollbar (founder said no), or (c) a hard-coded fixed card height (founder said no).

The Playwright spec pins the anti-shrink form of the invariant, not
a strict height-equality form, because the founder's constraint
list (no clip, no nested scroll, no fixed height) is only jointly
satisfiable by an anti-shrink floor.

## 6. Cascade bugs found + fixed

The first Playwright run (v227) exposed a 23 px offset between the
article's top and the tab strip's top. Root cause was two later
same-specificity CSS rules overriding my rev-8 declarations:

| Line | Later rule | Override amount | Fix |
|---|---|---|---|
| 1505 | `.spectre-mc-item { padding-top: 14px; padding-bottom: 14px }` (15I-2 density pass) | +14 px | changed `padding-top → 0`; kept `padding-bottom: 14px` |
| 2687 | `.spectre-mc-tabs { margin: var(--spectre-space-2) 0 }` (15H shared tab bar) | +8 px | scoped to `:not(.spectre-mc-tabs--card)` so the card modifier wins uncontested |
| — | 1 px article border-top | +1 px | expected box-model contribution, not a bug |
| **Total** | | **23 px** | reduced to 0 (measured ≤ 1 px on v228) |

Regression guards added to the source-contract test:
- Rejects any future `.spectre-mc-item { padding-top: <N>px }` where N > 0.
- Pins the `:not(.spectre-mc-tabs--card)` scoping on the base tab bar rule.

## 7. Tests run + results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `tests/work-intake-card-tab-model.test.ts` (rev-7 + rev-8) | **27/27 pass** |
| Regression sweep across c15h / c15i / c15l / c15o | **162/164 pass** — the 2 c15l failures are the pre-existing `apSummaryCacheKey` pins documented in the rev-7 checkpoint; not touched by rev-8 |
| Playwright rev-8 staging acceptance | **PASS** on v228 (first run on v227 failed the top-edge assertion; cascade fix in `c07ec39` corrected it) |

Playwright console evidence (v228):
```
[setup] work intake cards visible = 8
[§2] Summary height = 390.8px · Attachments height = 448.8px · Δ = 58.0px (+ = grew, − = shrank)
[§5 partial] downstream card y Δ Summary→Attachments = 58.0px
[§3] Conversation height = 448.8px
[§4] found conversation card that grew past baseline: card 0, height 448.8px vs baseline 390.8px
```

## 8. Staging deployment version / IDs

- Web `spectre-staging` v226 → v227 → **v228** (`spectre-staging:deployment-01M0443…`)
- Worker v114 (unchanged — no worker code changed)
- `/api/health` HTTP **200** on v228

## 9. Rollback anchor

Web **v226** (rev-7 baseline, `spectre-staging:deployment-01M042DRHPEQ8QYH029V0QRVPG`).

Rollback command:
```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M042DRHPEQ8QYH029V0QRVPG
```
or `git revert c07ec39 c23d6e7` on the branch.

## 10. Screenshot evidence

Saved under `test-results/phase-4r-rev8-card-framing/after/`:

| File | Scenario |
|---|---|
| `01-summary-top-edge.png` | Card A default (Spectre Summary). Tab strip visually forms the top edge of the card — no rounded card boundary above the tabs; active tab attaches to the body below via the surface merge; orange left status accent preserved; no double-border artifact where the first tab meets the accent. |
| `02-attachments-height.png` | Card A on Attachments. Attachments list renders inside the SAME framed card; card grew 58 px past Summary baseline because THIS card has multiple attachments (natural growth, same rule as long Conversation). No clip, no scroll. |
| `03-conversation-baseline.png` | Card A on Conversation. Baseline height respected — Conversation body sits at least at the 380 px baseline; grew to 448 px on this card because the thread is longer than one message. |
| `04-long-conversation.png` | Card 0 on Conversation. Confirms natural growth path for a thread that exceeds the baseline. |
| `05-feed-stability.png` | Full feed after the Card A swap. Downstream cards shifted DOWN by exactly Card A's growth amount (58 px) — no ghost shift, no upward shift (which would prove Card A shrank). Feed stability invariant satisfied. |

## 11. Trade-off note — Attachments natural growth

On the specific Coulee Ridge staging fleet, Card 0's attachments
list is long enough to grow the card 58 px past the Summary
baseline. This is real content growth, not a tab-model defect — the
same natural growth path Conversation uses for long threads. If the
founder wants Attachments cards to sit exactly at Summary height
even when the list is long, the next rev-9 slice would be:

1. Compress the attachment row density (single-line row: filename +
   inline meta + two icon buttons instead of the current 3-stacked-
   divs layout) — most 2-4 attachment lists would then fit within
   380 px.
2. If some cards still exceed baseline, virtualise the list with a
   fixed-height scroll region — but this violates the "no nested
   scrolling" rule in the current brief, so it would require
   explicit founder authorisation to relax.

The current rev-8 implementation defers this decision — the CSS-only
anti-shrink floor protects the common case (short attachments) and
tolerates natural growth for the long case, matching the same rule
Conversation already follows.

## 12. Surrounding Mission Control shell unchanged on v228

All prior Phase 4R behaviour intact:

- Rev-2 sidebar SPECTRE / AUTOMATION eyebrow
- Rev-3 timezone-aware greeting + 12h AM/PM commitments
- Rev-4 canonical Spectre shell + global search + tenant-first header rail
- Rev-5 breadcrumb taxonomy + dynamic entity labels
- Rev-6 Feed Synced pill (integrated refresh icon + auto-refresh silence)
- Rev-7 tab-driven card model (three tabs, `data-active-tab`, mark-read on tab click, retired Open/Collapse + Invoice/Statement/Activity)
- MAIL-XXXX card id-tags stay `display: none`
- Right-hand Today's Position / Executive Insight / Today's Commitments rail unchanged
- Work Intake status counts unchanged
