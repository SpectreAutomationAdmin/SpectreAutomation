# Phase 4R · UI Refinement rev-5 — Canonical Breadcrumb Taxonomy + Dynamic Entity Labels

**Date:** 2026-08-15  
**Author:** Claude Opus 4.7 (under founder authorization)  
**Branch:** `work-intake-state-outlook-archive-fix`  
**Commit:** `a0d6e0a`  
**Staging web:** v222 → **v223** (`spectre-staging:deployment-01M03G9SZ5KYW5RVE3H600YWPR`)  
**Staging worker:** v114 (unchanged)  
**Rollback anchor:** web v222 / `spectre-staging:deployment-01M03EFEDBQGHRB2NWTFJQ3JKN`

---

## 1. Root cause of raw vendor IDs appearing in breadcrumbs

`deriveBreadcrumbs(pathname)` in
[src/lib/chrome/breadcrumb.ts](src/lib/chrome/breadcrumb.ts) was a
generic kebab → Title-Case prettifier applied to every URL segment,
plus a single leaf-override map. It was a URL parser, not a
navigation model. So:

- `/app/admin/ap/vendors` rendered `App > Admin > Ap > Vendors` — every
  segment survived and `ap` prettified to `Ap`.
- `/app/admin/ap/vendors/cms4461to0002gypwkbhl8n67/timeline` leaked
  the vendor cuid because there was no mechanism to resolve it to
  the vendor display name.

## 2. Final breadcrumb architecture

`deriveBreadcrumbs` is now driven by four coordinated tools; each
segment resolves in one pass through this ladder:

| # | Rule | Data source |
|---|---|---|
| 1 | Leaf full-path override | `PATH_LEAF_LABEL_OVERRIDES` (`/app/admin` → `Mission Control`) |
| 2 | Segment suppression | `SEGMENT_SUPPRESS` (`admin`) |
| 3 | Dynamic entity label | `opts.dynamicLabels` (`vendor.id` → `Microsoft Corporation`) |
| 4 | cuid / UUID fallback | Renders `Detail` — never leaks the raw id |
| 5 | Per-segment acronym override | `SEGMENT_LABEL_OVERRIDES` (`ap`→AP, `ar`→AR, `coa`→COA, `gl`→GL, `hr`→HR, `it`→IT, `mfa`→MFA, `ops`→Operations, `pos`→POS, `ui`→UI) |
| 6 | Generic kebab → Title-Case prettifier | Fallback for every other slug |

Suppression is subordinate to leaf overrides so `/app/admin` still
renders `App > Mission Control` (the leaf override wins over
suppressing `admin`).

Non-leaf `href` values retain the **original** URL, so suppressing
`admin` does not break navigation links — clicking the `Vendors`
crumb still navigates to `/app/admin/ap/vendors`.

## 3. `Admin` suppression — global, not context-scoped

`admin` is now suppressed **globally** in `SEGMENT_SUPPRESS`.

Rationale: `Admin` is a URL namespace, not a user-facing navigation
concept. Mission Control has always read `App > Mission Control`
(never `App > Admin > Mission Control`); rev-5 makes every other
admin route consistent with that convention. The sidebar taxonomy
(`ACCOUNTS PAYABLE > Vendors`, `MEMBERSHIP > Members`) is the
user's mental model — the breadcrumb reflects the sidebar, not the
URL.

If a real future navigation level ever needs the word "Admin", it
can be re-added by removing that entry from `SEGMENT_SUPPRESS` and
introducing an explicit override at the appropriate depth. No
one-off exception was needed for rev-5.

## 4. Dynamic entity labels

The client-side registry lives in
[src/components/spectre/breadcrumb-labels.tsx](src/components/spectre/breadcrumb-labels.tsx):

- `<BreadcrumbLabelsProvider>` — React context, wraps the admin
  layout so both the topbar (crumb consumer) and page tree (label
  producer) share one context.
- `useBreadcrumbLabels()` — hook the topbar's `HeaderContextRail`
  reads to pass `dynamicLabels` into `deriveBreadcrumbs`.
- `<RegisterBreadcrumbLabel id={x} label={y} />` — the page/layout
  renders this once next to its content. Registration is
  `useEffect`-scoped, so it survives client-side navigation and is
  torn down cleanly on unmount (no stale labels on back-nav).

Reusability: keyed by the raw URL segment string, so the same
mechanism works for vendors, invoices, members, GL accounts — any
named entity. No entity type is baked into the registry.

The vendor timeline page and vendor detail page both inject the
vendor's display name:

```tsx
const vendorDisplayName = vendor.operatingName ?? vendor.legalName;
<RegisterBreadcrumbLabel id={vendor.id} label={vendorDisplayName} />
```

## 5. Files changed

Code:
- [src/lib/chrome/breadcrumb.ts](src/lib/chrome/breadcrumb.ts) —
  extended derivation with `SEGMENT_SUPPRESS`,
  `SEGMENT_LABEL_OVERRIDES`, cuid/UUID detection, `dynamicLabels`
  option, and the one-pass resolution ladder above
- **NEW** [src/components/spectre/breadcrumb-labels.tsx](src/components/spectre/breadcrumb-labels.tsx) —
  provider + hook + `<RegisterBreadcrumbLabel/>`
- [src/components/spectre/HeaderContextRail.tsx](src/components/spectre/HeaderContextRail.tsx) —
  consumes `useBreadcrumbLabels()` and passes `dynamicLabels` to
  `deriveBreadcrumbs`
- [src/app/app/admin/layout.tsx](src/app/app/admin/layout.tsx) —
  wraps the whole `AdminShell` in `<BreadcrumbLabelsProvider/>` so
  topbar + children share one context
- [src/app/app/admin/ap/vendors/\[id\]/page.tsx](src/app/app/admin/ap/vendors/[id]/page.tsx) — injects vendor label via `<RegisterBreadcrumbLabel/>`
- [src/app/app/admin/ap/vendors/\[id\]/timeline/page.tsx](src/app/app/admin/ap/vendors/[id]/timeline/page.tsx) — injects vendor label via `<RegisterBreadcrumbLabel/>`

Tests:
- **NEW** [tests/chrome-breadcrumb.test.ts](tests/chrome-breadcrumb.test.ts) — 27 tests: Mission Control preserved, `admin` suppressed at every depth, acronyms applied at any position, cuid/UUID never leaks, `dynamicLabels` resolve entity ids (including a second-vendor sanity case that proves the mechanism is not Microsoft-specific), non-leaf hrefs preserve the ORIGINAL URL
- **NEW** [tests/e2e/phase-4r-rev5-breadcrumb-acceptance.staging.spec.ts](tests/e2e/phase-4r-rev5-breadcrumb-acceptance.staging.spec.ts) — Playwright acceptance across Mission Control, AP Vendors, Microsoft Vendor Timeline, second-vendor discovery via global-search API + rev-4 shell / rev-3 timezone regression guards

Docs:
- [docs/phase-4r-ui-refinement-rev5-checkpoint.md](docs/phase-4r-ui-refinement-rev5-checkpoint.md) (this file)

## 6. Tests and results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `tests/chrome-breadcrumb.test.ts` (NEW) | **27/27** pass |
| `tests/global-search.test.ts` (rev-4 regression) | 12/12 |
| `tests/mission-control-local-time.test.ts` (rev-3 regression) | 24/24 |
| `tests/c16g-commitments.test.ts` (rev-3 regression) | 24/24 |
| `tests/c15o-two-step-vendor-and-ap-workflow-source-contract.test.ts` (rev-2 regression) | 58/58 |
| `tests/c15i-variant-d-card-source-contract.test.ts` | 48/48 |
| `tests/design-system-member-brand-shielding.test.ts` | pass |
| **Total regression suites** | **215/215** |
| `npm run scan:placeholders` | Clean in touched files |
| Playwright rev-5 staging acceptance | **PASS** |

Playwright console evidence:
```
[§1] Mission Control crumbs = ["App","Mission Control"]
[§2] AP Vendors crumbs = ["App","AP","Vendors"]
[§3a] Microsoft timeline crumbs = ["App","AP","Vendors","Microsoft Corporation","Timeline"]
[§3b] no second vendor available in list — skipping second-vendor assertion
[§4] greeting = "Good afternoon, Chris."
```

## 7. Staging deployment version / ID

- Web `spectre-staging` **v222 → v223** (`spectre-staging:deployment-01M03G9SZ5KYW5RVE3H600YWPR`)
- Worker v114 (unchanged)

## 8. Rollback anchor

Web **v222** (`spectre-staging:deployment-01M03EFEDBQGHRB2NWTFJQ3JKN`)

Rollback:
```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M03EFEDBQGHRB2NWTFJQ3JKN
```
or `git revert a0d6e0a` on the branch.

## 9. Screenshots

Saved under `test-results/phase-4r-rev5-breadcrumb/after/`:

| File | Surface | Breadcrumb |
|---|---|---|
| `01-mission-control.png` | Mission Control | `App > Mission Control` |
| `02-ap-vendors.png` | AP Vendors list | `App > AP > Vendors` |
| `03-vendor-timeline-microsoft.png` | Microsoft Vendor Timeline | `App > AP > Vendors > Microsoft Corporation > Timeline` |
| `04-vendor-timeline-second.png` | Second vendor timeline | Not captured — see §13 |

The Microsoft screenshot visually confirms:
- Sidebar `SPECTRE / AUTOMATION` with `ACCOUNTS PAYABLE` expanded and `Vendors` selected.
- Topbar reads `Coulee Ridge Golf & Country Club | App > AP > Vendors > Microsoft Corporation > Timeline` — tenant prominent, then breadcrumb; no `Admin`, no `Ap`, no cuid.

## 10. Rev-4 shell/search + rev-3 timezone behaviour intact

Verified end-to-end on v223:
- Sidebar `SPECTRE / AUTOMATION` two-line eyebrow (asserted by testids).
- Canonical Spectre shell on every admin route (Mission Control, AP Vendors, Vendor Timeline all captured).
- Tenant identity first + prominent in the header rail (DOM child-order asserted; visible in the screenshot).
- Global search still opens from the top-right icon and returns Microsoft results (the rev-5 acceptance spec re-uses the same endpoint to discover a second vendor).
- Greeting: `Good afternoon, Chris.` — America/Edmonton-aware.
- Commitments still render via `formatLocalTimeAmPm` (24 unit tests continue to pass).
- Work Intake card MAIL-XXXX id-tag remains `display: none`; AP field values + CTAs unchanged.

## 11. Unexpected findings

**Coulee Ridge staging currently has only one Vendor row.** The
Microsoft Corporation vendor is the only fixture on this club; the
other AP-fixture suppliers (Club Support, DMM, Oakcreek, OXIO,
CPA Alberta) exist only as extracted supplier text on ingested
invoices — they were never promoted to real `Vendor` rows on this
club. Consequently the staging Playwright acceptance could not
walk a live second-vendor timeline. The **dynamism** of the
breadcrumb resolver is proved instead by:

- `tests/chrome-breadcrumb.test.ts::"second vendor works too …"` — a
  deterministic unit test that resolves a synthetic cuid
  (`cms111zzz9999xxxyyy222aaa`) to a synthetic name
  (`Club Support Inc`) via `dynamicLabels`. No Microsoft-specific
  code path exists in the library or the vendor pages — they only
  call `<RegisterBreadcrumbLabel id={vendor.id} label={vendor.legalName} />`
  with whatever the vendor record has.

When staging gains a second real vendor (or when a fixture is
seeded), the acceptance spec's `findSecondVendor()` helper will
automatically discover it via the global-search API and run the
full crumb assertion.

## 12. Rev-5 stopped short of

- **General entity-metadata framework** — the founder asked to
  avoid one; the registry only knows `(segment, label)` pairs.
- **Deep-route label overrides beyond what the sidebar taxonomy
  requires** — no new full-path overrides were added; only the
  `admin` suppression + acronym map + dynamic labels are needed to
  produce the founder-cited canonical breadcrumbs.
- **Migration of other legacy detail pages** (AP invoices, members)
  to inject their own labels — the reusable mechanism exists; when
  those routes get their own visual polish they can add
  `<RegisterBreadcrumbLabel/>` in one line each without touching
  the shell or the derivation library.
