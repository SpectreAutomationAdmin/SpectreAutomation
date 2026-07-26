---
name: ui-product-design
description: Make sensible UX decisions on every screen change. Optimise for operational speed, readability, touch usability, and visual balance. Especially for hospitality / POS surfaces.
---

# UI product design

The `ui-quality` skill covers mechanics (empty/error/loading states,
token usage, confirm flows). This skill covers **judgment** — does
the screen actually help a server move faster?

## When to use
Any time you edit a file under `src/app/**/*.tsx` or
`src/components/**/*.tsx`. Mandatory for hospitality / POS surfaces
(`/app/admin/ops/pos/**`, `/app/admin/hospitality/**`).

## Operating principles
1. **Speed first.** A server on a Friday night should reach any
   action in one or two taps. If you can shave a tap, do it.
2. **Empty whitespace is a defect** when meaningful information
   could be shown. Treat dead space like a code smell: ask "what
   should live here?" before shipping.
3. **Touch usability is non-negotiable.** Touch targets ≥ 44 px on
   each side. Tiles act as buttons, not pills.
4. **Information density without noise.** Pack the screen with
   useful info but keep one clear focal point per zone.
5. **Visual balance** means the dominant workspace dominates and
   secondary panels stay secondary. If the screen feels symmetric
   when it shouldn't, fix the proportions.

## POS item tiles
- Tiles are touch buttons. Tile content order, top to bottom:
  **title → description → price**. Title largest, price pinned to
  the bottom-right.
- Description font is strictly smaller than the title (≥ 2 px
  smaller) and shrinks further if the description is long.
- Description should **fit** the tile. Use `line-clamp`, smaller
  font for longer text, `overflow-hidden` on the tile so a runaway
  string clips instead of spills.
- **Sizing rule (decided step 29, FINAL):**
  Every tile in a category renders at one fixed `tileHeight` in px.
  Uniform rows, predictable grid, no aspect-ratio gymnastics. Short
  descriptions leave intentional whitespace inside the tile; long
  descriptions are clamped by `getDescriptionTextClass`.
  - descriptive — 160 px (≤ 14 items, 3–4-line description)
  - standard    — 140 px (15–22 items, 2–3-line description)
  - compact     — 110 px (23–30 items, optional 1-line description)
  - dense       —  90 px (31+ items, name + price only)
- Use `grid-template-columns: repeat(auto-fill, minmax(MIN, 1fr))`
  so tiles share leftover panel width instead of being capped at an
  absolute max. **Do not** use both bounds absolute — it silently
  defeats `1fr`.
- Grid uses `align-items: start` so content-sized tiles sit at
  their own height; whitespace from height variance lives BETWEEN
  rows, never inside a tile.
- Tiles never stretch absurdly when a category has 1–3 items. Use
  `align-content: start` + `grid-auto-rows: min-content`.

**Rejected designs (kept here so future Claude doesn't repeat them):**
- V3 (step 25) used fixed CSS `aspect-ratio` per tier. Short
  descriptions left empty interior; descriptions of different
  lengths created inconsistent visual rhythm.
- V4 (step 28) made descriptive + standard CONTENT-SIZED. Solved
  per-tile empty space but produced uneven row heights — the menu
  looked masonry-messy.
- V5 (step 29, current) — fixed uniform `tileHeight` per tier.
  Clean rows; intentional whitespace inside short tiles is the
  accepted cost of a uniform grid.

## Floor maps
- A SEATED table must always show host, party size, and elapsed
  time, regardless of seating source (reservation vs. POS self-seat).
- One detail card shape for every seated table; the actions
  underneath differ by context.
- "Mark departed" is hidden or disabled while a check is still open.
- The map fits the viewport. No full-page scroll to find a table.

## Server workflows
- Every multi-step flow has a single clear next action. Avoid
  spreading equally-weighted buttons across the screen.
- A workflow's primary action lives in a sticky action bar that is
  outside any scroll container.
- Confirmation modals only for destructive or irreversible actions.
  Don't confirm common operations.
- Errors render inline next to the offending field; banners only for
  page-level failures.

## Sticky action bars
- Always visible. The bar is a sibling of the scrolling workspace,
  never nested inside it.
- Bar gets `flex-shrink-0` (or equivalent) so a long content area
  can't crowd it out.
- Bar contents: primary action, secondary action, then a right-aligned
  status / total summary. No more than 3–4 items.

## Touch targets
- Buttons (`btn-sm`) ≥ 44 px tall.
- Tile minimum height by tier: descriptive 140, standard 110,
  compact 90, dense 70.
- Tap-targets that change state (seat, table, tile) get hover +
  active styles so a server gets visual feedback.

## Use of whitespace
- Whitespace **separates groups**. Whitespace **does not** decorate
  empty panels.
- Card padding `card-body` (≈ 16 px) for grouping.
- Grid gaps: 8–12 px between tiles, 16 px between major zones.
- If a panel is mostly empty, either shrink it or fill it with the
  next most useful content.

## Information density
- Long lists scroll **internally**, never make the whole page scroll.
- A `min-h-0 flex-1 overflow-y-auto` is the standard internal-scroll
  container.
- Totals, status, and meta info live in a compact strip rather than
  scattered cards.

## UI quality checklist
Run BEFORE claiming UI work is done. Every item must be a "yes":

1. [ ] Sticky action bar is visible at every realistic screen size.
2. [ ] No full-page scroll for normal use (only internal scroll where needed).
3. [ ] Tiles / cards are squarish (aspect ≤ 1.6) and use available space.
4. [ ] No card or panel has obvious dead space — expand content first.
5. [ ] Title vs. description vs. price typography is clearly tiered.
6. [ ] All touch targets ≥ 44 px on the dominant axis.
7. [ ] Empty / error / loading states all render meaningfully.
8. [ ] The screen was opened in a browser; the workflow was clicked
       through; the screenshot would be defensible to a designer.
9. [ ] DevTools measurements taken on the affected elements
       (width × height, aspect ratio, font sizes).
10. [ ] The final summary documents what was measured and what was
        visually improved — not just what code changed.

If any item is "no", the work is not done.

## Red flags
- Tiles that look like horizontal strips (aspect > 2).
- A fixed CSS aspect-ratio on a tile that carries variable-length
  content (the trap from steps 25–27 — forces empty interior on
  short-description items).
- Uneven row heights within a single category (the trap from step 28
  — content-sized tiles make the menu look masonry-messy).
- Description font ≤ 2 px smaller than the title.
- Panels with 60%+ empty space.
- Action bar that can be scrolled away.
- Source-contract tests cited as proof the screen looks right.
- Final summary that says "all tests pass" without browser measurements.
