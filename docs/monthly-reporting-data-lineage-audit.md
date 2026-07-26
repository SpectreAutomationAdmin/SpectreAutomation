# Monthly Board Reporting Package — Data Lineage Audit

**Status:** Pre-Jonas-import readiness assessment
**Audit date:** 2026-06-22
**Scope:** All 14 chapters of the Monthly Board Reporting Package (`/app/admin/reporting/monthly`)
**Purpose:** Determine, before importing real Silver Springs Jonas GL data, which charts / cards / tables / commentary will react to that import vs. which will continue to display seeded demo content (and may mislead the board).

This audit is **read-only** — no fixes are implemented here. The audit produces the remediation plan that follows in §5.

---

## 1. Executive Summary

### Items inventoried

| Bucket | Sections | Items audited |
|---|---|---|
| A | Executive Opening · Financial Performance · Stewardship Dashboard | 55 |
| B | Statement of Activities · Capital Fund · Capital Projects | 67 |
| C | Financial Position · AR Aging · Operating Statistics | 35 |
| D | Departmental P&L · Payroll Analysis | 24 |
| E | Weather & Utilization · F&B Statistics · Inventory Analysis | 44 |
| **Total** | **14 sections** | **~225 distinct items** |

### Classification headcount (rough)

| Class | Count | What it means | Reacts to Jonas import? |
|---|---:|---|---|
| **A — Live accounting-backed** | ~16 | Real `prisma` query on `FiscalPeriod` / `FiscalYear` | **YES** — directly |
| **B — Live operational-backed** | ~7 | Real `prisma` query on `MemberAccount` / `ClubProfile` | Indirect — already responding |
| **C — Demo-data service-backed** | ~135 | Goes through a reporting service that returns `dataSource: "demo"` | **NO until service body is rewritten** — but the React layer needs zero changes when it is |
| **D — Hardcoded in React or service literal** | ~45 | String / number / narrative literal inline | **NO — will display the same value forever, even after Jonas import** |
| **E — Derived but questionable** | ~22 | Computed, but inputs are seeded; OR commentary reactive on demo inputs | **PARTIAL** — math works, but inputs misleading |

### Headline finding

**The Monthly Reporting Package is currently ~90 % demo by item count.** The only fully Jonas-reactive surfaces today are the **Financial Performance chapter** (Operating Results 12-month chart + Equity Value Over Time chart + their KPIs + commentaries) and a small handful of scorecard rows that read from those two services. **Everything else — every other chapter — will display the same seeded Silver-Springs-flavoured numbers after Jonas import as it did before.**

### Biggest pre-import risks

1. **Cover-page At-a-Glance KPIs (7 tiles)** are hardcoded React literals. They are the **first** numbers a board member sees. After Jonas import they will still read `$14.62M YTD Revenue`, `$3.18M NOI`, `$2.04M Capital Income`, `1.42x Reserve Coverage`, `$4.71M Working Capital`, `78.4% AR Current`, plus a hardcoded executive headline narrative — none of which respond to real GL data. **HIGHEST RISK.**
2. **Stewardship Dashboard scorecards (16 rows total)** are 14/16 demo. Most ratios (Payroll & Benefits, Equity-to-Assets, Reserve %, Net PPE, Debt-to-Equity, Capital Income vs Budget) will display stale seed values with confident green/amber/red status indicators. **HIGH RISK** — drives board-level "are we on plan?" judgment.
3. **Statement of Activities (37 rows)** is 100 % seeded. Three items carry specific live-data hazards: Depreciation is a hardcoded negative literal; the Capital Dues "On Plan" chip is a literal label (not branch logic); the Golf member-rounds commentary cites a seeded 0.30 YoY figure.
4. **Statement of Financial Position (Balance Sheet, ~14 rows + 6 ratio bars)** is 100 % hardcoded literals. Every asset, liability, equity, and capital-coverage ratio is a demo constant.
5. **Capital Fund Reserve Adequacy** has two hardcoded items that carry a "risk" tone unconditionally (Deferred Capital Liability $3.08M and Net-to-Gross PPE 0.44). After Jonas import these will still flag risk even if the real GL paints a healthier picture.
6. **Reactive commentary on demo inputs (Stewardship Dashboard Notes; CFO Commentary on SOA; Capital Stress Test commentary).** The narrative *logic* is reactive — but it currently reads from seeded inputs. After Jonas, the commentary will auto-correct IF the underlying scorecard / row data is updated; if not, the commentary will reinforce the wrong signal with confident prose. **HIGH RISK because the commentary sounds authoritative.**

### Jonas-import readiness verdict — by section

| # | Section | Ready for Jonas import test? | Why |
|---|---|---|---|
| 1 | Executive Opening | ❌ No | 7 cover KPIs hardcoded React literals |
| 2 | Financial Performance (Operating Results + Equity) | ✅ **YES** | Fully `getOperatingResults()` + `getEquityHistory()` reactive; commentaries branch on numeric inputs |
| 3 | Stewardship Dashboard | ⚠️ Partial | 3 rows live (NOI variance, NOI %, Equity CAGR); 13 rows seeded; payroll/dues/department supplemental cards 100 % seeded; Notes commentary reactive but on seeded inputs |
| 4 | Statement of Activities | ⚠️ Partial | All 37 rows seeded; CFO commentary fully reactive; 3 items (depreciation, capital dues chip, golf rounds %) hardcoded literals |
| 5 | Capital Fund Statement | ❌ No | All 11 rows seeded; Reserve Adequacy card has 2 hardcoded "risk" tones; YTD Contribution checkmark always rendered |
| 6 | Capital Projects | ⚠️ Partial | All 6 projects seeded constants; exception report fully reactive; ready when capital-project tracking schema added |
| 7 | Financial Position (Balance Sheet) | ❌ No | All 14 asset/liability/equity rows + 6 ratio bars hardcoded literals |
| 8 | AR Aging | ⚠️ Partial | `prisma.memberAccount` plumbing exists in `monthly-package.ts` but AR aging service ignores it and returns demo constants; refactor straightforward |
| 9 | Operating Statistics | ❌ No | All 13 ops metrics seeded; Member Engagement can read from MemberAccount; Payroll % needs GL; Rounds/Covers/Visits need POS/PMS |
| 10 | Departmental P&L | ❌ No | 100 % hardcoded narrative + constants; needs GL department mapping |
| 11 | Payroll Analysis | ⚠️ Partial | All 6 chart/KPI items + 2 commentary blocks reactive in shape; needs payroll provider integration (not Jonas GL alone) |
| 12 | Weather & Utilization | N/A | Operational domain — Jonas GL doesn't apply; needs weather API + POS rounds feed |
| 13 | F&B Statistics | N/A | Operational domain — needs POS integration; Jonas GL alone won't change anything |
| 14 | Inventory Analysis | N/A | Operational domain — needs inventory subledger |

### What "ready" means

- ✅ **YES**: section already reads live data via `prisma`. Import Jonas → section updates immediately.
- ⚠️ **Partial**: shape is live-reactive but inputs are seeded. Replace seeds with `prisma` queries → React layer needs zero changes.
- ❌ **No**: section has hardcoded React literals or hardcoded service constants whose presence will lie to the board even after Jonas import. Requires code change.

---

## 2. Section-by-section audit table

The full per-item audit is summarised below. Counts use the agents' classifications; risk levels reflect "will this confidently display wrong information to the board after Jonas import?"

### 2.1 Executive Opening — `page.tsx` PackageHeader + cover

| Item | File | Type | Class | Source of truth | Jonas-reactive | Risk | Owner |
|---|---|---|---|---|---|---|---|
| YTD Revenue tile | `monthly-package.ts:L1630` | KPI | **D** | Literal `"$14.62M"` | No | **HIGH** | new `formatExecutiveSummaryKpis()` |
| NOI Before Depreciation tile | `monthly-package.ts:L1638` | KPI | **D** | Literal `"$3.18M"` | No | **HIGH** | `getOperatingResults()` |
| Capital Income tile | `monthly-package.ts:L1646` | KPI | **D** | Literal `"$2.04M"` | No | **HIGH** | new capital-income service |
| Reserve Coverage tile | `monthly-package.ts:L1654` | KPI | **D** | Literal `"1.42x"` | No | **HIGH** | new reserve-coverage service |
| Working Capital tile | `monthly-package.ts:L1662` | KPI | **D** | Literal `"$4.71M"` | No | **HIGH** | balance-sheet service |
| AR Current % tile | `monthly-package.ts:L1670` | KPI | **B** | Literal `"78.4%"` but tagged sourced from AR service | Partial | Medium | AR aging service (already prisma-backed) |
| Executive Summary headline | `monthly-package.ts:L1620` | Commentary | **D** | Literal narrative | No | **HIGH** | new `buildExecutiveSummaryNarrative()` |
| Club name / city / est-year | `monthly-package.ts:L1315` | Label | **A** | `prisma.club.findUnique` | Yes | Low | already live |
| Period labels | `reporting-period.ts:buildReportingPeriod` | Label | **A** | Computed from `periodEnd` | Yes | Low | already live |

**Section verdict:** 7 of 9 items hardcoded literals at the React/service boundary. After Jonas import the cover will continue to display the same numbers. **MUST FIX BEFORE JONAS IMPORT TESTING — these are the first numbers the board sees.**

### 2.2 Financial Performance — Operating Results & Equity Value

| Item | File | Type | Class | Source of truth | Jonas-reactive | Risk | Owner |
|---|---|---|---|---|---|---|---|
| Operating Results bar chart (12 actual + 12 budget + 12 PY) | `operating-results.ts:L106` | Chart | **A** | `prisma.fiscalPeriod.findMany` | **Yes** | Low | `getOperatingResults` |
| YTD NOI tile | `operating-results.ts` | KPI | **A** | computed | Yes | Low | `getOperatingResults` |
| NOI % of Revenue tile | `operating-results.ts` | KPI | **A** | computed | Yes | Low | `getOperatingResults` |
| Budget Goal tile | `operating-results.ts` | KPI | **A** | `budgetNoi` from FiscalPeriod | Yes | Low | `getOperatingResults` |
| Prior Year YTD tile | `operating-results.ts` | KPI | **A** | prior FY FiscalPeriod | Yes | Low | `getOperatingResults` |
| Operating Results commentary | `operating-commentary.ts:L120` | Commentary | **A** | branches on inputs (ytdNoi, budget, PY, corridor) | Yes | Low | `buildOperatingCommentary` |
| Equity Value chart (3 series) | `equity-history.ts:L141` | Chart | **A** | `prisma.fiscalYear.findMany` + live `balanceSheet()` | Yes | Low | `getEquityHistory` |
| Actual / Best / Min CAGR tiles | `equity-history.ts` | KPI | **A** | computed | Yes | Low | `getEquityHistory` |
| Current Equity tile | `equity-history.ts` | KPI | **A** | FY closingEquity or live balance | Yes | Low | `getEquityHistory` |
| Equity commentary | `equity-commentary.ts:L90` | Commentary | **A** | 4-branch CAGR classifier | Yes | Low | `buildEquityCommentary` |

**Section verdict:** **10/10 live accounting-backed.** This chapter is the reference for what every other chapter should become. **READY FOR JONAS IMPORT.**

### 2.3 Stewardship Dashboard (chair's KPI dashboard)

**Operating Scorecard (8 rows)**

| Row | Class | Notes |
|---|---|---|
| Dues-to-Revenue Ratio | **C** | seeded `SILVER_SPRINGS_OPERATING_INPUTS.duesRevenue` |
| Initiation Fee Operating Subsidy | **C** | seeded |
| Payroll & Benefits Ratio | **C** | seeded — **high impact**; will mislead board |
| **NOI Variance to Budget** | **A** | from `getOperatingResults` |
| **NOI as % of Operating Revenue** | **A** | from `getOperatingResults` |
| F&B Subsidy % of Dues | **C** | null placeholder |
| Golf Rounds vs Budget | **C** | seeded 6,483 vs 5,455 |
| F&B Covers vs Budget | **C** | seeded 24,207 vs 29,310 |

**Capital Scorecard (8 rows)**

| Row | Class | Notes |
|---|---|---|
| **Equity Growth CAGR** | **A** | from `getEquityHistory` |
| Equity-to-Assets Ratio | **C** | seeded balance-sheet |
| Capital Reserve % of Assets | **C** | seeded reserve balance |
| Net Available Capital Ratio | **C** | seeded |
| Net Capital > Depreciation | **C** | seeded YES — wrong if real numbers differ |
| Long-Term Debt-to-Equity | **C** | null placeholder |
| Net PPE to Gross PPE Ratio | **C** | seeded 31 % vs 40 % benchmark |
| Total Capital Income vs Budget | **C** | seeded $1.59M shortfall scenario |

**Supplemental cards (department performance, dues subsidy donut, payroll department, payroll ratio trend)**

| Card | Class | Notes |
|---|---|---|
| Department Net Performance table (9 depts) | **C** | `SILVER_SPRINGS_DEPARTMENT_INPUTS` constants |
| Department Net Performance commentary | **D** | `SILVER_SPRINGS_DEPARTMENT_COMMENTARY` constant |
| Dues Subsidy donut (15 slices) | **C** | `SILVER_SPRINGS_DUES_CATEGORIES` percentages hardcoded |
| Dues Summary "$10.38M / 253 / ~$41K" | **C/B** | dues seed + live member count |
| Payroll Department grouped bar chart | **C** | `SILVER_SPRINGS_PAYROLL_DEPTS` constants |
| Payroll dept 4 KPI tiles | **C** | computed from seeds (reactive shape) |
| Payroll dept Dues-Cover-Payroll PASS/FAIL | **C** | live boolean function — reactive once inputs change |
| Payroll dept "Dues Revenue Covers Payroll Check" commentary | **C** | fully computed, every number derives from inputs |
| Payroll Ratio Trend line chart (4 series × 12 months) | **C** | `SILVER_SPRINGS_PAYROLL_*_MONTHLY` arrays |
| Payroll Ratio Trend 4 KPI tiles | **C** | computed from seed series |
| Payroll Ratio Trend commentary | **C** | fully computed, reactive |

**Dashboard Notes (reactive commentary block under scorecard pair)**

| Item | Class | Notes |
|---|---|---|
| Operating panel paragraph | **E** | reactive on scorecard tones — but scorecard is mostly seeded |
| Capital panel paragraph | **E** | reactive on reserve coverage (live) + PPE ratio (seeded) |

**Section verdict:** 3 rows live, 13 rows seeded, all supplemental cards seeded. Dashboard Notes commentary is reactive in shape but reads from seeded inputs — will confidently narrate stale data. **HIGH RISK; PARTIAL READINESS.**

### 2.4 Statement of Activities (37 rows + CFO commentary)

| Block | Class | Notes |
|---|---|---|
| Operating section (revenue, COGS, payroll, OpEx; 17 rows) | **C** | seeded via `revRow()` / `expRow()` |
| Total Operating Revenue subtotal | **C/E** | derived from rows above (math sound) |
| **Depreciation row** | **D** | hardcoded `-1,050,000` YTD — must become depreciation schedule |
| NOI Before/After Depreciation | **C/E** | derived |
| Capital section (Capital Dues, Initiation Fees, Investment Income; 4 rows) | **C** | seeded |
| **Capital Dues "On Plan" chip** | **D** | literal label, not branch logic |
| Investment Income / Gain on Disposals | **C** | seeded |
| Interest Expense | **C** | seeded |
| Total Capital Fund Activity / Net Income Combined | **C/E** | derived |
| CFO Commentary bullet 1 (operating verdict) | **C** | fully reactive on `noiVariancePct` |
| **CFO Commentary bullet 2 (Golf rounds 30 % YoY)** | **E** | reactive *template*; input `0.30` seeded hardcoded |
| CFO Commentary bullet 3 (Capital funding) | **C** | reactive |
| CFO Commentary bullet 4 (Two-fund framing) | **D** | static narrative constant |

**Section verdict:** All 37 rows currently demo; 3 specific items (Depreciation, Capital Dues chip, Golf rounds %) will lie confidently even after Jonas import. CFO commentary is fully reactive and will narrate correctly once row values are live. **PARTIAL READINESS.**

### 2.5 Capital Fund Statement (Capital Fund Statement of Activities + Reserve Adequacy)

| Block | Class | Notes |
|---|---|---|
| 11 fund rows (sources, deployed, analysis) | **C** | seeded `row()` constants |
| **Reserve Coverage hero ratio (61 %)** | **C** | numerator = seeded reserve balance, denominator = seeded replacement cost — both need GL link |
| Reserve markers (0/30/60/75/100 %) | **D** | hardcoded policy labels (acceptable — policy thresholds) |
| Reserve Adequacy: balance, replacement cost, ratio | **C** | seeded |
| **Reserve Adequacy: Deferred Capital Liability $3.08M (risk tone)** | **D** | hardcoded literal carrying "risk" tone unconditionally |
| **Reserve Adequacy: Net-to-Gross PPE 0.44 (risk tone)** | **D** | hardcoded literal carrying "risk" tone unconditionally |
| **YTD Contribution checkmark (always shown)** | **D** | hardcoded; should branch on variance |
| Capital Stress Test commentary | **C** | fully reactive on 5 inputs |

**Section verdict:** 4 hardcoded items (Reserve Coverage GL link, Deferred Liability, PPE ratio, YTD checkmark) will confidently signal "risk" / "on plan" after Jonas import regardless of real data. **HIGH RISK; NOT READY.**

### 2.6 Capital Projects (Tracker table + Exception Report + Notes)

| Block | Class | Notes |
|---|---|---|
| 6 active project rows | **C** | seeded constants (HVAC, Kitchen, Golf Cart Fleet, Fitness Center, Terrace, Driving Range) |
| Locker Room Renovation (pending) | **D** | literal `2,800,000` authorized; "TBD" projected |
| Total Authorized subtotal | **C/E** | derived |
| Exception Report commentary | **C** | fully reactive (5 branches on overruns/at-risk/favourable/all-clear) |
| Project Notes (2 bullets) | **D** | hardcoded project name "Locker Room Renovation"; cross-refs to ReportingPeriod + SOA stmt number |

**Section verdict:** No GL link exists for capital projects (Jonas doesn't ship project-level detail). Section needs a capital-project tracking source. Exception report logic is solid and will work on live data. **LOW RISK — transparent demo, no false confidence.**

### 2.7 Financial Position (Statement of Financial Position / Balance Sheet)

| Block | Class | Notes |
|---|---|---|
| Cash, AR, Inventories, Prepaid, Reserve, Cap Projects (current assets) | **D** | every literal |
| Land, Buildings, Equipment, Course, Accum Depreciation (PPE) | **D** | every literal |
| Total Current Assets / Total Capital Fund / Net PPE / Total Assets | **E** | derived from above literals (math correct, inputs all demo) |
| AP, Accrued Payroll, Accrued Expenses, Deferred Dues, Current Maturities | **D** | every literal |
| Long-Term Debt, Deferred Initiation Fees | **D** | every literal |
| Operating Fund Balance, Capital Reserve Balance, YTD Net Income | **D** | every literal |
| 6 stewardship ratio bars (Working Capital, AR, Dues-to-Revenue, Reserve Coverage, Net-to-Gross PPE, Debt Service) | **D** | literal ratios and targets |
| Balance Sheet Notes (3 numbered paragraphs) | **D** | template-reactive but consumes all-literal inputs |

**Section verdict:** 100 % hardcoded literals. After Jonas import the balance sheet displays the same $40M demo asset base. **HIGHEST RISK SECTION; NOT READY.**

### 2.8 AR Aging

| Block | Class | Notes |
|---|---|---|
| AR by category (Dues, F&B, Golf, Amenities) × 4 aging buckets | **D** | seeded literals — though `prisma.memberAccount` data IS fetched at `monthly-package.ts:L1377` and could be used |
| 4 KPI cards (Total AR, Current %, 31-60, Over 90) | **D** | derived from seeded detail rows |
| Aging row status pills (all "Current") | **D** | hardcoded |
| Membership Activity table (New / Resign / Net / Active YTD) | **D** | could query MemberAccount but currently seeded |
| Collection Notes commentary (2 paragraphs) | **C** | reactive template on seeded inputs |

**Section verdict:** MemberAccount plumbing exists; this is the **easiest section to make live** — just have the AR aging service consume the already-fetched member accounts and bucket them. **PARTIAL READINESS — quick win available.**

### 2.9 Operating Statistics

| Block | Class | Notes |
|---|---|---|
| Golf Operations (5 metrics: Total Rounds, Member 18/9, Guest, Merch) | **D** | every literal — needs POS/tee-sheet |
| Food & Beverage (4 metrics: Total Covers, Avg Check Food/Bev, Banquet) | **D** | every literal — needs POS |
| Member Engagement (Active Count, Visits, Satisfaction, New/Resign YTD) | **D** | Active/New/Resign can use MemberAccount; Visits/Satisfaction need new source |
| Payroll & Labor (FTEs, Payroll %, Turnover) | **D** | needs payroll provider; Payroll % needs GL revenue |
| 13 stat rows with delta + tone | **E** | classification logic correct + reactive; inputs all seeded |
| Operating Focus + Capital Focus commentary cards | **D** | template-driven on seeded inputs |

**Section verdict:** 100 % demo. **HIGH RISK; NOT READY** — but staged remediation possible (member counts first, then payroll %, then operational integrations).

### 2.10 Departmental P&L

| Block | Class | Notes |
|---|---|---|
| Department Net Performance card (9 dept rows, variance tone, trend bar) | **C** | shape live-reactive on `SILVER_SPRINGS_DEPARTMENT_INPUTS`; swap inputs → all variances/bars/colors recompute |
| Department Net Performance commentary | **D** | static `SILVER_SPRINGS_DEPARTMENT_COMMENTARY` |
| 6 department summary cards (P&L Summary cards) | **D** | every row literal in `departmental-pl-summary.ts:L99-178` |
| Department pill headers ("+$22K YTD") | **D** | literal tone + label per card |
| Department Notes (arrow bullets) | **D** | literal text |
| "Management Document" header / notice | **D** | literal boilerplate |

**Section verdict:** Department Net Performance card is reactive-in-shape (replace constant → card updates); Departmental P&L Summary cards are 100 % literals. **HIGH RISK; NOT READY without GL department mapping.**

### 2.11 Payroll Analysis

| Block | Class | Notes |
|---|---|---|
| Payroll Department grouped bar chart (10 depts × 3 series) | **C** | reactive on seed array |
| 4 KPI tiles (Total YTD, vs Budget, vs PY, Payroll Ratio) | **C** | all computed from seeds (live-reactive shape) |
| Dues-Cover-Payroll PASS/FAIL decision | **C** | live boolean function |
| Dues-Cover-Payroll commentary body | **C** | fully computed, every bolded number derives from inputs |
| Payroll Ratio Trend line chart (4 series × 12 months) | **C** | reactive on seed arrays |
| Payroll Ratio Trend 4 KPI tiles | **C** | computed |
| Payroll Ratio Trend commentary | **C** | fully reactive (golf rounds YoY %, dues ratio, payroll delta) |
| Benchmark % KPI (57 %) | **D** | static config (policy threshold — acceptable) |

**Section verdict:** Entire section is reactive in shape; needs **payroll provider integration** (Jonas GL alone doesn't typically source payroll). Once payroll data lands, every item updates. **PARTIAL READINESS — payroll integration is the blocker, not the React layer.**

### 2.12 Weather & Utilization

| Block | Class | Notes |
|---|---|---|
| 4 weather KPIs (Sunny / Rain Days, Avg Temp, Avg Wind) | **C** | seeded observation |
| Weather Pattern donut (4 slices) | **C** | seeded |
| Weather vs Golf Rounds bar chart (4 conditions) | **C** | seeded; correlations computed |
| Rounds chart insight commentary | **C** | template with interpolated seed numbers |
| Notable Weather Events table | **C** | seeded events |
| Golf Rounds Correlation card | **C** | Pearson computed each run (correct math, demo inputs) |
| Racquet & Court Utilization card | **C** | modeled from playable days |
| Dining & F&B card narrative | **C** | template prose with computed lift % |

**Section verdict:** Operational domain — **Jonas GL has zero impact**. Needs external weather API + POS rounds feed. **N/A FOR JONAS READINESS** but flagged for board demo quality (Phase 3).

### 2.13 F&B Statistics

| Block | Class | Notes |
|---|---|---|
| Total F&B Revenue / Cost % / Covers / Margin YTD (4 KPIs) | **C** | `MONTHLY_BASELINE` array |
| Revenue per Server / Member Sat / Avg Check / Gratuities (4 KPIs) | **C** | computed from seeds; gratuity % hardcoded 17.5 |
| Monthly Revenue vs Cost grouped-bar chart | **C** | seeded |
| Revenue by Category donut | **C** | `CATEGORY_SHARES` static |
| Monthly Covers grouped-bar chart | **C** | seeded |
| Food Cost % line chart + budget line | **C** | budget target 38.4 hardcoded |
| Cover Counts / Food Cost callouts | **C** | template prose, logic correct on seeds |

**Section verdict:** Operational domain — POS integration required. Jonas GL won't update F&B revenue/cost/covers. **N/A FOR JONAS READINESS** (Phase 3).

### 2.14 Inventory Analysis

| Block | Class | Notes |
|---|---|---|
| Inventory Turns KPIs (Food / Liquor / Soft Goods) | **C** | `TURNOVER_BASELINE` |
| Avg Food Balance KPI | **C** | computed from `MONTHLY_BALANCE_BASELINE` |
| Turnover by Category grouped-bar chart | **C** | seeded |
| Monthly Balances multi-line chart | **C** | seeded |
| Turnover commentary callout | **C** | conditional sentences |
| **Inventory Action table — Liquor Low Volume** | **D** | hardcoded "may be sitting through multiple quarters" assertion |
| **Inventory Action table — Food Cost Audit** | **D** | hardcoded references to "37.8 % vs 38.4 % budget", "${month} spike to 40.3 %" — duplicates F&B data instead of sourcing it |
| **Inventory Action table — Beer Volume** | **D** | arbitrary "× 3" multiplier; "may not be justified by volume" assertion |
| **Inventory Action table — Soft Goods 46.7 % margin** | **D** | hardcoded performance claim "is strong" |
| Period-aware timeline labels | **C** | correctly period-aware |

**Section verdict:** Operational domain — needs inventory subledger. **N/A FOR JONAS READINESS**, but Inventory Action commentary contains several hardcoded assertions and references duplicated from F&B that should be cleaned up before any board demo (Phase 2).

---

## 3. Hardcoded items — prioritised list

Items that will **continue to lie to the board even after Jonas import** — sorted by board-visibility risk.

### Tier 1 — Cover-page / first-scroll (must fix first)

1. **7 At-a-Glance KPI tiles** on the Executive Opening cover (YTD Revenue, NOI, Capital Income, Reserve Coverage, Working Capital, AR Current, Executive Summary headline) — `monthly-package.ts:L1620–1670`
2. **Statement of Activities Depreciation row** hardcoded negative literal — `statement-of-activities.ts:L488–491`
3. **Statement of Activities "On Plan" Capital Dues chip** — `statement-of-activities.ts:L532` (literal label, not variance logic)
4. **CFO Commentary Golf rounds 30 % YoY input** — seeded `0.30` at `statement-of-activities.ts:L607` (commentary cites it confidently)

### Tier 2 — Stewardship Dashboard scorecards + Capital Fund Adequacy

5. **Capital Fund Reserve Adequacy — Deferred Capital Liability** literal `$3,080,000` + unconditional "risk" tone — `capital-fund-statement.ts:L319, L329`
6. **Capital Fund Reserve Adequacy — Net-to-Gross PPE** literal `0.44` + unconditional "risk" tone — `capital-fund-statement.ts:L320, L330`
7. **Capital Fund YTD Contribution checkmark** always rendered — `capital-fund-statement.ts:L335`
8. **`SILVER_SPRINGS_OPERATING_INPUTS` constant** (6 scorecard rows: dues/payroll/initiation/f&b subsidy/golf rounds/f&b covers) — `scorecard-metrics.ts:L509`
9. **`SILVER_SPRINGS_CAPITAL_INPUTS` constant** (7 scorecard rows: equity/assets/reserve/PPE/debt/capital income) — `scorecard-metrics.ts:L527`
10. **`SILVER_SPRINGS_DEPARTMENT_INPUTS` + `_COMMENTARY` constants** — `department-net-performance.ts:L106, L118`
11. **`SILVER_SPRINGS_DUES_CATEGORIES`** 15-slice donut allocation percentages — `dues-subsidy.ts:L160`

### Tier 3 — Statement of Financial Position (entire section)

12. **All 14 balance-sheet line items** — Cash, AR, Inventories, Prepaid, Reserve, Cap Projects, Land, Buildings, Equipment, Course, AP, Accrued Payroll, Long-Term Debt, Deferred Initiation Fees, Fund Balances — `statement-of-financial-position.ts:L179–290`
13. **6 stewardship ratio bars** on balance sheet — `statement-of-financial-position.ts:L363–376`
14. **Balance Sheet Notes 3 numbered paragraphs** — `statement-of-financial-position.ts:L458–464`

### Tier 4 — Departmental P&L Summary cards + AR Aging detail

15. **All 6 Departmental P&L Summary cards** (revenue / expense / contribution rows per dept) — `departmental-pl-summary.ts:L93–180`
16. **AR Aging 4-bucket × 4-category table values** (despite `prisma.memberAccount` plumbing existing) — `accounts-receivable-aging.ts:L186–204`
17. **AR Aging Membership Activity table** (New / Resign / Net / Active YTD) — `accounts-receivable-aging.ts:L289–344`

### Tier 5 — Operating Statistics (entire section)

18. **All 13 Operating Statistics literal values** (Golf, F&B, Member Engagement, Payroll) — `operating-statistics.ts:L260–330`
19. **Operating Focus + Capital Focus commentary cards** — `operating-statistics.ts:L433–497`

### Tier 6 — Inventory Action commentary (operational, but assertions)

20. **Inventory Action Liquor / Food Cost / Beer / Soft Goods narratives** with hardcoded percentages and "is strong" / "may not be justified" assertions — `inventory-analysis.ts:L284–339`

---

## 4. Jonas import readiness — section verdict

(See §1 table.) Summary:

- ✅ **READY (1 chapter)**: Financial Performance only
- ⚠️ **PARTIAL (6 chapters)**: Stewardship Dashboard, Statement of Activities, Capital Projects, AR Aging, Payroll Analysis — shape reactive, inputs seeded
- ❌ **NOT READY (5 chapters)**: Executive Opening, Capital Fund Statement, Financial Position, Operating Statistics, Departmental P&L — hardcoded items will mislead the board
- 🔀 **N/A for Jonas (3 chapters)**: Weather, F&B Statistics, Inventory Analysis — operational data outside GL

**Bottom line for Jonas import test:** the Operating Results chart and the Equity Value chart will update. Almost everything else will continue to display Silver-Springs-flavoured seeded numbers, in some cases with confident-sounding commentary built on top of them.

---

## 5. Required remediation plan

### Phase 1 — MUST fix before Jonas import testing

Goal: ensure no part of the report displays a hardcoded number as if it were live GL data.

**1.1 Cover-page At-a-Glance KPIs (7 tiles)** — create `formatExecutiveSummaryKpis()` reading from `getOperatingResults()`, `getEquityHistory()`, `buildSilverSpringsAccountsReceivableAging()`, and new `getReserveCoverage()` / `getWorkingCapital()` services. Replace all 7 literal strings in `monthly-package.ts:L1620–1670`.

**1.2 Replace `SILVER_SPRINGS_OPERATING_INPUTS`** with a service that reads operating revenue, dues revenue, payroll & benefits, initiation-fee posting, F&B subsidy, golf-rounds, F&B-covers from real GL classes (`scorecard-metrics.ts:L509`).

**1.3 Replace `SILVER_SPRINGS_CAPITAL_INPUTS`** with a service that reads equity, total assets, capital reserve balance, depreciation, net & gross PPE, long-term debt, capital income from real GL accounts (`scorecard-metrics.ts:L527`).

**1.4 Statement of Activities Depreciation row** — read from Fixed Assets GL + depreciation schedule; remove `currentBudget: -350_000` / `ytdBudget: -1_050_000` literals (`statement-of-activities.ts:L488`).

**1.5 Statement of Activities Capital Dues "On Plan" chip** — convert literal to branch on `variancePct` like the CFO commentary already does (`statement-of-activities.ts:L532`).

**1.6 Capital Fund Reserve Adequacy** — replace literal Deferred Capital Liability + Net-to-Gross PPE values with computed values from Capital Projects unfunded items + balance sheet GL; tones must branch on policy thresholds (`capital-fund-statement.ts:L329, L330`). Replace YTD Contribution checkmark literal with variance branch (`L335`).

**1.7 Statement of Financial Position** — entire service rewrite. Every asset/liability/equity row must come from `prisma.journalEntry` filtered by GL account and fund. 6 stewardship ratios must compute from those values.

**1.8 Period labels audit** — confirm every label uses `period.*` (already mostly done per the Reporting Period Golden Rule — but verify no "Mar 2026" / "Q1" / hardcoded date strings remain in any section).

**1.9 Cover-page Executive Summary headline narrative** — author a `buildExecutiveSummaryNarrative()` generator that reads operating + capital + cash inputs and branches on outcome, replacing the literal at `monthly-package.ts:L1620`.

### Phase 2 — Should fix before board-demo quality

**2.1 AR Aging service rewrite** — consume the already-fetched `prisma.memberAccount` data (currently fetched at `monthly-package.ts:L1377`, then ignored). Aggregate by charge category, bucket by days-overdue, count membership activity YTD. Replace status pills (currently always "Current") with logic based on real account status flags.

**2.2 Operating Statistics — staged remediation:**
- Member Engagement (Active Count, New YTD, Resign YTD) → from `prisma.memberAccount`
- Payroll % → from Jonas GL (Payroll Expense / Operating Revenue)
- Other metrics flagged for Phase 3 (need POS / tee sheet / PMS)

**2.3 Departmental P&L Summary cards** — author `buildDepartmentalPLSummaryLive()` that queries GL lines grouped by department GL code; remove the literal 6 cards.

**2.4 Department Net Performance** — replace `SILVER_SPRINGS_DEPARTMENT_INPUTS` constant with prisma query against department-classified GL lines (shape is already reactive).

**2.5 Dues Subsidy donut** — map Jonas chart of accounts to the 15 category buckets; parameterise the allocation logic so the slices are computed from real GL allocations rather than hardcoded percentages.

**2.6 Capital Projects** — wire the 6 active project rows + Locker Room pending row to a capital-project tracking source (project-accounting or a new Spectre `CapitalProject` table).

**2.7 Dashboard Notes commentary** — verify Phase 1.2 / 1.3 work has flowed through so scorecard tones are now live; commentary will auto-correct.

**2.8 Inventory Action commentary cleanup** — remove hardcoded percentage references (37.8 %, 40.3 %, 46.7 %, "is strong", arbitrary "× 3" multiplier). Either source from F&B service or remove the assertions until inventory subledger is live.

### Phase 3 — Longer-term operational integration

**3.1 POS integration** — F&B revenue/cost/covers/category mix/gratuities (Lightspeed, Toast, or whatever the club uses).

**3.2 Tee-sheet / golf POS integration** — rounds played, member vs guest, merch revenue, member rounds YoY (the figure the CFO commentary depends on).

**3.3 Inventory subledger** — turnover, balances, variance alerts.

**3.4 Weather API** — replace `fetchObservation()` seeded provider with OpenMeteo or equivalent.

**3.5 PMS / survey integration** — member visits, satisfaction scores.

**3.6 Payroll provider integration** — replace seeded payroll arrays with payroll-provider API or GL payroll-cost reads.

---

## 6. Recommended reporting-service contracts

New services needed (or significantly extended):

| Service | Backs |
|---|---|
| `formatExecutiveSummaryKpis()` | Cover-page 7 KPIs + headline narrative |
| `getReserveCoverage()` | Capital Reserve % of Assets, Reserve Coverage Ratio, Reserve Adequacy card |
| `getWorkingCapital()` | Working Capital tile, Working Capital Ratio bar |
| `getDeferredCapitalLiability()` | Reserve Adequacy "Deferred Capital Liability" — reads Capital Projects unfunded items |
| `getNetToGrossPPE()` | Reserve Adequacy + Net-PPE-to-Gross-PPE scorecard row |
| `getDepartmentalGLAggregates()` | Department Net Performance + Departmental P&L Summary + Dues Subsidy allocation + Statement of Activities (Operating section by department) |
| `getBalanceSheet()` | Statement of Financial Position (all rows + stewardship ratios) |
| `getOperatingStatisticsLive()` | Operating Statistics (Member Engagement from MemberAccount; Payroll % from GL; others Phase 3) |
| `getARAgingLive()` (refactor of existing) | AR Aging (replace seeded categories/buckets with prisma aggregation on MemberAccount) |
| `getCapitalProjectsLive()` | Capital Projects tracker (needs new `CapitalProject` table) |
| `getDepreciationSchedule()` | Statement of Activities Depreciation row |
| `getMemberRoundsYoy()` | CFO Commentary Bullet 2 input |
| `getPayrollByDepartment()` | Payroll Department card (likely from payroll provider, not Jonas) |

Existing services that already work (do not touch):

| Service | Backs |
|---|---|
| `getOperatingResults()` | Operating Results chart + 4 KPI tiles + commentary |
| `getEquityHistory()` | Equity Value chart + 4 KPI tiles + commentary |
| `buildOperatingCommentary()` | Operating Results commentary (reactive) |
| `buildEquityCommentary()` | Equity Value commentary (reactive) |
| `buildReportingPeriod()` | All period labels |
| `prisma.club / clubProfile` reads | Club name, branding, city/province/year |

---

## 7. Jonas import responsiveness test plan

Tests to run after importing Silver Springs Jonas data. Each test must pass before the package is signed off as live.

### 7.1 GL actuals responsiveness

- **T1.1** Change a `FiscalPeriod.actualRevenue` / `actualNoi` value → confirm Operating Results chart and YTD NOI tile update.
- **T1.2** Change a month's actual NOI by enough to cross the break-even corridor → confirm Operating Results commentary text branches (e.g. "above corridor" → "below corridor") and tone flips.

### 7.2 Budget data responsiveness

- **T2.1** Change `FiscalPeriod.budgetNoi` for a month → confirm Budget Goal tile updates and chart budget bars resize.
- **T2.2** Change Capital Dues budget vs actual ratio → confirm "On Plan" chip flips to "Behind Plan" once branch logic is implemented (Phase 1.5).

### 7.3 Prior-year responsiveness

- **T3.1** Add prior-fiscal-year FiscalPeriod rows → confirm Prior Year YTD tile updates and overlay line redraws on Operating Results.
- **T3.2** Add prior-fiscal-year FiscalYear closingEquity → confirm Equity chart Actual line extends backward + Actual CAGR tile recomputes.

### 7.4 AR aging responsiveness

- **T4.1** Add a `MemberAccount` row with `pastDueDays > 90` → confirm Over-90 KPI tile and Over-90 bucket on AR table update.
- **T4.2** Change a category's outstanding balance → confirm AR-by-category row updates and Collection Notes commentary text reflects new totals.

### 7.5 Payroll responsiveness (post-payroll-integration)

- **T5.1** Change a department's actual payroll → confirm Payroll Department chart bar height + Total YTD KPI + Dues-Cover-Payroll PASS/FAIL update.
- **T5.2** Change a month's actual payroll ratio → confirm Payroll Ratio Trend line point + YTD Ratio KPI + commentary update.

### 7.6 F&B responsiveness (post-POS-integration)

- **T6.1** Change a month's F&B revenue → confirm Monthly Revenue vs Cost chart bar height + Total F&B Revenue KPI + Food Cost % line chart points update.
- **T6.2** Change category revenue mix → confirm donut slice arcs and amount labels update.

### 7.7 Commentary reactivity

- **T7.1** Force a favourable → unfavourable variance flip on Operating NOI → confirm CFO Commentary bullet 1 changes branch.
- **T7.2** Force a capital project to exceed budget → confirm Capital Project Exception Report swaps from "all clear" to "overrun" branch.
- **T7.3** Force Reserve Coverage to fall below 60 % floor → confirm Capital Stress Test commentary and Reserve Coverage card both flag risk.

### 7.8 No-demo-residue check

- **T8.1** With all live data populated, grep the rendered HTML for `$14.62M` / `$3.18M` / `1.42x` / `78.4%` / other cover-page seed literals — none should remain.
- **T8.2** With all live data populated, confirm no scorecard row carries `dataSource: "demo"`.
- **T8.3** With all live data populated, confirm Department Net Performance, Dues Subsidy donut, Capital Fund rows all carry `dataSource: "live"`.

---

## Companion documents

- [CLAUDE.md](../CLAUDE.md) — Financial Reporting Data Integrity rule + Reactive Commentary rule (the policy this audit measures against)
- [docs/equity-value-over-time-card-spec.md](equity-value-over-time-card-spec.md) — locked baseline (Equity card is the gold-standard live reference)
- [docs/spectre-framework.md](spectre-framework.md) — five-pillar framework (every reporting surface answers these four questions)
- [docs/monthly-reporting-chart-governance.md](monthly-reporting-chart-governance.md) — chart system rules (axis typography, plot utilization, etc.)
