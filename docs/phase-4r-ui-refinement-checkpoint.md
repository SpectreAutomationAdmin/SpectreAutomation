# Phase 4R · UI Refinement — Sidebar / Header / Breadcrumb / Card id-tag

**Date:** 2026-08-15  
**Author:** Claude Opus 4.7 (under founder authorization)  
**Branch:** `work-intake-state-outlook-archive-fix`  
**Commit:** `fb8fcb2`  
**Staging web:** v218 → **v219** (`spectre-staging:deployment-01M039DWW1R118P4R0H18VXDYH`)  
**Staging worker:** v114 (unchanged — no worker code touched)  
**Rollback anchor:** web v218 / `spectre-staging:deployment-01M035BWD24JYHN9SZ5D23FMH8`

Bounded presentation-only refinement to Mission Control chrome per
founder brief. No changes to AP intelligence, Work Intake lifecycle,
schema, tenant architecture, or card state derivation. Multi-tenant
clean: no Coulee Ridge literal introduced anywhere.

---

## 1. Files changed

Code:
- `src/components/Sidebar.tsx` — legacy admin identity: replaced
  `SPECTRE` eyebrow + `{clubName}` with single "Spectre Automation"
- `src/components/spectre/SpectreSidebar.tsx` — Spectre-chrome identity:
  same replacement; renamed testid → `spectre-sidebar-product-name`
- `src/components/spectre/SpectreTopBar.tsx` — added
  `PATH_LEAF_LABEL_OVERRIDES` map so `/app/admin` derives leaf label
  "Mission Control" instead of "Admin"
- `src/app/app/admin/page.tsx` — moved tenant identity out of the
  greeting into a small `spectre-mc-tenant-context` row above; greeting
  now reads only "Good {tod}, {firstName}."
- `src/app/globals.css` — new `.spectre-mc-tenant-context` style;
  renamed `.spectre-sidebar-club-name` → `.spectre-sidebar-product-name`
  (2-line clamp preserved); `.spectre-mc-id-tag { display: none }`;
  `.spectre-mc-greeting .club { display: none }` (belt-and-braces)

Tests:
- `tests/c15o-two-step-vendor-and-ap-workflow-source-contract.test.ts` —
  updated the sidebar identity contract to pin the new product-name
  shape (59/59 pass)
- `tests/e2e/phase-4r-ui-refinement-before-after.staging.spec.ts`
  (NEW) — full-page + sidebar + topbar + first-card capture,
  parameterised by `SPECTRE_UI_REFINEMENT_OUT` for before/after runs
- `tests/e2e/phase-4r-ui-refinement-acceptance.staging.spec.ts`
  (NEW) — executes each of the founder's numbered acceptance criteria

Docs:
- `docs/phase-4r-ui-refinement-checkpoint.md` (this file)

---

## 2. Validation performed

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `npm run scan:placeholders` | No new placeholders in touched files (all hits pre-existing in Prisma schema + seed) |
| `tests/c15o-two-step-vendor-and-ap-workflow-source-contract.test.ts` | **59/59 pass** with updated pins |
| `tests/c15n-variant-d-sidebar-icons-source-contract.test.ts` | Pass |
| `tests/c15i-variant-d-card-source-contract.test.ts` | 48/48 pass (unchanged) |
| `tests/design-system-member-brand-shielding.test.ts` | Pass |
| `tests/c15m-mission-control-refinement-source-contract.test.ts` | 22/24 pass — **2 pre-existing failures** on baseline (confirmed via `git stash` A/B, unrelated to this slice) |
| Staging deploy web v218 → v219 | Successful, `/api/health` = 200 |
| Playwright before + after screenshot capture (7 shots each, viewport 1440 × 900, deviceScaleFactor 2) | Successful |
| Playwright numbered-acceptance assertions | **All pass** |

## 3. Validation intentionally skipped

- Full vitest suite — this is a bounded UI slice touching 5 files;
  targeted contract tests + adjacent card/sidebar suites cover the
  blast radius.
- E2E on legacy admin routes (`/app/admin/members`, `/app/admin/reporting/monthly`)
  — full-page screenshots were captured but breadcrumb assertions
  were skipped because those routes render the LEGACY topbar chrome,
  not `SpectreTopBar`. Legacy topbar was not in scope for this slice;
  no regression expected because no legacy component was edited.

## 4. Acceptance results (from `phase-4r-ui-refinement-acceptance.staging.spec.ts`)

| # | Criterion | Result |
|---|---|---|
| §1 | Sidebar contains one product name "Spectre Automation" | PASS — `spectre-sidebar-product-name` element visible, text = "Spectre Automation" |
| §1 | No `SPECTRE` eyebrow above the product name | PASS — one "Spectre" occurrence in the identity block |
| §1 | Retired `spectre-sidebar-club-name` testid absent | PASS — element count = 0 |
| §1 | Spectre icon/mark preserved | PASS — the "S" mark on the left of the product name remains |
| §1 | Tenant name no longer in sidebar | PASS — no "Coulee Ridge" match in the identity block |
| §2 | Tenant name appears in upper page-context area | PASS — `spectre-mc-tenant-context` text = "Coulee Ridge Golf & Country Club" |
| §2 | Greeting reads "Good {tod}, {firstName}." only | PASS — text = "Good evening, Chris." (no tenant appended) |
| §3 | Mission Control breadcrumb reads `App > Mission Control` | PASS — crumb segments = `["App", "Mission Control"]` |
| §4 | `MAIL-XXXX` identifier absent from Active card | PASS — `.spectre-mc-id-tag` is `display: none` (computed style verified) |
| §4 | `MAIL-XXXX` identifier absent from Completed History card | PASS — same rule on history view |
| §4 | Underlying WI id remains internally | PASS — `data-work-intake-item-id="cmstrkizp02wz13qw3zcplzwe"` on card root; `.spectre-mc-id-tag` textContent still `MAIL-LZWE` for diagnostic tooling |
| §5 | Existing AP card values / states / actions unchanged | PASS — Club Support Inc / $778.16 CAD / #220824 / Subscriptions / GL 6071 / CTAs identical before + after |
| §6 | Multi-tenant clean — no `Coulee Ridge` literal introduced | PASS — tenant comes from `getActiveBranding()` / `snapshot.club` |
| §7 | Layout regression | None observed at 1440 × 900 (before/after full-page screenshots captured) |

## 5. Before / after evidence

Screenshots saved under:
- `test-results/phase-4r-ui-refinement/before/` (captured on v218)
- `test-results/phase-4r-ui-refinement/after/` (captured on v219)

Each folder contains:
- `01-mission-control-full.png` — full-page Mission Control
- `02-sidebar.png` — sidebar crop
- `03-topbar.png` — topbar crop (breadcrumb evidence)
- `04-first-card.png` — first AP card (MAIL id-tag evidence)
- `05-completed-history-full.png` — full-page Completed History
- `06-first-history-card.png` — first history card
- `08-members-full.png`, `08-reporting-monthly-full.png` — regression
  reference for two other Spectre pages

Key visual diffs the founder can verify:

| Surface | Before (v218) | After (v219) |
|---|---|---|
| Sidebar identity | `S` + `SPECTRE` eyebrow + `Coulee Ridge Golf & Country Club` (three lines) | `S` + `Spectre Automation` (single wordmark) |
| Topbar breadcrumb | `App > Admin` | `App > Mission Control` |
| Page greeting | `Good evening, Chris. Coulee Ridge Golf & Country Club` | Small "Coulee Ridge…" context line above `Good evening, Chris.` |
| First card head | `● VENDOR MATCH REQUIRED  MAIL-LZWE  15 hrs ago` | `● VENDOR MATCH REQUIRED  15 hrs ago` |

## 6. Unexpected findings

1. **Two other Spectre pages render the LEGACY topbar, not
   `SpectreTopBar`.** `/app/admin/members` and
   `/app/admin/reporting/monthly` are outside the
   `SPECTRE_MODE_EXACT_URLS` list in `AdminShell`, so they render
   the classic admin chrome (not the Spectre-designed chrome we
   updated). This is expected architecturally — the Spectre chrome
   is scoped to specific exact paths, and Mission Control (§Phase
   1) is currently the only Spectre-chrome admin route. The founder
   should be aware that today's UI-refinement therefore ONLY touches
   Mission Control's `SpectreTopBar`; the legacy `TopBar`
   (`src/components/TopBar.tsx`) is unmodified and remains on non-
   Mission-Control admin routes. Extending the same breadcrumb
   convention to the legacy topbar is a separate, larger slice.
2. **c15m has 2 pre-existing test failures on baseline** (mailbox
   feed-loader source-contract + shared-formatter call count).
   Confirmed unrelated to this slice via `git stash` A/B.
3. **AP card render is byte-identical for every visible field**
   except the head row — sanity check that no accidental
   projection or CSS drift affected the AP intelligence display.

## 7. Rollback

If this UI slice needs to be rolled back:

```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M035BWD24JYHN9SZ5D23FMH8
```

or revert commit `fb8fcb2` on the branch.

## 8. Remaining risk

- **None runtime-side.** All backend behaviour is untouched (no AP
  intelligence, no Work Intake state, no schema, no tenant scope
  logic).
- **Legacy admin topbar** still reads `App > Admin` on non-Mission-
  Control admin routes (see §6.1). This was outside the founder's
  brief scope ("Mission Control / Work Intake Feed") but is worth
  noting as a discoverable inconsistency between admin pages until
  either the same override map is applied to the legacy topbar or
  all admin routes migrate to Spectre chrome.
