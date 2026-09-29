# DIM-1 · Legacy `Account.fundApplicability` — compatibility status

**Effective 2026-09-29.** DIM-1 introduces `Fund` + `AccountFund` as
the authoritative per-club Fund model. The pre-existing
`Account.fundApplicability` CSV column is retained temporarily so
DIM-1 does not have to touch every consumer in the same slice.

New code MUST prefer the authoritative surfaces:

- **applicability set** — `AccountFund` M2M (`account.funds` relation)
- **posted attribution** — `JournalEntryLine.fundId` /
  `APInvoiceLine.fundId` / `BudgetLine.fundId` / `ForecastLine.fundId`

`Account.fundApplicability` is legacy: read-only for new code,
never a source of truth going forward.

## Remaining consumers (29 files as of 2026-09-29)

Grouped by DIM-2 retirement lane:

### Lane A · Reporting / classification (10 files) — read-side, retire by re-pointing at AccountFund

- `src/lib/accounting/balance.ts` — surfaces `fundApplicability` on `AccountBalance`
- `src/lib/accounting/reporting-balances.ts`
- `src/lib/reporting/ledger/live-synthesis.ts`
- `src/lib/reporting/ledger/classification-resolver.ts`
- `src/lib/reporting/ledger/contracts.ts`
- `src/lib/reporting/ledger/projections/income-statement-mapping.ts`
- `src/lib/reporting/ledger/projections/income-statement-projection.ts`
- `src/lib/reporting/ledger/importers/jonas-gl-mapping.ts`
- `src/lib/accounting/coa.ts`
- `src/lib/imports/tb-map-accounts.ts`

**DIM-2 plan:** each of these should read `account.funds`
(AccountFund rows) and derive the applicability set from FK truth,
not CSV parse. Line-level `fundId` should feed reporting filters
directly.

### Lane B · Predictor / importer (7 files) — write-side, retire by writing AccountFund at commit time

- `src/lib/imports/coa-predictor.ts` — predicts `fundApplicability` per row
- `src/app/app/admin/imports/_actions.ts`
- `src/app/app/admin/imports/[id]/map-accounts/page.tsx`
- `src/app/app/admin/imports/[id]/map-accounts/MapAccountsForm.tsx`
- `src/app/app/admin/coa/page.tsx`
- `src/app/app/admin/coa/new/page.tsx`
- `src/app/api/admin/coa/export.csv/route.ts`
- `src/app/app/admin/coa/_actions.ts`

**DIM-2 plan:** the COA importer commit path (`src/lib/imports/index.ts`
account.upsert) additionally writes `AccountFund` rows keyed by the
predictor's fund tokens. The predictor's output shape is unchanged; the
persistence layer normalises the CSV into FK rows.

### Lane C · AP Intelligence / GL Recommend (4 files) — read fund applicability during suggestion

- `src/lib/ap-intelligence/analyse.ts`
- `src/lib/ap-intelligence/gl-recommend.ts`
- `src/lib/ap-intelligence/nature-scoped-ranker.ts`
- `src/components/mission-control/IntelligenceReviewCard.tsx`
- `src/app/app/admin/ap/_post-ap-invoice-actions.ts`

**DIM-2 plan:** GL recommender + AP predictor consume `account.funds`
instead of parsing the CSV. AP invoice creation also proposes a
`fundId` on each line via the same predictor, subject to the
`AccountFund` applicability set.

### Lane D · Eligibility / Structural (2 files) — legacy, safe to leave until DIM-3

- `src/lib/accounting/eligibility/rules-structural.ts`
- `src/lib/accounting/eligibility/types.ts`

**DIM-2 plan:** none; these read the CSV for classification but do
not persist. Retire in DIM-3 when eligibility surfaces are
next-touched.

### Lane E · Backfill / bulk-set (3 files) — writers, retire together

- `src/lib/accounting/backfill-fund-applicability.ts`
- `src/lib/accounting/bulk-fund-applicability.ts`
- `src/lib/accounting/fund-applicability.ts` (helper module)

**DIM-2 plan:** replace with `AccountFund` upsert helpers. The
helper module `fund-applicability.ts` gains a dual-surface: writes
both the CSV (legacy) and the AccountFund rows (authoritative)
until DIM-3 flips the read-side over.

### Lane F · UI (1 file) — cosmetic display of the CSV in COA workspace

- `src/components/data-workspace/ChartOfAccountsClient.tsx`

**DIM-2 plan:** switch to showing the `AccountFund`-derived
applicability list.

## Retirement path

1. **DIM-2** — `Fund` + `AccountFund` become authoritative:
   - COA importer writes AccountFund rows during commit
   - `fund-applicability.ts` gains dual-write helpers
   - Reporting engine reads AccountFund instead of CSV
   - AP intelligence + GL recommender re-pointed
   - Legacy `Account.fundApplicability` still populated via
     dual-write for read-side compatibility

2. **DIM-3** — legacy retirement:
   - Reporting reads exclusively from AccountFund + JournalEntryLine.fundId
   - Legacy CSV writers are removed
   - `Account.fundApplicability` column becomes read-only / marked
     `@deprecated` in the Prisma schema comments
   - A follow-up migration removes the column entirely once no
     consumer references it

## New-feature rule (in force from DIM-1)

Any new reporting output, importer, predictor, or posting pipeline
introduced from DIM-1 onward **MUST NOT** read
`Account.fundApplicability`. It MUST read the authoritative
surfaces:

- `Fund` + `AccountFund` (per-club applicability set)
- `*.fundId` on `JournalEntryLine` / `APInvoiceLine` / `BudgetLine` / `ForecastLine`

The CSV column remains for compatibility with the 29 pre-existing
consumers listed above, not as new-code architecture.
