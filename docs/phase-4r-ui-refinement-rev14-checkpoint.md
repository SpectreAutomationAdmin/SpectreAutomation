# Phase 4R rev-14 — Work Intake refinements (LIVE ACCEPTANCE PASSED)

**Date:** 2026-08-16
**Author:** Claude Opus 4.7
**Branch:** `work-intake-state-outlook-archive-fix`
**Commit:** `ebbf735`
**Staging web:** v244 → **v245**
**Staging worker:** **v117 unchanged** (no worker code touched)
**Rollback anchor:** web **v244** (rev-13 accepted)

---

## 1. Exact visible label change

`CARD_TAB_LABEL["spectre-summary"]` value changed from `"Spectre Summary"` to `"AI Summary"`. The internal `Tab` union identifier `"spectre-summary"` is intentionally preserved — founder brief §1 explicitly warns against cascade-renaming intelligence services / component identifiers just because the visible label changed.

Live check on v245: first card's tab reads `"AI Summary"` (Playwright measured), and zero cards render the retired `"Spectre Summary"` string.

## 2. Final active-card / tab state model

Two layers:

- **Feed-level (new)**: `WorkFeedActiveContext` owns `activeWorkItemId: string | null` + `setActiveCard(workItemId)`. One provider mounted around the Work Intake card list in [src/app/app/admin/page.tsx](src/app/app/admin/page.tsx).
- **Card-local (retained)**: each `EmailIntakeCard` still owns `tab: Tab` (the founder's tab preference for THIS card).

The rendered tab is derived, not stored:

```ts
const isThisCardActive =
  workFeedActive != null && workFeedActive.activeWorkItemId === data.workIntakeItemId;
const effectiveTab: Tab = isThisCardActive ? tab : "spectre-summary";
```

Every render site — `data-active-tab`, `<CardTabBar active>`, the three `{effectiveTab === "…" && (…)}` body branches, the frame's `min-height` inline-style gate, and the ResizeObserver useLayoutEffect key — reads `effectiveTab`. The raw `tab` state is retained only so a card can restore its founder-preferred tab if the user returns via a specific tab click.

## 3. How previous-card reset is triggered

Purely by re-render — no explicit "reset" call, no state mutation on the reset card.

1. User clicks a tab on Card B.
2. Card B's `handleTabChange` runs: `setTab(next)` + `workFeedActive.setActiveCard(cardB.workIntakeItemId)`.
3. Context's `activeWorkItemId` flips from `cardA.id` to `cardB.id`.
4. Every card re-renders (context change).
5. Card A's `isThisCardActive` becomes `false` → `effectiveTab` becomes `"spectre-summary"` → JSX renders the AI Summary branch.
6. Card A's own `tab` state is unchanged. If the founder later returns to Card A via a tab click, that tab click sets both `tab` AND `setActiveCard` atomically.

## 4. Confirmation programmatic resets do not count as read interactions

The `effectiveTab` mask happens purely at the render layer. The reset flow:

- Does NOT call `setTab` on Card A — Card A's `tab` state is unchanged.
- Does NOT call `markReadOnce` — no state mutation, no `useEffect` that would fire it.
- Does NOT call `setActiveCard` for Card A — the setter is only called from user interaction handlers (`handleTabChange`, AP primary action).
- Does NOT enqueue any Graph mutation.
- Does NOT write to WorkIntakeItemRead, WorkIntakeAudit, or OutlookMarkReadMutation.

Playwright live evidence (v245): Card A's `OutlookMarkReadMutation` history was **3 rows before and 3 rows after** the reset — no new mutation created by the programmatic reset.

## 5. Behavior across background / manual feed refreshes

Rev-14 adds NO code to the refresh paths. Consequences:

- **Background auto-refresh** (`doBackgroundRefresh`, silent): re-renders the feed with fresh data. Card A's own `tab` state persists across React re-renders because it's `useState`. The context's `activeWorkItemId` also persists. If Card A is still the active work item AND still exists in the fresh snapshot, its `effectiveTab` still resolves to `tab` — Card A remains on its previously-selected tab.
- **Manual Feed Sync** (rev-13 sync barrier): same story. `router.refresh()` triggers server data re-fetch, but React state (both context + card-local `tab`) survives the re-render. Card A stays on its active tab if it's still the active work item.

The reset happens ONLY on user interaction with a different card (founder brief §8 satisfied).

## 6. Final Attachment row layout

CSS delta in `src/app/globals.css`:

```
.spectre-mc-attachment-list li > div:first-child {
   flex: 0 1 auto;   /* was 1 1 auto — no longer pushes actions right */
   min-width: 0;
   overflow: hidden;
   text-overflow: ellipsis;
   white-space: nowrap;
   margin-right: 8px;
}
.spectre-mc-attachment-list li > div:last-child {
   margin-top: 0;
   display: flex;
   gap: 4px;
   flex-shrink: 0;
   /* No margin-left: auto — the row's gap handles spacing */
}
```

The `<li>` row keeps `display: flex; gap: var(--spectre-space-2)`. The filename cluster shrinks to its content; the row's inherited `gap` + the added `margin-right: 8px` on the filename cluster produce a compact ~12 px visual separation between metadata and action buttons.

**Live measurement on v245** (`test-results/phase-4r-rev14-active-card/evidence.json`):
- Card width: 728 px
- Filename cluster ends at x = 460 px
- Action cluster starts at x = 476 px
- **Gap = 16 px** (down from ~500 px pre-rev-14)
- Actions sit ~252 px from the card's right edge (no more far-right push).

## 7. Exact files changed

Code:
- **NEW** `src/components/mission-control/WorkFeedActiveContext.tsx` — feed-level `activeWorkItemId` + `setActiveCard`.
- `src/app/app/admin/page.tsx` — wraps the Work Intake card list in `<WorkFeedActiveProvider>`.
- `src/components/mission-control/EmailIntakeCard.tsx`:
  - `CARD_TAB_LABEL["spectre-summary"] = "AI Summary"`.
  - Imports `useWorkFeedActive`.
  - Derives `effectiveTab` from context.
  - `handleTabChange` also calls `setActiveCard`.
  - AP primary-action click also calls `setActiveCard`.
  - `data-active-tab`, `CardTabBar active`, tab-body branches, `frameStyle` min-height, ResizeObserver useLayoutEffect all use `effectiveTab`.
- `src/app/globals.css` — attachment row `.spectre-mc-attachment-list li > div:first-child` flex change.

Tests:
- `tests/work-intake-card-tab-model.test.ts` — 8 new rev-14 pins; 5 pre-existing pins updated where the shape validly moved from `tab` → `effectiveTab`.
- **NEW** `tests/e2e/phase-4r-rev14-active-card.staging.spec.ts` — live acceptance for label, defaults, reset A↔B, attachment layout measurement, rev-13 mutation non-regression.

Docs:
- **NEW** `docs/phase-4r-ui-refinement-rev14-checkpoint.md` (this file).

## 8. Tests run and results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `tests/work-intake-card-tab-model.test.ts` (rev-7 through rev-14) | **71/71 pass** |
| Playwright `phase-4r-rev14-active-card` on v245 | **PASS** — see §12/§13/§14 |

## 9. Staging web deployment version / ID

**v245** (`spectre-staging:deployment-01M04…`) — `/api/health` HTTP 200.

## 10. Worker version / ID (unchanged)

**v117** — no worker code touched in rev-14. Rev-13 mark-read handler + tri-state normalize/sync retained verbatim. No worker deploy required.

## 11. Rollback anchor

Web **v244** (rev-13 accepted state — pre-rev-14 label/interaction/layout).
Or `git revert ebbf735` on the branch.

## 12. Screenshot of AI Summary default

`test-results/phase-4r-rev14-active-card/A-ai-summary-default.png` — first card on the founder fleet with tab strip reading `AI Summary | Conversation | Attachments`, `AI Summary` active. All 10 cards default to AI Summary on load.

## 13. Screenshot of revised #221007 Attachments row

`test-results/phase-4r-rev14-active-card/B-attachments-row-layout.png` — Card A on Attachments with the compact `filename · KB · View · Download` layout. Filename metadata + action buttons are one visual cluster with a 16 px gap between them; not pushed to opposite ends of the card.

## 14. Screenshot proving previous card resets to AI Summary after another card is selected

`test-results/phase-4r-rev14-active-card/C-card-switching-A-reset.png` — captured immediately after Step 2 (Card A was on Attachments → user clicked Card B's Conversation tab). Card A now reads AI Summary in its tab strip; Card B is on Conversation.

Playwright measured attribute sequence:
```
Step 1 — click A.Attachments:      A=attachments,      B=spectre-summary
Step 2 — click B.Conversation:     A=spectre-summary,  B=conversation    ← A reset
Step 3 — click A.Attachments:      A=attachments,      B=spectre-summary ← B reset
```

## 15. Confirmation rev-13 Outlook synchronization remains intact

Rev-14 changed zero rev-13 files. Worker deploy skipped (v117 unchanged).

Live evidence: Card A's `OutlookMarkReadMutation` history remained at 3 rows before AND after the programmatic reset — the reset itself does not create a new mutation. Rev-13's active-intent dedupe + generation model + tri-state sync are all preserved verbatim.

Playwright non-regression pin:
```
[rev-13 non-regression] Card A mutation history before/after reset = 3/3
```

## 16. Unexpected findings

- **The pre-rev-14 `tab` variable declaration site was too far down the function body for the ResizeObserver useLayoutEffect to reference `effectiveTab`.** I originally put the context + effectiveTab derivation near the other event handlers (~line 320), but the useLayoutEffect on line ~200 depended on `effectiveTab`. TypeScript's TDZ check caught it cleanly. Moved the derivation to immediately after the `tab` useState declaration so the entire lifecycle downstream can consume it.
- **The retired `margin-left: auto` mention in a CSS comment briefly false-positived the source-contract pin.** Fixed by stripping CSS block + line comments in the pin before regex-scanning. Documented so future CSS-focused pins take the same precaution.
- **The rev-9 `flex: 1 1 auto` on the attachment filename cluster was the entire mechanism producing the "actions pushed to the right edge" behaviour** — I initially expected to find an explicit `justify-content: space-between` or `margin-left: auto`. Neither existed. `flex: 1 1 auto` alone was enough to expand the filename cluster and shove the actions to the flex-remainder space. The one-word change to `flex: 0 1 auto` fixed it entirely.

---

Stopping here for founder review. No further phase started.
