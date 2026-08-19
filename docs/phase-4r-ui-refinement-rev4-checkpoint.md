# Phase 4R · UI Refinement rev-4 — Canonical Spectre Shell + Global Search + Tenant Prominence

**Date:** 2026-08-15  
**Author:** Claude Opus 4.7 (under founder authorization)  
**Branch:** `work-intake-state-outlook-archive-fix`  
**Commit:** `ac13709`  
**Staging web:** v221 → **v222** (`spectre-staging:deployment-01M03EFEDBQGHRB2NWTFJQ3JKN`)  
**Staging worker:** v114 (unchanged)  
**Rollback anchor:** web v221 / `spectre-staging:deployment-01M03CG36KEC5VZMZV7Z2S4BEV`

---

## 1. Root cause of the inconsistent sidebar

`src/components/admin/AdminShell.tsx` shipped as an **opt-in** shell
chooser: routes had to be explicitly listed in
`SPECTRE_MODE_EXACT_URLS` / `SPECTRE_MODE_PREFIXES` to receive the
Spectre chrome (Mission Control, Chart of Accounts, Settings,
Design System). Every other admin route fell through to the legacy
`Sidebar` + `TopBar`. The vendor timeline screenshot the founder
attached was showing the legacy shell for exactly this reason.

## 2. Components/layouts that previously rendered each shell

| Route class | Shell path | Component |
|---|---|---|
| `/app/admin` (Mission Control) exact | Spectre | `SpectreShell` + `SpectreSidebar` + `SpectreTopBar` |
| `/app/admin/coa` exact | Spectre | same |
| `/app/admin/settings` exact | Spectre | same |
| `/app/admin/design-system/**` prefix | Spectre | same |
| `/app/admin/reporting/**` | Reporting mode | Custom reporting layout (no admin chrome) |
| `/app/admin/ops/pos/lounge/**` | POS mode | Stripped chrome inside `AdminShell` |
| **Every other admin route** (Vendors, Vendor Timeline, Members, AP Invoices, Capture Inbox, Approvals, Governance, …) | **Legacy shell** | `src/components/Sidebar.tsx` + `src/components/TopBar.tsx` |

## 3. Final canonical shell architecture

Rev-4: the Spectre chrome is the **DEFAULT** for every admin route.
Only surfaces with a genuine product reason for a different chrome
opt out.

`isSpectreModePath` was deleted from `AdminShell` entirely. The
router now falls through to the Spectre branch whenever the caller
supplies `spectreSidebar` + `spectreTopbar` and the route is not
POS or Reporting:

```ts
const spectre =
  !pos && !reporting && !!spectreSidebar && !!spectreTopbar;
```

The legacy `Sidebar` + `TopBar` remain in the tree for the
member-portal layout + the reporting/pos fallback branches; they
no longer render for authenticated admin routes.

## 4. Files changed

Code:
- **NEW** [src/lib/search/global-search.ts](src/lib/search/global-search.ts) — extensible search domain module
- **NEW** [src/app/api/search/global/route.ts](src/app/api/search/global/route.ts) — auth + tenant-scoped GET endpoint
- **NEW** [src/components/spectre/GlobalSearch.tsx](src/components/spectre/GlobalSearch.tsx) — collapsed icon → expanded input + grouped predictive dropdown
- [src/components/spectre/SpectreTopBar.tsx](src/components/spectre/SpectreTopBar.tsx) — swapped dummy `IconSearch` button for `<GlobalSearch/>`
- [src/components/spectre/SpectreSidebar.tsx](src/components/spectre/SpectreSidebar.tsx) — removed sidebar-scoped search field; dropped unused `IconSearch` + `IconChevronLeft` imports
- [src/components/admin/AdminShell.tsx](src/components/admin/AdminShell.tsx) — flipped semantics: Spectre chrome by default, only POS/Reporting opt out; removed `SPECTRE_MODE_*` opt-in lists
- [src/app/globals.css](src/app/globals.css) — bumped `.spectre-header-rail-tenant` to 14 px / 600 weight / primary ink so tenant clearly leads breadcrumb; added complete `.spectre-global-search*` block

Tests:
- **NEW** [tests/global-search.test.ts](tests/global-search.test.ts) — 12 tests (tenant scoping, min-query-length, exact/prefix/substring ranking, recency boost, canonical URLs, per-group cap)
- **NEW** [tests/e2e/phase-4r-rev4-shell-search-acceptance.staging.spec.ts](tests/e2e/phase-4r-rev4-shell-search-acceptance.staging.spec.ts) — canonical-shell verification across MC / AP Vendors / Members / Vendor Timeline; live Microsoft search assertion; tenant vs breadcrumb typography contract; rev-3 timezone regression guard

Docs:
- [docs/phase-4r-ui-refinement-rev4-checkpoint.md](docs/phase-4r-ui-refinement-rev4-checkpoint.md) (this file)

## 5. Global-search architecture and data sources

Layers (each responsible for exactly one concern):

| Layer | Path | Concern |
|---|---|---|
| Data | `src/lib/search/global-search.ts` | ONE search-domain module — Prisma queries + JS scoring + result-model factory. No HTTP concerns. |
| HTTP | `src/app/api/search/global/route.ts` | Auth + tenant scoping only. Wraps the data layer. |
| UI trigger + panel | `src/components/spectre/GlobalSearch.tsx` | Collapsed icon button, expanded input, dropdown, debounce, keyboard nav, outside-click close. |
| Chrome host | `src/components/spectre/SpectreTopBar.tsx` | Mounts `<GlobalSearch>` in the top-right controls row. |

The result model is extensible:

```ts
export interface GlobalSearchResult {
  entityType: "VENDOR" | "AP_INVOICE";  // extend the union to add entity types
  id: string;
  primaryLabel: string;                  // dropdown line 1
  secondaryLabel: string;                // dropdown line 2
  href: string;                          // canonical destination
  score: number;                         // ranking key
}
```

Data sources for this slice:

- Prisma `Vendor` (`legalName`, `operatingName`, `vendorNumber`, `taxRegistrationNumber`) scoped to `clubId`
- Prisma `APInvoice` (`invoiceNumber`, `vendorReference`, `total`, `currency`, `status`, `invoiceDate`) joined to `vendor.legalName` / `vendor.operatingName`, scoped to `clubId`

Both are queried with bounded candidate caps (500 vendors, 1000 invoices) so the endpoint stays fast even on tenants with sizeable datasets; scoring + ranking happen in JS to keep the query portable across Postgres (production) and SQLite (dev + staging — Prisma's `mode: "insensitive"` is Postgres-only).

## 6. Search matching + ranking

Per-field scoring ladder (identical for every string field):

| Match | Score |
|---|---|
| Exact | 100 |
| Starts-with | 70 |
| Word-boundary hit (space + query) | 50 |
| Contains | 30 |
| No hit | 0 |

Best per-field score becomes the base score. Invoices additionally receive a **linear recency boost** peaking at +12 today and decaying to 0 at 365+ days, so ties break in favour of newer invoices — the two most recent Microsoft invoices naturally rise to the top of the invoice group.

Query hygiene:

- normalised (`toLowerCase().trim()`)
- min length 2 (short-circuits to empty results otherwise)
- 200 ms debounce on the client
- stale-response protection via query-id + AbortController
- per-group cap 8 (client dropdown height stays bounded)

## 7. Tests run + results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `tests/global-search.test.ts` (NEW) | **12/12** pass |
| `tests/mission-control-local-time.test.ts` (rev-3 regression) | 24/24 |
| `tests/c16g-commitments.test.ts` (rev-3 regression) | 24/24 |
| `tests/c15o-two-step-vendor-and-ap-workflow-source-contract.test.ts` (rev-2 regression) | 58/58 |
| `tests/c15i-variant-d-card-source-contract.test.ts` | 48/48 |
| `tests/design-system-member-brand-shielding.test.ts` | pass |
| **Total regression suites** | **176/176** |
| `npm run scan:placeholders` | Clean in touched files |
| Playwright rev-4 staging acceptance | **PASS** |

Playwright console evidence:
```
[§5] tenant style = {"fontSize":14,"fontWeight":600,"color":"rgb(23, 24, 27)"}
[§5] breadcrumb style = {"fontSize":13,"fontWeight":400}
[§6] greeting = "Good afternoon, Chris."
[§4] dropdown state = results
[§4] top vendor row = "Microsoft Corporation"
```

The tenant weight assertion (`≥ breadcrumb size` AND `> breadcrumb weight`) succeeded — tenant is 14 px / 600, breadcrumb is 13 px / 400.

## 8. Staging deployment version / rollback anchor

- Web `spectre-staging` **v221 → v222**
  (`spectre-staging:deployment-01M03EFEDBQGHRB2NWTFJQ3JKN`)
- Worker v114 (unchanged)
- **Rollback anchor**: web v221 (`spectre-staging:deployment-01M03CG36KEC5VZMZV7Z2S4BEV`)

Rollback:
```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M03CG36KEC5VZMZV7Z2S4BEV
```

## 9. Screenshot evidence

Under `test-results/phase-4r-rev4-shell-search/after/`:

1. `01-mission-control-default.png` — Mission Control, canonical shell, tenant-prominent header
2. `02-mission-control-search-open.png` — global search expanded in the top-right rail
3. `03-mission-control-search-microsoft.png` — Microsoft query → grouped VENDORS + AP INVOICES results (staging live data)
4. `04-ap-vendors.png` — AP Vendors on the canonical Spectre shell
5. `05-members.png` — Members on the canonical Spectre shell
6. `06-vendor-timeline-microsoft.png` — Microsoft Vendor Timeline on the canonical Spectre shell (previously legacy chrome). Sidebar renders `SPECTRE / AUTOMATION`, `ACCOUNTS PAYABLE` expanded with `Vendors` selected, `Coulee Ridge Golf & Country Club` prominent in the topbar before the breadcrumb.
7. `07-monthly-reporting.png` — Monthly Reporting (Reporting mode; keeps its founder-approved standalone chrome — see §12 exception below).

## 10. Rev-3 timezone / greeting / AM-PM behaviour

Preserved end-to-end:
- Greeting reads `Good afternoon, Chris.` on staging while Edmonton is in the afternoon (Playwright captured this on v222).
- `snapshot.clubTimezone.ianaZone` remains the authoritative source of tenant local time.
- Today's Commitments still renders via `formatLocalTimeAmPm` — the 24 unit tests in `mission-control-local-time.test.ts` continue to pass.

## 11. Rev-1 / rev-2 UI preserved

- Sidebar: `SPECTRE / AUTOMATION` two-line eyebrow (verified visually + via `spectre-sidebar-product-name-line-1/2` testids on Playwright)
- Header rail order: `tenant → separator → crumbs` (DOM order asserted in acceptance spec)
- Greeting: only `Good {tod}, {firstName}.` — no tenant appended
- Work Intake cards: MAIL-XXXX id-tag stays `display: none`; AP field values + CTAs untouched

## 12. Routes that intentionally do not use the canonical shell

**Monthly Reporting (`/app/admin/reporting/**`)** — reporting mode retains its founder-approved standalone chrome (chapter rail + back-to-admin link) that replaces the general application shell. Rationale: this is a documented product design decision per `docs/monthly-reporting-design-audit.md` and the "boardroom polished executive briefing" standard in CLAUDE.md. Bringing the canonical sidebar into reporting would compete visually with the report document — the exact anti-pattern the reporting design standard was created to avoid. The Monthly Reporting **link** remains reachable from the canonical sidebar (Governance & Reporting group); only the report page itself opts out.

**Lounge POS (`/app/admin/ops/pos/lounge/**`)** — POS mode retains its stripped edge-to-edge touch chrome for the operator behind a bar. Adding the full navigation to a shift-manager POS screen would add noise without benefit.

Both exceptions are documented at the top of `AdminShell.tsx`.

## 13. Unexpected findings

1. **Vendor timeline breadcrumb reads `App > Admin > Ap > Vendors > Cms4461… > Timeline`.** The generic segment prettifier prints the vendor cuid as a title-cased crumb and lower-cases `AP` to `Ap`. This is not new (it's how `deriveBreadcrumbs` already worked for un-overridden routes) and is out of scope for rev-4. If the founder wants friendlier deep-route crumbs, the fix is to add per-route override entries in `src/lib/chrome/breadcrumb.ts` (`PATH_LEAF_LABEL_OVERRIDES` + a segment-map extension). Flagged for a separate polish slice.
2. **c15m has 2 pre-existing baseline test failures** (mailbox feed-loader source-contract + shared-formatter call count) — unchanged by this slice, confirmed via `git stash` A/B in the earlier rev-1 checkpoint.
3. **Prisma `mode: "insensitive"` is Postgres-only** — staging + dev use SQLite, so the initial version of `runGlobalSearch` that relied on `mode` failed under vitest. Refactored to bounded-scan + JS-scoring which stays portable across both engines and matches the size of a typical club's dataset.

---

## Rollback

Rev-4 is a chrome + search-endpoint change; no DB migrations. To roll back:
```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M03CG36KEC5VZMZV7Z2S4BEV
```
or `git revert ac13709` on the branch.
