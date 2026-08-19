# Phase 4R · UI Refinement rev-2 — Sidebar eyebrow + tenant-in-header-rail

**Date:** 2026-08-15  
**Author:** Claude Opus 4.7 (under founder authorization)  
**Branch:** `work-intake-state-outlook-archive-fix`  
**Commit:** `5977cb8`  
**Staging web:** v219 → **v220** (`spectre-staging:deployment-01M03BB9AM76T3NE31SNJQ8JMD`)  
**Staging worker:** v114 (unchanged)  
**Rollback anchor:** web v219 / `spectre-staging:deployment-01M039DWW1R118P4R0H18VXDYH`

Founder corrections to the v219 UI-refinement checkpoint. Bounded
presentation-only. No changes to AP intelligence, Work Intake
lifecycle, schema, tenant architecture, or card state derivation.

---

## 1. Files changed

New (extracted shared logic):
- `src/lib/chrome/breadcrumb.ts` — `deriveBreadcrumbs()` +
  `PATH_LEAF_LABEL_OVERRIDES` map. ONE source of truth for
  pathname → crumb chain.
- `src/components/spectre/HeaderContextRail.tsx` — the shared
  "tenant · breadcrumb" rail. Consumers pass `tenantName` and
  optional explicit `breadcrumbs`; otherwise the rail derives
  crumbs from the current pathname via the shared lib.

Wiring:
- `src/components/spectre/SpectreTopBar.tsx` — accepts new
  `tenantName` prop, renders `<HeaderContextRail>` in its left
  region. Inline `deriveCrumbsFromPath` + override map deleted.
- `src/app/app/admin/layout.tsx` — threads `clubName` through as
  `tenantName={clubName}` on the Spectre topbar.

Sidebar identity (both surfaces):
- `src/components/spectre/SpectreSidebar.tsx` — replaces
  single-line "Spectre Automation" wordmark with a two-line eyebrow:
  `SPECTRE` / `AUTOMATION` (uppercase, tracking-[0.14em],
  font-[10px], muted). Two testids
  (`spectre-sidebar-product-name-line-1/2`) let contract tests
  pin each line independently.
- `src/components/Sidebar.tsx` — same treatment applied to the
  legacy admin sidebar so identity is consistent whether the
  founder navigates to a Spectre-chrome route or a legacy admin
  route.

Page:
- `src/app/app/admin/page.tsx` — removes the standalone
  `.spectre-mc-tenant-context` row that briefly appeared above the
  greeting in v219. Tenant now lives in the header rail.
- `src/app/globals.css` — adds `.spectre-header-rail*` styles
  (rail flex layout + tenant text + hairline separator). Drops
  the retired `.spectre-mc-tenant-context` block. Keeps
  `.spectre-mc-id-tag { display: none }` from v219.

Tests:
- `tests/c15o-two-step-vendor-and-ap-workflow-source-contract.test.ts`
  — pinned to the new two-line eyebrow contract (58/58 pass).
- `tests/e2e/phase-4r-ui-refinement-rev2-acceptance.staging.spec.ts`
  (NEW) — executes the founder's numbered acceptance criteria for
  rev-2.

---

## 2. Validation performed

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `npm run scan:placeholders` | No new placeholders in touched files (only pre-existing prisma/schema.prisma + prisma/seed.ts hits) |
| `tests/c15o-…` | 58/58 pass with rev-2 pins |
| `tests/c15n-variant-d-sidebar-icons-source-contract` | Pass |
| `tests/c15i-variant-d-card-source-contract` | 48/48 pass (unchanged) |
| `tests/design-system-member-brand-shielding` | Pass |
| Staging deploy web v219 → **v220** | Successful, `/api/health` = 200 |
| Playwright acceptance suite | **PASS** (all assertions) |

Console evidence from the Playwright acceptance run:
```
[§1] eyebrow lines = "SPECTRE" / "AUTOMATION"
[§1] eyebrow computed style = {"textTransform":"uppercase","fontSize":"10px","letterSpacing":"1.4px"}
[§2] header-rail tenant text = "Coulee Ridge Golf & Country Club"
[§2] rail crumbs = ["App","Mission Control"]
[§2] header-rail child order = ["spectre-header-rail-tenant","span","spectre-header-rail-crumbs"]
[§3] greeting text = "Good evening, Chris."
```

## 3. Acceptance results

| Criterion | Result |
|---|---|
| §1 Only one product identity in the sidebar | PASS |
| §1 Reads `SPECTRE` / `AUTOMATION` as two eyebrow lines | PASS (uppercase, 10px, letter-spacing 1.4px) |
| §1 No duplicate Spectre wordmark | PASS |
| §1 No tenant/club name in sidebar | PASS (no `Coulee Ridge` in sidebar `<aside>` text) |
| §2 Tenant identity **before** breadcrumb, **same** header layer | PASS (DOM order: `spectre-header-rail-tenant` → separator → `spectre-header-rail-crumbs`) |
| §2 Breadcrumb reads `App > Mission Control` | PASS (segments = `["App","Mission Control"]`) |
| §2 Visual separation between tenant and breadcrumb | PASS (12 px gap + 14 px hairline `.spectre-header-rail-sep`) |
| §2 Tenant does NOT appear above the greeting | PASS (`spectre-mc-tenant-context` count = 0) |
| §2 Tenant does NOT appear after the breadcrumb or inside greeting | PASS |
| §3 Greeting reads `Good evening, Chris.` only | PASS |
| §4 No visible `MAIL-XXXX` on Active or Completed card | PASS (computed `display: none`) |
| §4 Underlying WI id preserved for internal use | PASS (`data-work-intake-item-id` on card root) |
| §5 Existing AP card values / states / actions unchanged | PASS — Club Support Inc / $778.16 CAD / #220824 / Subscriptions / GL 6071 / CTAs identical to v219 |
| §6 Multi-tenant clean — no `Coulee Ridge` literal | PASS — tenant comes from `getActiveBranding()` |
| Architecture: shared breadcrumb source of truth | PASS — new `src/lib/chrome/breadcrumb.ts` |

## 4. Before / after evidence

Screenshots saved:
- `test-results/phase-4r-ui-refinement/before/` — v218 baseline (pre-Phase-4R)
- `test-results/phase-4r-ui-refinement/after/` — v219 (Phase-4R rev-1)
- `test-results/phase-4r-ui-refinement-rev2/after/` — v220 (this rev)

Key visual deltas (v219 → v220):

| Surface | v219 | v220 |
|---|---|---|
| Sidebar identity | `S` + `Spectre Automation` (single-line wordmark) | `S` + `SPECTRE` / `AUTOMATION` (two-line eyebrow) |
| Topbar left | `App > Mission Control` (crumbs only) | `Coulee Ridge Golf & Country Club` \| `App > Mission Control` (tenant → separator → crumbs) |
| Page header | `Coulee Ridge…` context row above `Good evening, Chris.` | `Good evening, Chris.` only (tenant now in topbar) |
| Card head | Unchanged — MAIL-XXXX still hidden | Unchanged |

## 5. Handling of the legacy `TopBar` vs `SpectreTopBar` split

The v219 checkpoint noted that non-Mission-Control admin routes
(`/app/admin/members`, `/app/admin/reporting/monthly`) render the
legacy `src/components/TopBar.tsx` instead of `SpectreTopBar`. That
legacy component currently renders NO breadcrumbs at all — it only
carries the account-menu on the right — so there was no competing
breadcrumb *implementation* to deduplicate, only an absence of
breadcrumbs on those routes.

Decision for this slice: **extract shared logic, do not migrate**.

- Extracted `deriveBreadcrumbs` + `PATH_LEAF_LABEL_OVERRIDES` into
  `src/lib/chrome/breadcrumb.ts` so a future consumer (a migrated
  legacy topbar, a PDF report chrome, an offline export) can read
  from ONE source of truth.
- Extracted the `Tenant · Breadcrumb` rail into
  `src/components/spectre/HeaderContextRail.tsx` so the same
  layout can be reused verbatim.
- Left the legacy `TopBar` unchanged. Wiring the shared rail into
  legacy admin chrome would add a header rail to Members and
  Monthly Reporting that isn't there today — a visible addition
  the founder asked to avoid until a broader migration is
  authorized.

When the founder is ready to unify the chrome, the migration is
now the two-line change of importing `HeaderContextRail` into
`TopBar.tsx` and passing `tenantName`; no derivation logic will
need to be re-authored.

## 6. Rollback

```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M039DWW1R118P4R0H18VXDYH
```
or revert commit `5977cb8` on the branch.

## 7. Unexpected findings

None. All rev-2 assertions passed on first Playwright run against
v220. c15o test-shape fix (regex tolerating whitespace around
`SPECTRE` / `AUTOMATION` JSX children) was needed but is a pure
test cleanup — no code path affected.

## 8. Remaining risk

- **None runtime-side.** No AP intelligence, no Work Intake
  state, no schema, no tenant-scope logic touched.
- **Legacy admin chrome** on Members / Monthly Reporting still
  has no breadcrumb or tenant rail; this is a documented,
  intentional gap awaiting a broader Spectre-chrome migration.
