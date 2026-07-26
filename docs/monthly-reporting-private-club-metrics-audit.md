# Monthly Reporting Package — Private-Club Metrics Gap Audit

**Date:** 2026-06-04
**Scope:** `/app/admin/reporting/monthly` — the Monthly Board Reporting Package
**Method:** Compared the rendered + structured KPI surfaces in
[`src/lib/reporting/monthly-package.ts`](../src/lib/reporting/monthly-package.ts)
and [`src/app/app/admin/reporting/monthly/page.tsx`](../src/app/app/admin/reporting/monthly/page.tsx)
against the metric vocabulary of a CMAA / NCA-tier private-club Finance
Committee package.
**Read-only:** No code was modified. This document delivers
prioritised recommendations only.

**Framework anchor.** Each priority area maps to a stewardship pillar
from [`docs/spectre-framework.md`](spectre-framework.md):

| Area | Pillar |
|---|---|
| Membership | Pillar 4 — Membership Stewardship |
| Golf | Pillar 5 — Experience Stewardship (operating-line P&L lives in Pillar 1) |
| Hospitality | Pillar 5 — Experience Stewardship + Pillar 1 — Operating Stewardship |
| Capital | Pillar 2 — Capital Stewardship |
| Collections | Pillar 1 — Operating Stewardship + Pillar 4 — Membership Stewardship |

The four-questions test from the Framework is the bar for every
recommended metric: *what happened / why does it matter / is the trend
improving or deteriorating / does the Board need to act?* A metric that
cannot answer all four does not earn page space.

**Reading guide.** Within each section:
- **Present** — what the page renders today
- **Gap** — what a Finance Committee would expect that is absent
- **Recommendations** — ranked P0 (must add), P1 (should add), P2 (nice to have)

---

## 1. Membership — Pillar 4

The single most under-served area on the page today. The package treats
membership as a population count and a waitlist depth; a private-club
board treats it as an equity-bearing constituency with a tenure curve, a
category mix, and an attrition pattern that drives 60–70% of revenue.

### Present
- Active members (1,284)
- New members YTD (36)
- Resignations YTD (11)
- Net change YTD (+25)
- Waitlist depth (47)
- Waitlist conversion % (38%)
- Dues-to-revenue ratio (operating KPI)
- Initiation Fee Operating Subsidy (operating KPI)

### Gap

The page does not answer the four questions a Finance Committee asks
every meeting about membership:

1. **Who is leaving and why?** No attrition rate, no
   trailing-12-month resignation pace, no resignation reason mix
   (relocation / financial / dissatisfaction / passing).
2. **What is the membership made of?** No category breakdown
   (Full Golf, Social, Junior, Senior, Non-Resident, Corporate,
   Honorary). The mix shift is the single largest forward indicator
   of dues revenue — a Full → Social drift erodes dues without
   showing up in the headline count.
3. **How long do members stay?** No average tenure, no tenure
   distribution (under-3-year / 3-10 / 10-25 / 25+). Tenure is the
   asset that produces both lifetime value and governance stability.
4. **Is the equity pool intact?** No equity-bond outstanding count,
   no refund queue for resigned members, no transfer-fee yield per
   transfer.
5. **Are members engaged?** No member-engagement rate (% of active
   members using a facility in the period) — a club with high counts
   and low engagement is one bad quarter away from a resignation
   cliff.

### Recommendations

**P0 — Membership Category Mix (4 columns + total).** Render category
counts, dues rate per category, and YTD net change per category. Without
this, the Board cannot see Full → Social migration, which is the single
largest hidden risk to dues. Maps to Pillar 4. Cite category authority
(bylaws) in the supporting note.

**P0 — Rolling-12-Month Attrition Rate.** A single KPI tile:
`resignations TTM / average active TTM`. Industry benchmark is 4–6%.
Above 7% is the threshold where the Finance Committee should request a
membership-experience review.

**P0 — Net Member Equity per Active Member.** `Total member equity / active members`. The Board needs to know whether the equity-per-seat is
holding, growing, or eroding — this is the headline metric for a
member-owned club's balance sheet narrative.

**P1 — Resignation Reason Mix.** Stacked breakdown of resignations YTD
by reason code (relocation / financial / dissatisfaction / health /
passing / unknown). The "unknown" share is itself a governance signal —
above 25% means the exit-interview discipline is not being kept.

**P1 — Average Member Tenure + Distribution.** A single tile showing
the median (or mean) tenure in years plus a 4-band distribution. Tenure
is the long-run health indicator of the membership franchise.

**P1 — Waitlist Aging.** The page shows depth (47) and conversion
(38%) but not how long names sit on the list. A 47-deep list where 30
names have sat 24+ months is structurally different from a 47-deep list
that turned over in 6 months.

**P1 — Member Engagement Rate.** % of active members who used at least
one facility (golf, F&B, fitness, event) in the period. Below 60%
sustained is the early signal of resignation risk.

**P2 — Dues Yield per Active Member.** `Total dues collected / active members`. Useful for benchmarking against peer clubs (CMAA Compensation
& Benefits Report carries the medians).

**P2 — Equity-Bond Refund Queue.** For clubs with refundable equity
bonds, the count and dollar value of refunds owed to resigned members
on the waitlist clearance queue. Reads as a soft liability and warrants
a footnote when material.

---

## 2. Golf — Pillar 5 (Experience) + Pillar 1 (Operating)

The package treats golf as rounds + utilization + spend per round.
Three useful tiles, but they miss the texture a Green Committee or Golf
Committee uses to govern the asset.

### Present
- Rounds YTD vs budget (+6.0%)
- Guest rounds YTD + guest share % (21.8%)
- Course utilization % (74.1%)
- Range utilization % (82.4%)
- Days lost YTD to weather (11)
- Spend per round (derived)

### Gap

A private-club Golf Committee — and the Board that approves the
agronomy capital plan — looks for:

1. **Member rounds per active member.** The activity-per-seat metric.
   Currently the page shows rounds total but not member rounds vs guest
   rounds split clearly. A drop in member rounds per active member is
   the leading indicator of disengagement.
2. **Tee-time fill rate at peak times.** Saturday 7–11am and Sunday
   7–11am fill rate is the structural demand signal. Below 90%
   sustained is the threshold for assessment review.
3. **Guest cap utilisation.** Clubs with guest-day or guest-fee caps
   need to see how close they are to policy.
4. **Course-condition score.** Member-rated agronomy quality is the
   leading indicator of capital-spend justification.
5. **Handicap-active members.** A leading indicator of golf engagement
   distinct from rounds count — a member who maintained a posting
   handicap is qualitatively more engaged than one who played the same
   number of rounds without posting.
6. **Lessons taught + lesson revenue.** The pro shop's professional
   services line is its own contribution centre.
7. **Pace of play.** The single most-complained-about operational
   variable on a private course; the Board sees the complaint volume
   but not the underlying minutes-per-round trend.
8. **Cart fee + range revenue per round.** These attach rates inform
   the equipment-replacement capital plan.

### Recommendations

**P0 — Member Rounds per Active Member (YTD + TTM).** Compute
`member rounds / active members` to surface activity-per-seat.
Pair with the existing total. Maps to Pillar 5 Experience Stewardship.

**P0 — Saturday Peak Fill Rate.** A single tile showing peak-window
tee-time fill % over the trailing 8 Saturdays + comparison to the
trailing 8 Saturdays a year ago. This is the canonical demand metric.

**P1 — Guest Cap Utilisation.** If the club has a per-member guest
cap or a guest-day cap, render utilisation vs policy. Below 50% means
the cap is structurally too generous; above 90% means policy review is
imminent.

**P1 — Course-Condition Score (Member Survey).** A 1–5 rolling-90-day
score on greens, fairways, bunkers, tees. The capital plan defence
runs through this number; without it, the agronomy investment case is
anecdotal.

**P1 — Handicap-Active Members.** Count of members with a posted score
in the trailing 60 days. Pair as ratio over active members. Below 45%
is the threshold for golf-engagement concern.

**P1 — Pace-of-Play Average (minutes per 18, foursome).** Operating
KPI from the starter's log. Above 4:30 is the threshold for course
operations review.

**P2 — Lessons Taught + Lesson Revenue YTD.** Pro shop professional
services contribution line — currently invisible.

**P2 — Cart Fee Revenue per Round.** Attach-rate metric used in the
cart-fleet replacement capital case.

**P2 — Range Balls Dispensed per Round.** Attach-rate metric used in
the range-equipment capital case.

---

## 3. Hospitality (F&B) — Pillar 5 + Pillar 1

The strongest section today on raw metric count (subsidy, covers,
average check, sales by outlet, labor %, food cost %, beverage cost %,
survey) but the most ambiguously framed: the metrics describe a
restaurant, not a private club's dining program.

### Present
- F&B revenue YTD ($2.01M)
- Covers YTD (44,180)
- Average check ($38.20, +4.1% YoY)
- Sales by outlet (4 outlets)
- Labor % (44.2%)
- Food cost % (32.6%)
- Beverage cost % (24.8%)
- Survey score (4.6/5.0)
- F&B subsidy ($312K, 5.1% of dues)
- 12-month subsidy trend

### Gap

A private-club House Committee asks five questions a restaurant board
does not:

1. **What share of the membership is dining?** A club that serves
   100,000 covers a year to 30% of its members is structurally
   different from one serving 100,000 covers to 80% of its members.
   This is the dining-participation rate — the single most important
   private-club F&B metric and it is not on the page.
2. **What's the member-vs-guest cover split?** Restaurants want every
   cover; private clubs want member covers. A drift toward guest
   covers without an event-program reason is a governance signal.
3. **What's the forward banquet/private event pipeline?** Event
   revenue is contractual months ahead. The current page shows YTD
   events revenue but no forward-booked figure.
4. **Are members hitting their dining minimums?** Clubs with
   minimums need a minimum-compliance rate and a "shortfall billed"
   line. A 15% non-compliance rate is operational; a 30% rate is a
   member-experience problem.
5. **Halfway-house attach to rounds.** The on-course F&B revenue per
   round is a private-club operating line that has no analogue in a
   standalone restaurant.

### Recommendations

**P0 — Dining Participation Rate.** % of active members with at least
one F&B charge in the period. The single most important private-club
hospitality metric and currently absent. Maps to Pillar 5. Pair with
the cover count.

**P0 — Member vs Guest Cover Split.** Two-bar breakdown of YTD covers
or a stacked KPI tile. The drift between member and guest covers is the
single largest signal in F&B revenue mix.

**P0 — Forward Banquet Pipeline ($ booked, next 90 / 180 days).**
Contracted revenue ahead of the close. Without this, the Board sees
backward F&B revenue only — half a story. Currently invisible.

**P1 — Member Dining Minimum Compliance.** If the club operates
minimums: % of members meeting minimum, total billed shortfall $. If
the club does not operate minimums, note that explicitly in the section
header so the gap is not read as an oversight.

**P1 — Halfway-House Revenue per Round.** `Halfway-house revenue / rounds`. Attach metric — currently the outlet shows in sales-by-outlet
but the per-round attach is what governs the halfway-house refurbishment
capital case.

**P1 — Member Dining Frequency.** Average dining visits per dining
member per month. Tells the Board whether the increase in covers is
breadth (more members dining) or depth (same members dining more).

**P1 — Beverage Program Contribution.** Beverage as a % of F&B revenue,
beverage gross margin %, wine cellar inventory $. The beverage program
is typically the only profitable F&B sub-line at a private club;
visibility matters.

**P2 — Repeat-Event Booking Rate.** % of corporate / wedding events
that re-book within 12 months. Forward-pipeline quality indicator.

**P2 — Covers per Labor Hour (Outlet).** Productivity metric for
outlet-level operating reviews.

**P2 — Waste / Spoilage %.** Cost-discipline metric for the
controller's narrative when food cost % runs over plan.

---

## 4. Capital — Pillar 2

The strongest section today on financial discipline (reserve coverage,
PPE reinvestment, debt/equity, project list with budget/YTD/used/status,
two reserve ratios) but missing the *asset-condition* texture a Long
Range Planning committee uses to justify the next 10 years of capital.

### Present
- Reserve coverage (1.42x) + sufficiency (2.49x)
- PPE reinvestment (0.51)
- Long-term debt/equity (0.08x)
- Working capital ($4.71M)
- Capital project completion (6 of 7)
- Capital spend vs plan (-16.5%)
- Capital income vs plan (+4.6%)
- Project list with budget / YTD / used / status

### Gap

A Long Range Planning Committee — and the Board that votes on the
five-year capital plan — looks for:

1. **Reserve Study cycle status.** Years since last study; industry
   standard is 5 years. Above 7 is the threshold for commissioning a
   new study. Currently invisible.
2. **Deferred maintenance backlog ($).** The cumulative dollar value
   of identified maintenance not yet executed. The leading indicator of
   future capital pressure. Currently invisible.
3. **Asset-aging breakdown.** Net book value by asset category
   (clubhouse / course / equipment / vehicles) with average remaining
   useful life. The capital plan defence runs through this table.
4. **Depreciation funded vs unfunded.** Is annual depreciation being
   replenished into the reserve at par? Currently the reserve
   sufficiency ratio is a proxy but the explicit funded-vs-unfunded
   read is more legible.
5. **Capital plan adherence multi-year.** Single-year project list is
   present; rolling 3-year adherence to the approved capital plan is
   not. A clean current year that closes on a string of deferred prior-
   year work is a governance signal.
6. **Critical asset replacement timeline.** The next 3 / 5 / 10 years
   of plant items requiring replacement — currently buried in the
   Reserve Study, not on the page.
7. **Special-assessment history.** Member-asked governance question
   the page cannot currently answer ("when did the club last levy a
   special assessment, and for what?").
8. **Project change-order rate.** Cost-discipline metric the Capital
   Committee uses to assess GC + project-manager performance.

### Recommendations

**P0 — Deferred Maintenance Backlog ($).** Single hero tile, with
12-month delta. The most-asked Long Range Planning Committee question
and currently invisible. Maps to Pillar 2.

**P0 — Reserve Study Cycle Status.** "Last study FY24 — refresh due
FY29." A single line in the capital section header. Cheap to add,
high-value governance signal.

**P0 — Asset-Aging Breakdown (4–6 rows).** Net book value by major
asset category with average remaining useful life. This is the table
that turns reserve-coverage from an abstraction into a capital plan.

**P1 — Depreciation-Replenishment Ratio.** `Reserve contribution YTD / depreciation YTD`. At 1.0x, reserves replenish at exactly the depreciation pace; below 1.0x sustained means the reserve is eroding in
real terms.

**P1 — Capital Plan Adherence (Rolling 3-Year).** % of approved
multi-year capital plan dollars actually executed in the year planned.
Below 80% is the threshold for plan-quality review.

**P1 — Critical Asset Replacement Schedule (Next 5 Years).** A short
table from the Reserve Study showing the top 5 expected capital items
by year. Surfaces the future-spend pressure currently visible only in
the Reserve Study itself.

**P2 — Special-Assessment History (Last 10 Years).** A footnote or
small table — assessment year, amount, purpose. Most useful as
governance proof that current reserves are intact precisely because
the club has not had to assess.

**P2 — Project Change-Order Rate.** `Change orders $ / original budget $` across active capital projects. Tracks GC and project-manager
discipline.

**P2 — Capital Reserve Runway (Months).** `Reserve balance / trailing-12-month capital spend`. Tells the Board, in months, how
long the club can keep building without new capital income.

---

## 5. Collections (AR) — Pillar 1 + Pillar 4

A strong narrative in the current package, but the metric coverage is
thin. The chapter shows the four aging buckets and one trend signal
(AR Current %) but does not surface the collections workflow the
General Manager and Membership Committee actually run.

### Present
- Total receivable ($235K)
- 4 aging buckets (Current, 31–60, 61–90, 90+)
- AR Current % (78.4%)
- Variance vs prior month per bucket
- Notes paragraph (narrative)

### Gap

A controller working a collections meeting wants:

1. **Days Sales Outstanding (DSO).** The single most-used AR health
   metric in any business; on a private club's monthly dues cycle
   the relevant DSO is 30–35 days for healthy operations.
2. **Bad debt YTD / write-offs.** What the club actually lost this
   year vs the allowance set aside. Currently invisible.
3. **Accounts on payment plan.** Count + balance. This is the active
   workflow GM is running and the metric the Membership Committee
   tracks.
4. **Average member balance + largest 10 accounts.** Aging
   concentration. A $235K receivable spread across 1,284 accounts is
   structurally different from $235K concentrated in 8 accounts.
5. **Late-fee revenue + waiver rate.** Governance metric — the
   late-fee waiver rate is a leading indicator of policy-enforcement
   discipline.
6. **Member suspensions due to AR.** Count of members who lost
   facility access in the period because of AR — material to both the
   Membership Committee and the GM's narrative.
7. **Credit balances (members carrying credit).** A small but
   genuine soft-cash position worth surfacing.
8. **Allowance for doubtful accounts.** GAAP / audit signal — the
   Finance Committee should see this against actual write-offs to
   judge reserve adequacy.

### Recommendations

**P0 — Days Sales Outstanding (DSO).** Single hero tile. Without this,
the AR section is incomplete on the controller's side. Maps to
Pillar 1. Industry benchmark: 30–35 days for a monthly dues cycle.

**P0 — Accounts on Payment Plan (Count + $ Balance).** The visible
collections workflow. Pair with the over-90 bucket so the Board can
see what share of the over-90 is actively managed vs uncovered.

**P0 — Write-Offs YTD ($) + as % of Dues.** What was actually lost.
The trailing-12-month write-off rate is the controller's reserve
calibration signal.

**P1 — Average Member Balance + Top 10 Concentration.** Pair the
aging buckets with a concentration read. A
*"top 10 accounts = 41% of receivable"* line in the notes is more
governance-useful than the aging table alone.

**P1 — Late-Fee Waiver Rate.** Late fees waived / late fees assessed.
Above 30% sustained is the policy-enforcement signal the audit M2
narrative already references but currently has no metric for.

**P1 — Member Suspensions Due to AR.** Count of members with
facility access suspended during the period. Sensitive metric — render
with a privacy-respecting count, no names.

**P1 — Allowance for Doubtful Accounts.** $ allowance vs trailing-12
write-offs. Audit-side metric the Finance Committee should see at
month-close.

**P2 — Member Credit Balances ($).** Soft-cash position.

**P2 — Return-Payment Count YTD.** Operational signal — return-payment
volume is a leading indicator of dues-collection friction.

---

## Cross-Cutting Findings

### A. The package is rich on financial-statement detail and thin on private-club operating discipline.

Statement of Activities, Capital Fund, and Financial Position are
strong. Membership, Golf, Hospitality, and Collections — the four
domains a private-club Board distinguishes itself from a generic-SaaS
finance dashboard on — carry between 4 and 9 metrics each. Industry
peer packages typically carry 12–20 per domain.

### B. Survey / experience metrics are nearly absent.

One score (F&B 4.6/5.0) carries the entire member-experience reading.
Pillar 5 Experience Stewardship is materially under-served. At minimum
the page should carry: F&B score, course-condition score, staff service
score, overall member satisfaction (NPS or 1–5), and a member-
engagement rate.

### C. Forward-looking metrics are absent.

Every metric on the page reports a backward reading. A private-club
Board package should carry at least three forward indicators:
- Banquet pipeline ($ booked, next 90/180 days)
- Waitlist depth + aging
- Capital plan obligations (next 12 months committed but unspent)

### D. The CMAA-standard "club-comparison" framing is absent.

Several metrics carry peer-median benchmarks (Dues / Rev, Payroll
Ratio, NOI Margin, F&B Subsidy, AR Current, PPE Reinvestment, Debt /
Equity). But the package does not state the peer-comparison source
(CMAA, NCA, BoardRoom) anywhere. The Board cannot calibrate the
benchmarks without knowing whose data they came from.

### E. The audit treats "Collections" as a chapter of its own; many private-club packages would fold it under Membership.

This is a presentation choice, not a defect. Worth noting that a
future re-shape could merge X (AR) and the Membership section of VI
(Operations & Analytics) into a unified Membership Stewardship chapter,
since the AR governance threads run through Membership Committee.

---

## Recommendation Summary

| # | Priority | Area | Metric | Pillar |
|---|---|---|---|---|
| 1 | P0 | Membership | Membership Category Mix (Full/Social/Junior/Senior/etc.) | 4 |
| 2 | P0 | Membership | Rolling-12-Month Attrition Rate | 4 |
| 3 | P0 | Membership | Net Member Equity per Active Member | 4 + 3 |
| 4 | P0 | Golf | Member Rounds per Active Member | 5 |
| 5 | P0 | Golf | Saturday Peak Fill Rate | 5 |
| 6 | P0 | Hospitality | Dining Participation Rate (% members) | 5 |
| 7 | P0 | Hospitality | Member vs Guest Cover Split | 5 + 1 |
| 8 | P0 | Hospitality | Forward Banquet Pipeline ($ booked) | 1 |
| 9 | P0 | Capital | Deferred Maintenance Backlog ($) | 2 |
| 10 | P0 | Capital | Reserve Study Cycle Status | 2 |
| 11 | P0 | Capital | Asset-Aging Breakdown by Category | 2 |
| 12 | P0 | Collections | Days Sales Outstanding (DSO) | 1 |
| 13 | P0 | Collections | Accounts on Payment Plan (count + $) | 1 + 4 |
| 14 | P0 | Collections | Write-Offs YTD ($) + % of Dues | 1 |
| 15 | P1 | Membership | Resignation Reason Mix | 4 |
| 16 | P1 | Membership | Average Member Tenure + Distribution | 4 |
| 17 | P1 | Membership | Waitlist Aging | 4 |
| 18 | P1 | Membership | Member Engagement Rate | 4 + 5 |
| 19 | P1 | Golf | Guest Cap Utilisation | 5 |
| 20 | P1 | Golf | Course-Condition Score | 5 |
| 21 | P1 | Golf | Handicap-Active Members | 5 |
| 22 | P1 | Golf | Pace-of-Play Average | 5 |
| 23 | P1 | Hospitality | Member Dining Minimum Compliance | 4 + 1 |
| 24 | P1 | Hospitality | Halfway-House Revenue per Round | 1 |
| 25 | P1 | Hospitality | Member Dining Frequency | 5 |
| 26 | P1 | Hospitality | Beverage Program Contribution | 1 |
| 27 | P1 | Capital | Depreciation-Replenishment Ratio | 2 |
| 28 | P1 | Capital | Capital Plan Adherence (Rolling 3-Year) | 2 |
| 29 | P1 | Capital | Critical Asset Replacement Schedule (Next 5 Years) | 2 |
| 30 | P1 | Collections | Top 10 Account Concentration | 1 |
| 31 | P1 | Collections | Late-Fee Waiver Rate | 1 |
| 32 | P1 | Collections | Member Suspensions Due to AR | 1 + 4 |
| 33 | P1 | Collections | Allowance for Doubtful Accounts | 1 |
| 34 | P2 | Membership | Dues Yield per Active Member | 4 |
| 35 | P2 | Membership | Equity-Bond Refund Queue | 3 + 4 |
| 36 | P2 | Golf | Lessons Taught + Lesson Revenue | 5 |
| 37 | P2 | Golf | Cart Fee Revenue per Round | 1 |
| 38 | P2 | Golf | Range Balls Dispensed per Round | 1 |
| 39 | P2 | Hospitality | Repeat-Event Booking Rate | 1 |
| 40 | P2 | Hospitality | Covers per Labor Hour (Outlet) | 1 |
| 41 | P2 | Hospitality | Waste / Spoilage % | 1 |
| 42 | P2 | Capital | Special-Assessment History (10-Year) | 2 |
| 43 | P2 | Capital | Project Change-Order Rate | 2 |
| 44 | P2 | Capital | Capital Reserve Runway (Months) | 2 |
| 45 | P2 | Collections | Member Credit Balances | 1 |
| 46 | P2 | Collections | Return-Payment Count YTD | 1 |

---

## Proposed Implementation Sequence

The Definition of Done in
[`CLAUDE.md`](../CLAUDE.md) requires each metric to land with: a
service field, a render surface, a four-questions narrative, peer-
benchmark citation where available, and a Board Consideration tag.
That is roughly one full PR per ~3 metrics. The P0 block is therefore
~5 implementation passes:

1. **Membership category mix + attrition rate + equity per member**
   (Pillar 4 close-out — 1 pass)
2. **Golf member-rounds + Saturday peak fill** (Pillar 5 demand
   close-out — 1 pass)
3. **Hospitality participation + member/guest split + forward
   banquet pipeline** (Pillar 5 + Pillar 1 close-out — 1 pass)
4. **Capital deferred-maintenance + reserve-study cycle +
   asset-aging breakdown** (Pillar 2 close-out — 1 pass)
5. **Collections DSO + payment plans + write-offs** (Pillar 1 + 4
   close-out — 1 pass)

P1 and P2 metrics layer in after the P0 set is rendered and the page
chrome accommodates the new density.

---

## Constraint Notes

- **Source-of-truth.** Several P0 metrics (membership category, member
  rounds per member, dining participation, payment plans, write-offs)
  require Prisma fields that may not yet exist. Each implementation
  pass should begin with a 5-minute schema check before the metric is
  added to the service. Metrics that cannot be sourced from real data
  must be clearly labelled `Demo` in the data-source chip, per the
  no-placeholder rule.
- **Page chrome.** Adding ~14 P0 metrics roughly doubles the
  At-a-Glance density. The KPI grid will need a second tier so the
  hero KPIs do not lose their visual authority. Recommend a "Pillar
  Detail" sub-grid below each chapter's headline KPIs.
- **Tenant scope.** Every new metric must read through `tenantWhere` /
  explicit `clubId` filter — none of these metrics are cross-club.
- **White-label.** None of the metric names contain "Spectre" — safe
  for the admin-only reporting surface, and would also be safe if any
  of these metrics later surface on a member-portal dashboard.

---

## What This Audit Does Not Cover

- Visual rendering — the
  [executive-reporting-design-system](spectre-executive-reporting-design-system.md)
  governs that and is not in scope here.
- Service architecture or data-pipeline design — each implementation
  pass should pair with a 5-minute Prisma-schema check.
- Member-portal surfaces — none of these metrics are member-facing.
- The Operating KPIs (chapter IV Stewardship Dashboard) coverage —
  the 8 cards in `operatingKPIs` and 8 in `capitalKPIs` are doing the
  job they were designed for; gaps there were closed by the prior
  [KPI audit](monthly-reporting-kpi-audit.md).

---

**End of audit.**
