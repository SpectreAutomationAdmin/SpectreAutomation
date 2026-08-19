# Phase 4R · UI Refinement rev-7 — Tab-Driven Work Intake Card

**Date:** 2026-08-15  
**Author:** Claude Opus 4.7 (under founder authorization)  
**Branch:** `work-intake-state-outlook-archive-fix`  
**Commit:** `b887385`  
**Staging web:** v225 → **v226** (`spectre-staging:deployment-01M042DRHPEQ8QYH029V0QRVPG`)  
**Staging worker:** v114 (unchanged)  
**Rollback anchor:** web v225 / `spectre-staging:deployment-01M03XKGDEXWARAZXPQK5FN1QG`

---

## 1. Existing card state architecture (pre-rev-7)

`EmailIntakeCard` (`src/components/mission-control/EmailIntakeCard.tsx`, ~1525 lines pre-rev-7) carried:

- `const [expanded, setExpanded] = useState(false)` — accordion toggle
- `const [tab, setTab] = useState<Tab>(defaultTabFor(data))` with `Tab = "conversation" | "attachments" | "invoice" | "statement" | "activity"`
- `handlePrimarySurfaceClick` — click-to-expand/collapse; also fired `markReadOnce`
- A `role="button"` wrapper around the whole summary body (`.spectre-mc-item-surface`) that toggled `expanded`
- A separate `.spectre-btn` "Open" / "Collapse" text button (`data-testid="card-toggle"`)
- An expanded region below the summary + action row (`.spectre-mc-item-expanded`) containing a `TabBar` + a switch-case tab body
- Two heavyweight facet-pane sub-components inside the tab body: `InvoiceFacetPane` + `StatementFacetPane` (~112 LOC combined)
- An Activity tab that rendered a placeholder note ("See conversation tab for message history")

Effect: the Spectre Summary was **always** visible; opening the card added a **second** navigation layer of `Conversation | Attachments | Invoice Review | Statement Review | Activity` beneath it.

## 2. Final simplified tab architecture (rev-7)

```
type Tab = "spectre-summary" | "conversation" | "attachments";
```

Every Work Intake card is now a single tab-driven card:

```
┌──────────────────────────────────────────────────────┐
│  Spectre Summary | Conversation | Attachments        │
├──────────────────────────────────────────────────────┤
│                                                      │
│             SELECTED TAB CONTENT                     │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- `tabsFor(data)` returns `["spectre-summary", "conversation"]` always; `"attachments"` is pushed only when the intake carries at least one attachment.
- `useState<Tab>("spectre-summary")` — every card renders with Spectre Summary selected by default.
- No `expanded` / `setExpanded` — retired entirely.
- Tab click owns three side effects: `setTab(next)`, `markReadOnce()`, and the target-tab's lazy load (`loadConversationOnce` / `loadAttachmentsOnce`).
- Each `<article>` carries `data-active-tab={tab}` so the DOM state is queryable per card without JS.

## 3. Exact handling of the old Open/Collapse state

Retired completely. No vestigial `isExpanded` / `showSummary` / `expanded` flag survives in the card component. The retired affordances:

- `<div className="spectre-mc-item-surface" role="button" tabIndex={0} …>` — the click-to-expand wrapper
- `handlePrimarySurfaceClick` callback + `openButtonRef` — retired
- `<button data-testid="card-toggle">{expanded ? "Collapse" : "Open"}</button>` — retired
- `{expanded ? (<div className="spectre-mc-item-expanded">…</div>) : null}` — retired
- `.spectre-mc-item-surface`, `.spectre-mc-item-expanded` CSS — retired

The DOM attribute rename `data-expanded` → `data-active-tab` is deliberate and asserted by the new source-contract test.

## 4. What happened to the Invoice Review tab's unique information

`InvoiceFacetPane` rendered `apEvidence` payloads (`document`, `extraction`, `vendorResolution`, `capitalRecommendation`, `glRecommendation`, `sourceCorrespondence`). Every founder-visible field it displayed is **already surfaced inside the Spectre Summary** through the loader's `ApInvoiceCardIntelligence` projection:

| InvoiceFacetPane field | Spectre Summary surface |
|---|---|
| `extraction.vendor.guessedName` | Title line ("Club Support Inc invoice #…") |
| `extraction.invoiceNumber` | Title + INVOICE readout cell |
| `extraction.total` / `currency` | AMOUNT readout cell |
| `glRecommendation.accountName` | CATEGORY readout cell + `GL 6071 Subscriptions` chip in the Spectre narrative |
| `vendorResolution.state` | Workflow pill (`VENDOR MATCH REQUIRED` etc.) |
| `capitalRecommendation.state` | Recommendation strip |
| `sourceCorrespondence.senderName` | Sender line under the title |

No unique founder-useful data was lost. The retired `apEvidence` endpoint remains for diagnostics + the CVAP modal.

## 5. Activity/audit data preservation

The Activity tab in rev-6 rendered a placeholder note that pointed to the Conversation tab for message history. No data displayed on Activity was unique to it. Underlying audit rows continue to land in the existing `WorkIntakeAudit` table via the standard `audit()` service — retired UI tab, unchanged data model.

## 6. Read/unread coupling

Rev-6 fired `markReadOnce` on `handlePrimarySurfaceClick` (Open-click). With Open removed, mark-read moves to `handleTabChange` — fires on **any tab click**. Merely rendering the card still does NOT flip read state (passive scroll-past is untouched).

Also confirmed the primary-action click path still fires `markReadOnce` for AP modal-open actions (Create vendor & post, Approve & post, etc.) — a founder who never touches a tab and clicks the primary action immediately still marks the item read.

## 7. Files changed

Code:
- [src/components/mission-control/EmailIntakeCard.tsx](src/components/mission-control/EmailIntakeCard.tsx) — refactored to the tab-driven model; retired ~112 LOC of facet-pane sub-components + Activity/Invoice/Statement tab plumbing
- [src/app/globals.css](src/app/globals.css) — retired `.spectre-mc-item-surface` + `.spectre-mc-item-expanded`; added `.spectre-mc-item-body` + `.spectre-mc-tabs--card`

Tests:
- [tests/work-intake-card-tab-model.test.ts](tests/work-intake-card-tab-model.test.ts) (NEW) — 19 source-contract assertions covering the retired affordances, the tab set, the default-tab guarantee, the mark-read coupling, and the CSS class contract.
- [tests/c15i-variant-d-card-source-contract.test.ts](tests/c15i-variant-d-card-source-contract.test.ts) — updated pins from rev-6 (accordion) to rev-7 (tab-driven); documented that `IntelligenceReviewCard` is out of scope for the rev-7 refactor.
- [tests/c15h-unified-remediation-source-contract.test.ts](tests/c15h-unified-remediation-source-contract.test.ts) — updated tab-set + facet-pane pins to rev-7.
- [tests/c15l-ap-vendor-first-workflow-source-contract.test.ts](tests/c15l-ap-vendor-first-workflow-source-contract.test.ts) — retired the `.spectre-mc-item-surface:hover` hover-fill assertions (no surface to wash).
- [tests/c15o-two-step-vendor-and-ap-workflow-source-contract.test.ts](tests/c15o-two-step-vendor-and-ap-workflow-source-contract.test.ts) — `renderApCollapsedBody` receives `false` as the expanded compat arg (no more local `expanded` variable).
- [tests/e2e/phase-4r-rev7-card-tabs.staging.spec.ts](tests/e2e/phase-4r-rev7-card-tabs.staging.spec.ts) (NEW) — Playwright acceptance across all four screenshot scenarios.

Docs:
- [docs/phase-4r-ui-refinement-rev7-checkpoint.md](docs/phase-4r-ui-refinement-rev7-checkpoint.md) (this file)

## 8. Tests run and results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `npm run scan:placeholders` | Clean in touched files (only pre-existing prisma/schema.prisma + seed.ts hits) |
| `tests/work-intake-card-tab-model.test.ts` (NEW) | **19/19 pass** |
| Full regression across rev-2 → rev-7 pins (10 suites) | **291/291 pass** |
| Playwright rev-7 staging acceptance | **PASS** |

Playwright console evidence:
```
[setup] work intake cards visible = 8
[§4] card A tab = "attachments" · card B tab = "conversation"
```

The independent-per-card assertion confirmed by two different active tabs on two different cards after switching only card B.

The 2 pre-existing failures in `tests/c15l-ap-vendor-first-workflow-source-contract.test.ts` (`apSummaryCacheKey` signature pins for a helper that lives in a separate file) predate this change — confirmed via `git stash` A/B.

## 9. Staging deployment version / ID

- Web `spectre-staging` **v225 → v226** (`spectre-staging:deployment-01M042DRHPEQ8QYH029V0QRVPG`)
- Worker v114 (unchanged)

## 10. Rollback anchor

Web **v225** (`spectre-staging:deployment-01M03XKGDEXWARAZXPQK5FN1QG`)

Rollback:
```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M03XKGDEXWARAZXPQK5FN1QG
```
or `git revert b887385` on the branch.

## 11. Screenshot evidence

Saved under `test-results/phase-4r-rev7-card-tabs/after/`:

| File | Scenario |
|---|---|
| `01-spectre-summary.png` | Default state — `Spectre Summary | Conversation | Attachments` tab bar at the top; status pill + Club Support title + sender + Spectre narrative + 4-cell readout + recommendation + `Create vendor & post` / `Assign` / `Defer 24 hr` / `Invoice · PDF` actions. No Open/Collapse anywhere. |
| `02-conversation.png` | Conversation tab selected — card body is the conversation; the Spectre Summary body is absent above it. |
| `03-attachments.png` | Attachments tab selected (only captured when the card has ≥1 attachment) — attachment list + View PDF / Download actions; no summary above. |
| `04-independent-tabs.png` | Full feed — one card on `attachments`, another on `conversation`. |

## 12. Surrounding Mission Control shell unchanged

All prior Phase 4R behaviour intact on v226:

- Rev-2 sidebar SPECTRE / AUTOMATION eyebrow
- Rev-3 timezone-aware greeting + 12h AM/PM commitments
- Rev-4 canonical Spectre shell + global search + tenant-first header rail
- Rev-5 breadcrumb taxonomy + dynamic entity labels
- Rev-6 Feed Synced pill (integrated refresh icon + auto-refresh silence)
- MAIL-XXXX card id-tags stay `display: none`
- Right-hand Today's Position / Executive Insight / Today's Commitments rail unchanged
- Work Intake status counts unchanged

## 13. Unexpected findings

- **`IntelligenceReviewCard` is a separate card renderer** for orphaned `AP_INVOICE_REVIEW` / `VENDOR_STATEMENT_REVIEW` intakes (rendered only when a review intake has no parent email — the normal AP flow suppresses child review intakes via `loadChildReviewIntakesToSuppress` so the parent email's `EmailIntakeCard` carries the workflow). Rev-7 intentionally leaves `IntelligenceReviewCard` alone — it still uses its own Open/Collapse accordion. Migrating it would extend scope beyond the "Work Intake card" the founder brief targets. The c15i source-contract test was updated to scope the retired-model assertions to `EmailIntakeCard` only + documents this exception.
- The retired `ap-evidence` + `statement-evidence` API routes are **still active** and used by other consumers (CVAP modal fetches `ap-evidence` lazily; diagnostic Playwright specs like `microsoft-forensic-trace` continue to poll them). Only the card's proxying of those endpoints into tab bodies was retired.
- 8 Work Intake cards visible on staging Coulee Ridge — the acceptance spec could exercise the multi-card independence assertion on the real fleet.
