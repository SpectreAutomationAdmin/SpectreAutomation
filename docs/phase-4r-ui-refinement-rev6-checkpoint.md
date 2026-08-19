# Phase 4R · UI Refinement rev-6 — Quiet Refresh + Integrated Icon + Sidebar Alignment

**Date:** 2026-08-15  
**Author:** Claude Opus 4.7 (under founder authorization)  
**Branch:** `work-intake-state-outlook-archive-fix`  
**Commit:** `49bcb17`  
**Staging web:** v223 → **v224** (`spectre-staging:deployment-01M03JNPXJYM3VE17JVPD276HP`)  
**Staging worker:** v114 (unchanged)  
**Rollback anchor:** web v223 / `spectre-staging:deployment-01M03G9SZ5KYW5RVE3H600YWPR`

---

## 1. Root cause of the duplicate/distracting refresh UI

[src/components/mission-control/MissionControlLiveRefresh.tsx](src/components/mission-control/MissionControlLiveRefresh.tsx)
owned three visible artefacts side-by-side inside `.spectre-mc-header-meta`:

- a `Refreshing…` `<span>` that showed **for every refresh** (auto + manual)
- a `Refresh now` `<button>` label
- an occasional inline error span

The refresh state model was a single `refreshing: boolean` flag with
no notion of who initiated the refresh, so the same visible chip
fired for the routine 60-second background poll and for a user
click. That produced the "flashing extra pill next to the Feed
Synced pill" the founder wanted removed.

## 2. Automatic vs manual refresh presentation now

Rev-6 splits refresh source-of-truth into two flags via a shared
context and only the manual one is visualised:

| Refresh source | Provider flag | Pill label | Extra chip |
|---|---|---|---|
| Background 60 s poll | `backgroundRefreshing: true` | `Feed synced` (unchanged) | none |
| Tab-focus resume | `backgroundRefreshing: true` | `Feed synced` (unchanged) | none |
| User click on the pill's refresh icon | `manualRefreshing: true` | `Refreshing…` (temporary) | none |
| Manual failure | `error !== null` | `Refresh failed` (persistent until next attempt) | none |
| Background failure while there's already a manual error | `error !== null` | `Refresh failed` (preserved — not silently reset) | none |

The pill's label logic reads **only** `manualRefreshing`. It never
consults `backgroundRefreshing`, so the background poll cannot
visually flash the pill. Verified by the unit test `pill's visible
label ONLY responds to the manual flag (never the background
flag)`.

## 3. Final Feed Synced control behaviour

The pill is now the single Mission Control refresh control:

- Dot + status label (`Feed synced` / `Feed delayed` / `Reconnect required` / `Not connected`), whose click still opens the connected-accounts settings.
- A hairline divider inside the pill.
- An `<IconRefresh>` button (accessible label `Refresh feed`, spin animation while pending, disabled + `aria-busy` while pending, keyboard-actionable).

The retired affordances are gone:
- No standalone `Refreshing…` chip next to the pill.
- No separate `Refresh now` text button.
- No auto-refresh state flash.

The "N new work items — click to load" banner (which appears when a
reviewer had a pane expanded while a background poll picked up new
items) is preserved — it responds to user-relevant new content, not
to refresh state.

## 4. Root cause of the sidebar/greeting vertical misalignment

The sidebar identity block (`px-4 py-4` inside `<aside className="spectre-sidebar">`) rendered ~64 px tall, but the nav container immediately below used `mt-3` (12 px). So the first nav item's baseline sat at ~94 px from the page top while the greeting baseline sat at ~116 px — a ~22 px offset the founder noticed on Mission Control.

## 5. Exact layout change

Two shell tokens, no route-specific nudges:

```css
/* src/app/globals.css */
.spectre-sidebar-identity {
  min-height: var(--spectre-topbar-h);        /* matches topbar */
}
.spectre-sidebar-nav-scroll {
  padding-top: calc(var(--spectre-workspace-pad-y) - 8px);
  /* workspace-pad-y minus the nav-item's own 8 px top padding, so
     the item's TEXT ROW lines up with the greeting's TEXT ROW. */
}
```

The two class names replace `py-4` on the identity block and
`mt-3` on the `<nav>` inside [SpectreSidebar.tsx](src/components/spectre/SpectreSidebar.tsx). Because the tokens
reference the same variables used by the topbar height and workspace
padding, the alignment holds automatically at any viewport that uses
the same tokens (the founder-approved 1440 × 900 target and the
responsive fall-throughs at 1023 / 767 px).

Measured on staging v224 at 1440 × 900:
```
Mission Control nav center y = 107.0
Greeting center y            = 110.0
Delta                        = -3.0 px    (was ~22 px pre-rev-6)
```

## 6. Files changed

Code:
- **NEW** [src/components/mission-control/LiveRefreshContext.tsx](src/components/mission-control/LiveRefreshContext.tsx) — provider + hook, owns split `manualRefreshing` / `backgroundRefreshing` / `error` / `newItemsAvailable`, plus `refreshManually()` + `acceptNewItems()`. `inFlightRef` protects against double-click; background poll skips when a manual is pending.
- [src/components/mission-control/FeedSyncedStatusPill.tsx](src/components/mission-control/FeedSyncedStatusPill.tsx) — converted to `"use client"`, consumes the context, renders the integrated refresh icon + label swap + failure state.
- [src/components/mission-control/MissionControlLiveRefresh.tsx](src/components/mission-control/MissionControlLiveRefresh.tsx) — gutted; now a headless consumer that renders only the "N new work items" banner. Retired `mc-live-refresh-status` + `mc-refresh-now` testids.
- [src/components/spectre/icons/index.tsx](src/components/spectre/icons/index.tsx) — added canonical `IconRefresh` (circular arrow, Feather-style stroke).
- [src/components/spectre/SpectreSidebar.tsx](src/components/spectre/SpectreSidebar.tsx) — identity block gets `.spectre-sidebar-identity`; nav container gets `.spectre-sidebar-nav-scroll`.
- [src/app/app/admin/page.tsx](src/app/app/admin/page.tsx) — wraps the header meta row in `<LiveRefreshProvider>` and drops the refresh-state props from `<MissionControlLiveRefresh/>`.
- [src/app/globals.css](src/app/globals.css) — adds `.spectre-feed-pill__label-link`, `.spectre-feed-pill__refresh`, `.is-spinning` + `@keyframes spectre-refresh-spin`, `.spectre-sidebar-identity` (min-height), `.spectre-sidebar-nav-scroll` (padding-top).

Tests:
- **NEW** [tests/mission-control-live-refresh.test.ts](tests/mission-control-live-refresh.test.ts) — 18 tests, source-contract level. Retired affordances gone; icon integrated in the pill; manual-vs-background source distinction; honest failure state; page wiring; CSS alignment token contract.
- **NEW** [tests/e2e/phase-4r-rev6-refresh-alignment-acceptance.staging.spec.ts](tests/e2e/phase-4r-rev6-refresh-alignment-acceptance.staging.spec.ts) — behaviour verification on staging.

Docs:
- [docs/phase-4r-ui-refinement-rev6-checkpoint.md](docs/phase-4r-ui-refinement-rev6-checkpoint.md) (this file)

## 7. Tests and results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `tests/mission-control-live-refresh.test.ts` (NEW) | **18/18** pass |
| `tests/chrome-breadcrumb.test.ts` (rev-5) | 27/27 |
| `tests/global-search.test.ts` (rev-4) | 12/12 |
| `tests/mission-control-local-time.test.ts` (rev-3) | 24/24 |
| `tests/c16g-commitments.test.ts` (rev-3) | 24/24 |
| `tests/c15o-two-step-vendor-and-ap-workflow-source-contract.test.ts` (rev-2) | 58/58 |
| `tests/c15i-variant-d-card-source-contract.test.ts` | 48/48 |
| `tests/design-system-member-brand-shielding.test.ts` | pass |
| **Full regression** | **233/233** |
| `npm run scan:placeholders` | Clean in touched files |
| Playwright rev-6 staging acceptance | **PASS** |

Playwright console evidence:
```
[§1] idle pill label = "Feed synced"
[§2] pill during manual refresh = "Refreshing…"
[§3] pill after refresh = "Feed synced"
[§5] Mission Control nav center y = 107.0, greeting center y = 110.0, delta = -3.0
```

## 8. Staging deployment version / ID

- Web `spectre-staging` **v223 → v224** (`spectre-staging:deployment-01M03JNPXJYM3VE17JVPD276HP`)
- Worker v114 (unchanged)

## 9. Rollback anchor

Web **v223** (`spectre-staging:deployment-01M03G9SZ5KYW5RVE3H600YWPR`)

Rollback:
```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M03G9SZ5KYW5RVE3H600YWPR
```
or `git revert 49bcb17` on the branch.

## 10. Screenshots

Saved under `test-results/phase-4r-rev6-refresh-align/after/`:

| File | State |
|---|---|
| `01-idle.png` | Idle Mission Control — `FEED SYNCED` pill + integrated refresh icon; no `Refresh now` text; `Mission Control` sidebar row aligned with the greeting; tenant identity prominent above breadcrumb |
| `02-manual-refreshing.png` | Manual refresh in flight — the SAME pill reads `REFRESHING…`; no second pill; the icon spins |
| `03-post-refresh.png` | Post-refresh — pill returned to `Feed synced` |
| `04-alignment.png` | Sidebar/greeting alignment reference — nav center to greeting center delta 3 px |

Automatic/background refresh silence is proven by:
- The pill's `data-manual-refreshing` attribute remaining `"false"` outside of user click (asserted on idle + post states).
- The unit test that the pill's label logic reads **only** `manualRefreshing` — the string `backgroundRefreshing` doesn't appear anywhere in `FeedSyncedStatusPill.tsx`.

## 11. Rev-3 through rev-5 behaviour intact

- **rev-3 timezone**: greeting still reads the founder's Alberta local time (`Good afternoon, Chris.` in the screenshots) via `snapshot.clubTimezone.ianaZone`; commitments still render via `formatLocalTimeAmPm` (see `TODAY'S COMMITMENTS · 3:00 PM Call Patricia and Jeff` visible on the manual-refreshing screenshot).
- **rev-4 shell + search**: canonical Spectre sidebar renders on every admin route; global search remains in the top-right; no sidebar search field.
- **rev-5 breadcrumbs**: Mission Control still reads `App > Mission Control`; vendor timelines still resolve `{cuid}` → vendor display name via `<RegisterBreadcrumbLabel/>`.
- **rev-2 identity**: sidebar `SPECTRE / AUTOMATION` eyebrow intact; header rail tenant-first prominent.
- **rev-1 cards**: MAIL-XXXX id-tag stays `display: none`; AP field values + CTAs unchanged.

## 12. Unexpected findings

None. The refresh state was structurally shared with the visible chip
(same boolean), which is what let the founder-cited flash happen; the
fix cleanly separated the state and moved the visible chrome into one
control. The alignment fix landed within the founder-approved tolerance
(3 px vs the ~22 px pre-rev-6 offset) via shell tokens with no
route-specific override. Coulee Ridge staging still has only Microsoft
as a real Vendor row, so the rev-5 second-vendor breadcrumb Playwright
walk remains proof-by-unit-test — unchanged from rev-5.
