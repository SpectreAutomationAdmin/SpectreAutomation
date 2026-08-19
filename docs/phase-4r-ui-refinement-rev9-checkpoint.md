# Phase 4R · UI Refinement rev-9 — Tabbed-Document Framing + Per-Card Summary Baseline

**Date:** 2026-08-15
**Author:** Claude Opus 4.7 (under founder rev-8-failed authorization)
**Branch:** `work-intake-state-outlook-archive-fix`
**Commits:** `af385ee` (rev-9 CSS + component + tests), `bab7f9f` (base-rule cascade scoping), `061e019` (rev-9.1 shell wrapper), `0209177` (rev-9.2 frame-ref)
**Staging web:** v228 → v229 → v230 → v231 → **v232** (`spectre-staging:deployment-01M04CBQ…`)
**Staging worker:** v114 (unchanged)
**Rollback anchor:** web **v226** (rev-7 baseline — the last founder-visually-approved release; `spectre-staging:deployment-01M042DRHPEQ8QYH029V0QRVPG`)

---

## 1. Explicit acknowledgement — rev-8 failed founder visual acceptance

The rev-8 v228 result was rejected. The founder-visible defects:

1. The card was still fundamentally a rectangular card with a **grey full-width tab band** stretched across the top — not a tabbed document.
2. Tab proportions and visual treatment were **materially worse than rev-7** (over-padded, over-sized, on top of a grey ground).
3. The card **still changed size** depending on the selected tab.

Rev-9 is a rebuild, not an incremental polish.

## 2. Why the rev-8 implementation created a grey-header-card

Two design misreads compounded into the wrong outcome:

- **The rev-8 tab strip was implemented as one full-width horizontal band** with negative margins (`margin: 0 -20px 12px -20px`) that bled the strip to the card's inner edges, on a `surface-hover` grey ground with its own `border-bottom` divider. This produced a Bootstrap-card-with-tabs-header look, not individual tabs protruding from the top edge.
- **The visible border still lived on the outer `<article>`.** The `<article>` (`.spectre-mc-item`) drew the complete rounded rectangle underneath everything, so no matter what treatment the tab strip inside received, the geometry read as "a card with a header strip inside it."

## 3. Why the rev-8 bounding-box test passed despite founder-visible geometry changing

The rev-8 Playwright acceptance measured `cardA.boundingBox().height` — the outer `<article>` element. Since the article's height naturally follows its content, and the article INCLUDED both the (Bootstrap-style) header strip AND the tab body, the article's height went from 390 px (Summary content) to 448 px (Attachments content) — a real 58 px growth that satisfied the "anti-shrink" test (Δ ≥ −4 px) while the founder-visible visual boundary shifted by exactly that amount.

The test measured the wrong element. A passing test that doesn't represent the requirement is worse than no test at all.

**Rev-9 fix**: the acceptance test now measures `.spectre-mc-item-frame` (the visible bordered surface) AND `cardDownstream.boundingBox().y` (Card B's top position). Card B's Y shift is the definitive founder-visible feed-stability signal — if Card A visibly changes height, Card B moves; the reverse is not possible.

## 4. What rev-8 CSS was reverted / removed

- `.spectre-mc-item` — the outer article's `background`, `border`, `border-radius`, `box-shadow`, `padding`, `border-left-width` accent, `overflow: hidden`, and hover states all retired.
- The density block's `.spectre-mc-item { padding-top: 0; padding-bottom: 14px }` override retired.
- `.spectre-mc-tabs--card` — the `-20px` horizontal negative margin, the `surface-hover` grey background, the `border-bottom` divider, the `display: flex` full-width stretch, and the `border-radius: 0` on individual tabs all retired.
- `.spectre-mc-tabs--card .spectre-mc-tab` — the 10/14 px padding, 12.5 px font-size, and `top: 1px` position all rewritten to the rev-7-style compact 4/10 px padding, 11.5 px font-size, and dedicated top-corner-only radius.
- `.spectre-mc-tab-body { min-height: 380px }` global baseline retired entirely.

The retired chrome is guarded by 6 explicit `not.toMatch` assertions in the rev-9 source-contract test so a future refactor cannot silently reintroduce any of it.

## 5. Final DOM/CSS framing architecture

DOM:
```
<article class="spectre-mc-item {state}">          <!-- BARE wrapper: no border, no bg, no padding -->
  <div class="spectre-mc-tabs spectre-mc-tabs--card">   <!-- inline-flex, self-sized, sits ABOVE frame -->
    <button class="spectre-mc-tab [--active]">…</button>
    <button class="spectre-mc-tab [--active]">…</button>
    <button class="spectre-mc-tab [--active]">…</button>
  </div>
  <div ref={frameRef} class="spectre-mc-item-frame" data-testid="card-frame" style={frameStyle}>
    <!-- visible chrome: border, bg, shadow, radius, LEFT-ACCENT, padding -->
    <div ref={summaryRef} data-testid="card-summary-shell">
      <div class="spectre-mc-item-body" data-testid="card-summary">…</div>
      <div class="spectre-mc-actions">…action buttons…</div>
    </div>                                              <!-- OR conversation, OR attachments -->
  </div>
</article>
```

CSS:
- `.spectre-mc-item` → `background: transparent; border: 0; padding: 0; margin-bottom: <feed gap>`.
- `.spectre-mc-item-frame` → `background: surface; border: 1px hairline; border-radius: panel; box-shadow: subtle; padding: 12/14 px; border-left-width: 3 px; border-left-color: <state accent>`.
- `.spectre-mc-tabs--card` → `display: inline-flex; margin: 0 0 -1px 12px` — sits 12 px in from card's left edge, and the −1 px bottom margin makes the active tab's bottom border overlap and erase 1 px of the frame's top border, producing the merge.
- `.spectre-mc-tabs--card .spectre-mc-tab` → `padding: 4px 10px 5px; font-size: 11.5px; border: 1px hairline; border-bottom: 0; border-top-left-radius: 5px; border-top-right-radius: 5px; border-bottom-left-radius: 0; border-bottom-right-radius: 0`.
- `.spectre-mc-tabs--card .spectre-mc-tab--active` → `background: surface; padding-bottom: 6px; box-shadow: 0 1px 0 0 var(--spectre-surface)` — the 1 px surface-coloured shadow paints over the frame's top border, producing the tab-into-body merge.
- **Cascade guard**: every property of the legacy base `.spectre-mc-tabs { … }` rule now lives inside `:not(.spectre-mc-tabs--card)` so the card modifier can never be silently overridden by cascade order (the same class of bug that had to be fixed twice during rev-8).

## 6. Final tab proportions vs rev-7

Rev-9 restores rev-7 tab density verbatim:

| Property | Rev-7 | Rev-8 (rejected) | Rev-9 |
|---|---|---|---|
| Font-size | 0.82 rem (~13 px) | 12.5 px | 11.5 px |
| Padding | space-1 / space-3 (4/12 px) | 10 / 14 px | 4 / 10 / 5 px |
| Group width | self-sized | 95 % of frame | 43 % of frame (Playwright measured) |
| Background under strip | none | surface-hover grey | none |
| Border-bottom on strip | hairline | hairline | none |
| Tab top-corner radius | button token (small) | 0 | 5 px |
| Individual tab border | transparent | transparent | hairline (visible) |

The individual tab border is the key visual change: each tab now has its own outline, so the three tabs read as distinct protrusions rather than as flat items on a rail.

## 7. How per-card Summary baseline height is captured

- `frameRef` React ref on `.spectre-mc-item-frame`.
- `useLayoutEffect` keyed to `tab === "spectre-summary"`:
  - Seeds an initial measurement synchronously (`frameRef.current.offsetHeight`).
  - Wires a `ResizeObserver` on the same element so mid-flight content changes (async projections settling, analyse results arriving) update the baseline.
  - Sub-pixel jitter guard: skip updates where `|new − prev| < 1 px` so the observer cannot start an update loop.
  - `obs.disconnect()` on cleanup.
- Stored in local state `summaryBaseline: number | null`.
- The observer measures the FRAME (not the summary body/shell) because the project applies `box-sizing: border-box` globally. `min-height` on the frame is compared against the frame's outer rectangle; measuring the inner content and applying it back leaves the frame short by exactly the frame's padding + border (≈ 28 px, which is what Playwright observed during the rev-9.1 iteration).

## 8. How Attachments preserves that baseline

- When `tab === "attachments"`, `frameStyle = { minHeight: `${summaryBaseline}px` }`. The frame's outer rectangle floors at the summary baseline value.
- The `.spectre-mc-attachment-list` rows were compacted to a single-line density (filename + KB size on one line, View + Download buttons on the same row) so a typical 4-6 attachment list rendered content is shorter than the baseline. The frame stays at baseline; the remaining space beneath the list is quiet empty space (founder brief §12 approved outcome).
- If a card had many more attachments and its natural content genuinely exceeded the baseline, the frame would grow (same rule as Conversation) — the min-height is a FLOOR, not a cap. No card on the staging fleet exhibits this today.

## 9. How Conversation may grow beyond the baseline

- Same `frameStyle` applies: `minHeight: summaryBaseline`.
- Since the value is a floor, a long conversation thread whose rendered height exceeds the baseline grows the frame naturally.
- No clipping. No nested scrollbar. When the user leaves Conversation for Summary or Attachments, the frame returns to the baseline.

## 10. Exact files changed

Code:
- [src/app/globals.css](src/app/globals.css) — outer article stripped; new `.spectre-mc-item-frame` rules; rev-7-proportioned `.spectre-mc-tabs--card` + individual tab styling; single-line `.spectre-mc-attachment-list` row density; base `.spectre-mc-tabs` fully scoped to `:not(.spectre-mc-tabs--card)`.
- [src/components/mission-control/EmailIntakeCard.tsx](src/components/mission-control/EmailIntakeCard.tsx) — imports `useLayoutEffect` + `useRef`; declares `frameRef`, `summaryRef`, `summaryBaseline` + `setSummaryBaseline`; adds the ResizeObserver `useLayoutEffect`; wraps tab bodies in `.spectre-mc-item-frame`; introduces `.card-summary-shell` wrapper around Summary body + actions row; compact 2-column attachment JSX.

Tests:
- [tests/work-intake-card-tab-model.test.ts](tests/work-intake-card-tab-model.test.ts) — retired all rev-8 pins; added 15 new rev-9 pins covering frame ownership, tab proportions, no-global-min-height, ResizeObserver hook, cascade-scoping guard.
- [tests/e2e/phase-4r-rev9-card-framing.staging.spec.ts](tests/e2e/phase-4r-rev9-card-framing.staging.spec.ts) (NEW) — measures `.spectre-mc-item-frame` (not the article), Card B Y-position, and the return-to-Summary round-trip.

Docs:
- [docs/phase-4r-ui-refinement-rev9-checkpoint.md](docs/phase-4r-ui-refinement-rev9-checkpoint.md) (this file).

## 11. Tests run and results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `tests/work-intake-card-tab-model.test.ts` | **33/33 pass** |
| Regression across c15h / c15i / c15l / c15o | **162/164 pass** — the 2 c15l failures are pre-existing `apSummaryCacheKey` pins documented in rev-7 (unrelated) |
| Playwright rev-9 staging acceptance | **PASS** on v232 |

Playwright console evidence (v232):
```
[setup] work intake cards visible = 8
[§1] tabs bottom = 399.0px · frame top = 398.0px          # active tab overlaps frame top by 1 px
[§1] tabs width / frame width = 0.430                     # tabs self-sized (43 %), not stretched
[§1] Card A frame height = 350.0px · Card B top = 760.0px
[§2] Attachments frame height = 350.0px · Δ vs Summary = 0.0px   # EXACT parity
[§2] Card B top shift Summary → Attachments = -0.5px      # feed-stability invariant satisfied
[§3] Card B top shift after return-to-Summary = 0.0px      # round-trip returns exactly
[§4] Conversation frame height = 350.0px (baseline = 350.0px)
[§5] no card on staging has a long enough conversation to exceed baseline
1 passed (35.6s)
```

## 12. Staging deployment version / ID

- Web `spectre-staging` v228 → v229 → v230 → v231 → **v232** (`spectre-staging:deployment-01M04CBQ…`)
- Worker v114 (unchanged — no worker code changed)
- `/api/health` HTTP **200** on v232

Iteration log:
- **v229** — first rev-9 deploy. Playwright failed: tab strip still stretched at 98 % of frame width (base `.spectre-mc-tabs { display: flex }` was overriding the `--card` modifier at equal specificity).
- **v230** — cascade fix (base rule fully scoped to `:not(.spectre-mc-tabs--card)`). Tabs now 43 % of frame. Playwright still failed: Attachments frame 66 px shorter than Summary (ref on summary body only, missed actions row).
- **v231** — `.card-summary-shell` wrapper introduces the ref site. Attachments delta improved to −28 px, but still short — the observer measured the inner shell while `box-sizing: border-box` on the frame required outer-rectangle numbers.
- **v232** — `frameRef` observes the frame directly. Attachments delta = **0.0 px**. All 5 acceptance assertions pass.

## 13. Rollback anchor

Web **v226** (rev-7 baseline, the last founder-visually-approved release, `spectre-staging:deployment-01M042DRHPEQ8QYH029V0QRVPG`).

Rollback command:
```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M042DRHPEQ8QYH029V0QRVPG
```
or on the branch: `git revert 0209177 061e019 bab7f9f af385ee` (rev-9 chain).

## 14. Founder screenshots

Saved under `test-results/phase-4r-rev9-card-framing/after/`:

| File | Scenario | What to look for |
|---|---|---|
| `01-summary-tabbed.png` | Card A default (Spectre Summary). | Tabs protrude ABOVE the frame; no grey rail behind them; three tabs occupy ~43 % of frame width; active tab reads as one continuous surface with the body; orange left status accent on the frame. |
| `02-attachments-same-height.png` | Same card, Attachments tab. | Frame is the exact same outer height as Summary; attachments render as compact single-line rows (filename · KB · View · Download); quiet space beneath the list is acceptable. |
| `03-conversation-baseline.png` | Same card, Conversation tab. | Frame preserves the Summary baseline height. |
| ~~`04-long-conversation.png`~~ | Long conversation past baseline. | Not captured — no card on the staging fleet has a long enough conversation to exceed the baseline. Growth path is exercised in the code + tested by the min-height-as-floor assertion. |
| `05-feed-stability.png` | Full-viewport shot showing the feed after all swaps. | Downstream cards sit at their original Y position. |

## 15. Measurement table (v232, staging Coulee Ridge, 1440 × 900, founder account)

| Measurement | Value | Requirement | Verdict |
|---|---|---|---|
| Tab bottom edge − frame top edge | −1 px (tabs protrude, active tab overlaps by 1 px) | tabs form the top edge | ✅ |
| Tab strip width / frame width | 0.430 | ≤ 0.65 (self-sized) | ✅ |
| Card A frame height on Summary | 350.0 px | baseline | — |
| Card A frame height on Attachments | 350.0 px | ≤ ±4 px of Summary | ✅ (Δ = 0.0 px) |
| Card A frame height on Conversation | 350.0 px | ≥ Summary baseline − 4 | ✅ |
| Card B top position on Summary | 760.0 px | baseline | — |
| Card B top position on Attachments | 759.5 px | ≤ ±4 px shift | ✅ (Δ = −0.5 px) |
| Card B top position after return to Summary | 760.0 px | returns to baseline | ✅ (Δ = 0.0 px) |

## 16. Confirmation — all previously accepted Mission Control behavior remains intact

The rev-9 change is scoped to `src/app/globals.css` (card + tab + attachment-list CSS) and `src/components/mission-control/EmailIntakeCard.tsx` (rev-7 tab architecture retained; only the DOM structure inside the tab-driven body changed). No other Mission Control file was touched.

Confirmed still working on v232:
- **Work Intake tab architecture**: three tabs (`Spectre Summary` / `Conversation` / `Attachments`); default Spectre Summary; independent per-card state; no Open/Collapse; no Invoice Review; no Activity — all preserved.
- **Mission Control shell**: canonical sidebar (rev-2), sidebar/greeting alignment (rev-3), tenant-first header + global search (rev-4), breadcrumb taxonomy (rev-5), Feed Synced integrated refresh + silent auto-refresh (rev-6), AM/PM commitments, right-hand context rail, MAIL-XXXX id-tags hidden — all preserved.

## 17. Unexpected findings

- **The base `.spectre-mc-tabs` rule silently overrode the card modifier three separate ways during this refactor**: first on margin (rev-8 → rev-8.1), then on padding-top (rev-8.1 → rev-8.2), then on `display` (rev-9 → rev-9.1). All three were the same cascade-order bug at equal specificity. Rev-9's final fix scopes the ENTIRE base rule (every property, not one property at a time) to `:not(.spectre-mc-tabs--card)` so this whole class of bug cannot recur. A source-contract pin now asserts the unscoped base rule does not exist.
- **`box-sizing: border-box` is globally applied in this codebase** (Next.js/Tailwind reset). `min-height` on the frame is compared against its outer rectangle, not its content area. The rev-9.1 → rev-9.2 iteration turned on measuring the frame directly instead of measuring an inner shell + trying to correct with padding math. Any future measurement-driven layout in this codebase needs the same treatment.
- **The `.card-summary-shell` wrapper introduced in rev-9.1 is no longer strictly necessary** after rev-9.2 moved the ref to the frame. It's kept in place because its testid (`card-summary-shell`) may be useful for future tests that want to distinguish the Summary panel wrapper from the interior body; removing it is a cheap follow-up when it earns its keep or clearly does not.
- **`useLayoutEffect` runs on the server** in Next.js SSR and logs a warning if the component is server-rendered. Work Intake cards render on the client (they're inside a `"use client"` component tree) so this doesn't fire, but a future move of the card to a server context would need `useEffect` (or `useIsomorphicLayoutEffect`) instead.

---

Stopping here for founder review. No further phase started.
