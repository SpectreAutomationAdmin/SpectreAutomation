# TB-HIST-12A — January Partial-Availability Matrix

**Status:** living document, updated per slice
**Context:** TB-HIST-12A directive — Monthly Board Reporting Package KPI-level availability

The May 2026 Monthly Board Reporting Package (reference) is used ONLY
as presentation + KPI + formula reference. **No Silver Springs numeric
value is used as Coulee data.** The purpose of this document is to
inventory every KPI from the May reference and classify each one's
January supportability against Coulee's authoritative sources.

---

## A. May 2026 reference — KPI inventory (reference only; no Coulee facts)

### Chapter I — Executive Opening

| Card | KPI | Formula |
|---|---|---|
| At A Glance | YTD Revenue | sum(IS revenue accounts) over period |
| At A Glance | NOI before Depreciation | Revenue − COGS − OpEx (excl. depreciation) |
| At A Glance | Capital Income YTD | sum(capital-income accounts) over period |
| At A Glance | Reserve Coverage | capital-reserve balance ÷ 3-yr avg capex |
| Operations | Revenue | sum(IS revenue) |
| Operations | NOI before Dep. | Revenue − COGS − OpEx (excl. depreciation) |
| Operations | Dues-to-Revenue | dues revenue ÷ total revenue |
| Financial Health | Working Capital | Current Assets − Current Liabilities |
| Financial Health | Reserve Coverage | reserve balance ÷ 3-yr avg capex |
| Financial Health | Current Ratio | Current Assets ÷ Current Liabilities |
| Financial Health | AR Current | AR Current bucket ÷ Total AR |
| Capital Program | Capex YTD | sum(capital-expenditure accounts) |
| Capital Program | Active Projects | count(open capital projects) |
| Capital Program | Reserve Funded % | reserve balance ÷ reserve target |
| Capital Program | Reserve Contributions | sum(capital-reserve contribution lines) |

### Chapter II — Financial Performance

| KPI | Formula |
|---|---|
| Revenue | sum(IS revenue) |
| Gross Margin | (Revenue − COGS) ÷ Revenue |
| Operating Expense | sum(IS operating-expense accounts) |
| NOI | Revenue − COGS − OpEx |
| Net Income | NOI − depreciation − interest − taxes (as applicable) |
| Capital Income | sum(capital-income accounts) |
| Department Net Performance | per-dept (revenue − cogs − opex) |
| Dues Subsidy / Allocation | opex allocated across dues coverage categories |

### Chapter III — Stewardship Dashboard

| KPI | Formula | Target source |
|---|---|---|
| Working Capital | CA − CL | policy floor |
| Current Ratio | CA ÷ CL | policy band |
| Dues-to-Revenue | dues ÷ revenue | policy band |
| Net-to-Gross PP&E | (PP&E − Accum Dep) ÷ PP&E | benchmark |
| Reserve Coverage | reserve ÷ 3-yr avg capex | policy |
| Debt-to-Equity | LTD ÷ Equity | policy |
| Equity Growth CAGR | multi-year equity series | benchmark |
| F&B Subsidy % of Dues | F&B operating loss ÷ dues | benchmark |

### Chapter V — Capital Fund

| KPI | Formula |
|---|---|
| Capital Fund Balance | sum(capital-reserve accounts) |
| Capital Income YTD | sum(capital-income IS accounts) |
| Capital Spending YTD | sum(capex / project draw accounts) |
| PP&E Gross | sum(BS capital asset accounts, non-accum-dep) |
| Accumulated Depreciation | sum(BS accum-dep accounts) |
| Net PP&E | Gross PP&E − Accum Dep |

### Chapter VI — Capital Projects

| KPI | Formula |
|---|---|
| Project Count | count(active capital projects) |
| On-Track Count | count(projects status=on-track) |
| Spend vs Budget per project | per-project (actual ÷ approved budget) |
| Deferred / Rescheduled | count/listing of flagged projects |

### Chapter VII — Financial Position (Statement of Financial Position)

| KPI | Formula |
|---|---|
| Total Assets | sum(ASSET accounts, natural balance) |
| Total Liabilities | sum(LIABILITY accounts, natural balance) |
| Members' Equity | Assets − Liabilities |
| Working Capital | CA − CL |
| Current Ratio | CA ÷ CL |
| Debt-to-Equity | LTD ÷ Equity |

### Chapter VIII — AR Aging

| KPI | Formula |
|---|---|
| Total AR | sum(all buckets per member row) |
| Current $ / % | current bucket, current ÷ total |
| 1-Month $, 2-Month $, 3-Month $, 4+ Month $ | per bucket |
| Non-current $ / % | 1+ aggregate ÷ total |
| Account count | distinct member rows |
| Non-current account count | count(rows where any non-current bucket > 0) |
| AR → GL reconciliation | subledger total vs. GL AR control account |

### Chapter IX — Operating Statistics

| KPI | Formula |
|---|---|
| Member rounds | count(golf-round records in period) |
| F&B covers | count(F&B check-records in period) |
| Labour ratio | payroll ÷ revenue (also appears in XII) |
| Service hours | sum(timeclock hours in period) |

### Chapter X — Departmental P&L

| KPI | Formula |
|---|---|
| Per-dept Revenue, COGS, OpEx, Net | sum by department, by classification |
| Budget per dept | from budget source |
| Variance vs Budget | actual − budget |

### Chapter XI — Weather & Utilization

Weather feed + utilization counts; outside the TB entirely.

### Chapter XII — Payroll Analysis

| KPI | Formula |
|---|---|
| Total YTD Payroll | sum(IS payroll accounts) |
| vs Budget / Prior Year | actual vs. budget / vs. prior-year payroll |
| Payroll Ratio | payroll ÷ revenue |
| Per-dept payroll | sum by department |

### Chapter XIII — F&B Statistics

F&B check / cover / revenue breakouts; outside the TB.

### Chapter XIV — Inventory Analysis

Inventory turnover / shrinkage; outside the TB.

---

## B. January supportability matrix (Coulee authoritative sources)

Each KPI is classified against Coulee's committed January 2026 Jonas
Trial Balance (Account=562, JournalEntry=0, 2 committed TB snapshots).

**Legend**
- **REAL** — exact value available from the Jonas TB
- **DERIVED** — computable from the Jonas TB via a documented formula
- **MANUAL** — requires a persisted manual input (not yet wired)
- **UNAVAILABLE** — source not loaded; renders "Unavailable", NOT $0

### Chapter I — Executive Opening

| KPI | Jan supportability | Source |
|---|---|---|
| YTD Revenue | **DERIVED** | sum(fsGroupKey ∈ IS_REVENUE_*) over Jan |
| NOI before Depreciation | **DERIVED** | Revenue − COGS − OpEx (excl. depreciation) |
| Capital Income YTD | **DERIVED** | sum(capital-income IS accounts) if classified |
| Reserve Coverage | **UNAVAILABLE** | needs 3-yr avg capex history |
| Dues-to-Revenue | **DERIVED** | DUES_AND_CHARGES revenue ÷ Total revenue |
| Working Capital | **DERIVED** | sum(categoryKey=CURRENT_ASSETS, natural) − sum(categoryKey=CURRENT_LIABILITIES, natural) |
| Current Ratio | **DERIVED** | CA ÷ CL |
| AR Current % | **UNAVAILABLE** | no AR aging dataset imported yet |
| Capex YTD | **DERIVED** | sum(capex IS accounts) if classified |
| Active Projects | **UNAVAILABLE** | no capital project tracker records |
| Reserve Funded % | **UNAVAILABLE** | reserve target not configured |
| Operations status (On Plan / Watch / Off Plan) | **UNAVAILABLE** | no budget source |
| Financial Health status (Strong Position / Stable / Watch / Concern) | **MANUAL** | no derived rule; could be manual |
| Capital Program status (Executing / Monitor / Delayed) | **UNAVAILABLE** | no project source |

### Chapter II — Financial Performance

| KPI | Jan | Notes |
|---|---|---|
| Revenue | **DERIVED** | from IS |
| COGS | **DERIVED** | from IS |
| Gross Margin | **DERIVED** | (Rev − COGS) ÷ Rev |
| OpEx | **DERIVED** | from IS |
| NOI | **DERIVED** | from IS |
| Capital Income | **DERIVED** | from IS if classified |
| Dept Net Performance | **DERIVED** | per-dept from TB-HIST-10 resolver |
| Dues Subsidy allocation | **UNAVAILABLE** | needs allocation ruleset |

### Chapter III — Stewardship Dashboard

| KPI | Jan | Notes |
|---|---|---|
| Working Capital | **DERIVED** | CA − CL |
| Current Ratio | **DERIVED** | CA ÷ CL |
| Dues-to-Revenue | **DERIVED** | from IS |
| Net-to-Gross PP&E | **DERIVED** | once PP&E / accum-dep COA accounts are classified |
| Reserve Coverage | **UNAVAILABLE** | needs 3-yr capex history |
| Debt-to-Equity | **DERIVED** | LTD ÷ Equity when LTD accounts classified |
| Equity Growth CAGR | **DERIVED** | from multi-year committed TB snapshots (2 snapshots → directional only, not CAGR) |
| F&B Subsidy | **DERIVED** | F&B dept net ÷ dues |

### Chapter V — Capital Fund

| KPI | Jan | Notes |
|---|---|---|
| Capital Fund Balance | **DERIVED** | from BS if reserve accounts classified |
| Capital Income YTD | **DERIVED** | from IS |
| Capital Spending YTD | **DERIVED** | from IS/BS capex accounts |
| PP&E Gross | **DERIVED** | from BS BS_CAPITAL_ASSETS |
| Accumulated Depreciation | **DERIVED** | from BS (currently rolled into BS_CAPITAL_ASSETS; needs sub-grouping) |
| Net PP&E | **DERIVED** | once accum-dep sub-group lands |

### Chapter VI — Capital Projects

Entire chapter: **UNAVAILABLE** — no capital project tracker rows for
Coulee. This is a separate data source from accounting.

### Chapter VII — Financial Position

All KPIs **DERIVED** from the Jan BS. Already rendering today (TB-HIST-9).

### Chapter VIII — AR Aging

| KPI | Jan | Notes |
|---|---|---|
| Total AR / Current $ / Aging buckets | **UNAVAILABLE** | AR aging source not imported |
| AR → GL reconciliation | **UNAVAILABLE until AR imported** | GL AR control = Jonas account 1100 natural balance (available now); subledger side needs import |
| Member names | **PRIVACY** — never load real names; synthetic staging identities only |

### Chapter IX — Operating Statistics

Entire chapter: **UNAVAILABLE** — needs rounds / covers / timeclock feeds.

### Chapter X — Departmental P&L

| KPI | Jan | Notes |
|---|---|---|
| 8-dept rows (Rev/COGS/OpEx/Net) | **DERIVED** | TB-HIST-10 resolver, 8 depts, isBalanced |
| Budget / Variance | **UNAVAILABLE** | no budget source |

### Chapter XI — Weather & Utilization

Entire chapter: **UNAVAILABLE** — external data feeds not connected.

### Chapter XII — Payroll Analysis

| KPI | Jan | Notes |
|---|---|---|
| Total YTD Payroll | **DERIVED** | sum(IS_PAYROLL fsGroupKey) over period |
| Payroll Ratio | **DERIVED** | payroll ÷ revenue |
| Per-dept payroll | **DERIVED** | from Jan TB payload (dimensional) |
| vs Budget / Prior Year | **UNAVAILABLE** | no budget; prior-year series needs Dec payroll snapshot classification |

### Chapter XIII — F&B Statistics

Entire chapter: **UNAVAILABLE** — needs POS / cover / check feeds.

### Chapter XIV — Inventory Analysis

Entire chapter: **UNAVAILABLE** — needs inventory tracking feeds.

---

## C. Operations card — before / after

### Before (TB-HIST-12)

```
OPERATIONS
Are we operating successfully?

Unavailable

Operations status is unavailable for this reporting period: no derived
or persisted manual operations status source has been wired for this
tenant. Required rounds, F&B covers, and service-hour feeds are not yet
connected.

Revenue:         Unavailable
NOI before dep.: Unavailable
Dues-to-Revenue: Unavailable  (Not derived)
```

Problem: Revenue / NOI / Dues-to-Revenue ARE derivable from the Jan TB
— but the card forced the entire tile to Unavailable.

### After (TB-HIST-12A)

```
OPERATIONS
Are we operating successfully?

Financial operating position
(no verdict label — needs budget / target source)

Revenue:         $<DERIVED from Jan IS>
NOI before dep.: $<DERIVED from Jan IS>
Dues-to-Revenue: <DERIVED from Jan IS>

Budget comparison: Unavailable
Actual financial data through January 31, 2026. Budget has not been loaded.
```

Each KPI renders on its own availability; only the budget-dependent
verdict ("On Plan" / "Watch" / "Off Plan") remains unavailable.

---

## D. Financial Health card — before / after

### Before (TB-HIST-12)

Everything Unavailable, including Working Capital and Current Ratio.

### After (TB-HIST-12A)

```
FINANCIAL HEALTH
Is the Club financially healthy?

Financial position
(no verdict label — needs policy / benchmark configuration)

Working Capital: $<CA − CL from Jan BS>
Current Ratio:   <CA ÷ CL from Jan BS>
Reserve Coverage: Unavailable (needs 3-yr capex history)
AR Current:       Unavailable (AR aging not yet imported)

Factual: Current assets exceed current liabilities by $X.
```

AR Current remaining unavailable does NOT suppress Working Capital.

---

## E. Capital Program card — before / after (DEFERRED to TB-HIST-12B)

Partial split (financial position vs project execution) is designed on
paper but not implemented in this slice — the Capital Program card
remains Unavailable on live tenants per TB-HIST-12. TB-HIST-12B will:

- Render Capex YTD + Capital Income YTD if IS classifications land
- Keep Active Projects / Reserve Funded % / Reserve Contributions marked
  Unavailable (no project tracker source)

Reason for deferral: Capital Fund IS classifications (`IS_CAPITAL_INCOME`
+ `IS_CAPEX`) are not yet first-class in Coulee's COA mapping. Delivering
them requires a resolver + COA audit that extends beyond this slice.

---

## F. Stewardship Dashboard — before / after (DEFERRED to TB-HIST-12B)

The full partial-availability rebuild of the Stewardship Dashboard
(Working Capital tile, Current Ratio tile, Dues-to-Revenue tile, etc. at
tile level, with policy targets explicitly "Not configured") is a
multi-component refactor touching ~8 scorecard primitives. Deferred to
TB-HIST-12B. The three Executive Opening cards deliver the top-of-page
partial-availability pattern in this slice.

---

## G. Chart partial-availability — DEFERRED to TB-HIST-12B

Shared chart primitives (`EditorialLineChart`, `EditorialBarChart`,
`EditorialDonut`) already accept series lists; adding an "actual-only"
mode where budget/prior-year series are explicitly omitted rather than
plotted-as-zero is a shared-primitive change that needs its own slice
with visual-parity regression against the Financial Performance
reference charts (`docs/monthly-reporting-chart-governance.md` §13).

---

## H. Factual narrative generator — DELIVERED

New helper `buildFactualNarrative(parts)` composes deterministic
factual statements (e.g. "Current assets exceed current liabilities by
$X.") from derived numerics. Avoids evaluative labels ("Strong
Position", "On Plan") unless a derived rule or manual source provides
them.

---

## I/J. AR importer architecture — DELIVERED (parser only, no DB)

See `src/lib/imports/ar-aging/parser.ts`:
- Zod schema matches founder's source columns (Member Code, Member
  Name, Net Amount, Current, 1 Mths, 2 Mths, 3 Mths, Over 4 Mths, Club,
  Club Description, Primary Club, Primary Club Description).
- Row-level reconciliation: `Net Amount == Current + 1 Mths + 2 Mths +
  3 Mths + Over 4 Mths` within $0.01 tolerance.
- Aggregate reconciliation: subledger totals vs. GL AR control (Jonas
  account 1100 natural balance for the same asOf).
- Returns `{ rows, totals, reconciliation }` — never mutates database.
- Member identity fields pass through verbatim; sanitization is the
  caller's responsibility (fixture / test code uses `CR-NNNN` / `Member
  NNNN`).

---

## K. Privacy controls — DELIVERED

- `.gitignore`: adds `tests/fixtures/ar-aging/*.real.*` and
  `tests/fixtures/ar-aging/sources/` — real-identity workbooks cannot
  be committed.
- Tests use SYNTHETIC fixture rows only (`CR-0001` / `Member 0001`
  etc.). Zero real names appear in repo / tests / logs / screenshots.
- The founder's actual AR workbook stays in their Downloads folder.
  Spectre never reads it, imports it, or copies it anywhere.

---

## L. Chapter I-XIV granular source matrix — See §B above.

---

## M-O. Tests + staging screenshots + accounting invariants

See `tests/tb-hist-12a-*.test.ts` + `tests/e2e/tb-hist-12a-*.staging.spec.ts`
and the §19 acceptance package returned at the end of the slice.

---

## P. DRH-1 release

Pushed to `staging-deploy/tb-hist-12a-partial-availability`. Deploy
confirmed via GitHub Actions + `/api/health` → 200.

**No February upload. No real AR workbook imported. Zero accounting
writes. December + January snapshots unchanged byte-for-byte.**
