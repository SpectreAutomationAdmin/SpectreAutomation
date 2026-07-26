// Monthly Reporting Package — shared body component (rendered by
// both the admin /app/admin/reporting/monthly route and the board
// read-only /app/reports/monthly-package/[id] route). See the
// MonthlyReportingPackageBody export below for the contract.
//
// This file owns the full chapter library: cover, Chair's
// Dashboard, Stewardship KPIs, Statement of Activities, Capital
// Fund, Capital Project Tracker, Statement of Financial Position,
// AR Aging, Operating Statistics, Departmental P&L, Weather,
// Payroll, Food & Beverage, Inventory — and every helper /
// sub-component they need. Page-level concerns (auth, data fetch,
// publish lifecycle, snapshot vs live) live in the two callers.

import { Fragment } from "react";
import {
  getMonthlyReportingPackage,
  type KpiTone,
  type StatementLine,
  type BoardConsideration,
  type BoardRisk,
  type BoardRiskSeverity,
  type BoardRiskTrend,
  type BoardDecision,
  type DecisionAction,
} from "@/lib/reporting/monthly-package";
import {
  evaluateMetric,
  rollupChapter,
  countFlagged,
  labelFor,
  kpiToneFor,
  type Attention,
  type PillarKey,
} from "@/lib/reporting/attention";
import { AtAGlanceBlock } from "@/components/reporting/AtAGlanceBlock";

// ============================================================================
// MonthlyReportingPackageBody — the shared report body component
//
// Renders the cover + all fourteen chapters from a fully-formed
// MonthlyReportingPackage payload. Exported and consumed by:
//
//   • The admin page (default export above) — passes the live
//     reporting-service payload and a PublishHeaderButton in the
//     `adminHeader` slot.
//
//   • The board read-only view at /app/reports/monthly-package/[id]
//     — passes the FROZEN snapshot from
//     `MonthlyPackage.packagePayloadJson` and omits `adminHeader`
//     so no publish/overwrite/archive controls render.
//
// The component is intentionally presentation-only: no auth, no
// data fetching, no lifecycle state. The two callers handle those.
// This keeps the Board view a byte-faithful copy of the admin
// surface (same chapters, same chrome, same scroll behaviour) with
// the only difference being the admin-header slot.
// ============================================================================
type MonthlyReportingPackageBodyProps = {
  /** The full reporting payload. Either live (admin) or frozen
   *  snapshot (board). The two paths use the same type. */
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
  /** Admin-only header content (the PublishHeaderButton portal
   *  source). Omit on the board surface. */
  adminHeader?: React.ReactNode;
};

export function MonthlyReportingPackageBody({
  pkg,
  adminHeader,
}: MonthlyReportingPackageBodyProps) {
  return (
    <div data-testid="monthly-reporting-body" className="min-w-0">
      {/* Publish button — portals into the dark green ReportingShell
          header. Modes (controller-facing only; Board users never
          reach this surface because the board route renders this
          body WITHOUT passing adminHeader):
            • DRAFT → "Publish" (action; first publish, no overwrite
              dialog because no prior snapshot to replace)
            • PUBLISHED + hashes match → "Published" (informational
              pill; this row IS the current Live)
            • PUBLISHED + hashes differ → "Overwrite Package"
              (action; refreshes snapshot in place, row stays Live
              if currentLive — which it is when PUBLISHED here)
            • ARCHIVED → "Overwrite Package" (action; historical
              correction; row stays Archived, Board pointer does
              NOT regress) */}
      {adminHeader}

      {/* I. Executive Opening — the cover. Anchored so the chapter
          rail's "I" link returns the reader to the document top. */}
      <div id="executive-opening" className="scroll-mt-24">
        <PackageHeader pkg={pkg} />
      </div>

      {/* II. Chair's Dashboard — Finance Chair's one-page command
          center. Five-pillar single-page summary; sits between the
          cover (Executive Briefing) and the long-form Board Financial
          Briefing. The intended reading flow is:
            cover  → "what's the story?"
            II     → "show me the entire Club"
            III    → "tell me the details"
          Saguaro-style next-section tease: the chair's-dashboard
          chapter peeks above the fold at 1440×900 so the reader sees
          there is more report below. The decorative ornament between
          cover and II is removed and the section gap tightened to a
          minimal `mt-6`; the chapter title forms the visible tease. */}
      <section id="financial-performance" className="mt-0 scroll-mt-24 [@media(min-height:880px)]:mt-2">
        <ChairsDashboard pkg={pkg} />
      </section>

      {/* III. Stewardship KPI Dashboard — Saguaro-style executive
          scorecard sitting BETWEEN Financial Performance and the
          pillar deep-dives. Four top KPI summary cards + Operating
          + Capital panels + reactive Dashboard Notes. Data flows
          from `pkg.stewardshipKpiDashboard` + the existing
          `operatingKPIs.cards` / `capitalKPIs.cards` rows (single
          source of truth — chapter II's Stewardship Dashboard and
          chapter III's panels render the same KPI rows). */}
      <ChapterOrnament />
      <section id="stewardship-dashboard" className="mt-16 scroll-mt-24">
        <StewardshipKpiDashboard pkg={pkg} />
      </section>

      {/* IV. Statement of Activities — Two-Fund Format. Saguaro-style
          board-facing financial statement. Operating revenues +
          expenses above the NOI line, capital fund activity below —
          separated by institutional discipline. Data flows entirely
          from `pkg.statementOfActivitiesV2` (service-owned variance
          math + reactive CFO commentary). Replaces the chapter XI
          Statement of Activities `BoardStatement` invocation as the
          canonical surface; the duplicate render is removed below. */}
      <ChapterOrnament />
      <section id="statement-of-activities" className="mt-16 scroll-mt-24">
        <StatementOfActivitiesPanel pkg={pkg} />
      </section>

      {/* V. Capital Fund Statement. Saguaro-style two-column capital
          stewardship surface: Sources & Uses table on the left
          (annual budget / YTD actual / remaining), reserve coverage
          progress ribbon + reserve adequacy detail + capital
          stress-test commentary on the right. Data flows entirely
          from `pkg.capitalFundStatement` (service-owned numerics +
          reactive stress-test). Statement of Activities chapter IV
          shows capital activity as part of combined performance;
          chapter V is the dedicated capital-stewardship chapter and
          consumes the same per-period numerics through the shared
          ReportingPeriod, so the two surfaces never drift. */}
      <ChapterOrnament />
      <section id="capital-fund" className="mt-16 scroll-mt-24">
        <CapitalFundPanel pkg={pkg} />
      </section>

      {/* VI. Capital Project Tracker. Saguaro-style nine-column
          project ledger: Active Replacements + Active Improvements
          + Planning rows, a Total band for authorized projects, a
          green-tinted exception report + bullet project notes
          beneath. Capital Fund (chapter V) answers WHERE capital
          comes from; Capital Project Tracker (this) answers WHAT
          was approved and WHETHER projects are off course. Period
          labels + the "Q[N] {year}" next-board-meeting reference
          flow from ReportingPeriod. */}
      <ChapterOrnament />
      <section id="capital-projects" className="mt-16 scroll-mt-24">
        <CapitalProjectTrackerPanel pkg={pkg} />
      </section>

      {/* VII. Statement of Financial Position. Saguaro-style balance
          sheet adapted for Spectre's narrower right-hand canvas:
          rendered VERTICALLY (Assets table → Liabilities & Members'
          Equity table → Stewardship Ratios card → Balance Sheet
          Notes block). Replaces the legacy chapter-XIV BoardStatement
          Statement of Financial Position invocation as the
          canonical surface; the duplicate render is removed below. */}
      <ChapterOrnament />
      <section id="financial-position" className="mt-16 scroll-mt-24">
        <StatementOfFinancialPositionPanel pkg={pkg} />
      </section>

      {/* VIII. Accounts Receivable Aging. Saguaro-style AR aging
          surface: 4 KPI summary cards → 7-column aging table with
          status pills → 5-column membership activity table →
          reactive collection notes bullets. Data flows entirely
          from `pkg.accountsReceivableAging`. Period labels +
          quarter-derived membership column headers flow from
          ReportingPeriod. */}
      <ChapterOrnament />
      <section id="ar-aging" className="mt-16 scroll-mt-24">
        <AccountsReceivableAgingPanel pkg={pkg} />
      </section>

      {/* IX. Operating Statistics & Focus Areas — first chapter of
          the Operations & Analytics group (2026-06-16). Period-over-
          prior-year statistics (month vs same month last year for
          monthly reports) + two Focus Area cards. */}
      <ChapterOrnament />
      <section id="operating-statistics" className="mt-16 scroll-mt-24">
        <OperatingStatisticsPanel pkg={pkg} />
      </section>

      {/* X. Departmental P&L Summary — second chapter of the Operations
          & Analytics group (2026-06-16). Six department cards in a
          responsive 3-col grid + management-document notice +
          department notes. */}
      <ChapterOrnament />
      <section id="departmental-p-and-l" className="mt-16 scroll-mt-24">
        <DepartmentalPLSummaryPanel pkg={pkg} />
      </section>

      {/* XI. Monthly Weather Summary — third chapter of the Operations
          & Analytics group (2026-06-16). 4 weather KPI cards + a
          weather-pattern donut + a rounds-by-condition bar chart + a
          notable weather events table + 3 weather-utilization
          correlation cards. All icons are premium inline SVGs — no
          emoji or SaaS-grade stoplight glyphs. */}
      <ChapterOrnament />
      <section id="weather-and-utilization" className="mt-16 scroll-mt-24">
        <MonthlyWeatherSummaryPanel pkg={pkg} />
      </section>

      {/* XII. Departmental Payroll Analysis — fourth chapter of the
          Operations & Analytics group (2026-06-17). 4 KPI cards + 4
          interactive charts (Actual vs Budget grouped bars / YTD
          variance / Payroll Distribution donut / Wages vs Taxes &
          Benefits stacked bars) + MTD/YTD summary table with a
          dark-green Club Total band. */}
      <ChapterOrnament />
      <section id="payroll-analysis" className="mt-16 scroll-mt-24">
        <DepartmentalPayrollAnalysisPanel pkg={pkg} />
      </section>

      {/* XIII. Food & Beverage Statistics — fifth chapter of the
          Operations & Analytics group (2026-06-18). 4 KPI cards + 4
          interactive charts (Monthly Revenue vs Cost / Revenue by
          Category donut / Monthly Cover Counts / Food Cost % by
          Month line). Period-aware monthly trends + reactive
          callouts derive from `ReportingPeriod`. */}
      <ChapterOrnament />
      <section id="f-and-b-statistics" className="mt-16 scroll-mt-24">
        <FoodBeverageStatisticsPanel pkg={pkg} />
      </section>

      {/* XIV. Inventory Analysis — sixth chapter of the Operations &
          Analytics group (2026-06-19). 4 KPI cards + 2 interactive
          charts (Inventory Turnover by Category bars vs prior year +
          F&B Inventory Balances monthly multi-line) + Inventory
          Management Flags & Action Items table. Final chapter of the
          14-statement reporting package. */}
      <ChapterOrnament />
      <section id="inventory-analysis" className="mt-16 scroll-mt-24">
        <InventoryAnalysisPanel pkg={pkg} />
      </section>

      {/* 2026-06-16 removal: the legacy pillar-panel deep-dives
          (Operations / Financial Health / Capital / Membership Health
          / Experience Health), the Board Financial Briefing, the
          At-a-Glance KPIs, the legacy Financial Statements block, and
          the legacy AR / Collections block were all superseded by the
          five Saguaro chapters above (Statement of Activities → AR
          Aging). The board now reads ONE authoritative
          financial-performance surface, not two. */}

      {/* Legacy "Operations & Analytics" (id: operations) chapter
          was REMOVED 2026-06-19. Its narrative-first headline tiles
          and grouped operating-metric tables were the original
          Pillar-1/4/5 catch-all surface, but every load-bearing
          reading now ships in one of the six chapters above
          (Operating Statistics → Inventory Analysis). The standalone
          chapter became redundant and was retired. The shared
          `pkg.operatingStats` + `pkg.weatherUtilization` +
          `pkg.fbStats` + `pkg.commentary.operations` service fields
          remain available — the Weather chapter's utilization-
          extension tiles and the 5-pillar Board Briefing rollup
          (which consumes `commentary.operations.boardHeadline`)
          continue to read them from the same source of truth. The
          "Operations & Analytics" group label persists as the rail
          heading above the six surviving operational chapters. */}

      {/* Legacy "Payroll" (id: payroll) chapter was REMOVED 2026-06-19
          — it duplicated the canonical chapter XII "Payroll Analysis"
          (id: departmental-payroll-analysis). The monthly package now
          renders payroll exactly ONCE, at chapter XII. The
          `pkg.commentary.payroll` field is still produced by the
          service for the export path. */}

      {/* Legacy "F&B / Hospitality" (id: fb-hospitality) chapter was
          REMOVED 2026-06-19 — it duplicated the canonical chapter
          XIII "Food & Beverage Statistics" (id: food-beverage-statistics).
          The monthly package now renders F&B exactly ONCE, at chapter
          XIII. The `pkg.fb` / `pkg.fbStats` / `pkg.commentary.fb` /
          `pkg.membershipStewardship` (for member satisfaction) data
          sources are PRESERVED on the reporting service so the new
          F&B Statistics chapter can keep consuming Average Check,
          Member Satisfaction, Cover Counts, Revenue by Outlet,
          Revenue by Category, F&B Margin, and POS analytics from the
          shared source of truth. */}

      {/* Legacy "Capital / Projects" (id: capital-projects) was
          REMOVED 2026-06-17 — it duplicated the canonical Financial
          Performance chapter VI "Capital Projects" / Capital Project
          Tracker (id: capital-project-tracker). The monthly package
          now renders Capital Projects exactly ONCE, at chapter VI. */}

      {/* Legacy "Membership Stewardship" (id: membership-stewardship)
          was REMOVED 2026-06-19. The chapter's load-bearing surfaces
          (Active / Attrition / Entrance Fees / Average Tenure tiles +
          Membership Category Mix + Waitlist Depth & Aging + Tenure
          Distribution) were migrated into the Stewardship KPI
          Dashboard (chapter III) earlier the same day; the residual
          L4 lead + attrition trend sparkline did not justify a
          standalone chapter, so the Pillar 4 chapter was retired.
          The shared `pkg.membershipStewardship` and
          `pkg.commentary.membershipStewardship` service data remain
          available — the dashboard consumes them for its membership
          headline tiles + sub-blocks, and the export path continues
          to read them from the same source of truth. */}

      {/* Legacy "Experience Stewardship" (id: experience-stewardship)
          was REMOVED 2026-06-19. Rounds YTD, Course Utilization,
          Spend per Member, and Spend per Round were lifted into the
          Weather & Utilization chapter earlier the same day; F&B
          covers + F&B subsidy already live inside the F&B Statistics
          chapter and the Stewardship KPI Dashboard. The residual L4
          lead + golf/hospitality reading prose + subsidy sparkline
          did not justify a standalone chapter, so Pillar 5 was
          retired. The shared `pkg.experienceStewardship` and
          `pkg.commentary.experienceStewardship` service fields stay
          available — the Board Briefing rollup still consumes the
          experience pillar's board-headline, and the export path
          continues to read these fields from the same source of
          truth. */}

    </div>
  );
}

// ============================================================================
// Cover — document opening
//
// Step / two-column cover redesign (Saguaro Executive Briefing pattern).
//
// Previously the cover was a centered three-register publication panel
// (masthead / hero / colophon) that consumed the full first viewport
// for identity facts only. A director opening the package learned the
// club name + period + committee but nothing about whether the Club
// was OK that month.
//
// The redesign converts the first viewport into a two-column briefing
// page modeled on Saguaro's p01 (sample-club.netlify.app — captured
// in test-results/cmp-saguaro-cover.png):
//
//   LEFT column (col-span-5, ~38% wide)
//     - Identity stack, left-aligned
//     - Club name shrunk from text-7xl (72px) to text-5xl (48px) —
//       a 65% vertical-footprint reduction, one line at the narrower
//       column width
//     - Period, FY context, prepared-for committee, prepared date,
//       framework colophon — all preserved, just compressed and
//       left-aligned
//
//   RIGHT column (col-span-7, ~62% wide)
//     - Executive Briefing area — three medium-density briefing cards
//       wired to existing pkg.boardBriefing.{operations, financialHealth,
//       capitalProgram} data (no new service fields)
//     - Each card carries: status headline + concise narrative (first
//       sentence of the existing memo) + 2-row mini KPI dl (first two
//       existing chips) + Board Consideration chip
//     - (Previously a subtle anchor link sat at the foot of the
//       column; it has been removed so the three cards can distribute
//       evenly over the full identity-column height.)
//
// The first viewport now answers "is the Club OK this month?" within
// ~10-15 seconds without scrolling. Nothing below the cover changed.
// ============================================================================

const ENGLISH_ORDINAL_WORDS: Record<number, string> = {
  1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six",
  7: "Seven", 8: "Eight", 9: "Nine", 10: "Ten", 11: "Eleven", 12: "Twelve",
};

function ordinalWord(n: number): string {
  return ENGLISH_ORDINAL_WORDS[n] ?? String(n);
}

function formatPreparedDate(iso: string): string {
  // Use UTC so server render is deterministic regardless of host timezone.
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
}

// Extract the first sentence from a memo narrative, capped at ~140
// characters at a word boundary. Used by the cover briefing cards to
// surface the headline of each Board Briefing memo without inventing
// new copy — the existing narratives are already CFO-authored, and
// their opening sentences are the natural cover headlines. The cap
// keeps the three briefing cards visually balanced when one memo's
// opening sentence is materially longer than the others (the capital
// memo's first sentence runs ~40 words; operations and financial
// health are 12-16 words). On truncation a single ellipsis closes the
// excerpt and signals "more on chapter II" — the deep-link to the
// full memo is reachable via the persistent chapter rail.
function firstClause(s: string, maxLen = 140): string {
  const period = s.indexOf(". ");
  const candidate = period > 0 ? s.slice(0, period + 1) : s;
  if (candidate.length <= maxLen) return candidate;
  const truncated = candidate.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

function PackageHeader({ pkg }: { pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>> }) {
  const preparedDate = formatPreparedDate(pkg.preparedAt);
  // Board Attention Engine — overall verdict across the 5 pillars.
  // The cover attention indicator (cover-attention-ribbon) was removed
  // from the masthead per the founder's alignment pass — the per-card
  // status verdicts (On Plan / Strong Position / Executing) on the
  // three briefing cards now carry the required-actions signal.
  // All three briefing areas (Operations, Financial Health, Capital
  // Program) now render via dedicated first-scroll atoms — each
  // implements the first-scroll standard's headline-dominant +
  // narrative-between + metrics-subordinate hierarchy with the
  // standard's four required metrics for its area. The generic
  // CoverBriefingCard atom is no longer wired to the cover.

  // At-a-Glance block — the four most-quoted board KPIs, rendered
  // in the dead space below the left identity column's framework
  // colophon. Mirrors Saguaro p01's lower-left figure block: a
  // restrained 2x2 grid that reinforces the same numbers a Director
  // sees in the right-column briefing cards. Values come straight
  // from pkg.executiveSummary.kpis so the narrative voice stays
  // single-sourced with the rest of the package — no inventory.
  const COVER_AT_A_GLANCE_KEYS = ["ytd-revenue", "noi", "capital-income", "reserve-coverage"] as const;
  const ataGlance = COVER_AT_A_GLANCE_KEYS
    .map((key) => pkg.executiveSummary.kpis.find((k) => k.key === key))
    .filter((k): k is NonNullable<typeof k> => Boolean(k))
    .map((k) => ({
      key: k.key,
      label: k.label,
      value: k.value,
      variance: k.comparison?.variance ?? "",
    }));

  return (
    <header data-testid="monthly-package-header" className="border-b border-club-sand">
      <div
        data-testid="monthly-cover"
        className="mx-auto pb-3 [@media(min-height:880px)]:pb-4"
      >
        {/* === Masthead band — full-width letterhead.
            Single horizontal row: PACKAGE LABEL (left) + EXECUTIVE
            BRIEFING + ATTENTION INDICATOR (right). Compressed from
            the prior two-stack layout so the briefing cards + the
            At-a-Glance teaser claim more of the first viewport.
            The eyebrow row lives here — not inside the right column
            — so both registers share one baseline. */}
        <div data-testid="monthly-cover-masthead">
          {/* Masthead uses the same 12-col grid as the two-column
              body below so the package label sits in the identity
              column (col-span-5) and the EXECUTIVE BRIEFING label
              sits in the briefing column (col-span-7) left-anchored
              — its left edge aligns exactly with the OPERATIONS
              briefing card directly below it. */}
          {/* Masthead row + underline as ONE element pair, mirroring the
              rail's `border-b border-club-sand pb-3` pattern. Both the
              MBRP and EB labels sit at the same top edge of this row;
              the row's own `border-b` produces the underline at the
              same relative offset (pb-3) as the rail's "IN THIS
              PACKAGE" — so all three headings + all three underlines
              share one horizontal rhythm across the page. No translate
              hacks, no min-h nudges, no separate hairline div. */}
          {/* Symmetric 50/50 two-track grid:
                track 1 — identity, `minmax(0, 1fr)`
                track 2 — briefing, `minmax(0, 1fr)`
              The remaining content area (everything after the rail)
              is split equally between the cover-summary column and
              the Executive Briefing column. Extra space at any
              viewport is shared evenly; neither column caps. The
              0 minimums prevent overflow at narrow widths. Children
              land in tracks 1 and 2 by source order; no col-span
              classes needed. The MASTHEAD uses the SAME template as
              the body grid below so the package-label cell sits
              directly above the identity column and EB sits directly
              above the briefing column. */}
          <div className="grid grid-cols-1 gap-4 border-b border-club-sand pb-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-12">
            <div
              data-testid="monthly-cover-package-label"
              className="whitespace-nowrap text-[11px] uppercase tracking-[0.32em] text-club-gold"
            >
              Monthly Board Reporting Package
            </div>
            {/* Negative-left margin tracks the briefing column body
                below so the EB label stays vertically above its card
                column at every viewport. The shift scales with
                breakpoint: smaller at lg/xl (where the identity column
                is narrow and the NOI label sits closer to the column
                edge), larger at 2xl (where there is more right-side
                whitespace inside the identity column to reclaim).
                No border on the masthead cell so the horizontal
                masthead rule remains continuous across both columns;
                the vertical divider starts BELOW the masthead. */}
            <div className="whitespace-nowrap text-[11px] uppercase tracking-[0.32em] text-club-gold lg:-ml-4 lg:pl-2 xl:-ml-14 2xl:-ml-40">
              Executive briefing
            </div>
          </div>
        </div>

        {/* === Two-column body — symmetric 50/50 grid =================
            Track 1 (LEFT) — identity stack. `minmax(0, 1fr)`.
            Track 2 (RIGHT) — Executive Briefing. `minmax(0, 1fr)`.
            The reading column (everything after the rail) is split
            evenly between the cover-summary content and the
            briefing cards — both columns receive equal width at
            every desktop viewport, and additional horizontal space
            is shared between them rather than absorbed by one side.
            No caps, no clamps; cards stretch to the full 50% column
            width so they never feel compressed at large monitors.
            No col-span classes — children land in tracks 1 and 2
            by source order; markup stays symmetric with the
            masthead row above (same grid template, same source
            order). */}
        <div className="mt-4 grid grid-cols-1 gap-6 [@media(min-height:880px)]:mt-6 [@media(min-height:880px)]:gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-12">

          {/* ----- LEFT COLUMN — identity stack ----------------------- */}
          <div data-testid="monthly-cover-identity">
            {/* L1 — Club name. text-5xl (48px) — 65% reduction from the
                previous text-7xl ceremonial size. Single line at the
                left-column width; one-line vertical footprint shrinks
                from ~155px to ~52px.

                `text-balance` (CSS `text-wrap: balance`) tells the
                browser to distribute wrapped lines evenly when the
                name DOES wrap, so an orphan word — e.g. "Club"
                stranded on a second line — gets pushed up to balance
                with its neighbour. Works for any club name, not just
                Silver Springs: a three-word name like "Pebble Beach
                Club" still single-lines; a five-word name like
                "Silver Springs Golf & Country Club" wraps as
                "Silver Springs Golf &" / "Country Club" instead of
                "… Country" / "Club". Pure CSS rule, no JS, no
                hard-coded breaks. */}
            <h1
              data-testid="monthly-cover-club-name"
              className="font-serif text-4xl/[1.15] tracking-tight text-balance text-club-green-900 sm:text-5xl/[1.15]"
            >
              {pkg.club.name}
            </h1>

            {/* Club-identity supporting line — CITY, PROVINCE · EST.
                YEAR. Editorial hierarchy: sits as METADATA under the
                club name, not as a competing subtitle. Smaller, lighter
                weight, generous whitespace above so the title can
                breathe. Each piece is pulled from ClubProfile (Admin
                → Club Settings) and rendered only if present; a tenant
                with no fields set omits the line entirely. */}
            {(() => {
              const cityProvince = [pkg.club.city, pkg.club.provinceState]
                .filter((s) => s && s.trim().length > 0)
                .join(", ");
              const est = pkg.club.yearFounded ? `EST. ${pkg.club.yearFounded}` : "";
              const pieces = [cityProvince, est].filter((s) => s.length > 0);
              if (pieces.length === 0) return null;
              return (
                <div
                  data-testid="monthly-cover-club-meta"
                  className="mt-3 text-[11px] uppercase tracking-[0.18em] text-club-green-800/65"
                >
                  {pieces.join(" · ")}
                </div>
              );
            })()}

            {/* Reporting-period GROUP — read as one unit. The two lines
                are tightly spaced (mt-1) and live inside a single
                wrapper with generous whitespace above. The first line
                is the SECONDARY heading (text-xl, was text-2xl — no
                longer competes with the L1 club name); the second is
                a supporting eyebrow. Drawn from
                pkg.period.periodEndedLabel which is derived from
                periodEnd, and pkg.period.ytdMonthsElapsed via the
                fiscal-period helper. */}
            <div className="mt-8">
              <div
                data-testid="monthly-cover-period"
                className="font-serif text-xl tracking-tight text-club-green-900"
              >
                {pkg.period.periodEndedLabel}
              </div>
              <div
                data-testid="monthly-cover-fy"
                className="mt-1 text-[11px] uppercase tracking-[0.18em] text-club-green-800/55"
              >
                Period {ordinalWord(pkg.period.ytdMonthsElapsed)} of Twelve
              </div>
            </div>

            {/* Prepared-for — RESTRAINED METADATA tier. Treated as
                supporting information, not a primary content block.
                Eyebrow + two body lines at the same metadata size,
                committee in regular weight, board in italic; the pair
                reads as a single addressee group. "The" prefix
                dropped — "Finance Committee / Board of Directors"
                reads cleaner. */}
            <div
              className="mt-8"
              data-testid="monthly-cover-prepared-for"
            >
              <div className="text-[11px] uppercase tracking-[0.18em] text-club-green-800/55">
                Prepared for
              </div>
              <div className="mt-1 font-serif text-[13px] leading-snug text-club-green-900">
                Finance Committee
              </div>
              <div className="font-serif text-[13px] italic leading-snug text-club-green-800/60">
                Board of Directors
              </div>
            </div>

            {/* Framework + confidentiality colophon — FOOTER METADATA
                tier. Generous whitespace above (mt-10) explicitly
                separates them from the report identity content above
                so they read as footer notes, not as competing copy.
                Quieter colour (/55) and smaller size (text-[12px])
                push them firmly into the metadata tier. The decorative
                aldus-leaf ornament between this block and the
                prepared-for above has been removed — whitespace alone
                provides the separation; the ornament was a decorative
                element that no longer justified its existence in the
                tightened editorial hierarchy. */}
            <div
              data-testid="monthly-cover-framework"
              className="mt-10 max-w-[420px] font-serif italic text-[12px] leading-relaxed text-club-green-800/55"
            >
              Prepared using the Spectre Framework.
            </div>
            <div
              data-testid="monthly-cover-confidentiality"
              className="mt-1 max-w-[420px] font-serif italic text-[12px] leading-relaxed text-club-green-800/55"
            >
              This report is confidential and intended solely for the Board of Directors.
            </div>

            {/* At-a-Glance — 2x2 grid of the four most-quoted board
                KPIs. Reinforces the same numbers a Director sees in
                the right-column briefing cards so the financial
                position is visible before the first scroll.
                Implementation lives in `<AtAGlanceBlock>` so the
                Board dashboard widget can render exactly the same
                visual block (testid namespace + styling are 1:1). */}
            <AtAGlanceBlock metrics={ataGlance} />
          </div>

          {/* ----- RIGHT COLUMN — Executive Briefing -----------------
              Wrapper is a flex column so the inner card stack can
              claim full row-height (default `align-items: stretch`
              on the parent grid already stretches this element to
              the row's tallest column = the identity column).

              The negative-left margin (`-ml-N`) + `border-l` +
              `pl-2` triplet does three things at once:
                - moves the briefing column's LEFT EDGE LEFT into
                  the identity column's right-side whitespace area
                  (where the right column of the at-a-glance grid —
                  NOI Before Depreciation / Reserve Coverage —
                  lives but doesn't fill horizontally);
                - draws the faint vertical divider at the briefing
                  column's new left edge, which now sits closer to
                  the end of the "DEPRECIATION" word in the NOI
                  label;
                - adds 8px of breathing room (`pl-2`) between the
                  divider rule and the leading edge of the cards.

              Responsive shift values:
                - lg  (1024-1279): -ml-8  (32px)
                - xl  (1280-1535): -ml-12 (48px)
                - 2xl (≥1536):     -ml-32 (128px)
              The shift grows at wider viewports because the
              identity column's at-a-glance content (which has a
              ~fixed pixel width) leaves more right-side whitespace
              to reclaim there.

              The identity column's grid track is UNCHANGED at every
              breakpoint — the briefing element overflows its own
              track to the left via negative margin without resizing
              or shifting any identity content. */}
          <div
            data-testid="monthly-cover-briefing"
            className="flex flex-col lg:-ml-8 lg:h-full lg:border-l lg:border-club-sand/50 lg:pl-2 xl:-ml-14 2xl:-ml-40"
          >
            {/* Continuous editorial briefing panel — three items
                (Operations, Financial Health, Capital Program) flow
                as ONE document, separated by a faint top-rule + small
                top padding rather than as three boxed cards. Each
                briefing item implements the L1-L5 hierarchy:
                  L1 SECTION eyebrow
                  L2 Question (italic serif)
                  L3 CONCLUSION (serif, tone-coloured — the dominant
                     element)
                  L4 Narrative (body)
                  L5 Metrics (quiet grid, hairline-separated)
                The wrapper no longer uses `justify-between` because
                each item brings its own `border-t pt-3/pt-4` (with
                `first:pt-0 first:border-t-0` on the leading item),
                so the panel reads as one continuous flowing
                document rather than as three card tiles spread
                apart. */}
            <div className="mt-2 [@media(min-height:880px)]:mt-3">
              <OperationsBriefingCard b={pkg.boardBriefing.operations} />
              <FinancialHealthBriefingCard b={pkg.boardBriefing.financialHealth} />
              <CapitalProgramBriefingCard b={pkg.boardBriefing.capitalProgram} />
            </div>
          </div>
        </div>
      </div>

    </header>
  );
}

// Cover briefing card — Executive Briefing tile rendered on the cover's
// right column. Medium density per the approved spec:
//   - status headline (title + tone dot + statusLabel) in the card head
//   - concise narrative (first sentence of the underlying memo)
//   - 2-row mini KPI dl (the first two chips of the source briefing)
//   - Board Consideration chip in the card foot
//
// Pulls from existing pkg.boardBriefing.<key> data — no new service
// fields, no new prose. The full memo prose remains on chapter II.
function CoverBriefingCard({
  cardKey, title, b,
}: {
  cardKey: string;
  title: string;
  b: {
    status: KpiTone;
    statusLabel: string;
    narrative: string;
    chips: Array<{ key: string; label: string; value: string; subtitle?: string }>;
    consideration: BoardConsideration;
  };
}) {
  const headlineKpis = b.chips.slice(0, 2);
  return (
    <article
      data-testid={`cover-briefing-${cardKey}`}
      data-tone={b.status}
      className="rounded-lg border border-club-sand bg-white p-4"
    >
      {/* Card head — title + status (statusLabel + tone dot). */}
      <div className="flex items-baseline justify-between gap-3 border-b border-club-sand/70 pb-2">
        <h3
          data-testid={`cover-briefing-${cardKey}-title`}
          className="font-serif text-lg tracking-tight text-club-green-900"
        >
          {title}
        </h3>
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${dotForTone(b.status)}`}
            aria-hidden="true"
          />
          <span
            data-testid={`cover-briefing-${cardKey}-status`}
            className={`text-xs font-medium ${toneHeadlineClass(b.status)}`}
          >
            {b.statusLabel}
          </span>
        </div>
      </div>

      {/* Concise narrative — opening clause of the existing CFO-authored
          memo, capped at ~140 chars (firstClause helper) so the three
          cards balance visually. Truncation closes with a single
          ellipsis; the deep-link to the full memo lives on the
          persistent chapter rail. */}
      <p
        data-testid={`cover-briefing-${cardKey}-narrative`}
        className="mt-2 text-[13px] leading-snug text-club-green-900/85"
      >
        {firstClause(b.narrative)}
      </p>

      {/* Mini KPI dl — first two chips of the source briefing. */}
      <dl
        data-testid={`cover-briefing-${cardKey}-kpis`}
        className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-club-sand/70 pt-2"
      >
        {headlineKpis.map((chip) => (
          <div key={chip.key} className="flex flex-col">
            <dt className="text-[10px] uppercase tracking-[0.18em] text-club-green-800/65">
              {chip.label}
            </dt>
            <dd className="mt-0.5 font-serif text-base tabular-nums text-club-green-900">
              {chip.value}
            </dd>
            {chip.subtitle && (
              <dd className="text-[11px] text-club-green-800/65">
                {chip.subtitle}
              </dd>
            )}
          </div>
        ))}
      </dl>

      {/* Board Consideration chip — same atom used throughout the
          package, so the cover posture reads identically to every other
          consideration signal in the document. */}
      <div className="mt-2.5 flex items-center justify-between border-t border-club-sand/70 pt-2">
        <span className="text-[11px] uppercase tracking-[0.22em] text-club-green-800/70">
          Board consideration
        </span>
        <BoardConsiderationChip consideration={b.consideration} />
      </div>
    </article>
  );
}

// ----------------------------------------------------------------------------
// Operations briefing card — dedicated first-scroll atom
// ----------------------------------------------------------------------------
//
// Implements the first-scroll standard's headline-dominant /
// narrative-between / metrics-subordinate anatomy for the Operations
// area of the Executive Briefing. Answers the briefing question
// "Are we operating successfully?" using the three Operating Health
// metrics named in docs/spectre-first-scroll-reporting-standard.md
// (Revenue, NOI before depreciation, Dues-to-Revenue %).
//
// Visual hierarchy:
//   1. Title eyebrow + status verdict — status is the HEADLINE: serif
//      text-2xl in tone-coloured editorial green, dominant by typography
//      tier (vs metrics at text-base) and by colour (vs metric labels in
//      neutral smallcaps).
//   2. Italic-serif question caption — the L4-style framing line that
//      states the question the card answers ("Are we operating
//      successfully?"). Reads as a CFO subtitle, not as UI chrome.
//   3. Narrative — max 2 sentences pulled from the service
//      coverNarrative field. References the three KPIs inline so the
//      metric grid below reads as supporting evidence, not data dump.
//   4. Three-metric row — Revenue / NOI before depreciation /
//      Dues-to-Revenue, label + serif text-base tabular-nums value +
//      smaller comparator. Subordinate to the headline by typography
//      tier and by horizontal density (3 columns vs 2 columns on the
//      generic card).
//   5. Board Consideration footer — same atom used package-wide.
//
// Headline status tier: the service status field maps to the
// three-state cascade declared in the user's spec —
//   "green"  → "On Plan"
//   "amber"  → "Watch"
//   "red"    → "Off Plan"
// The mapping is enforced via the service statusLabel (which we
// capitalize to match the spec exactly).
function OperationsBriefingCard({
  b,
}: {
  b: {
    status: KpiTone;
    statusLabel: string;
    question: string;
    coverNarrative: string;
    coverMetrics: ReadonlyArray<{ key: string; label: string; value: string; sub: string }>;
    consideration: BoardConsideration;
  };
}) {
  return (
    // Saguaro-style editorial briefing panel: no card chrome (no
    // surrounding border, no paper-tile background, no rounded
    // corners). Sections separate via a faint top-rule on the
    // second/third cards — `first:` strips it on the leading card
    // so the briefing reads as ONE continuous document instead of
    // three disconnected dashboard tiles.
    <article
      data-testid="cover-briefing-operations"
      data-tone={b.status}
      className="border-t border-club-green-800/25 pt-3 first:border-t-0 first:pt-0 [@media(min-height:880px)]:pt-4 [@media(min-height:880px)]:first:pt-0"
    >
      {/* L1 — SECTION eyebrow. Quietest tier: 11px smallcaps, green. */}
      <div
        data-testid="cover-briefing-operations-title"
        className="text-[14px] uppercase tracking-[0.18em] font-semibold text-club-green-900 [@media(min-height:880px)]:text-[15px]"
      >
        Operations
      </div>

      {/* L2 — Question. Italic serif, larger than the eyebrow so the
          briefing question reads as the prompt the conclusion answers. */}
      <p
        data-testid="cover-briefing-operations-question"
        className="mt-1 font-serif italic text-[12px] leading-snug text-club-green-800/75 [@media(min-height:880px)]:text-[13px]"
      >
        {b.question}
      </p>

      {/* L3 — CONCLUSION. The dominant element of the briefing:
          serif L1f tier in tone-coloured editorial green. No status
          dot — the typography + colour carry the verdict. Sized
          slightly larger than the prior text-2xl so the conclusion
          out-weighs the narrative below. */}
      <p
        data-testid="cover-briefing-operations-status"
        className={`mt-1 font-serif text-[18px] leading-none tracking-tight tabular-nums ${toneBriefingHeadlineClass(b.status)}`}
      >
        {b.statusLabel}
      </p>

      {/* L4 — Narrative. Reads as the conclusion's supporting prose.
          Smaller than the conclusion so the visual weight ranks
          conclusion > narrative > metrics. */}
      <p
        data-testid="cover-briefing-operations-narrative"
        className="mt-2.5 text-[14px] leading-snug text-club-green-900/85 [@media(min-height:880px)]:mt-3 [@media(min-height:880px)]:text-[15px] [@media(min-height:880px)]:leading-[1.45]"
      >
        {b.coverNarrative}
      </p>

      {/* L5 — Metrics. Quiet 3-column grid; faint hairline above sets
          them apart from the narrative without re-introducing card
          chrome. Smallcaps labels + serif tabular-nums values keep
          the tier subordinate to L3. */}
      <dl
        data-testid="cover-briefing-operations-kpis"
        className="mt-3 grid grid-cols-3 gap-x-4 gap-y-1 border-t border-club-sand/40 pt-2"
      >
        {b.coverMetrics.map((m) => (
          <div key={m.key} data-testid={`cover-briefing-operations-kpi-${m.key}`} className="flex flex-col">
            <dt className="text-[11px] uppercase tracking-[0.18em] text-club-green-800/70">
              {m.label}
            </dt>
            <dd className="mt-0.5 font-serif text-base leading-tight tabular-nums text-club-green-900">
              {m.value}
            </dd>
            <dd className="hidden text-[11px] text-club-green-800/70 [@media(min-height:880px)]:block">
              {m.sub}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

// ----------------------------------------------------------------------------
// Financial Health briefing card — dedicated first-scroll atom
// ----------------------------------------------------------------------------
//
// Mirrors OperationsBriefingCard visually. Answers the briefing
// question "Is the Club financially healthy?" using the four
// Financial Health metrics named in
// docs/spectre-first-scroll-reporting-standard.md (Working Capital,
// Reserve Coverage, Current Ratio, AR Current %).
//
// Status cascade (per the user's spec — four states, one more than
// the operations card's three):
//   "green"   → "Strong Position"
//   "neutral" → "Stable"
//   "amber"   → "Watch"
//   "red"     → "Concern"
//
// Only structural difference from the Operations card: the metrics
// grid is grid-cols-4 (four metrics) instead of grid-cols-3 (three).
// All other anatomy — title eyebrow, italic-serif question caption,
// headline status hero (L1f text-2xl tone-coloured), 2-sentence
// narrative, Board Consideration chip footer — is identical so the
// two cards read as siblings on the first viewport.
function FinancialHealthBriefingCard({
  b,
}: {
  b: {
    status: KpiTone;
    statusLabel: string;
    question: string;
    coverNarrative: string;
    coverMetrics: ReadonlyArray<{ key: string; label: string; value: string; sub: string }>;
    consideration: BoardConsideration;
  };
}) {
  // Editorial briefing item — anatomy mirrors OperationsBriefingCard
  // (see its inline comments for the L1-L5 hierarchy rationale).
  // Only the metric grid columns differ (4 vs 3).
  return (
    <article
      data-testid="cover-briefing-financial-health"
      data-tone={b.status}
      className="border-t border-club-green-800/25 pt-3 first:border-t-0 first:pt-0 [@media(min-height:880px)]:pt-4 [@media(min-height:880px)]:first:pt-0"
    >
      <div
        data-testid="cover-briefing-financial-health-title"
        className="text-[14px] uppercase tracking-[0.18em] font-semibold text-club-green-900 [@media(min-height:880px)]:text-[15px]"
      >
        Financial Health
      </div>
      <p
        data-testid="cover-briefing-financial-health-question"
        className="mt-1 font-serif italic text-[12px] leading-snug text-club-green-800/75 [@media(min-height:880px)]:text-[13px]"
      >
        {b.question}
      </p>
      <p
        data-testid="cover-briefing-financial-health-status"
        className={`mt-1 font-serif text-[18px] leading-none tracking-tight tabular-nums ${toneBriefingHeadlineClass(b.status)}`}
      >
        {b.statusLabel}
      </p>
      <p
        data-testid="cover-briefing-financial-health-narrative"
        className="mt-2.5 text-[14px] leading-snug text-club-green-900/85 [@media(min-height:880px)]:mt-3 [@media(min-height:880px)]:text-[15px] [@media(min-height:880px)]:leading-[1.45]"
      >
        {b.coverNarrative}
      </p>
      <dl
        data-testid="cover-briefing-financial-health-kpis"
        className="mt-3 grid grid-cols-4 gap-x-3 gap-y-1 border-t border-club-sand/40 pt-2"
      >
        {b.coverMetrics.map((m) => (
          <div
            key={m.key}
            data-testid={`cover-briefing-financial-health-kpi-${m.key}`}
            className="flex flex-col"
          >
            <dt className="text-[11px] uppercase tracking-[0.18em] text-club-green-800/70">
              {m.label}
            </dt>
            <dd className="mt-0.5 font-serif text-base leading-tight tabular-nums text-club-green-900">
              {m.value}
            </dd>
            <dd className="hidden text-[11px] text-club-green-800/70 [@media(min-height:880px)]:block">
              {m.sub}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

// ----------------------------------------------------------------------------
// Capital Program briefing card — dedicated first-scroll atom
// ----------------------------------------------------------------------------
//
// Mirrors FinancialHealthBriefingCard visually (and therefore
// OperationsBriefingCard transitively). Answers the briefing question
// "Are capital projects and reserve investments being executed
// properly?" using the four Capital Health metrics named in
// docs/spectre-first-scroll-reporting-standard.md (Active Projects,
// Capital Spend YTD, Reserve Contributions, Reserve Funded %).
//
// Status cascade (per the user's spec):
//   "green"   → "Executing"
//   "amber"   → "Monitor"
//   "red"     → "Delayed"   (mild project execution issue)
//   "red"     → "Critical"  (material concern requiring board action)
//
// The two red-tier labels (Delayed / Critical) are distinguished by
// the service statusLabel field, not by the KpiTone alone. Demo data
// ships "green/Executing" — the program is broadly on track: five of
// seven FY26 projects on schedule, one complete, and one engineering
// deferral that actually raised reserve coverage. The deferral is
// captured in Board Decisions Required, not as a capital-health drag.
//
// Anatomy is identical to FinancialHealthBriefingCard: title eyebrow
// + italic-serif question caption on the left, tone dot + L1f
// text-2xl serif status hero on the right, narrative between, 4-col
// metric grid, Board Consideration footer.
function CapitalProgramBriefingCard({
  b,
}: {
  b: {
    status: KpiTone;
    statusLabel: string;
    question: string;
    coverNarrative: string;
    coverMetrics: ReadonlyArray<{ key: string; label: string; value: string; sub: string }>;
    consideration: BoardConsideration;
  };
}) {
  return (
    <article
      data-testid="cover-briefing-capital-program"
      data-tone={b.status}
      className="border-t border-club-green-800/25 pt-3 first:border-t-0 first:pt-0 [@media(min-height:880px)]:pt-4 [@media(min-height:880px)]:first:pt-0"
    >
      <div
        data-testid="cover-briefing-capital-program-title"
        className="text-[14px] uppercase tracking-[0.18em] font-semibold text-club-green-900 [@media(min-height:880px)]:text-[15px]"
      >
        Capital Program
      </div>
      <p
        data-testid="cover-briefing-capital-program-question"
        className="mt-1 font-serif italic text-[12px] leading-snug text-club-green-800/75 [@media(min-height:880px)]:text-[13px]"
      >
        {b.question}
      </p>
      <p
        data-testid="cover-briefing-capital-program-status"
        className={`mt-1 font-serif text-[18px] leading-none tracking-tight tabular-nums ${toneBriefingHeadlineClass(b.status)}`}
      >
        {b.statusLabel}
      </p>
      <p
        data-testid="cover-briefing-capital-program-narrative"
        className="mt-2.5 text-[14px] leading-snug text-club-green-900/85 [@media(min-height:880px)]:mt-3 [@media(min-height:880px)]:text-[15px] [@media(min-height:880px)]:leading-[1.45]"
      >
        {b.coverNarrative}
      </p>
      <dl
        data-testid="cover-briefing-capital-program-kpis"
        className="mt-3 grid grid-cols-4 gap-x-3 gap-y-1 border-t border-club-sand/40 pt-2"
      >
        {b.coverMetrics.map((m) => (
          <div
            key={m.key}
            data-testid={`cover-briefing-capital-program-kpi-${m.key}`}
            className="flex flex-col"
          >
            <dt className="text-[11px] uppercase tracking-[0.18em] text-club-green-800/70">
              {m.label}
            </dt>
            <dd className="mt-0.5 font-serif text-base leading-tight tabular-nums text-club-green-900">
              {m.value}
            </dd>
            <dd className="hidden text-[11px] text-club-green-800/70 [@media(min-height:880px)]:block">
              {m.sub}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

// ============================================================================
// Chapter II — Chair's Dashboard
// ============================================================================
//
// One-page summary of the entire Club, divided into the five
// stewardship pillars (Operations, Financial, Capital, Membership,
// Experience). Sits between the cover (Executive Briefing) and the
// long-form Board Financial Briefing.
//
// Intended reading flow:
//   Cover                → "What's the story?"
//   Chair's Dashboard    → "Show me the entire Club."
//   Board Briefing+      → "Tell me the details."
//
// Per the founder's direction this chapter is a Finance Chair's
// command center: a director who reads ONLY the cover + this chapter
// should understand approximately 80-90% of the Club's condition
// before entering the board meeting.
//
// Per first-scroll standard discipline, the five pillar cards must
// fit comfortably on one screen at the reference viewport (1440x900)
// without feeling crowded. The layout uses a single-row 5-column grid
// on lg+ viewports with a stacked fallback on narrower widths.

// The Five Observations — derived from the existing pkg.commentary
// boardHeadline fields. One sentence per pillar, Director-voice, no
// jargon. Ordered by attention severity (RED → YELLOW → GREEN) so the
// chair reads the most attention-requiring observation first; ties
// within an attention tier preserve canonical pillar order
// (Operations · Financial · Capital · Membership · Experience).
//
// Phase 1 — commentary is the single source of truth; observations are
// pulled straight from pkg.commentary.<pillar>.boardHeadline. A future
// optional pkg.executiveNarrative override field (Phase 2) and engine
// validation (Phase 3) build on this contract without changing the
// component's interface.
function getExecutiveNarrative(pkg: PkgT): Array<{
  key: string;
  pillarKey: PillarKey;
  pillarName: string;
  sentence: string;
  attention: Attention;
}> {
  const verdicts = computeAllPillarAttentions(pkg);
  const sources: Array<{
    key: string;
    pillarKey: PillarKey;
    pillarName: string;
    sentence: string;
    attention: Attention;
  }> = [
    {
      key: "operations",
      pillarKey: "operations",
      pillarName: "Operations",
      sentence: pkg.commentary.operations.boardHeadline ?? "",
      attention: verdicts.operations.attention,
    },
    {
      key: "financial",
      pillarKey: "financial",
      pillarName: "Financial Health",
      sentence: pkg.commentary.financialStatements.boardHeadline ?? "",
      attention: verdicts.financial.attention,
    },
    {
      key: "capital",
      pillarKey: "capital",
      pillarName: "Capital",
      sentence: pkg.commentary.capitalProjects.boardHeadline ?? "",
      attention: verdicts.capital.attention,
    },
    {
      key: "membership",
      pillarKey: "membership",
      pillarName: "Membership",
      sentence: pkg.commentary.membershipStewardship.boardHeadline ?? "",
      attention: verdicts.membership.attention,
    },
    {
      key: "experience",
      pillarKey: "experience",
      pillarName: "Experience",
      sentence: pkg.commentary.experienceStewardship.boardHeadline ?? "",
      attention: verdicts.experience.attention,
    },
  ];

  // Worst-attention first (RED → YELLOW → GREEN), preserving canonical
  // pillar order within each tier via a stable sort over rank.
  const rank: Record<Attention, number> = { red: 0, yellow: 1, green: 2 };
  return sources
    .filter((s) => s.sentence.length > 0)
    .map((s, idx) => ({ ...s, _idx: idx }))
    .sort((a, b) => rank[a.attention] - rank[b.attention] || a._idx - b._idx)
    .map(({ _idx: _, ...rest }) => rest)
    .slice(0, 5);
}

// Executive Narrative — The Five Observations.
//
// Opens the Chair's Dashboard chapter. Five Director-voice sentences,
// one per stewardship pillar, ordered by attention severity. Each
// observation carries a subtle engine-driven tone dot — the dot supports
// the narrative, it does not replace it. Reads in under 20 seconds and
// gives the chair the month's story before any metric tile is reviewed.
//
// Per the founder's spec:
//   - max 5 observations
//   - one sentence each (no paragraphs, no second supporting line)
//   - written for Directors, not accountants
//   - no jargon
//   - ordered by importance
//   - tone dots subtle; not a traffic-light dashboard
function ExecutiveNarrative({ observations }: {
  observations: ReturnType<typeof getExecutiveNarrative>;
}) {
  return (
    <section
      data-testid="executive-narrative"
      className="mt-8 border-t border-club-sand/70 pt-7"
      aria-label="The Five Observations"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3
          data-testid="executive-narrative-eyebrow"
          className="text-[10px] font-medium uppercase tracking-[0.22em] text-club-gold"
        >
          The Five Observations
        </h3>
        <span className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/55">
          Finance Chair&rsquo;s read of the month
        </span>
      </div>
      <ol
        data-testid="executive-narrative-list"
        className="mt-5 space-y-4"
      >
        {observations.map((obs, i) => (
          <li
            key={obs.key}
            data-testid={`executive-narrative-item-${obs.key}`}
            data-pillar={obs.pillarKey}
            data-attention={obs.attention}
            className="grid grid-cols-[auto_auto_1fr] items-baseline gap-x-4"
          >
            <span
              data-testid={`executive-narrative-item-${obs.key}-numeral`}
              className="font-serif text-[14px] tabular-nums text-club-gold-700/80"
            >
              {i + 1}.
            </span>
            <span
              data-testid={`executive-narrative-item-${obs.key}-dot`}
              className={`mt-[2px] h-1.5 w-1.5 shrink-0 rounded-full ${attentionDotClass(obs.attention)}`}
              aria-label={`${obs.pillarName} — ${labelFor(obs.pillarKey, obs.attention)}`}
            />
            <p
              data-testid={`executive-narrative-item-${obs.key}-sentence`}
              className="font-serif text-[17px] leading-[1.45] text-club-green-900/90"
            >
              {obs.sentence}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ============================================================================
// Board Decisions Required — sub-section of the Chair's Dashboard
// ============================================================================
//
// Sits BETWEEN the 5-pillar grid and Board Risks. Answers the most
// time-sensitive question in any Board package: "What does the Board
// need to DO this period?" Action outranks monitoring, so Decisions
// renders ahead of Risks.
//
// Per the founder's design direction (locked-in as a permanent
// Spectre Framework rule):
//   - Action vocabulary: APPROVE / REVIEW / RATIFY (3 verbs only)
//   - Max 3 decisions; ideally 0–2 in a typical month
//   - Filled action chip — heavier visual weight than Board Risks'
//     text-only severity label, because decisions drive action
//   - Gold accent stripe (4px) — slightly wider than Board Risks' 3px
//   - Healthy-month fallback "No Board decisions required this period."
//     reads as a SUCCESS state, not an empty placeholder
//   - No card grids, no shadow chrome, no SaaS-style alert widgets
//
// Visual emphasis cascade within the chip:
//   APPROVE → gold-filled (highest emphasis — Board must vote)
//   REVIEW  → green-filled neutral (medium — discussion / oversight)
//   RATIFY  → cream-filled with gold ring (lowest — formalising prior action)
function actionChipClass(a: DecisionAction): string {
  // Filled chips. Chip background and text color carry the emphasis
  // cascade; chip dimensions stay constant across actions so the
  // chair scans them in a single eye-fix.
  switch (a) {
    case "approve":
      // Highest emphasis — gold-700 filled, cream text. The Board
      // is being asked to vote.
      return "inline-flex items-center rounded-sm bg-club-gold-700 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-club-cream";
    case "review":
      // Medium emphasis — deep-green filled, cream text. Discussion
      // or oversight (committee report-out, sustained-trend review).
      return "inline-flex items-center rounded-sm bg-club-green-800 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-club-cream";
    case "ratify":
      // Lowest emphasis — cream filled with gold-700 ring + text.
      // Formalising a prior committee or management action.
      return "inline-flex items-center rounded-sm bg-club-cream px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-club-gold-700 ring-1 ring-club-gold-700/40";
  }
}

function actionLabel(a: DecisionAction): string {
  switch (a) {
    case "approve": return "APPROVE";
    case "review":  return "REVIEW";
    case "ratify":  return "RATIFY";
  }
}

function BoardDecisionRow({ decision, index }: { decision: BoardDecision; index: number }) {
  return (
    <li
      data-testid={`board-decision-row-${decision.key}`}
      data-action={decision.action}
      className="relative flex gap-5 border-b border-club-sand/60 py-6 last:border-b-0"
    >
      {/* Gold stripe — 4px wide (one pixel wider than Board Risks'
          3px stripe) signals the section's heavier weight. */}
      <span
        data-testid={`board-decision-row-${decision.key}-stripe`}
        aria-hidden
        className="mt-[2px] w-[4px] shrink-0 rounded-full bg-club-gold-700/80"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <span
              data-testid={`board-decision-row-${decision.key}-action`}
              className={actionChipClass(decision.action)}
            >
              {actionLabel(decision.action)}
            </span>
            <span
              data-testid={`board-decision-row-${decision.key}-meeting`}
              className="text-[11px] uppercase tracking-[0.22em] text-club-green-800/70"
            >
              by {decision.meeting}
            </span>
          </div>
          <span
            data-testid={`board-decision-row-${decision.key}-numeral`}
            className="font-serif text-[18px] tabular-nums text-club-gold-700/75"
          >
            {index + 1}
          </span>
        </div>
        <h4
          data-testid={`board-decision-row-${decision.key}-title`}
          className="font-serif text-2xl tracking-tight text-club-green-900 leading-tight"
        >
          {decision.title}
        </h4>
        <p
          data-testid={`board-decision-row-${decision.key}-ask`}
          className="max-w-[680px] font-serif text-[16px] italic leading-relaxed text-club-green-900/85"
        >
          {decision.ask}
        </p>
        <p
          data-testid={`board-decision-row-${decision.key}-sponsor`}
          className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/65"
        >
          <span className="text-club-gold-700/80">Sponsor&nbsp;·&nbsp;</span>
          {decision.sponsor}
        </p>
      </div>
    </li>
  );
}

function BoardDecisions({ decisions }: { decisions: BoardDecision[] }) {
  // Capped at 3 — per the founder's direction this is the absolute
  // maximum. A typical month carries 0–2 decisions.
  const visible = decisions.slice(0, 3);
  const isHealthyMonth = visible.length === 0;
  return (
    <section
      data-testid="board-decisions"
      data-empty={isHealthyMonth ? "true" : "false"}
      className="mt-10 border-t border-club-sand/70 pt-7"
      aria-label="Board Decisions Required"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3
          data-testid="board-decisions-eyebrow"
          className="text-[10px] font-medium uppercase tracking-[0.22em] text-club-gold"
        >
          Board Decisions Required
        </h3>
        <span className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/55">
          What the Board must decide
        </span>
      </div>
      <p
        data-testid="board-decisions-lead"
        className="mt-3 max-w-[680px] font-serif text-[16px] italic leading-relaxed text-club-green-900/85"
      >
        The items the Board is being asked to act on this period.
        Listed in meeting-precedence order.
      </p>

      {isHealthyMonth ? (
        // Healthy-month fallback — per founder direction this reads as
        // a SUCCESS, not a void. Stays gold-toned so the visual rhythm
        // with populated months is preserved.
        <ul
          data-testid="board-decisions-list"
          className="mt-6"
        >
          <li
            data-testid="board-decisions-empty-row"
            data-action="none"
            className="relative flex gap-5 py-5"
          >
            <span
              aria-hidden
              className="mt-[2px] w-[4px] shrink-0 rounded-full bg-club-gold-700/40"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p
                data-testid="board-decisions-empty-summary"
                className="max-w-[680px] font-serif text-[16px] leading-relaxed text-club-green-900/85"
              >
                No Board decisions required this period.
              </p>
            </div>
          </li>
        </ul>
      ) : (
        <ul
          data-testid="board-decisions-list"
          className="mt-6"
        >
          {visible.map((d, i) => (
            <BoardDecisionRow key={d.key} decision={d} index={i} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ============================================================================
// Board Risks — sub-section of the Chair's Dashboard
// ============================================================================
//
// Closes the Chair's Dashboard chapter, immediately below the 5-pillar
// grid. Answers "what requires continued attention". Hand-authored,
// management-judgment driven — NOT engine-derived (the engine can later
// suggest candidates; management approves).
//
// Per the founder's design direction:
//   - Severity vocabulary: HIGH / MODERATE / WATCH only
//     (no CRITICAL / SEVERE / URGENT — Board document, not IT alert)
//   - Trend vocabulary:    WORSENING / STABLE / IMPROVING / NEW
//   - Severity dominant, trend supporting
//   - No risk scores, no probabilities, no impact matrices
//   - Healthy-month fallback row renders when boardRisks is empty
//   - Capped at 5 by the component (.slice(0, 5))
//
// Visual hierarchy:
//   - Left tone stripe (red / amber / gold) is the eye-catcher
//   - Severity label (red/amber/gold smallcaps) leads each row
//   - Trend label follows in subtle tint (red-tint / neutral / green-tint / gold-tint)
//   - L3 sub-block title (text-2xl serif) — the headline
//   - L4 16px serif summary (not italic) — one Director-voice sentence
//   - Optional Board-action note in smallcaps below summary
function severityStripeClass(s: BoardRiskSeverity): string {
  switch (s) {
    case "high":     return "bg-red-700";
    case "moderate": return "bg-amber-700";
    case "watch":    return "bg-club-gold";
  }
}

function severityLabelClass(s: BoardRiskSeverity): string {
  switch (s) {
    case "high":     return "text-red-700";
    case "moderate": return "text-amber-700";
    case "watch":    return "text-club-gold-700";
  }
}

function severityLabel(s: BoardRiskSeverity): string {
  switch (s) {
    case "high":     return "HIGH";
    case "moderate": return "MODERATE";
    case "watch":    return "WATCH";
  }
}

function trendLabelClass(t: BoardRiskTrend): string {
  // Severity is dominant; trend tints are intentionally subtle. The
  // chair should read SEVERITY first and TREND second.
  switch (t) {
    case "worsening": return "text-red-700/75";
    case "stable":    return "text-club-green-800/55";
    case "improving": return "text-club-green-700/85";
    case "new":       return "text-club-gold-700/75";
  }
}

function trendLabel(t: BoardRiskTrend): string {
  switch (t) {
    case "worsening": return "WORSENING";
    case "stable":    return "STABLE";
    case "improving": return "IMPROVING";
    case "new":       return "NEW";
  }
}

function BoardRiskRow({ risk, index }: { risk: BoardRisk; index: number }) {
  return (
    <li
      data-testid={`board-risk-row-${risk.key}`}
      data-severity={risk.severity}
      data-trend={risk.trend}
      className="relative flex gap-5 border-b border-club-sand/60 py-5 last:border-b-0"
    >
      {/* Left tone stripe — the dominant visual cue. 4px wide so the eye
          lands here first. */}
      <span
        data-testid={`board-risk-row-${risk.key}-stripe`}
        aria-hidden
        className={`mt-[2px] w-[3px] shrink-0 rounded-full ${severityStripeClass(risk.severity)}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span
              data-testid={`board-risk-row-${risk.key}-severity`}
              className={`text-[11px] font-medium uppercase tracking-[0.22em] ${severityLabelClass(risk.severity)}`}
            >
              {severityLabel(risk.severity)}
            </span>
            <span className={`text-[10px] uppercase tracking-[0.22em] ${trendLabelClass(risk.trend)}`}>
              ·
            </span>
            <span
              data-testid={`board-risk-row-${risk.key}-trend`}
              className={`text-[10px] uppercase tracking-[0.22em] ${trendLabelClass(risk.trend)}`}
            >
              {trendLabel(risk.trend)}
            </span>
          </div>
          <span
            data-testid={`board-risk-row-${risk.key}-numeral`}
            className="font-serif text-[14px] tabular-nums text-club-gold-700/65"
          >
            {index + 1}
          </span>
        </div>
        <h4
          data-testid={`board-risk-row-${risk.key}-title`}
          className="font-serif text-2xl tracking-tight text-club-green-900 leading-tight"
        >
          {risk.title}
        </h4>
        <p
          data-testid={`board-risk-row-${risk.key}-summary`}
          className="max-w-[680px] font-serif text-[16px] leading-relaxed text-club-green-900/85"
        >
          {risk.summary}
        </p>
        {risk.boardAction ? (
          <p
            data-testid={`board-risk-row-${risk.key}-board-action`}
            className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/60"
          >
            <span className="text-club-gold-700/80">Board action&nbsp;·&nbsp;</span>
            {risk.boardAction}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function BoardRisks({ risks }: { risks: BoardRisk[] }) {
  const visible = risks.slice(0, 5);
  const isHealthyMonth = visible.length === 0;
  return (
    <section
      data-testid="board-risks"
      data-empty={isHealthyMonth ? "true" : "false"}
      className="mt-10 border-t border-club-sand/70 pt-7"
      aria-label="Board Risks"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3
          data-testid="board-risks-eyebrow"
          className="text-[10px] font-medium uppercase tracking-[0.22em] text-club-gold"
        >
          Board Risks
        </h3>
        <span className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/55">
          What requires continued attention
        </span>
      </div>
      <p
        data-testid="board-risks-lead"
        className="mt-3 max-w-[680px] font-serif text-[16px] italic leading-relaxed text-club-green-900/85"
      >
        The exposures the Board is monitoring this period. Ranked by materiality.
        Severity reflects current condition; trend reflects direction since prior period.
      </p>

      {isHealthyMonth ? (
        // Healthy-month fallback row — per founder direction, the
        // system never manufactures risks. Stays visible so the
        // chapter is honest about why the list is empty.
        <ul
          data-testid="board-risks-list"
          className="mt-6"
        >
          <li
            data-testid="board-risks-empty-row"
            data-severity="watch"
            className="relative flex gap-5 py-5"
          >
            <span
              aria-hidden
              className={`mt-[2px] w-[3px] shrink-0 rounded-full ${severityStripeClass("watch")}`}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span className={`text-[11px] font-medium uppercase tracking-[0.22em] ${severityLabelClass("watch")}`}>
                {severityLabel("watch")}
              </span>
              <p
                data-testid="board-risks-empty-summary"
                className="max-w-[680px] font-serif text-[16px] leading-relaxed text-club-green-900/85"
              >
                No material risks requiring Board action this period.
              </p>
            </div>
          </li>
        </ul>
      ) : (
        <ul
          data-testid="board-risks-list"
          className="mt-6"
        >
          {visible.map((r, i) => (
            <BoardRiskRow key={r.key} risk={r} index={i} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ============================================================================
// Stewardship Dashboard — visual-first two-card opener for Section II
// ============================================================================
//
// Two equal-width cards rendered side-by-side immediately after the
// Executive Briefing. Each card answers ONE board question; the chart
// is the dominant element, the KPI ribbon is supporting, the
// interpretation is footer-tier prose (max 2 sentences). The cards
// stack on narrow viewports; on xl+ they sit side-by-side.
//
// Chart implementation is intentionally a hand-rolled SVG renderer
// (no chart library) so the typography, line weight, and benchmark
// styling stay inside the editorial palette and aren't dragged into
// a SaaS-analytics aesthetic by a heavy dependency.

type DashSeries = { label: string; value: number };

// EditorialLineChart lives in its own client component module so it can
// track its container width with ResizeObserver — without this, the
// SVG capped at viewBox aspect 3.0 and left ~221 px of cream gutters
// inside the Equity card at viewports ≥ 1600 px.
//
// The LineChart's LegendEntry models a LINE preview (stroke +
// dasharray + optional marker) because Saguaro's line-chart legend
// shows a short line sample, not a filled box. The BarChart's
// LegendEntry supports BOTH a filled rectangle (for bars) and a
// stroked line sample (for overlay lines like prior-year) so the
// legend always previews the actual chart glyph.
import { EditorialLineChart } from "@/components/reporting/EditorialLineChart";
import { EditorialChartReveal } from "@/components/reporting/EditorialChartReveal";
import {
  EditorialBarChart,
  type BarLegendEntry,
} from "@/components/reporting/EditorialBarChart";
import { DuesSubsidyDonut } from "@/components/reporting/DuesSubsidyDonut";
import { EditorialGroupedBarChart } from "@/components/reporting/EditorialGroupedBarChart";

// (Old in-page EditorialLineChart server function removed — the chart
// now lives in `src/components/reporting/EditorialLineChart.tsx` as a
// client component so it can track its container width via
// ResizeObserver and grow with the card at viewports > 1600 px.)

// One KPI in the ribbon above each chart. Sized as SUPPORTING tier —
// small smallcaps label + restrained serif value. The KPIs MUST feel
// quieter than the chart's actual line so the chart remains the
// primary storyteller; the values use the deeper, less-saturated
// club-green-800 family (never the saturated club-green-500 the
// chart's actual line carries), and the label/value contrast is held
// noticeably below the chart's line-to-background contrast.
// (Old in-page EditorialBarChart server function removed — the chart
// now lives in `src/components/reporting/EditorialBarChart.tsx` as a
// client component so it can track its container width via
// ResizeObserver, render uniform-scale SVG, and emit a line-preview
// legend. See the equity-card-spec.md baseline this brings parity to.)

// One KPI tile in the 4-cell ribbon below each panel header. Built to
// the Saguaro p03 spec measured in
// docs/spectre-stewardship-rebuild-spec.md: large status-tinted serif
// numeral on top (Cormorant Garamond 700 @ 20.7 px in Saguaro;
// rendered here in Spectre's Source Serif 4 @ 21 px / 700), smallcaps
// label below in tracked sans uppercase (Saguaro DM Mono @ 9 px;
// rendered here in system sans @ 9.5 px with matching letter-spacing).
// All 4 tiles in a card share the same size — Saguaro does NOT use a
// "primary" vs "neutral" tier here.
type KpiStatus = "primary" | "neutral" | "favourable" | "unfavourable";

function StewardshipKpi({ label, value, status = "neutral" }: {
  label: string;
  value: string;
  /** Status colour for the numeral. Mirrors Saguaro's four status
   *  tones, all sourced from the existing Spectre palette except the
   *  unfavourable red, which uses a Saguaro-matched literal. */
  status?: KpiStatus;
}) {
  const numeralColor =
    status === "primary"       ? "text-club-gold"          : // gold for the lead metric (Saguaro: rgb(154, 123, 58))
    status === "favourable"    ? "text-club-green-500"     : // saturated green for "above plan"
    status === "unfavourable"  ? "text-[#8b3520]"          : // Saguaro-matched clay; not a new token
                                 "text-club-green-900";      // neutral dark green
  // Each KPI now renders as its OWN small editorial card — ivory
  // (cream) panel + subtle club-green-800/15 border + small radius.
  // Mirrors the Saguaro Equity / Operating Stewardship ribbon tiles:
  // centred serif value, smallcaps label below, quiet boardroom
  // chrome (no shadows, no decorative effects).
  return (
    <div className="flex h-full flex-col items-center justify-center rounded border border-club-green-800/15 bg-club-cream px-2">
      <span
        className={`font-serif font-bold tabular-nums leading-none tracking-tight ${numeralColor}`}
        style={{ fontSize: "21px" }}
      >
        {value}
      </span>
      <span
        className="mt-1.5 uppercase font-medium text-club-green-800/60"
        style={{ fontSize: "9px", letterSpacing: "0.9px" }}
      >
        {label}
      </span>
    </div>
  );
}

// Single card scaffold shared by both stewardship charts. Tier targets:
//   - Header (title + question)       ≈ 8-10% of card height
//   - KPI ribbon                      ≈ 15-20% of card height
//   - Chart (flex-1, h-full SVG)      ≈ 70-75% of card height
//   - Interpretation footer prose     ≈ 10-12% of card height
// The chart's `flex-1` + the SVG's `h-full` together ensure the chart
// claims every pixel the header/ribbon/footer don't, so as we shrink
// those tiers the chart grows automatically. No fixed chart height
// shipped — the chart adapts to whatever space the other tiers leave.
// Renders an interpretation string with markdown-style **bold**
// inline emphasis. Each `**...**` span becomes a non-italic semibold
// run that sits inside the surrounding italic prose — the Saguaro
// commentary-band convention measured in
// docs/spectre-stewardship-rebuild-spec.md.
function renderInterpretation(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**")
      ? <strong key={i} className="font-semibold not-italic text-club-green-900">{p.slice(2, -2)}</strong>
      : <span key={i}>{p}</span>,
  );
}

// Saguaro p03 reference replication — the four-band card structure.
// Card dims: 534 × 513 px (Saguaro). Outer padding 0; each band has
// its own background + padding. Heights match Saguaro's measured
// percentages: header 15% (76 px), KPI ribbon ~26% (135 px),
// chart 39% (200 px), commentary 20% (102 px).
function StewardshipCard({
  title, subtitle, chipLabel, kpis, chart, interpretation, testid,
  layout = "default",
  insetCommentary = false,
}: {
  title: string;
  /** Smallcaps subtitle inside the dark header band — the "question"
   *  the chart answers, rendered as tracked uppercase per Saguaro. */
  subtitle: string;
  /** Gold smallcaps chip on the right side of the header band
   *  (Saguaro: "NET WORTH" / "NOI TREND"). */
  chipLabel: string;
  kpis: React.ReactNode;
  chart: React.ReactNode;
  interpretation: string;
  testid: string;
  /** Layout variant. "default" keeps the original 77/200/102 band
   *  heights used by Operating Results. "chart-dominant" trims the
   *  KPI ribbon and commentary so the chart band can grow — the
   *  Equity Value Over Time card uses this to make the chart the
   *  hero element per the founder's directive. */
  layout?: "default" | "chart-dominant";
  /** When true, the commentary's green-tinted block is wrapped in a
   *  px-3.5 gutter so it sits INSIDE the card body rather than
   *  touching the outer card edges. Saguaro-style executive-report
   *  convention. Default false to preserve Operating Results' full-
   *  width treatment. */
  insetCommentary?: boolean;
}) {
  const dims = layout === "chart-dominant"
    ? {
        // Chart-dominant band heights. Re-balanced so the commentary
        // band can hold the full 4-line interpretation prose (≈ 95 px
        // text + padding) without the green-tinted shading clipping
        // through the card edge. Chart drops 15 px (260 → 245) and
        // commentary gains 15 (85 → 100); chart is still the hero
        // (245 / 60 ≈ 4× the KPI ribbon).
        kpiHeight: 60,
        chartHeight: 245,
        commentaryHeight: 100,
        kpiMarginTop: 12,
        chartMarginTop: 10,
        commentaryMarginTop: 8,
      }
    : {
        kpiHeight: 77,
        chartHeight: 200,
        commentaryHeight: 102,
        kpiMarginTop: 16,
        chartMarginTop: 14,
        commentaryMarginTop: 10,
      };
  return (
    <article
      data-testid={testid}
      className="flex w-full flex-1 flex-col overflow-hidden rounded-md border border-club-green-800/10 bg-club-cream"
      style={{ height: 513 }}
    >
      {/* Band 1 — Header. Dark deep-green slab with serif title +
          smallcaps subtitle + gold smallcaps chip on the right.
          Saguaro measured: 76 px tall, padding 12/18/12/18, bg
          rgb(42, 61, 37). */}
      <header
        className="flex items-start justify-between bg-club-green-900"
        style={{ height: 76, paddingTop: 12, paddingBottom: 12, paddingLeft: 18, paddingRight: 18 }}
      >
        <div className="min-w-0 flex-1 pr-3">
          <h3 className="font-serif text-club-cream" style={{ fontSize: "17px", fontWeight: 600, lineHeight: 1.2 }}>
            {title}
          </h3>
          {/* Subtitle: the "question" the chart answers, rendered as
              quiet smallcaps per Saguaro. Readability bumps (founder
              feedback): cream opacity 45 → 70, fontSize 9 → 10.5,
              letterSpacing 1.1 → 0.7. Still subordinate to the title,
              still editorial — but legible at board-package viewing
              distance instead of squinty. */}
          <p
            className="mt-1 uppercase text-club-cream/70"
            style={{ fontSize: "10.5px", letterSpacing: "0.7px", lineHeight: 1.35 }}
          >
            {subtitle}
          </p>
        </div>
        <span
          className="inline-flex shrink-0 items-center rounded-full border border-club-gold/30 px-2.5 py-1 uppercase text-club-gold"
          style={{ fontSize: "9px", letterSpacing: "1px", fontWeight: 500 }}
        >
          {chipLabel}
        </span>
      </header>

      {/* Band 2 — KPI ribbon. Default layout: 77 px. Chart-dominant:
          60 px (frees vertical room for a taller chart band below).
          Each KPI is its own small editorial card (chrome lives on
          StewardshipKpi). No tinted wash sits behind the ribbon — the
          tile borders carry the visual structure. */}
      <div
        className="grid grid-cols-4 gap-1.5 px-3.5"
        style={{ height: dims.kpiHeight, marginTop: dims.kpiMarginTop }}
      >
        {kpis}
      </div>

      {/* Band 3 — Chart canvas. Default layout: 200 px. Chart-dominant:
          260 px (the chart becomes the hero of the card). */}
      <div
        className="bg-club-cream"
        style={{ height: dims.chartHeight, marginTop: dims.chartMarginTop }}
      >
        {chart}
      </div>

      {/* Band 4 — Commentary band. Default layout: 102 px. Chart-
          dominant: 85 px. Same green-wash background as Saguaro's
          trend-note in both variants.
          When insetCommentary is true, the tinted block is wrapped in
          a px-3.5 lateral gutter so the green wash does not touch the
          card edges — Saguaro-style inset for executive surfaces. */}
      {insetCommentary ? (
        // Outer wrapper holds the band's fixed footprint (so the
        // card's flex column maths still add to 513 px). The INNER
        // <p> auto-sizes to its text + padding so the green wash
        // wraps only the commentary, instead of filling the
        // leftover band space down to the card bottom. Any
        // remaining vertical room within the band stays cream —
        // Saguaro's "shading stops at the text" convention.
        <div
          className="px-3.5"
          style={{
            height: dims.commentaryHeight,
            marginTop: dims.commentaryMarginTop,
          }}
        >
          <p
            data-testid={`${testid}-commentary`}
            className="font-sans italic text-club-green-900"
            style={{
              padding: "10px 14px",
              fontSize: "13px",
              lineHeight: 1.45,
              backgroundColor: "rgba(63, 112, 66, 0.10)",
              borderLeft: "3px solid rgba(63, 112, 66, 0.55)",
            }}
          >
            {renderInterpretation(interpretation)}
          </p>
        </div>
      ) : (
        <p
          data-testid={`${testid}-commentary`}
          className="font-sans italic text-club-green-900"
          style={{
            height: dims.commentaryHeight,
            marginTop: dims.commentaryMarginTop,
            padding: "10px 16px",
            fontSize: "13px",
            lineHeight: 1.45,
            backgroundColor: "rgba(63, 112, 66, 0.10)",
          }}
        >
          {renderInterpretation(interpretation)}
        </p>
      )}
    </article>
  );
}

// Card 1 — Equity Value Over Time. Long-term stewardship.
function EquityValueCard({ data }: {
  data: {
    series: DashSeries[];
    benchmarkBest: DashSeries[];
    benchmarkMin: DashSeries[];
    actualCagrLabel: string;
    bestInClassCagrLabel: string;
    minimumRequiredCagrLabel: string;
    currentValueLabel: string;
    interpretation: string;
    yAxisMin: number;
    yAxisMax: number;
    yAxisTicks: number;
  };
}) {
  const xLabels = data.series.map((p) => p.label);
  const chart = (
    <EditorialChartReveal testid="stewardship-equity-reveal">
    <EditorialLineChart
      xLabels={xLabels}
      // Chart-dominant layout: 245 px chart band (default Operating
      // layout is 200) so the chart remains the hero of the card.
      // Must match StewardshipCard's chart-dominant chartHeight so
      // the SVG viewBox matches the container div.
      height={245}
      // Y-axis label column alignment: the y-tick labels ("$15M",
      // "$20M", …) sit in the left padding band, right-anchored at
      // (padLeft − 8) viewBox px. With padLeft=44, the LEFT edge of
      // the widest label ("$35M") lands within ~1 px of the LEFT
      // edge of the Actual CAGR KPI tile directly above the chart —
      // a Saguaro-tier vertical alignment invariant the founder
      // anchored. Default 66 would push the labels ~21 px right of
      // the KPI tile edge.
      padLeft={44}
      // Rightmost-data-point alignment: with padRight=14 the FY2025
      // marker (and the "2025" x-axis label, which is text-anchor=end)
      // lands within ~1 px of the RIGHT edge of the Current Equity
      // KPI tile directly above the chart. Default 31 would leave the
      // marker ~17 px short of the KPI tile edge.
      padRight={14}
      formatY="dollars-millions"
      // Y-domain + tick count come from `formatEquityDashboard` (in
      // src/lib/reporting/monthly-package.ts), which derives them
      // dynamically from the data:
      //   - yAxisMin  = floor(first plotted value / $5M) × $5M
      //   - yAxisMax  = ceil(highest plotted value / $5M) × $5M
      //   - yAxisTicks = (yAxisMax − yAxisMin) / 5
      // Nothing here is hardcoded — the chart adapts as the GL-fed
      // series changes.
      yDomain={[data.yAxisMin, data.yAxisMax]}
      yTicks={data.yAxisTicks}
      lines={[
        // Minimum required — quietest dashed line.
        {
          values: data.benchmarkMin.map((p) => p.value),
          stroke: "stroke-club-gold",
          width: 1.4,
          dasharray: "3 4",
          opacity: 0.55,
        },
        // Best-in-class — quiet dashed line.
        {
          values: data.benchmarkBest.map((p) => p.value),
          stroke: "stroke-club-gold",
          width: 1.4,
          dasharray: "6 4",
          opacity: 0.65,
        },
        // Actual equity — DOMINANT solid line with point markers
        // (Saguaro convention). The line also opts in to the
        // Saguaro "veiled green area" — a subtle muted-green fill
        // beneath the line, sitting BEHIND the benchmark dashes.
        {
          values: data.series.map((p) => p.value),
          stroke: "stroke-club-green-500",
          width: 2.4,
          markers: true,
          markerFill: "fill-club-green-500",
          areaFill: "fill-club-green-500/10",
        },
      ]}
      legend={[
        // Legend previews MIRROR the actual chart lines — same stroke,
        // same width, same dasharray, same opacity — so the legend
        // reads as a true preview of what's on the chart, not a
        // generic boxed key. Club Equity carries the round marker that
        // also sits on every data point of the actual line.
        {
          label: "Club Equity",
          stroke: "stroke-club-green-500",
          strokeWidth: 2.4,
          showMarker: true,
          markerFill: "fill-club-green-500",
        },
        {
          label: "Best-in-Class",
          stroke: "stroke-club-gold",
          strokeWidth: 1.4,
          dasharray: "6 4",
          opacity: 0.65,
        },
        {
          label: "Min. Required",
          stroke: "stroke-club-gold",
          strokeWidth: 1.4,
          dasharray: "3 4",
          opacity: 0.55,
        },
      ]}
      // Founder rule 2026-07-05 v15.12 — shared editorial hover.
      // The tooltip snaps to the nearest FISCAL YEAR (each x-slot
      // is one closed FY per `formatEquityDashboard`) and surfaces
      // ONLY the Club Equity row — the benchmark overlays are
      // reference lines, not values the reader needs at hover time.
      // Values are the pre-scaled millions the y-axis already
      // displays, but rendered with one decimal at hover time
      // ("$28.9M") to match the Current Equity KPI tile above the
      // chart — the y-axis rounds to whole $M so we override with
      // the shared `dollars-millions-1d` descriptor rather than a
      // closure (RSC-serialisable).
      tooltip={{
        xHeaders: xLabels,
        lineLabels: [null, null, "Club Equity"],
        valueFormat: "dollars-millions-1d",
      }}
    />
    </EditorialChartReveal>
  );

  return (
    <StewardshipCard
      testid="stewardship-equity"
      title="Equity Value Over Time"
      subtitle='"Is the club’s financial health growing, stagnant, or declining?"'
      chipLabel="Net Worth"
      // Chart-dominant: KPI ribbon shrinks (77 → 60), commentary
      // shrinks (102 → 85), chart grows (200 → 260). Reclaimed
      // vertical pixels go directly to the plot region — the founder
      // directive: chart is the hero, KPIs support it.
      layout="chart-dominant"
      // Saguaro-style inset: the green-tinted commentary block sits
      // inside the card body with px-3.5 lateral gutter instead of
      // spanning edge-to-edge. Operating Results keeps the default
      // full-width treatment.
      insetCommentary
      kpis={
        <>
          <StewardshipKpi label="Actual CAGR" value={data.actualCagrLabel} status="primary" />
          <StewardshipKpi label="Best-in-Class" value={data.bestInClassCagrLabel} status="neutral" />
          <StewardshipKpi label="Min. Required" value={data.minimumRequiredCagrLabel} status="favourable" />
          <StewardshipKpi label="Current Equity" value={data.currentValueLabel} status="neutral" />
        </>
      }
      chart={chart}
      interpretation={data.interpretation}
    />
  );
}

// Card 2 — Operating Results 12-Month Rolling.
function OperatingResultsCard({ data }: {
  data: {
    series: DashSeries[];
    budget: DashSeries[];
    /** Monthly prior-year NOI ($K) — retained on the data shape for
     *  any downstream consumer; the chart itself plots the cumulative
     *  series below so the line reconciles visually to the KPI tile. */
    priorYear: DashSeries[];
    /** Prior-year YTD CUMULATIVE NOI ($K) — running sum of priorYear.
     *  Endpoint always equals the Prior Year KPI value, so the
     *  chart's overlay line ANCHORS visually at the KPI tile value
     *  by construction (no React-side literal is involved). */
    priorYearYtd: DashSeries[];
    breakEven: number;
    breakEvenCorridor: { lower: number; upper: number };
    ytdNoiLabel: string;
    noiPctRevenueLabel: string;
    budgetGoalLabel: string;
    priorYearLabel: string;
    interpretation: string;
  };
}) {
  const xLabels = data.series.map((p) => p.label);
  // Y-axis domain is COMPUTED from the actual plotted data, NEVER
  // hardcoded. Inputs:
  //   - data.series         (monthly NOI bars)
  //   - data.budget         (monthly budget bars)
  //   - data.priorYearYtd   (CUMULATIVE prior-year line, ending at
  //                          the Prior Year KPI value)
  // Rounded to the nearest $50K so the y-tick labels stay in
  // board-readable increments. Using the CUMULATIVE prior-year series
  // (not monthly) means the y-axis naturally reaches the depth of the
  // YTD loss displayed in the KPI tile — fixing the prior visual
  // mismatch where the y-axis stopped at ~($125K) even though the
  // Prior Year KPI was ($193K).
  const ROUND_INC_K = 50;
  const allYs = [
    ...data.series.map((p) => p.value),
    ...data.budget.map((p) => p.value),
    ...data.priorYearYtd.map((p) => p.value),
  ];
  const rawMin = Math.min(...allYs, 0);
  const rawMax = Math.max(...allYs, 0);
  const yLo = Math.floor(rawMin / ROUND_INC_K) * ROUND_INC_K;
  const yHi = Math.ceil(rawMax / ROUND_INC_K) * ROUND_INC_K;
  const yTickCount = Math.max(2, Math.round((yHi - yLo) / ROUND_INC_K));

  const chart = (
    <EditorialChartReveal testid="stewardship-operating-reveal">
    <EditorialBarChart
      xLabels={xLabels}
      // Match the Equity card's chart-dominant chart-band height so
      // the two cards share a visual baseline at the same row.
      height={245}
      formatY="dollars-thousands"
      yDomain={[yLo, yHi]}
      yTicks={yTickCount}
      // Y-axis label column → YTD NOI tile LEFT edge alignment.
      // Default padL=48 left labels ~20 px right of the tile edge.
      // padLeft=44 lands them within ~1 px of the KPI tile edge,
      // matching the equity card's alignment invariant.
      padLeft={44}
      // Rightmost bar slot → Prior Year tile RIGHT edge alignment.
      // Default padR=16 left the right column short. padRight=14
      // pushes the last bar slot's centre to within ~1 px of the
      // Prior Year tile right edge.
      padRight={14}
      // Primary diverging bars: favourable green for ≥ 0, Saguaro-
      // matched clay for < 0.
      primary={{
        values: data.series.map((p) => p.value),
        positiveFill: "fill-club-green-500",
        negativeFill: "fill-[#8b3520]",
      }}
      // Budget as narrower tan bars behind the primary.
      secondary={{
        values: data.budget.map((p) => p.value),
        fill: "fill-club-gold",
        opacity: 0.55,
      }}
      // Prior-year YTD CUMULATIVE — the running sum of prior-year
      // monthly NOI. The line's right-edge endpoint equals the Prior
      // Year KPI tile value by construction, so the chart visually
      // reconciles to the KPI strip above. (Previously this used
      // data.priorYear monthly values, which never reached the depth
      // of the YTD loss — the chart and KPI told different stories.)
      overlay={{
        values: data.priorYearYtd.map((p) => p.value),
        stroke: "stroke-club-green-800",
        width: 1.3,
        dasharray: "2 4",
        opacity: 0.65,
      }}
      // Legend previews MIRROR the actual chart glyphs. Bars use a
      // filled rectangle that matches each series's `fill-` class
      // exactly; the prior-year overlay uses a stroked dashed line
      // sample matching `dasharray: "2 4"` on the chart. No more
      // generic uniform-colour swatches.
      legend={[
        {
          label: "Actual",
          // Saguaro-style diagonally split swatch — the upper-right
          // triangle uses the same fill as positive bars, the
          // lower-left triangle uses the same fill as negative
          // bars. Communicates "Actual can be either positive or
          // negative" without forcing the chair to inspect the bars.
          // Fills MIRROR `primary.positiveFill` / `primary.negativeFill`
          // above so the legend always previews the actual chart
          // colours, never a generic guess.
          shape: "split-bar",
          positiveSwatch: "fill-club-green-500",
          negativeSwatch: "fill-[#8b3520]",
        },
        {
          label: "Budget",
          shape: "bar",
          swatch: "fill-club-gold",
          opacity: 0.55,
        },
        {
          // Labelled "YTD" so the legend names the cumulative
          // semantics of the line — it traces the running prior-year
          // NOI, anchored on the Prior Year KPI tile at the right
          // edge.
          label: "Prior Year YTD",
          shape: "line",
          stroke: "stroke-club-green-800",
          strokeWidth: 1.3,
          dasharray: "2 4",
          opacity: 0.65,
        },
      ]}
    />
    </EditorialChartReveal>
  );

  // YTD NOI status — green if positive, clay if negative.
  const ytdPositive = !data.ytdNoiLabel.includes("(");
  const priorPositive = !data.priorYearLabel.includes("(");

  return (
    <StewardshipCard
      testid="stewardship-operating"
      title="Operating Results — 12-Month Rolling Trend"
      subtitle="Actual vs. Budget vs. Prior Year · Break-Even Zone (−2.8% to +3.3%)"
      chipLabel="NOI Trend"
      // Mirror the Equity card's chart-dominant hierarchy. KPI ribbon
      // shrinks (77 → 60), commentary shrinks-to-text (102 → 100),
      // chart band grows (200 → 245). Chart becomes the hero —
      // matching the equity card's locked layout.
      layout="chart-dominant"
      // Saguaro-style inset commentary: green-tinted text block sits
      // inside the card body with px-3.5 gutter + 3px deep-green
      // border-left accent. Same treatment the equity card uses.
      insetCommentary
      kpis={
        <>
          <StewardshipKpi
            label="YTD NOI"
            value={data.ytdNoiLabel}
            status={ytdPositive ? "favourable" : "unfavourable"}
          />
          <StewardshipKpi label="% of Revenue" value={data.noiPctRevenueLabel} status="neutral" />
          <StewardshipKpi label="Budget Goal" value={data.budgetGoalLabel} status="neutral" />
          <StewardshipKpi
            label="Prior Year"
            value={data.priorYearLabel}
            status={priorPositive ? "neutral" : "unfavourable"}
          />
        </>
      }
      chart={chart}
      interpretation={data.interpretation}
    />
  );
}

// ---------------------------------------------------------------------------
// StewardshipScorecardCard — ClubBenchmarking-style KPI table.
//
// Saguaro reference anatomy:
//   1. Dark green header band — serif title + smallcaps subtitle on
//      the left; three small status dots (On Track / Monitor / Action)
//      with their labels on the right.
//   2. Cream section-band row below the header (single smallcaps line
//      naming the metric domain — e.g. "NON-PROFIT OPERATING LEDGER").
//   3. Column header row — "Metric" on the left, three center-anchored
//      column labels (Actual / Budget / Benchmark).
//   4. KPI rows — alternating row tint, status dot on the left, metric
//      name + italic description, three values, status glyph on right.
// ---------------------------------------------------------------------------

type ScorecardData = Awaited<ReturnType<typeof getMonthlyReportingPackage>>["stewardshipDashboard"]["scorecards"]["operating"];

/** Colour for the row's status dot. Uses Tailwind arbitrary-hex
 *  values rather than the saturated tone class names the Executive
 *  Reporting color audit forbids elsewhere on the page (those read as
 *  SaaS-style stoplight chips and were removed from card chrome).
 *  Saguaro-style scorecards legitimately need three status colours —
 *  the hex values below match the brand palette exactly. */
function scorecardDotClass(status: ScorecardData["rows"][number]["status"]): string {
  switch (status) {
    case "on-track": return "bg-[#3f7042]"; // brand green (= club-green-500 hex)
    case "monitor":  return "bg-[#b08a4a]"; // brand gold  (= club-gold hex)
    case "action":   return "bg-[#8b3520]"; // brand clay  (Saguaro negatives)
  }
}

/** Trend / status glyph rendered on the right of each row. By
 *  default the arrow direction follows the status (on-track ↑,
 *  monitor →, action ↓) — but a row can override this via an
 *  explicit `trend` field when status and direction don't agree
 *  (e.g. a Monitor-status row that is still trending DOWN). */
function scorecardStatusGlyph(row: ScorecardData["rows"][number]): string {
  if (row.trend) {
    switch (row.trend) {
      case "up":   return "↑";
      case "down": return "↓";
      case "flat": return "→";
    }
  }
  switch (row.status) {
    case "on-track": return "↑";
    case "monitor":  return "→";
    case "action":   return "↓";
  }
}

function StewardshipScorecardCard({
  data,
  testid,
}: {
  data: ScorecardData;
  testid: string;
}) {
  return (
    <article
      data-testid={testid}
      className="flex w-full flex-1 flex-col overflow-hidden rounded-md border border-club-green-800/10 bg-club-cream"
    >
      {/* Band 1 — Header. Dark deep-green slab with serif title on the
          left + three legend dots on the right. */}
      <header
        className="flex items-start justify-between bg-club-green-900"
        style={{ padding: "12px 18px" }}
      >
        <div className="min-w-0 flex-1 pr-3">
          <h3
            data-testid={`${testid}-title`}
            className="font-serif text-club-cream"
            style={{ fontSize: "17px", fontWeight: 600, lineHeight: 1.2 }}
          >
            {data.title}
          </h3>
          <p
            data-testid={`${testid}-subtitle`}
            className="mt-1 uppercase text-club-cream/70"
            style={{ fontSize: "10.5px", letterSpacing: "0.7px", lineHeight: 1.35 }}
          >
            {data.subtitle}
          </p>
        </div>
        {/* Top-right legend — three colored dots with smallcaps labels.
            Saguaro convention: legend lives inside the header band, not
            in a separate ribbon below it. */}
        <div
          data-testid={`${testid}-legend`}
          className="flex shrink-0 items-center gap-3 pl-3"
          style={{ fontSize: "9px", letterSpacing: "0.9px", lineHeight: 1, color: "rgba(248,245,239,0.75)" }}
        >
          {[
            { status: "on-track" as const, label: "On Track" },
            { status: "monitor" as const,  label: "Monitor" },
            { status: "action" as const,   label: "Action" },
          ].map((l) => (
            <span key={l.status} className="inline-flex items-center gap-1.5 uppercase">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${scorecardDotClass(l.status)}`} />
              {l.label}
            </span>
          ))}
        </div>
      </header>

      {/* Band 2 — Cream section-divider band, single line, smallcaps. */}
      <div
        data-testid={`${testid}-section-band`}
        className="border-b border-club-sand bg-club-cream/70 px-4 py-2 uppercase text-club-green-800/75"
        style={{ fontSize: "10px", letterSpacing: "1.4px" }}
      >
        {data.sectionBand}
      </div>

      {/* Band 3 — Column headers. Narrow, smallcaps, centered values.
          Layout: [metric column] [actual] [budget] [benchmark] [glyph]
          The trailing glyph column has no header label (just the
          status arrow). */}
      <div
        className="grid items-center border-b border-club-sand bg-club-cream/40 px-4 py-2 uppercase text-club-green-800/65"
        style={{
          fontSize: "9.5px",
          letterSpacing: "1.1px",
          gridTemplateColumns: "minmax(0, 1fr) 4.4rem 4.4rem 5.2rem 1.4rem",
          columnGap: "0.75rem",
        }}
      >
        <span>Metric</span>
        <span className="text-center">{data.columnHeaders.actual}</span>
        <span className="text-center">{data.columnHeaders.budget}</span>
        <span className="text-center">{data.columnHeaders.benchmark}</span>
        <span />
      </div>

      {/* Band 4 — KPI rows. Alternating row tint per Saguaro. */}
      <div data-testid={`${testid}-rows`}>
        {data.rows.map((row, i) => (
          <div
            key={row.key}
            data-testid={`${testid}-row-${row.key}`}
            data-status={row.status}
            className={`grid items-center px-4 py-3 ${
              i % 2 === 1 ? "bg-club-sand/30" : "bg-club-cream"
            } ${i < data.rows.length - 1 ? "border-b border-club-sand/40" : ""}`}
            style={{
              gridTemplateColumns: "minmax(0, 1fr) 4.4rem 4.4rem 5.2rem 1.4rem",
              columnGap: "0.75rem",
            }}
          >
            {/* Metric column — status dot + name + italic description. */}
            <div className="min-w-0 flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${scorecardDotClass(row.status)}`}
              />
              <div className="min-w-0">
                <div
                  className="font-serif text-club-green-900"
                  style={{ fontSize: "13px", fontWeight: 500, lineHeight: 1.3 }}
                >
                  {row.metric}
                </div>
                <div
                  className="mt-0.5 italic text-club-green-800/70"
                  style={{ fontSize: "11.5px", lineHeight: 1.35 }}
                >
                  {row.description}
                </div>
              </div>
            </div>

            {/* Three value columns — centered, tabular-nums for clean
                column alignment. */}
            <div
              className="text-center font-serif tabular-nums text-club-green-900"
              style={{ fontSize: "13px", fontWeight: 600 }}
            >
              {row.actual}
            </div>
            <div
              className="text-center font-serif tabular-nums text-club-green-800/85"
              style={{ fontSize: "12.5px" }}
            >
              {row.budget}
            </div>
            <div
              className="text-center font-serif tabular-nums text-club-green-800/85"
              style={{ fontSize: "12.5px" }}
            >
              {row.benchmark}
            </div>

            {/* Status glyph column — arrow indicates direction. */}
            <div
              className="text-center"
              style={{ fontSize: "12px", lineHeight: 1, color: row.status === "action" ? "#8b3520" : row.status === "monitor" ? "#a07a2e" : "rgb(63, 112, 66)" }}
              aria-label={`status: ${row.status}`}
            >
              {scorecardStatusGlyph(row)}
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// DepartmentNetPerformanceCard — third row, first column.
//
// Saguaro anatomy:
//   1. Dark green header band, serif title, smallcaps subtitle,
//      pill chip top-right (matching the chart-card chips like
//      "NET WORTH" / "NOI TREND").
//   2. Column headers in smallcaps (Department / YTD Actual / YTD
//      Budget / Variance / Trend).
//   3. Alternating-tint rows. Variance text is green for favourable
//      (>0) and clay for unfavourable (<0). Trend column carries a
//      muted horizontal track with a proportional fill on it.
//   4. Cream-tinted commentary block at the bottom, matching the
//      `insetCommentary` treatment used elsewhere.
// ---------------------------------------------------------------------------

type DepartmentData = Awaited<
  ReturnType<typeof getMonthlyReportingPackage>
>["stewardshipDashboard"]["departmentPerformance"];

function DepartmentNetPerformanceCard({ data }: { data: DepartmentData }) {
  return (
    <article
      data-testid="department-net-performance"
      className="flex w-full flex-1 flex-col overflow-hidden rounded-md border border-club-green-800/10 bg-club-cream"
    >
      {/* Header band */}
      <header
        className="flex items-start justify-between bg-club-green-900"
        style={{ padding: "12px 18px" }}
      >
        <div className="min-w-0 flex-1 pr-3">
          <h3
            data-testid="department-net-performance-title"
            className="font-serif text-club-cream"
            style={{ fontSize: "17px", fontWeight: 600, lineHeight: 1.2 }}
          >
            {data.title}
          </h3>
          <p
            data-testid="department-net-performance-subtitle"
            className="mt-1 uppercase text-club-cream/70"
            style={{ fontSize: "10.5px", letterSpacing: "0.7px", lineHeight: 1.35 }}
          >
            {data.subtitle}
          </p>
        </div>
        <span
          data-testid="department-net-performance-pill"
          className="inline-flex shrink-0 items-center rounded-full border border-club-gold/30 px-2.5 py-1 uppercase text-club-gold"
          style={{ fontSize: "9px", letterSpacing: "1px", fontWeight: 500 }}
        >
          {data.pillLabel}
        </span>
      </header>

      {/* Column headers */}
      <div
        className="grid items-center border-b border-club-sand bg-club-cream/40 px-4 py-2 uppercase text-club-green-800/65"
        style={{
          fontSize: "9.5px",
          letterSpacing: "1.1px",
          gridTemplateColumns: "minmax(0, 1fr) 5rem 5rem 5rem 5rem",
          columnGap: "0.75rem",
        }}
      >
        <span>Department</span>
        <span className="text-right">YTD Actual</span>
        <span className="text-right">YTD Budget</span>
        <span className="text-right">Variance</span>
        <span className="text-center">Trend</span>
      </div>

      {/* Rows */}
      <div data-testid="department-net-performance-rows">
        {data.rows.map((row, i) => (
          <div
            key={row.key}
            data-testid={`department-row-${row.key}`}
            data-favorable={row.isFavorable ? "true" : "false"}
            className={`grid items-center px-4 py-2.5 ${
              i % 2 === 1 ? "bg-club-sand/30" : "bg-club-cream"
            } ${i < data.rows.length - 1 ? "border-b border-club-sand/40" : ""}`}
            style={{
              gridTemplateColumns: "minmax(0, 1fr) 5rem 5rem 5rem 5rem",
              columnGap: "0.75rem",
            }}
          >
            <div
              className="font-serif text-club-green-900"
              style={{ fontSize: "13px", fontWeight: 500, lineHeight: 1.3 }}
            >
              {row.name}
            </div>
            <div
              className="text-right font-serif tabular-nums text-club-green-800/85"
              style={{ fontSize: "12.5px" }}
            >
              {row.actualLabel}
            </div>
            <div
              className="text-right font-serif tabular-nums text-club-green-800/85"
              style={{ fontSize: "12.5px" }}
            >
              {row.budgetLabel}
            </div>
            <div
              className="text-right font-serif tabular-nums"
              style={{
                fontSize: "12.5px",
                fontWeight: 600,
                color: row.isFavorable ? "rgb(63, 112, 66)" : "#8b3520",
              }}
            >
              {row.varianceLabel}
            </div>
            {/* Trend bar — muted horizontal track with a proportional
                fill. Saguaro understated convention: no rounded
                progress-bar styling. */}
            <div
              className="relative w-full"
              style={{ height: "6px", backgroundColor: "rgba(63, 112, 66, 0.08)" }}
              aria-label={`Trend: ${row.varianceLabel}`}
            >
              <div
                style={{
                  width: `${row.trendBarPct}%`,
                  height: "100%",
                  backgroundColor: row.isFavorable ? "rgb(63, 112, 66)" : "#8b3520",
                  opacity: 0.7,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Commentary band — Saguaro-style inset green wash. */}
      <div className="mt-1 px-3.5 pb-3.5 pt-2">
        <p
          data-testid="department-net-performance-commentary"
          className="font-sans italic text-club-green-900"
          style={{
            padding: "10px 14px",
            fontSize: "12.5px",
            lineHeight: 1.45,
            backgroundColor: "rgba(63, 112, 66, 0.10)",
            borderLeft: "3px solid rgba(63, 112, 66, 0.55)",
          }}
        >
          {data.commentary}
        </p>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// DuesSubsidyAnalysisCard — third row, second column.
//
// Saguaro anatomy:
//   1. Header band parallel to the Department card.
//   2. Centered summary line ("TOTAL OPERATING DUES: $10.38M /
//      253 Members = ~$41K / member / yr") in smallcaps.
//   3. Two-column body: donut SVG on the left, category legend with
//      colour squares on the right.
//   4. Donut is rendered as SVG arcs (one <path> per category) with
//      cumulative arc angles computed in the dues-subsidy service.
// ---------------------------------------------------------------------------

type DuesData = Awaited<
  ReturnType<typeof getMonthlyReportingPackage>
>["stewardshipDashboard"]["duesSubsidy"];

// (polarToCartesian + describeArc helpers moved to the client component
// `src/components/reporting/DuesSubsidyDonut.tsx` along with the donut
// SVG, hover state, tooltip, and slice-separator gaps.)

function DuesSubsidyAnalysisCard({ data }: { data: DuesData }) {
  return (
    <article
      data-testid="dues-subsidy-analysis"
      className="flex w-full flex-1 flex-col overflow-hidden rounded-md border border-club-green-800/10 bg-club-cream"
    >
      <header
        className="flex items-start justify-between bg-club-green-900"
        style={{ padding: "12px 18px" }}
      >
        <div className="min-w-0 flex-1 pr-3">
          <h3
            data-testid="dues-subsidy-analysis-title"
            className="font-serif text-club-cream"
            style={{ fontSize: "17px", fontWeight: 600, lineHeight: 1.2 }}
          >
            {data.title}
          </h3>
          <p
            data-testid="dues-subsidy-analysis-subtitle"
            className="mt-1 uppercase text-club-cream/70"
            style={{ fontSize: "10.5px", letterSpacing: "0.7px", lineHeight: 1.35 }}
          >
            {data.subtitle}
          </p>
        </div>
        <span
          data-testid="dues-subsidy-analysis-pill"
          className="inline-flex shrink-0 items-center rounded-full border border-club-gold/30 px-2.5 py-1 uppercase text-club-gold"
          style={{ fontSize: "9px", letterSpacing: "1px", fontWeight: 500 }}
        >
          {data.pillLabel}
        </span>
      </header>

      {/* Summary line band — single smallcaps statement. */}
      <div
        data-testid="dues-subsidy-summary"
        className="border-b border-club-sand bg-club-cream/40 px-4 py-2.5 uppercase text-club-green-800/75"
        style={{ fontSize: "10.5px", letterSpacing: "1px", lineHeight: 1.4 }}
      >
        TOTAL OPERATING DUES: <span className="text-club-green-900" style={{ fontWeight: 600 }}>{data.totalDuesLabel}</span>
        {" / "}<span className="text-club-green-900" style={{ fontWeight: 600 }}>{data.memberCountLabel}</span>
        {" = "}<span className="text-club-green-900" style={{ fontWeight: 600 }}>{data.perMemberLabel}</span>
      </div>

      {/* Body: donut + legend in a 2-column row.
          items-center vertically centres the 200×200 donut against
          the much taller 15-row legend column on the right — without
          this, the donut sits at the top of the body and visually
          floats high-left while the legend extends down. */}
      <div className="grid items-center gap-4 px-4 py-4" style={{ gridTemplateColumns: "200px minmax(0, 1fr)" }}>
        {/* Donut — client component owns hover state, tooltip, and
            cream slice-separator slivers. Founder rule 2026-07-13
            v15.13.2 — wrapped in EditorialChartReveal so the bespoke
            donut inherits the same viewport-triggered reveal as the
            shared EditorialDonut, with the DuesSubsidyDonut's arcs
            group already tagged with `chart-anim-donut`. */}
        <EditorialChartReveal testid="dues-subsidy-analysis-reveal">
          <DuesSubsidyDonut categories={data.categories} />
        </EditorialChartReveal>

        {/* Legend — restrained editorial list, percent right-aligned.
            Typography bump for the visual-refinement pass:
              - font 12 → 14 px         (+17 % size)
              - gap-1.5 → gap-2.5       (6 → 10 px between rows)
              - swatch 10 → 12 px       (matches the larger font)
              - percent column 2.5 → 2.8 rem  (room for "100 %")
              - lineHeight 1.3 → 1.4    (more breathing room)
            Result: legend reads cleanly at boardroom distance and
            fills the donut row's vertical space more naturally. */}
        <div data-testid="dues-subsidy-legend" className="flex flex-col gap-2.5">
          {data.categories.map((c) => (
            <div
              key={c.key}
              data-testid={`dues-legend-${c.key}`}
              className="grid items-center"
              style={{ gridTemplateColumns: "12px minmax(0, 1fr) 2.8rem", columnGap: "0.6rem" }}
            >
              <span
                aria-hidden="true"
                style={{ width: "12px", height: "12px", backgroundColor: c.color, display: "inline-block" }}
              />
              <span
                className="font-serif text-club-green-900"
                style={{ fontSize: "14px", lineHeight: 1.4 }}
              >
                {c.label}
              </span>
              <span
                className="text-right font-serif tabular-nums text-club-green-900"
                style={{ fontSize: "14px", fontWeight: 600 }}
              >
                {c.pct}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Reusable header band — dark green slab + serif title + smallcaps
// subtitle + top-right pill chip. Used by the two new payroll cards
// (and matches the chip treatment on the Equity / Operating chart
// cards so the four supplemental cards read as a single anatomy).
// ---------------------------------------------------------------------------
function CardHeaderBand({
  testid,
  title,
  subtitle,
  pillLabel,
}: {
  testid: string;
  title: string;
  subtitle: string;
  pillLabel: string;
}) {
  return (
    <header
      className="flex items-start justify-between bg-club-green-900"
      style={{ padding: "12px 18px" }}
    >
      <div className="min-w-0 flex-1 pr-3">
        <h3
          data-testid={`${testid}-title`}
          className="font-serif text-club-cream"
          style={{ fontSize: "17px", fontWeight: 600, lineHeight: 1.2 }}
        >
          {title}
        </h3>
        <p
          data-testid={`${testid}-subtitle`}
          className="mt-1 uppercase text-club-cream/70"
          style={{ fontSize: "10.5px", letterSpacing: "0.7px", lineHeight: 1.35 }}
        >
          {subtitle}
        </p>
      </div>
      <span
        data-testid={`${testid}-pill`}
        className="inline-flex shrink-0 items-center rounded-full border border-club-gold/30 px-2.5 py-1 uppercase text-club-gold"
        style={{ fontSize: "9px", letterSpacing: "1px", fontWeight: 500 }}
      >
        {pillLabel}
      </span>
    </header>
  );
}

/** Renders text containing **bold** + __italic__ markers. Used by the
 *  payroll cards' commentary blocks. Inert against XSS — text is
 *  passed in as a string and split, never set as HTML. */
function renderRichText(s: string): React.ReactNode {
  // Split on the union of (**…**) | (__…__) and preserve the delims.
  const parts = s.split(/(\*\*[^*]+\*\*|__[^_]+__)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("__") && part.endsWith("__")) {
      return <em key={i} className="italic">{part.slice(2, -2)}</em>;
    }
    return <span key={i}>{part}</span>;
  });
}

// ---------------------------------------------------------------------------
// PayrollDepartmentCard — fourth row, first column.
//
// Anatomy: header band → 4 KPI tiles → grouped bar chart → inset
// light-tan commentary with checkmark and PASS ✓.
// ---------------------------------------------------------------------------

type PayrollDeptData = Awaited<
  ReturnType<typeof getMonthlyReportingPackage>
>["stewardshipDashboard"]["payrollDepartment"];

function PayrollKpiTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center rounded border border-club-green-800/15 bg-club-cream px-2">
      <span
        className="font-serif font-bold tabular-nums leading-none tracking-tight text-club-green-900"
        style={{ fontSize: "21px" }}
      >
        {value}
      </span>
      <span
        className="mt-1.5 uppercase font-medium text-club-green-800/60"
        style={{ fontSize: "9px", letterSpacing: "0.9px" }}
      >
        {label}
      </span>
    </div>
  );
}

function PayrollDepartmentCard({ data }: { data: PayrollDeptData }) {
  return (
    <article
      data-testid="payroll-department"
      className="flex w-full flex-1 flex-col overflow-hidden rounded-md border border-club-green-800/10 bg-club-cream"
    >
      <CardHeaderBand
        testid="payroll-department"
        title={data.title}
        subtitle={data.subtitle}
        pillLabel={data.pillLabel}
      />

      {/* KPI ribbon */}
      <div
        data-testid="payroll-department-kpis"
        className="grid grid-cols-4 gap-1.5 px-3.5"
        style={{ height: 60, marginTop: 12 }}
      >
        <PayrollKpiTile value={data.kpis.totalYtdLabel}     label="Total YTD Payroll" />
        <PayrollKpiTile value={data.kpis.vsBudgetLabel}     label="vs. Budget" />
        <PayrollKpiTile value={data.kpis.vsPriorYearLabel}  label="vs. Prior Year" />
        <PayrollKpiTile value={data.kpis.payrollRatioLabel} label="Payroll Ratio" />
      </div>

      {/* Grouped bar chart */}
      <div className="bg-club-cream" style={{ height: 240, marginTop: 10 }}>
        <EditorialChartReveal testid="payroll-department-breakdown-reveal">
        <EditorialGroupedBarChart
          xLabels={data.xLabels}
          height={240}
          formatY="dollars-thousands"
          padLeft={48}
          padRight={14}
          series={[
            { name: data.actualSeriesLabel, values: data.rows.map((r) => r.actualK),    color: data.seriesColors.actual    },
            { name: "Budget",      values: data.rows.map((r) => r.budgetK),    color: data.seriesColors.budget    },
            { name: "Prior Year",  values: data.rows.map((r) => r.priorYearK), color: data.seriesColors.priorYear },
          ]}
        />
        </EditorialChartReveal>
      </div>

      {/* Commentary check panel — light-tan inset with centred
          checkmark icon and PASS ✓ in green. */}
      <div className="mt-2 px-3.5 pb-3.5">
        <div
          data-testid="payroll-department-check"
          data-decision={data.check.decision}
          className="flex flex-col items-center gap-2 rounded"
          style={{
            backgroundColor: "rgba(176, 138, 74, 0.10)",
            border: "1px solid rgba(176, 138, 74, 0.30)",
            padding: "14px 16px",
          }}
        >
          {/* Centred checkmark — restrained, board-appropriate. */}
          <span
            aria-hidden="true"
            style={{
              fontSize: "18px",
              lineHeight: 1,
              color: data.check.decision === "PASS" ? "rgb(63, 112, 66)" : "#8b3520",
            }}
          >
            ✓
          </span>
          <p
            className="text-center font-sans text-club-green-900"
            style={{ fontSize: "12.5px", lineHeight: 1.5 }}
          >
            <strong className="font-semibold">{data.check.headerPhrase}</strong>{" "}
            {renderRichText(data.check.bodySentence)}{" "}
            <span
              data-testid="payroll-department-check-decision"
              style={{
                color: data.check.decision === "PASS" ? "rgb(63, 112, 66)" : "#8b3520",
                fontWeight: 700,
              }}
            >
              {data.check.decision} ✓
            </span>
          </p>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// PayrollRatioTrendCard — fourth row, second column.
//
// Anatomy: header band → 4 KPI tiles → 12-month line chart with 4
// series → inset green-tinted commentary with the middle sentence
// italicised.
// ---------------------------------------------------------------------------

type PayrollTrendData = Awaited<
  ReturnType<typeof getMonthlyReportingPackage>
>["stewardshipDashboard"]["payrollRatioTrend"];

function PayrollRatioTrendCard({ data }: { data: PayrollTrendData }) {
  return (
    <article
      data-testid="payroll-ratio-trend"
      className="flex w-full flex-1 flex-col overflow-hidden rounded-md border border-club-green-800/10 bg-club-cream"
    >
      <CardHeaderBand
        testid="payroll-ratio-trend"
        title={data.title}
        subtitle={data.subtitle}
        pillLabel={data.pillLabel}
      />

      {/* KPI ribbon */}
      <div
        data-testid="payroll-ratio-trend-kpis"
        className="grid grid-cols-4 gap-1.5 px-3.5"
        style={{ height: 60, marginTop: 12 }}
      >
        <PayrollKpiTile value={data.kpis.ytdRatioLabel}    label="YTD Ratio" />
        <PayrollKpiTile value={data.kpis.budgetRatioLabel} label="Budget Ratio" />
        <PayrollKpiTile value={data.kpis.priorYearLabel}   label="Prior Year" />
        <PayrollKpiTile value={data.kpis.benchmarkLabel}   label="Benchmark" />
      </div>

      {/* Line chart — 4 series with the line-preview legend. */}
      <div className="bg-club-cream" style={{ height: 240, marginTop: 10 }}>
        <EditorialChartReveal testid="payroll-ratio-trend-reveal">
        <EditorialLineChart
          xLabels={data.months}
          height={240}
          formatY="percent"
          yDomain={data.yDomain}
          yTicks={data.yTicks}
          padLeft={44}
          padRight={14}
          // Executive board-report convention: every month label is
          // visible (no auto-skip). The actual line series ALREADY
          // carries nulls for future months so no extra clipping is
          // needed — see the actualSeries comment below.
          xLabelStep={1}
          lines={[
            // Benchmark (drawn first so it sits behind)
            {
              values: data.benchmarkSeries.map((p) => p.value),
              stroke: "stroke-club-gold",
              width: 1.2,
              dasharray: "3 3",
              opacity: 0.55,
            },
            // Prior year — dotted green
            {
              values: data.priorYearSeries.map((p) => p.value),
              stroke: "stroke-club-green-800",
              width: 1.4,
              dasharray: "1 4",
              opacity: 0.7,
            },
            // Budget — dashed gold
            {
              values: data.budgetSeries.map((p) => p.value),
              stroke: "stroke-club-gold",
              width: 1.5,
              dasharray: "6 4",
              opacity: 0.85,
            },
            // Actual — solid green with markers (the hero)
            {
              values: data.actualSeries.map((p) => p.value),
              stroke: "stroke-club-green-500",
              width: 2.2,
              markers: true,
              markerFill: "fill-club-green-500",
            },
          ]}
          legend={[
            {
              label: data.actualSeriesLabel,
              stroke: "stroke-club-green-500",
              strokeWidth: 2.2,
              showMarker: true,
              markerFill: "fill-club-green-500",
            },
            {
              label: `Budget (${data.kpis.budgetRatioLabel})`,
              stroke: "stroke-club-gold",
              strokeWidth: 1.5,
              dasharray: "6 4",
              opacity: 0.85,
            },
            {
              label: `Benchmark ${data.kpis.benchmarkLabel}`,
              stroke: "stroke-club-gold",
              strokeWidth: 1.2,
              dasharray: "3 3",
              opacity: 0.55,
            },
            {
              label: "Prior Year",
              stroke: "stroke-club-green-800",
              strokeWidth: 1.4,
              dasharray: "1 4",
              opacity: 0.7,
            },
          ]}
          // Founder rule 2026-07-05 v15.12 — shared editorial hover.
          // The tooltip surfaces ONLY the Payroll Ratio (Actual)
          // row — Budget / Benchmark / Prior Year are reference
          // overlays, not values the reader needs at hover time.
          // Header combines month + reporting year (extracted from
          // the actualSeriesLabel, e.g. "2026 Actual" → "2026") so
          // each callout reads e.g. "May 2026 · Payroll Ratio · 59.2%".
          // Value formatter is the shared "percent" descriptor — no
          // closure crosses the RSC boundary.
          tooltip={{
            xHeaders: data.months.map(
              (m) => `${m} ${data.actualSeriesLabel.split(" ")[0]}`,
            ),
            lineLabels: [null, null, null, "Payroll Ratio"],
            valueFormat: "percent",
          }}
        />
        </EditorialChartReveal>
      </div>

      {/* Inset green-tinted commentary with the middle sentence
          italicised (via __…__ markers on the service-emitted string). */}
      <div className="mt-2 px-3.5 pb-3.5">
        <p
          data-testid="payroll-ratio-trend-commentary"
          className="font-sans text-club-green-900"
          style={{
            padding: "10px 14px",
            fontSize: "12.5px",
            lineHeight: 1.5,
            backgroundColor: "rgba(63, 112, 66, 0.10)",
            borderLeft: "3px solid rgba(63, 112, 66, 0.55)",
          }}
        >
          {renderRichText(data.commentary)}
        </p>
      </div>
    </article>
  );
}

// Two-card wrapper. Stacks on narrow viewports; side-by-side on xl+.
function StewardshipDashboard({ data }: {
  data: Awaited<ReturnType<typeof getMonthlyReportingPackage>>["stewardshipDashboard"];
}) {
  return (
    // Container holds the two chart cards on top and the two
    // scorecard cards directly beneath, with the same column width
    // and 20 px gap between rows.
    <div
      data-testid="stewardship-dashboard"
      className="mt-6 flex flex-col gap-5"
    >
      {/* Top row — Equity + Operating Results charts. */}
      <div className="flex flex-col gap-5 xl:flex-row">
        <EquityValueCard data={data.equity} />
        <OperatingResultsCard data={data.operating} />
      </div>
      {/* Middle row — Operating + Capital Stewardship scorecards. */}
      <div
        data-testid="stewardship-scorecards"
        className="flex flex-col gap-5 xl:flex-row"
      >
        <StewardshipScorecardCard
          data={data.scorecards.operating}
          testid="stewardship-scorecard-operating"
        />
        <StewardshipScorecardCard
          data={data.scorecards.capital}
          testid="stewardship-scorecard-capital"
        />
      </div>
      {/* Third row — Department Net Performance + Dues Subsidy
          Analysis (Saguaro-style supplemental cards beneath the
          scorecards). Same column widths + gutters as the rows
          above so all four rows align column-for-column. */}
      <div
        data-testid="stewardship-supplemental"
        className="flex flex-col gap-5 xl:flex-row"
      >
        <DepartmentNetPerformanceCard data={data.departmentPerformance} />
        <DuesSubsidyAnalysisCard data={data.duesSubsidy} />
      </div>
      {/* Bottom row — Payroll Analysis Department Breakdown + Payroll
          Ratio Monthly Trend. Same column widths so all four rows
          align column-for-column. */}
      <div
        data-testid="stewardship-payroll"
        className="flex flex-col gap-5 xl:flex-row"
      >
        <PayrollDepartmentCard data={data.payrollDepartment} />
        <PayrollRatioTrendCard data={data.payrollRatioTrend} />
      </div>
    </div>
  );
}

function ChairsDashboard({ pkg }: { pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>> }) {
  return (
    <div data-testid="financial-performance">
      <SectionHeading
        eyebrow="Silver Springs Golf & Country Club · Visual Summary"
        title="Financial Performance, Illustrated"
        rightChip={<VisualSummaryChip />}
      />

      {/* Chapter metadata — single editorial reference line mirroring
          Saguaro p03's information hierarchy. Period-driven: reads
          `pkg.period.periodEndShortLabel` so the eyebrow renders the
          correct period-end date regardless of the package's
          selected period. Per the Reporting Period Golden Rule. */}
      <div
        data-testid="chairs-dashboard-meta"
        className="mt-4 flex flex-wrap items-baseline gap-x-2 font-serif text-[14px] text-club-green-800/85"
      >
        <span>{pkg.period.periodEndShortLabel}</span>
        <span aria-hidden>·</span>
        <span>Year to Date</span>
      </div>

      {/* Chapter description — single editorial sentence mirroring
          Saguaro p03's `.sec-note` one-liner. Italicized per the
          Saguaro reference. Item #5 in the structural list. */}
      <p
        data-testid="chairs-dashboard-description"
        className="mt-6 max-w-[760px] font-serif italic text-[16px] leading-relaxed text-club-green-900/85"
      >
        The financial story in charts. Equity trajectory, operating
        trends, KPI scorecards, department performance, and dues
        analysis.
      </p>

      {/* Chapter navigation cards — 4-tile TOC strip matching
          Saguaro's in-chapter sub-section index. Each entry carries a
          page-range eyebrow, a title in editorial case, and a one-line
          body summary. Item #6 in the structural list, sitting
          immediately above the chart cards (item #7). */}
      <div
        data-testid="chairs-dashboard-nav"
        className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <ChapterNavCard
          eyebrow="Pages 1–2"
          label="Visual Summary"
          detail="Charts and KPIs. Start here. The financial story in pictures."
        />
        <ChapterNavCard
          eyebrow="Pages 3–4"
          label="KPI Scorecard & P&L"
          detail="Are we on plan? The board-level operating and capital check-in."
        />
        <ChapterNavCard
          eyebrow="Pages 5–7"
          label="Capital & Projects"
          detail="Reserve health, active projects, and operational context."
        />
        <ChapterNavCard
          eyebrow="Pages 8–10"
          label="Detailed Statements"
          detail="Department detail, balance sheet, and AR. For the finance committee."
        />
      </div>

      {/* Stewardship visual dashboard — TWO equal-width cards that
          answer the two board questions a chair needs answered in 5
          seconds without reading paragraphs:
            LEFT  → Is the Club becoming financially stronger?
            RIGHT → Are operations performing appropriately?
          This is the FINAL block in the Financial Performance chapter.
          Per founder direction 2026-06-14 (Saguaro reference parity),
          the chapter ends at the Payroll Ratio — Monthly Trend card,
          which lives inside <StewardshipDashboard>. The five-pillar
          grid, executive narrative, board decisions, and board risks
          that previously sat below the Stewardship cards were removed
          to match the Saguaro Financial Performance section, where
          those cards do not appear. The downstream chapter
          (Operations panel) follows immediately. */}
      <StewardshipDashboard data={pkg.stewardshipDashboard} />
    </div>
  );
}

// Chair's Dashboard top rollup — surfaces the cross-pillar attention
// verdict. Distinct visual treatment from the chapter ribbon: this is
// the chair's command-centre signal, so it carries a slightly larger
// verdict font + flagged-pillar count.
function DashboardAttentionRollup({
  attention,
  flaggedCount,
  totalCount,
}: {
  attention: Attention;
  flaggedCount: number;
  totalCount: number;
}) {
  const verdict =
    attention === "green"  ? "GREEN"  :
    attention === "yellow" ? "YELLOW" :
                             "RED";
  const summary =
    attention === "green"
      ? `All ${totalCount} pillars on plan`
      : `${flaggedCount} of ${totalCount} pillars flagged`;
  return (
    <div
      data-testid="chairs-dashboard-attention-rollup"
      data-attention={attention}
      className="mt-8 flex items-center gap-3 border-t border-b border-club-sand py-3"
    >
      <span className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/65">
        Board attention
      </span>
      <span
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${attentionDotClass(attention)}`}
        aria-hidden="true"
      />
      <span
        data-testid="chairs-dashboard-attention-rollup-verdict"
        className={`font-serif text-base font-medium uppercase tracking-[0.22em] ${attentionTextClass(attention)}`}
      >
        {verdict}
      </span>
      <span className="mx-1 text-club-green-800/40" aria-hidden="true">·</span>
      <span
        data-testid="chairs-dashboard-attention-rollup-summary"
        className="text-[11px] uppercase tracking-[0.18em] text-club-green-800/65"
      >
        {summary}
      </span>
    </div>
  );
}

// Pillar summary card — chair's-dashboard atom. Compact anatomy:
//   - eyebrow row: pillar numeral + pillar name
//   - status headline (tone-coloured serif + dot)
//   - italic-serif briefing question (the question this pillar answers)
//   - hairline
//   - three metric rows (label + serif tabular-nums value)
//   - hairline
//   - Board Consideration chip (same atom used package-wide)
//
// Headline tier is text-xl (vs text-2xl on the Executive Briefing
// cards) because chair's-dashboard cards are narrower (one-fifth the
// row at 1440px). The smaller hero keeps each card legible without
// overflowing the column.
function PillarSummaryCard({
  pillar,
}: {
  pillar: {
    key: string;
    numeral: string;
    name: string;
    pillarShort: string;
    question: string;
    status: { tone: KpiTone; label: string };
    metrics: Array<{ key: string; label: string; value: string }>;
    consideration: BoardConsideration;
  };
}) {
  return (
    <article
      data-testid={`pillar-summary-${pillar.key}`}
      data-tone={pillar.status.tone}
      className="flex flex-col rounded-lg border border-club-sand bg-white p-4"
    >
      {/* Eyebrow row — pillar roman numeral + pillar name. */}
      <div className="text-[10px] uppercase tracking-[0.22em] text-club-gold">
        Pillar {pillar.numeral}
      </div>
      <div
        data-testid={`pillar-summary-${pillar.key}-name`}
        className="mt-0.5 text-[11px] uppercase tracking-[0.22em] text-club-green-800/75"
      >
        {pillar.name}
      </div>

      {/* HEADLINE — status verdict in serif text-xl + tone-coloured.
          The L1f tier-1-step tighter than the Executive Briefing's
          text-2xl, sized for the narrower column. */}
      <div className="mt-3 flex items-baseline gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${dotForTone(pillar.status.tone)}`}
          aria-hidden="true"
        />
        <span
          data-testid={`pillar-summary-${pillar.key}-status`}
          className={`font-serif text-xl leading-none tracking-tight ${toneHeadlineClass(pillar.status.tone)}`}
        >
          {pillar.status.label}
        </span>
      </div>

      {/* Italic-serif question — the briefing question this pillar
          answers. L4-style. Hidden at narrow viewports per the
          first-scroll-standard responsive pattern. */}
      <p
        data-testid={`pillar-summary-${pillar.key}-question`}
        className="mt-2 hidden font-serif italic text-[11px] leading-snug text-club-green-800/65 [@media(min-height:880px)]:block"
      >
        {pillar.question}
      </p>

      {/* Three metric rows — label + serif tabular-nums value. */}
      <dl
        data-testid={`pillar-summary-${pillar.key}-metrics`}
        className="mt-3 space-y-1.5 border-t border-club-sand/70 pt-3"
      >
        {pillar.metrics.map((m) => (
          <div
            key={m.key}
            data-testid={`pillar-summary-${pillar.key}-metric-${m.key}`}
            className="flex items-baseline justify-between gap-2"
          >
            <dt className="text-[11px] uppercase tracking-[0.18em] text-club-green-800/70">
              {m.label}
            </dt>
            <dd className="font-serif text-[15px] leading-none tabular-nums text-club-green-900">
              {m.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Board Consideration chip — same atom used package-wide. */}
      <div className="mt-auto pt-3">
        <div className="flex items-center justify-between border-t border-club-sand/70 pt-2.5">
          <span className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/65">
            Board posture
          </span>
          <BoardConsiderationChip consideration={pillar.consideration} />
        </div>
      </div>
    </article>
  );
}
// Helper — parse a percentage / numeric string into a plain number.
// Accepts forms like "+3.7%", "-1.4%", "49.2%", "1,284", "$14.62M",
// "$4.71M", "1.42x", "78.4%". Strips leading + or -, currency, M/K
// suffix (treats M as ×1; the threshold config is in the same unit
// as the displayed value), commas, trailing % / x.
function parsePct(raw: string | number): number {
  if (typeof raw === "number") return raw;
  if (!raw) return 0;
  let s = String(raw).trim();
  // Strip currency, suffixes, separators.
  s = s.replace(/[$,xX]/g, "").replace(/[MK]/g, "");
  s = s.replace(/%/g, "");
  s = s.replace(/^\+/, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// ----------------------------------------------------------------------------
// Per-pillar attention computation helpers
// ----------------------------------------------------------------------------
//
// Each helper computes the attention verdict for one pillar by
// re-evaluating its threshold rules. Called by:
//   - the Chair's Dashboard (per-card status + dashboard rollup)
//   - the cover Executive Briefing column (rollup ribbon)
//
// The legacy pillar-panel deep-dives (Operations / Financial Health /
// Capital / Membership Health / Experience Health) that used to be a
// third caller were removed 2026-06-16; their content is now covered
// by the five Saguaro chapters (Statement of Activities → AR Aging).

type PkgT = Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
type PillarVerdict = { attention: Attention; flagged: number; total: number };

function pillarVerdict(verdicts: Attention[]): PillarVerdict {
  return {
    attention: rollupChapter(verdicts),
    flagged: countFlagged(verdicts),
    total: verdicts.length,
  };
}

function computeOperationsAttention(pkg: PkgT): PillarVerdict {
  const revenueKpi = pkg.executiveSummary.kpis.find((k) => k.key === "ytd-revenue");
  const noiKpi     = pkg.executiveSummary.kpis.find((k) => k.key === "noi");
  const duesRatio  = pkg.operatingKPIs.cards.find((c) => c.key === "dues-rev");
  return pillarVerdict([
    evaluateMetric("operations.revenue",         parsePct(revenueKpi?.comparison?.variance ?? "0")),
    evaluateMetric("operations.noi",             parsePct(noiKpi?.comparison?.variance ?? "0")),
    evaluateMetric("operations.payroll-ratio",   parsePct(pkg.payroll.payrollRatio)),
    evaluateMetric("operations.dues-to-revenue", parsePct(duesRatio?.actual ?? "0")),
  ]);
}

function computeFinancialAttention(pkg: PkgT): PillarVerdict {
  const fh = pkg.boardBriefing.financialHealth.coverMetrics;
  return pillarVerdict([
    evaluateMetric("financial.working-capital",  parsePct(fh.find((m) => m.key === "working-capital")?.value ?? "0")),
    evaluateMetric("financial.current-ratio",    parsePct(fh.find((m) => m.key === "current-ratio")?.value ?? "0")),
    evaluateMetric("financial.reserve-coverage", parsePct(fh.find((m) => m.key === "reserve-coverage")?.value ?? "0")),
    evaluateMetric("financial.ar-current",       parsePct(fh.find((m) => m.key === "ar-current")?.value ?? "0")),
  ]);
}

function computeCapitalAttention(pkg: PkgT): PillarVerdict {
  const cp = pkg.boardBriefing.capitalProgram.coverMetrics;
  const activeProjects = cp.find((m) => m.key === "active-projects");
  const capitalSpend   = cp.find((m) => m.key === "capital-spend-ytd");
  const reserveContrib = cp.find((m) => m.key === "reserve-contributions");
  const delayedCount = pkg.capitalProjects.rows.filter((r) => r.tone === "amber" || r.tone === "red").length;
  const capitalSpendPct = (parsePct(capitalSpend?.value ?? "0") /
    parsePct((capitalSpend?.sub ?? "Plan $1.94M").replace(/^Plan\s*/i, "") || "1")) * 100;
  const reserveContribPct = parsePct(reserveContrib?.value ?? "0") >= 0 ? 100 : -100;
  return pillarVerdict([
    evaluateMetric("capital.capital-spend-pct",         capitalSpendPct),
    evaluateMetric("capital.projects-active",           parsePct(activeProjects?.value ?? "0")),
    evaluateMetric("capital.projects-delayed",          delayedCount),
    evaluateMetric("capital.reserve-contributions-pct", reserveContribPct),
  ]);
}

function computeMembershipAttention(pkg: PkgT): PillarVerdict {
  const m = pkg.membershipStewardship;
  const memberCountVsTargetPct = ((m.netYTD - 30) / 30) * 100;
  const newMembersVsTargetPct  = ((m.newYTD - 30) / 30) * 100;
  return pillarVerdict([
    evaluateMetric("membership.member-count-vs-target-pct", memberCountVsTargetPct),
    evaluateMetric("membership.waitlist",                    m.waitlist.depth),
    evaluateMetric("membership.new-members-vs-target-pct",   newMembersVsTargetPct),
    evaluateMetric("membership.attrition-ttm",               parsePct(m.attritionRateTTM)),
  ]);
}

function computeExperienceAttention(pkg: PkgT): PillarVerdict {
  const stats = pkg.operatingStats;
  const fb = pkg.fbStats;
  return pillarVerdict([
    evaluateMetric("experience.rounds",        parsePct(stats.rounds.varPct)),
    evaluateMetric("experience.covers",        parsePct(stats.fbCovers.varPct)),
    evaluateMetric("experience.average-check", 4.1),
    evaluateMetric("experience.fb-subsidy",    parsePct(fb.subsidyPctOfDues)),
  ]);
}

// All five pillar verdicts in one call. Drives both the Chair's
// Dashboard top ribbon and the cover Executive Briefing attention strip.
function computeAllPillarAttentions(pkg: PkgT): {
  operations: PillarVerdict;
  financial:  PillarVerdict;
  capital:    PillarVerdict;
  membership: PillarVerdict;
  experience: PillarVerdict;
} {
  return {
    operations: computeOperationsAttention(pkg),
    financial:  computeFinancialAttention(pkg),
    capital:    computeCapitalAttention(pkg),
    membership: computeMembershipAttention(pkg),
    experience: computeExperienceAttention(pkg),
  };
}
// Universal three-state attention → tone classes. Reuses the
// Executive Reporting Theme tokens; AA-compliant on cream.
function attentionDotClass(a: Attention): string {
  switch (a) {
    case "green":  return "bg-club-green-700";
    case "yellow": return "bg-amber-700";
    case "red":    return "bg-red-700";
  }
}
function attentionTextClass(a: Attention): string {
  switch (a) {
    case "green":  return "text-club-green-700";
    case "yellow": return "text-amber-700";
    case "red":    return "text-red-700";
  }
}
// ============================================================================
// 4 / 5 — Stewardship KPI blocks (operating + capital, same shape)
// ============================================================================

// Step / Stewardship redesign — Operating + Capital groups, each as
// a controller's brief. Every metric card answers three questions:
//
//   1. What is it?          → labelled paragraph
//   2. Why does it matter?  → labelled paragraph
//   3. Is it good or bad?   → assessment headline (tone-coloured)
//
// Cards are denser than the at-a-glance tiles (controllers prefer
// information density to hero numbers), arranged in a 2-column grid.
type StewardshipCard = {
  key: string;
  name: string;
  whatIsIt: string;
  whyItMatters: string;
  assessment: string;
  actual: string;
  budget?: string;
  benchmark?: string;
  tone: KpiTone;
};

function StewardshipBlock({
  title, description, cards, testId, className,
}: {
  title: string; description: string;
  cards: ReadonlyArray<StewardshipCard>;
  testId: string;
  className?: string;
}) {
  return (
    <div data-testid={testId} className={className ?? ""}>
      {/* L3 sub-block heading — text-2xl serif. Documented sub-block tier. */}
      <div className="flex items-baseline justify-between gap-4 border-b border-club-sand pb-3">
        <h3 className="font-serif text-2xl tracking-tight text-club-green-900">{title}</h3>
        <span className="text-[10px] uppercase tracking-[0.22em] text-club-gold/75">
          {cards.length} ratios
        </span>
      </div>
      {/* L4 framing — italic serif text-[15px] /85 per spec. Was previously
          text-sm sans /75 (audit F10). */}
      <p className="mt-4 max-w-[680px] font-serif text-[16px] italic leading-relaxed text-club-green-900/85">
        {description}
      </p>
      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {cards.map((c) => (
          <StewardshipMetricCard key={c.key} kpi={c} />
        ))}
      </div>
    </div>
  );
}

/**
 * Brand-palette dot class for the explanatory KPI card status dot.
 *
 * 2026-06-14: uplift from the desaturated `dotForTone` to the brand
 * hexes already used by chapter II's StewardshipScorecardCard so the
 * status reads at normal viewing distance:
 *   - green  → club-green-500 (#3f7042) "fairway green"
 *   - amber  → club-gold (#b08a4a)
 *   - red    → Saguaro clay (#8b3520)
 *   - neutral → club-sand
 * All four sit inside the restrained editorial palette — no SaaS
 * stoplight saturation. Used by StewardshipMetricCard only; the
 * desaturated `dotForTone` continues to drive elsewhere unchanged.
 */
function stewardshipBrandDotClass(tone: KpiTone): string {
  switch (tone) {
    case "green":  return "bg-[#3f7042]";
    case "amber":  return "bg-[#b08a4a]";
    case "red":    return "bg-[#8b3520]";
    case "neutral":return "bg-club-sand";
  }
}

function StewardshipMetricCard({ kpi }: { kpi: StewardshipCard }) {
  const tone = kpi.tone ?? "neutral";
  // 2026-06-14 compaction pass: padding tightened p-7 → p-5; spacing
  // between name/value/definitions/footer tightened mt-5/mt-6 →
  // mt-3/mt-4 so the explanatory cards stop dominating the chapter
  // height while keeping every founder-named field present (name,
  // dot, actual, assessment, What it is, Why it matters, Policy /
  // Target, Benchmark). Status dot upsized from h-2 w-2 (8 px) to
  // h-2.5 w-2.5 (10 px) and recoloured via the brand-palette
  // helper above.
  return (
    <article
      data-testid={`stewardship-${kpi.key}`}
      data-tone={tone}
      className="flex h-full flex-col rounded-lg bg-white p-5"
    >
      {/* Metric name + tone dot. */}
      <div className="flex items-start justify-between gap-3">
        <h4
          data-testid={`stewardship-${kpi.key}-name`}
          className="text-[11px] uppercase tracking-[0.22em] text-club-green-800/75"
        >
          {kpi.name}
        </h4>
        <span
          data-testid={`stewardship-${kpi.key}-tone`}
          data-tone={tone}
          className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${stewardshipBrandDotClass(tone)}`}
          aria-hidden="true"
        />
      </div>

      {/* Headline KPI + result interpretation. */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          data-testid={`stewardship-${kpi.key}-actual`}
          className="font-serif text-3xl leading-none tracking-tight tabular-nums text-club-green-900"
        >
          {kpi.actual}
        </span>
        <span
          data-testid={`stewardship-${kpi.key}-assessment`}
          className={`text-sm font-medium ${toneHeadlineClass(tone)}`}
        >
          {kpi.assessment}
        </span>
      </div>

      {/* What it is / Why it matters — controller-style definitions. */}
      <dl
        data-testid={`stewardship-${kpi.key}-definitions`}
        className="mt-4 space-y-2"
      >
        <div>
          <dt className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/65">
            What it is
          </dt>
          <dd
            data-testid={`stewardship-${kpi.key}-what`}
            className="mt-0.5 text-[12.5px] leading-snug text-club-green-900/85"
          >
            {kpi.whatIsIt}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/65">
            Why it matters
          </dt>
          <dd
            data-testid={`stewardship-${kpi.key}-why`}
            className="mt-0.5 text-[12.5px] leading-snug text-club-green-900/85"
          >
            {kpi.whyItMatters}
          </dd>
        </div>
      </dl>

      {/* Policy / Target + Benchmark comparator footer. mt-auto pins
          this row to the bottom of the flex column so paired-row
          grid cells keep their footer aligned even when adjacent
          cards have different `What it is` / `Why it matters` text
          lengths. */}
      {(kpi.budget || kpi.benchmark) && (
        <dl className="mt-4 space-y-1 border-t border-club-sand/70 pt-3">
          {kpi.budget && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75">
                Policy / target
              </dt>
              <dd className="font-mono text-[12px] tabular-nums text-club-green-900">
                {kpi.budget}
              </dd>
            </div>
          )}
          {kpi.benchmark && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75">
                Benchmark
              </dt>
              <dd className="font-mono text-[12px] tabular-nums text-club-green-900">
                {kpi.benchmark}
              </dd>
            </div>
          )}
        </dl>
      )}
    </article>
  );
}

// ============================================================================
// Chapter III — Stewardship KPI Dashboard
// ============================================================================
// Executive-style explanatory dashboard. NOT the chapter II detailed
// scorecard tables — those (StewardshipScorecardCard, fed by
// `pkg.stewardshipDashboard.scorecards.*`) live in chapter II as the
// ClubBenchmarking-style KPI tables. Chapter III's role is the
// "what is this metric and why does it matter?" presentation: each
// KPI renders as an explanatory card via StewardshipMetricCard
// (carrying What it is / Why it matters / Policy or Target /
// Benchmark) so directors get the metric definitions alongside the
// values.
//
// Single source of truth: both chapters consume the same reporting-
// service rows. Chapter II uses `pkg.stewardshipDashboard.scorecards.*`;
// chapter III uses `pkg.operatingKPIs.cards` / `pkg.capitalKPIs.cards`.
// No KPI calculations / accounting reads / commentary generation
// are duplicated — both data fields are produced by the same
// reporting service.

/**
 * Dark-green header band for chapter III's stewardship panels.
 *
 * Used as a per-column header in the paired-row grid. Carries the
 * serif panel title + subordinate italic rhetorical question.
 * Visual chrome matches chapter II's StewardshipScorecardCard
 * (deep `bg-club-green-900`, serif cream title, italic cream/75
 * subtitle) so the two surfaces read as peers in the same system.
 */
function StewardshipKpiPanelHeader({
  testid, title, question,
}: { testid: string; title: string; question: string }) {
  return (
    <header
      data-testid={`${testid}-header`}
      className="rounded-t-md bg-club-green-900"
      style={{ padding: "14px 20px" }}
    >
      <h3
        data-testid={`${testid}-title`}
        className="font-serif text-club-cream"
        style={{ fontSize: "17px", fontWeight: 600, lineHeight: 1.2 }}
      >
        {title}
      </h3>
      <p
        data-testid={`${testid}-question`}
        className="mt-1.5 font-serif italic text-club-cream/75"
        style={{ fontSize: "12px", lineHeight: 1.4 }}
      >
        {question}
      </p>
    </header>
  );
}

/**
 * Italic-serif section description rendered immediately under each
 * column header in the paired-row grid. Drives the panel's editorial
 * register — the explanatory paragraphs the founder asked to
 * preserve. Sits inside its own grid cell so the row baseline is
 * shared with the opposite column's description.
 */
function StewardshipKpiPanelDescription({
  testid, children,
}: { testid: string; children: React.ReactNode }) {
  return (
    <p
      data-testid={`${testid}-description`}
      className="px-1 font-serif italic text-[14px] leading-relaxed text-club-green-900/85"
    >
      {children}
    </p>
  );
}

/**
 * Paired-row grid for chapter III's Operating + Capital panels.
 *
 * The grid uses 2 columns × N rows: row 0 is the dark-green header
 * pair, row 1 is the section-description pair, rows 2..N are paired
 * KPI explanatory cards. CSS Grid's `align-items: stretch` (default)
 * makes both cells in any given row share the row's natural height —
 * Operating KPI 1 and Capital KPI 1 start at the same y position
 * AND end at the same y position; same for KPI 2, KPI 3, etc.
 *
 * When one side has more KPIs than the other (e.g. 8 Operating vs
 * 6 Capital), the extra Operating rows render with an empty cell on
 * the Capital side — no masonry layout, no staggered placement; the
 * grid simply leaves the missing cell blank.
 */
function StewardshipKpiPairedGrid({
  operating,
  capital,
}: {
  operating: { testid: string; title: string; question: string; description: string; cards: ReadonlyArray<StewardshipCard> };
  capital:   { testid: string; title: string; question: string; description: string; cards: ReadonlyArray<StewardshipCard> };
}) {
  const rowCount = Math.max(operating.cards.length, capital.cards.length);
  const rows: Array<{ key: string; op: StewardshipCard | null; cap: StewardshipCard | null }> = [];
  for (let i = 0; i < rowCount; i++) {
    const op  = operating.cards[i] ?? null;
    const cap = capital.cards[i] ?? null;
    rows.push({ key: `pair-${i}-${op?.key ?? "_"}-${cap?.key ?? "_"}`, op, cap });
  }
  return (
    <div
      data-testid="stewardship-kpi-dashboard-panels"
      className="mt-12 grid grid-cols-1 gap-x-5 gap-y-4 xl:grid-cols-2"
    >
      {/* Row 0 — dark-green column headers (panel title + question). */}
      <StewardshipKpiPanelHeader
        testid={operating.testid}
        title={operating.title}
        question={operating.question}
      />
      <StewardshipKpiPanelHeader
        testid={capital.testid}
        title={capital.title}
        question={capital.question}
      />

      {/* Row 1 — italic section-level descriptions. */}
      <StewardshipKpiPanelDescription testid={operating.testid}>
        {operating.description}
      </StewardshipKpiPanelDescription>
      <StewardshipKpiPanelDescription testid={capital.testid}>
        {capital.description}
      </StewardshipKpiPanelDescription>

      {/* Rows 2..N — paired KPI explanatory cards. Each row's two
          cells share the row's natural height (grid stretch) so
          Operating KPI N and Capital KPI N start and end at the same
          y position. */}
      {rows.map((row, idx) => (
        <Fragment key={row.key}>
          {row.op ? (
            <StewardshipMetricCard kpi={row.op} />
          ) : (
            <div
              data-testid={`${operating.testid}-row-${idx}-empty`}
              aria-hidden="true"
              className="hidden xl:block"
            />
          )}
          {row.cap ? (
            <StewardshipMetricCard kpi={row.cap} />
          ) : (
            <div
              data-testid={`${capital.testid}-row-${idx}-empty`}
              aria-hidden="true"
              className="hidden xl:block"
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Tailwind class for a budget-variance amount span on a summary card.
 *
 * Driven by `VarianceTone` from the reporting service — the React
 * surface never inspects the sign of the amount string. Brand-palette
 * hexes (NOT desaturated SaaS stoplights):
 *   - positive → club-green-500 (#3f7042) "fairway green"
 *   - negative → Saguaro clay (#8b3520)
 *   - neutral  → muted body colour
 */
function varianceAmountClass(tone: import("@/lib/reporting/monthly-package").VarianceTone): string {
  switch (tone) {
    case "positive": return "text-[#3f7042] font-medium";
    case "negative": return "text-[#8b3520] font-medium";
    case "neutral":  return "text-club-green-900/80";
  }
}

type VarianceSubtext = {
  varianceAmount: string;
  varianceLabel: string;
  varianceTone: import("@/lib/reporting/monthly-package").VarianceTone;
  /** Optional trailing context after the variance label, e.g. "4.4% margin". */
  trailing?: string;
};

function StewardshipKpiSummaryCard({
  testId, label, value, sub, variance,
}: {
  testId: string;
  label: string;
  value: string;
  /** Plain descriptive subtext (for cards without a variance). */
  sub?: string;
  /** Variance subtext where ONLY the amount is tone-coloured. */
  variance?: VarianceSubtext;
}) {
  return (
    <article
      data-testid={testId}
      className="flex flex-col rounded-lg bg-white p-6 ring-1 ring-club-sand/60"
    >
      <h4
        data-testid={`${testId}-label`}
        className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75"
      >
        {label}
      </h4>
      <p
        data-testid={`${testId}-value`}
        className="mt-3 font-serif text-4xl leading-none tracking-tight tabular-nums text-club-green-900"
      >
        {value}
      </p>
      <p
        data-testid={`${testId}-sub`}
        className="mt-3 text-[13px] leading-relaxed text-club-green-900/80"
      >
        {variance ? (
          <>
            <span
              data-testid={`${testId}-variance-amount`}
              data-tone={variance.varianceTone}
              className={varianceAmountClass(variance.varianceTone)}
            >
              {variance.varianceAmount}
            </span>
            {" "}
            {variance.varianceLabel}
            {variance.trailing ? ` · ${variance.trailing}` : null}
          </>
        ) : (
          sub
        )}
      </p>
    </article>
  );
}

function StewardshipKpiDashboard({
  pkg,
}: {
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
}) {
  const dashboard = pkg.stewardshipKpiDashboard;
  const m = pkg.membershipStewardship;
  return (
    <div data-testid="stewardship-kpi-dashboard">
      <SectionHeading
        eyebrow="Silver Springs Golf & Country Club · KPI Dashboard"
        title="Stewardship KPI Dashboard"
      />

      <div
        data-testid="stewardship-kpi-dashboard-meta"
        className="mt-4 font-serif text-[14px] text-club-green-800/85"
      >
        {dashboard.periodLabel}
      </div>

      {/* Membership Stewardship sub-blocks lifted from the legacy
          Membership Stewardship chapter (2026-06-19). Inserted
          immediately after the dashboard header so the board reads
          the franchise-health dimension first; all pre-existing
          Stewardship Dashboard content below renders in its original
          order. Data bindings come from `pkg.membershipStewardship` —
          the same fields the legacy chapter consumed; no React-side
          calculations. */}
      <div
        data-testid="stewardship-kpi-dashboard-membership-headline"
        className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4"
      >
        <OperatingHeadlineTile
          testId="membership-active"
          label="Active members"
          value={m.activeMembers.toLocaleString()}
          context="Dues-paying members in good standing at period close."
          sub={`+${m.netYTD} net YTD · LRP target +30`}
          tone="green"
        />
        <OperatingHeadlineTile
          testId="membership-attrition"
          label="Attrition (TTM)"
          value={m.attritionRateTTM}
          context="Rolling-12-month resignations as a share of average active membership."
          sub={m.attritionBenchmark}
          tone={m.attritionTone}
        />
        <OperatingHeadlineTile
          testId="membership-entrance-fee"
          label="Entrance fees YTD"
          value={m.entranceFee.ytd}
          context="Initiation fee income collected from new members YTD."
          sub={`${m.entranceFee.varPctYoY} · ${m.entranceFee.perNewMember} per new`}
          tone={m.entranceFee.tone}
        />
        <OperatingHeadlineTile
          testId="membership-tenure"
          label="Average tenure"
          value={m.tenure.averageYears}
          context="Mean years of continuous membership across the active roster."
          sub="franchise stability indicator"
          tone="neutral"
        />
      </div>

      <MembershipCategoryMix mix={m.categoryMix} total={m.activeMembers} />

      <MembershipWaitlist waitlist={m.waitlist} />

      <MembershipTenureDistribution
        distribution={m.tenure.distribution}
        averageYears={m.tenure.averageYears}
      />

      {/* ─── Original Stewardship KPI Dashboard content (unchanged
          order) ─────────────────────────────────────────────────── */}

      {/* "Operating vs. Capital Stewardship" sub-header — restores
          the section-hierarchy rhythm after the lifted membership
          blocks. Style matches the Tenure Distribution section header
          exactly: mt-10 wrapper, bordered block with border-b
          border-club-sand pb-2, font-serif text-2xl tracking-tight
          text-club-green-900. */}
      <div
        data-testid="stewardship-kpi-dashboard-op-vs-cap-heading"
        className="mt-10"
      >
        <div className="border-b border-club-sand pb-2">
          <h3 className="font-serif text-2xl tracking-tight text-club-green-900">
            Operating vs. Capital Stewardship
          </h3>
        </div>
      </div>

      <p
        data-testid="stewardship-kpi-dashboard-intro"
        className="mt-6 max-w-[760px] font-serif italic text-[16px] leading-relaxed text-club-green-900/85"
      >
        {dashboard.introQuestion}
      </p>

      {/* Top KPI summary cards — 4-up grid that collapses to 2-up
          (sm) then 1-up (default) so the surface stays readable down
          to 1280 px. */}
      <div
        data-testid="stewardship-kpi-dashboard-summary"
        className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <StewardshipKpiSummaryCard
          testId="stewardship-summary-revenue"
          label="Total Operating Revenue"
          value={dashboard.summaryCards.revenue.value}
          variance={{
            varianceAmount: dashboard.summaryCards.revenue.varianceAmount,
            varianceLabel:  dashboard.summaryCards.revenue.varianceLabel,
            varianceTone:   dashboard.summaryCards.revenue.varianceTone,
          }}
        />
        <StewardshipKpiSummaryCard
          testId="stewardship-summary-noi"
          label="NOI Before Depreciation"
          value={dashboard.summaryCards.noiBeforeDep.value}
          variance={{
            varianceAmount: dashboard.summaryCards.noiBeforeDep.varianceAmount,
            varianceLabel:  dashboard.summaryCards.noiBeforeDep.varianceLabel,
            varianceTone:   dashboard.summaryCards.noiBeforeDep.varianceTone,
            trailing:       dashboard.summaryCards.noiBeforeDep.marginPct,
          }}
        />
        <StewardshipKpiSummaryCard
          testId="stewardship-summary-capital-fund-income"
          label="Capital Fund Income YTD"
          value={dashboard.summaryCards.capitalFundIncome.value}
          sub={dashboard.summaryCards.capitalFundIncome.subtext}
        />
        <StewardshipKpiSummaryCard
          testId="stewardship-summary-reserve-coverage"
          label="Reserve Coverage Ratio"
          value={dashboard.summaryCards.reserveCoverage.value}
          sub={`${dashboard.summaryCards.reserveCoverage.balance} · ${dashboard.summaryCards.reserveCoverage.benchmark}`}
        />
      </div>

      {/* Operating + Capital Stewardship explanatory panels —
          chapter III's executive presentation layer. NOT the chapter
          II detailed scorecard tables (those live in chapter II's
          StewardshipScorecardCard pair fed by
          `pkg.stewardshipDashboard.scorecards.*`); this dashboard
          renders the "what is this metric and why does it matter?"
          explanatory cards via StewardshipMetricCard.
          Single-grid paired-row layout: dark-green header pair on
          row 0, italic descriptions on row 1, paired KPI explanatory
          cards on rows 2..N. CSS Grid stretches both cells in each
          row to the row's natural height — Operating KPI N and
          Capital KPI N start AND end at the same y position so the
          two columns read as symmetrical, never staggered. */}
      <StewardshipKpiPairedGrid
        operating={{
          testid: "stewardship-kpi-panel-operating",
          title: "Operating Stewardship",
          question: "Is the club living within the plan?",
          description: "These metrics confirm the operating model is sustaining the member experience without borrowing from capital or future years.",
          cards: pkg.operatingKPIs.cards,
        }}
        capital={{
          testid: "stewardship-kpi-panel-capital",
          title: "Capital Stewardship",
          question: "Is the club protecting its future?",
          description: "These metrics confirm capital obligations are being funded, projects are executing on plan, and the club’s long-range asset position is moving in the right direction.",
          cards: pkg.capitalKPIs.cards,
        }}
      />

      {/* Dashboard Notes — two paragraph bullets stacked vertically.
          Reactive: each paragraph is composed by
          buildStewardshipDashboardNotes from the SAME operating +
          capital KPI rows the cards above render. The two entries
          (operating + capital) render as full-paragraph bullets —
          complete executive thoughts, not fragmented sentence
          snippets. Single-column stack so each paragraph uses the
          full card width.
          Per CLAUDE.md `Reactive Commentary for Financial Reporting`,
          every figure quoted in a paragraph reconciles to the
          chapter III KPI dataset above. */}
      <div
        data-testid="stewardship-kpi-dashboard-notes"
        className="mt-10 rounded-lg bg-club-cream/60 px-6 py-5 ring-1 ring-club-sand/60"
      >
        <h3
          data-testid="stewardship-kpi-dashboard-notes-heading"
          className="text-[10px] uppercase tracking-[0.22em] text-club-gold/80"
        >
          Dashboard Notes
        </h3>
        <ul
          data-testid="stewardship-kpi-dashboard-notes-list"
          className="mt-4 space-y-4 font-serif text-[14px] leading-relaxed text-club-green-900/90"
        >
          {dashboard.dashboardNotes.map((bullet) => {
            // Saguaro-style directional arrow markers. Operating
            // observations get a muted board-report red (the same
            // Saguaro clay hex the StewardshipMetricCard uses for
            // action-status dots — #8b3520). Capital observations
            // get a muted board-report slate-blue (#3a5a78) — a
            // restrained editorial complement to the warm clay,
            // never SaaS-blue. Only the arrow carries colour; the
            // paragraph stays in the report's body colour.
            const arrowClass =
              bullet.tone === "operating"
                ? "text-[#8b3520]"
                : "text-[#3a5a78]";
            return (
              <li
                key={bullet.tone}
                data-testid={`stewardship-kpi-dashboard-notes-${bullet.tone}`}
                className="flex items-start gap-3"
              >
                <span
                  aria-hidden="true"
                  data-testid={`stewardship-kpi-dashboard-notes-${bullet.tone}-marker`}
                  data-tone={bullet.tone}
                  className={`mt-1 inline-block shrink-0 text-[11px] leading-none ${arrowClass}`}
                >
                  &#9654;
                </span>
                <p className="flex-1">{bullet.text}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ============================================================================
// Chapter IV — Statement of Activities (Two-Fund Format)
// ============================================================================
// Saguaro-style board-facing financial statement. 8-column table
// (Category + Current Month Budget/Actual/Variance + YTD Budget/
// Actual/Variance + % Variance), section bands, the dark-green
// NOI band, pale-blue capital divider, inline commentary rows, and
// a reactive CFO Commentary block.
//
// Per CLAUDE.md `Financial Reporting Data Integrity — Mandatory`,
// the React surface RENDERS ONLY. Variance math, tone
// classification, commentary branching, and seed numerics all live
// in `src/lib/reporting/statement-of-activities.ts`. The component
// reads `pkg.statementOfActivitiesV2` directly.

import type {
  StatementOfActivitiesV2Row,
  StatementOfActivitiesV2Values,
} from "@/lib/reporting/statement-of-activities";

/** Render a numeric value cell.
 *  - null  → em-dash "—"
 *  - negative → parens "(1,234)"
 *  - positive → "1,234"
 *  Variance tone is decided by the SERVICE via the variance sign;
 *  the React surface just maps the sign to a Tailwind class. */
function formatStatementValue(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "—";
  const abs = Math.abs(Math.round(value));
  const str = abs.toLocaleString("en-US");
  return value < 0 ? `(${str})` : str;
}

function formatStatementPct(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "—";
  const pct = (value * 100).toFixed(1);
  return value > 0 ? `+${pct}%` : `${pct}%`;
}

/** Tone class for a variance cell (number or %). */
function statementVarianceClass(value: number | null): string {
  if (value === null || value === 0) return "text-club-green-900/55";
  return value > 0 ? "text-[#3f7042] font-medium" : "text-[#8b3520] font-medium";
}

/** Pill chip class for the on-plan / watch / action tones. */
function statementChipClass(tone: "on-plan" | "watch" | "action"): string {
  switch (tone) {
    case "on-plan":
      return "border-club-green-700/40 bg-club-green-700/8 text-club-green-700";
    case "watch":
      return "border-[#b08a4a]/50 bg-[#b08a4a]/10 text-[#8a6d3a]";
    case "action":
      return "border-[#8b3520]/50 bg-[#8b3520]/8 text-[#8b3520]";
  }
}

/** Column-width template — used for every row that renders 7 numeric
 *  columns. Category column flexes; numerics use a fixed minmax
 *  template so columns align across section bands and total rows. */
const STATEMENT_GRID =
  "minmax(0, 1fr) 6.2rem 6.2rem 6.2rem 6.4rem 6.4rem 6.4rem 5rem";
const STATEMENT_GRID_GAP = "1rem";

function StatementValueRow({
  values, baseClass, valueClass, varianceClass,
}: {
  values: StatementOfActivitiesV2Values;
  baseClass: string;
  valueClass?: string;
  varianceClass?: string;
}) {
  // The 7 numeric cells. Variance cells get their own tone class
  // driven by the service-supplied sign; non-variance cells use the
  // base body / total class.
  return (
    <>
      <span className={`text-right tabular-nums ${baseClass} ${valueClass ?? ""}`}>
        {formatStatementValue(values.currentBudget)}
      </span>
      <span className={`text-right tabular-nums ${baseClass} ${valueClass ?? ""}`}>
        {formatStatementValue(values.currentActual)}
      </span>
      <span className={`text-right tabular-nums ${varianceClass ?? statementVarianceClass(values.currentVariance)}`}>
        {formatStatementValue(values.currentVariance)}
      </span>
      <span className={`text-right tabular-nums ${baseClass} ${valueClass ?? ""}`}>
        {formatStatementValue(values.ytdBudget)}
      </span>
      <span className={`text-right tabular-nums ${baseClass} ${valueClass ?? ""}`}>
        {formatStatementValue(values.ytdActual)}
      </span>
      <span className={`text-right tabular-nums ${varianceClass ?? statementVarianceClass(values.ytdVariance)}`}>
        {formatStatementValue(values.ytdVariance)}
      </span>
      <span className={`text-right tabular-nums ${varianceClass ?? statementVarianceClass(values.variancePct)}`}>
        {formatStatementPct(values.variancePct)}
      </span>
    </>
  );
}

function StatementRow({ row, isCapitalSection }: {
  row: StatementOfActivitiesV2Row;
  isCapitalSection: boolean;
}) {
  // Each branch returns ONE <div> with the 8-column grid. Section /
  // band / commentary rows span all 8 cells via `gridColumn: 1/-1`.
  switch (row.kind) {
    case "section-band": {
      // Beige band, smallcaps gold (operating side). Same beige is
      // reused for capital but `isCapitalSection` would pick a
      // different colour — capital uses `capital-band` kind below.
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          className="px-4 py-2 uppercase tracking-[0.18em] text-[10.5px] text-[#a08850] bg-[#e8dfc8]/70 border-y border-club-sand/40"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.label}
        </div>
      );
    }
    case "capital-band": {
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          className="px-4 py-2 uppercase tracking-[0.18em] text-[10.5px] text-[#4a6280] bg-[#d4e0ec]/55 border-y border-[#bcd0e2]/50"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.label}
        </div>
      );
    }
    case "capital-divider": {
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          className="px-4 py-2 uppercase tracking-[0.22em] text-[11px] text-[#4a6280] text-center bg-[#d4e0ec]/70 border-y border-[#bcd0e2]"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.label}
        </div>
      );
    }
    case "capital-intro": {
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          className="px-4 py-3 italic text-[13px] leading-snug text-club-green-900/75"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.text}
        </div>
      );
    }
    case "commentary": {
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind="commentary"
          className="px-6 py-2 italic text-[12.5px] leading-snug text-club-green-900/70 bg-club-cream/40"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.text}
        </div>
      );
    }
    case "noi-band": {
      // Dark forest green slab. Cream text. The visual climax of
      // the operating section.
      if (!row.values) return null;
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind="noi-band"
          className="grid items-center px-4 py-3 bg-club-green-900 text-club-cream font-serif"
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          <span className="font-semibold text-[14px]">{row.label}</span>
          <StatementValueRow
            values={row.values}
            baseClass="text-[13.5px] text-club-cream font-medium"
            valueClass=""
          />
        </div>
      );
    }
    case "noi-after": {
      if (!row.values) return null;
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind="noi-after"
          className="grid items-center px-4 py-2.5 bg-[#e8dfc8]/55 border-y border-club-sand/40 font-serif italic"
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          <span className="font-semibold text-[13px] text-club-green-900">{row.label}</span>
          <StatementValueRow
            values={row.values}
            baseClass="text-[13px] text-club-green-900 font-semibold"
          />
        </div>
      );
    }
    case "capital-total": {
      if (!row.values) return null;
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind="capital-total"
          className="grid items-center px-4 py-2.5 bg-[#d4e0ec]/60 border-y border-[#bcd0e2] font-serif italic"
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          <span className="font-semibold text-[13px] text-club-green-900">{row.label}</span>
          <StatementValueRow
            values={row.values}
            baseClass="text-[13px] text-club-green-900 font-semibold"
          />
        </div>
      );
    }
    case "net-combined": {
      if (!row.values) return null;
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind="net-combined"
          className="grid items-center px-4 py-3 bg-[#e8dfc8]/85 border-y border-club-sand font-serif italic"
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          <span className="font-semibold text-[14px] text-club-green-900">{row.label}</span>
          <StatementValueRow
            values={row.values}
            baseClass="text-[13.5px] text-club-green-900 font-semibold"
          />
        </div>
      );
    }
    case "subtotal":
    case "total": {
      if (!row.values) return null;
      const isTotal = row.kind === "total";
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind={row.kind}
          className={`grid items-center px-4 py-2 ${
            isTotal
              ? "bg-[#e8dfc8]/65 border-y border-club-sand/55"
              : "bg-[#e8dfc8]/35 border-y border-club-sand/30"
          } font-serif italic`}
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          <span className="font-semibold text-[13px] text-club-green-900">{row.label}</span>
          <StatementValueRow
            values={row.values}
            baseClass="text-[13px] text-club-green-900 font-semibold"
          />
        </div>
      );
    }
    case "depreciation":
    case "detail":
    default: {
      if (!row.values) return null;
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind="detail"
          className={`grid items-center px-4 py-1.5 ${
            isCapitalSection ? "bg-club-cream/10" : "bg-club-cream/20"
          } border-b border-club-sand/25 hover:bg-club-cream/45`}
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          <span className="flex items-center gap-2 text-[13px] text-club-green-900">
            {row.label}
            {row.chip ? (
              <span
                data-testid={`soa-row-${row.key}-chip`}
                className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[9.5px] uppercase tracking-[0.18em] ${statementChipClass(row.chip.tone)}`}
              >
                {row.chip.label}
              </span>
            ) : null}
          </span>
          <StatementValueRow
            values={row.values}
            baseClass="text-[13px] text-club-green-900"
          />
        </div>
      );
    }
  }
}

function StatementColumnHeaderRow({
  headers,
}: {
  headers: NonNullable<Awaited<ReturnType<typeof getMonthlyReportingPackage>>["statementOfActivitiesV2"]>["columnHeaders"];
}) {
  return (
    <div
      data-testid="soa-column-headers"
      className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/60 bg-[#e8dfc8]/40 border-y border-club-sand/40"
      style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
    >
      <span className="text-left">{headers.category}</span>
      <span className="text-right">{headers.currentBudget}</span>
      <span className="text-right">{headers.currentActual}</span>
      <span className="text-right">{headers.currentVariance}</span>
      <span className="text-right">{headers.ytdBudget}</span>
      <span className="text-right">{headers.ytdActual}</span>
      <span className="text-right">{headers.ytdVariance}</span>
      <span className="text-right">{headers.variancePct}</span>
    </div>
  );
}

function StatementOfActivitiesPanel({
  pkg,
}: {
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
}) {
  const soa = pkg.statementOfActivitiesV2;
  return (
    <div data-testid="statement-of-activities-v2" className="font-serif">
      {/* Header chrome — eyebrow + title + period + intro + top-right meta. */}
      <header className="flex flex-col gap-4 border-b border-club-sand/60 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <p
            data-testid="soa-eyebrow"
            className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
          >
            {soa.eyebrow}
          </p>
          <h2
            data-testid="soa-title"
            className="font-serif text-[34px] leading-[1.05] tracking-tight text-club-green-900"
          >
            {soa.title}
          </h2>
          <p
            data-testid="soa-period"
            className="uppercase tracking-[0.22em] text-[10.5px] text-club-green-800/65"
          >
            {soa.periodLabel}
          </p>
          <p
            data-testid="soa-intro"
            className="mt-3 max-w-[600px] italic text-[14.5px] leading-relaxed text-club-green-900/85"
          >
            {soa.introNote}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <p
            data-testid="soa-statement-number"
            className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65"
          >
            {soa.statementNumber}
          </p>
          <span
            data-testid="soa-document-chip"
            className="inline-flex items-center rounded-md border border-club-gold/40 bg-club-cream px-2.5 py-1 uppercase tracking-[0.18em] text-[10px] text-club-gold-700"
          >
            {soa.documentChip}
          </span>
          <p
            data-testid="soa-prepared-for"
            className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65"
          >
            {soa.preparedFor}
          </p>
        </div>
      </header>

      {/* Operating section table — column headers + all operating rows. */}
      <div
        data-testid="soa-table-operating"
        className="mt-6 overflow-hidden rounded-md border border-club-sand/60"
      >
        <StatementColumnHeaderRow headers={soa.columnHeaders} />
        {soa.operatingRows.map((row) => (
          <StatementRow key={row.key} row={row} isCapitalSection={false} />
        ))}
      </div>

      {/* Capital section — divider band + capital subtable with its own column headers. */}
      <div data-testid="soa-table-capital" className="mt-4">
        {/* Divider + intro rows render WITHOUT a surrounding card so
            the pale-blue band reads as a top-of-section heading,
            matching the Saguaro reference. */}
        <div
          className="grid"
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          {soa.capitalRows
            .filter((r) => r.kind === "capital-divider" || r.kind === "capital-intro")
            .map((row) => (
              <StatementRow key={row.key} row={row} isCapitalSection={true} />
            ))}
        </div>
        {/* Capital subtable proper — column headers labelled "CAPITAL
            FUND ACTIVITY" and the remaining rows. */}
        <div className="mt-3 overflow-hidden rounded-md border border-[#bcd0e2]/70">
          <div
            data-testid="soa-capital-column-headers"
            className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-[#4a6280] bg-[#d4e0ec]/40 border-b border-[#bcd0e2]/50"
            style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
          >
            <span className="text-left">Capital Fund Activity</span>
            <span className="text-right">{soa.columnHeaders.currentBudget}</span>
            <span className="text-right">{soa.columnHeaders.currentActual}</span>
            <span className="text-right">{soa.columnHeaders.currentVariance}</span>
            <span className="text-right">{soa.columnHeaders.ytdBudget}</span>
            <span className="text-right">{soa.columnHeaders.ytdActual}</span>
            <span className="text-right">{soa.columnHeaders.ytdVariance}</span>
            <span className="text-right">{soa.columnHeaders.variancePct}</span>
          </div>
          {soa.capitalRows
            .filter((r) => r.kind !== "capital-divider" && r.kind !== "capital-intro")
            .map((row) => (
              <StatementRow key={row.key} row={row} isCapitalSection={true} />
            ))}
        </div>
      </div>

      {/* CFO Commentary block — reactive ▶ paragraph bullets sourced
          from buildCfoCommentary in the service. */}
      <div
        data-testid="soa-cfo-commentary"
        className="mt-8 px-1"
      >
        <h3
          data-testid="soa-cfo-eyebrow"
          className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
        >
          {soa.cfoCommentary.eyebrow}
        </h3>
        <ul
          data-testid="soa-cfo-list"
          className="mt-4 space-y-3 font-serif text-[13.5px] leading-relaxed text-club-green-900/90"
        >
          {soa.cfoCommentary.bullets.map((bullet, idx) => (
            <li
              key={idx}
              data-testid={`soa-cfo-bullet-${idx}`}
              className="flex items-start gap-3"
            >
              <span
                aria-hidden="true"
                className="mt-1 inline-block shrink-0 text-[11px] leading-none text-[#8b3520]"
              >
                &#9654;
              </span>
              <p className="flex-1">{bullet.text}</p>
            </li>
          ))}
        </ul>
      </div>

      {/* Bottom padding spacer — the reference attribution line was
          removed 2026-06-15 (production package, not a Saguaro
          reference illustration). The mt-12 here preserves the
          breathing room the footer used to occupy so the section
          does not feel abruptly cut off before the next chapter
          ornament. */}
      <div aria-hidden="true" className="mt-12" />
    </div>
  );
}

// ============================================================================
// Chapter V — Capital Fund Statement
// ============================================================================
// Saguaro-style two-column board-facing capital statement. Left
// column carries the Sources & Uses table (annual budget / YTD
// actual / remaining); right column carries the reserve coverage
// progress ribbon, reserve adequacy detail rows, and the reactive
// capital-stress-test commentary card.
//
// Per CLAUDE.md `Financial Reporting Data Integrity — Mandatory`,
// the React surface RENDERS ONLY. The seed numerics, reserve
// markers, adequacy tones, and stress-test commentary all live in
// `src/lib/reporting/capital-fund-statement.ts`. Period labels
// flow from `ReportingPeriod` per the Golden Rule.

import type {
  CapitalFundRow,
  CapitalFundStatementValues,
  CapitalFundAdequacyTone,
} from "@/lib/reporting/capital-fund-statement";

/** Tone class for an adequacy-detail row value. */
function capitalAdequacyToneClass(tone: CapitalFundAdequacyTone): string {
  switch (tone) {
    case "favorable": return "text-[#3f7042] font-medium";
    case "risk":      return "text-[#8b3520] font-medium";
    case "neutral":
    default:          return "text-club-green-900";
  }
}

/** Format a Capital Fund table value. Em-dash for null + zero;
 *  parens for negative (e.g. "Less: Debt Service"); thousands
 *  separator for positive. */
function formatCapitalValue(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "—";
  const abs = Math.abs(Math.round(value));
  const str = abs.toLocaleString("en-US");
  return value < 0 ? `(${str})` : str;
}

const CAPITAL_GRID = "minmax(0, 1fr) 6.6rem 6.6rem 6.6rem";
const CAPITAL_GRID_GAP = "1rem";

function CapitalFundValueCells({
  values, baseClass,
}: {
  values: CapitalFundStatementValues;
  baseClass: string;
}) {
  return (
    <>
      <span className={`text-right tabular-nums ${baseClass}`}>
        {formatCapitalValue(values.annualBudget)}
      </span>
      <span className={`text-right tabular-nums ${baseClass}`}>
        {formatCapitalValue(values.ytdActual)}
      </span>
      <span className={`text-right tabular-nums ${baseClass}`}>
        {formatCapitalValue(values.remaining)}
      </span>
    </>
  );
}

function CapitalFundRowRender({ row }: { row: CapitalFundRow }) {
  switch (row.kind) {
    case "section-band":
    case "analysis-band": {
      return (
        <div
          data-testid={`cf-row-${row.key}`}
          className="px-4 py-2 uppercase tracking-[0.18em] text-[10.5px] text-[#4a6280] bg-[#d4e0ec]/55 border-y border-[#bcd0e2]/50"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.label}
        </div>
      );
    }
    case "commentary": {
      return (
        <div
          data-testid={`cf-row-${row.key}`}
          data-kind="commentary"
          className="px-6 py-2 italic text-[12.5px] leading-snug text-club-green-900/70 bg-club-cream/40"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.text}
        </div>
      );
    }
    case "summary-band": {
      // Net Capital Position Change — heavier pale-blue band, bold
      // italic. Visual emphasis sits BETWEEN the Saguaro "Total"
      // band and the NOI dark-green band.
      if (!row.values) return null;
      return (
        <div
          data-testid={`cf-row-${row.key}`}
          data-kind="summary-band"
          className="grid items-center px-4 py-2.5 bg-[#d4e0ec]/70 border-y border-[#bcd0e2] font-serif italic"
          style={{ gridTemplateColumns: CAPITAL_GRID, columnGap: CAPITAL_GRID_GAP }}
        >
          <span className="font-semibold text-[13.5px] text-club-green-900">{row.label}</span>
          <CapitalFundValueCells
            values={row.values}
            baseClass="text-[13px] text-club-green-900 font-semibold"
          />
        </div>
      );
    }
    case "subtotal": {
      if (!row.values) return null;
      return (
        <div
          data-testid={`cf-row-${row.key}`}
          data-kind="subtotal"
          className="grid items-center px-4 py-2 bg-[#e8dfc8]/65 border-y border-club-sand/55 font-serif italic"
          style={{ gridTemplateColumns: CAPITAL_GRID, columnGap: CAPITAL_GRID_GAP }}
        >
          <span className="font-semibold text-[13px] text-club-green-900">{row.label}</span>
          <CapitalFundValueCells
            values={row.values}
            baseClass="text-[13px] text-club-green-900 font-semibold"
          />
        </div>
      );
    }
    case "net-line": {
      if (!row.values) return null;
      return (
        <div
          data-testid={`cf-row-${row.key}`}
          data-kind="net-line"
          className="grid items-center px-4 py-2 bg-[#e8dfc8]/65 border-y border-club-sand/55 font-serif italic"
          style={{ gridTemplateColumns: CAPITAL_GRID, columnGap: CAPITAL_GRID_GAP }}
        >
          <span className="font-semibold text-[13.5px] text-club-green-900">{row.label}</span>
          <CapitalFundValueCells
            values={row.values}
            baseClass="text-[13px] text-club-green-900 font-semibold"
          />
        </div>
      );
    }
    case "detail":
    default: {
      if (!row.values) return null;
      return (
        <div
          data-testid={`cf-row-${row.key}`}
          data-kind="detail"
          className="grid items-center px-4 py-1.5 bg-club-cream/20 border-b border-club-sand/25"
          style={{ gridTemplateColumns: CAPITAL_GRID, columnGap: CAPITAL_GRID_GAP }}
        >
          <span className="text-[13px] text-club-green-900">{row.label}</span>
          <CapitalFundValueCells
            values={row.values}
            baseClass="text-[13px] text-club-green-900"
          />
        </div>
      );
    }
  }
}

function CapitalFundPanel({
  pkg,
}: {
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
}) {
  const cf = pkg.capitalFundStatement;
  // Cap the progress bar fill at 100%.
  const reservePctFill = Math.min(100, Math.max(0, cf.reserveCoverage.currentPct * 100));
  return (
    <div data-testid="capital-fund-statement" className="font-serif">
      {/* Header chrome — same shape as Statement of Activities so
          the two chapters read as peers. */}
      <header className="flex flex-col gap-4 border-b border-club-sand/60 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <p
            data-testid="cf-eyebrow"
            className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
          >
            {cf.eyebrow}
          </p>
          <h2
            data-testid="cf-title"
            className="font-serif text-[34px] leading-[1.05] tracking-tight text-club-green-900"
          >
            {cf.title}
          </h2>
          <p
            data-testid="cf-period"
            className="uppercase tracking-[0.22em] text-[10.5px] text-club-green-800/65"
          >
            {cf.periodLabel}
          </p>
          <p
            data-testid="cf-intro"
            className="mt-3 max-w-[560px] italic text-[14.5px] leading-relaxed text-club-green-900/85"
          >
            {cf.introNote}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <p
            data-testid="cf-statement-number"
            className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65"
          >
            {cf.statementNumber}
          </p>
          <span
            data-testid="cf-document-chip"
            className="inline-flex items-center rounded-md border border-club-gold/40 bg-club-cream px-2.5 py-1 uppercase tracking-[0.18em] text-[10px] text-club-gold-700"
          >
            {cf.documentChip}
          </span>
          <p
            data-testid="cf-prepared-for"
            className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65"
          >
            {cf.preparedFor}
          </p>
        </div>
      </header>

      {/* Two-column body — left table + right cards stack. */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1.55fr_1fr] lg:gap-7">
        {/* LEFT — Sources & Uses table. */}
        <div
          data-testid="cf-table"
          className="overflow-hidden rounded-md border border-club-sand/60"
        >
          {/* Column header row — same beige treatment as Statement
              of Activities so the two tables share a visual family. */}
          <div
            data-testid="cf-column-headers"
            className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/60 bg-[#e8dfc8]/40 border-y border-club-sand/40"
            style={{ gridTemplateColumns: CAPITAL_GRID, columnGap: CAPITAL_GRID_GAP }}
          >
            <span className="text-left">{cf.columnHeaders.category}</span>
            <span className="text-right">{cf.columnHeaders.annualBudget}</span>
            <span className="text-right">{cf.columnHeaders.ytdActual}</span>
            <span className="text-right">{cf.columnHeaders.remaining}</span>
          </div>
          {cf.rows.map((row) => (
            <CapitalFundRowRender key={row.key} row={row} />
          ))}
        </div>

        {/* RIGHT — Reserve cards stack. */}
        <div className="flex flex-col gap-5">
          {/* Card 1 — Reserve Coverage Ratio vs. Targets. */}
          <article
            data-testid="cf-card-reserve-coverage"
            className="rounded-md border border-club-sand/60 bg-club-cream/40 px-5 py-5"
          >
            <h3
              data-testid="cf-card-reserve-coverage-eyebrow"
              className="uppercase tracking-[0.18em] text-[10.5px] text-[#4a6280]"
            >
              Reserve Coverage Ratio — Current Position vs. Targets
            </h3>
            <div className="mt-4 grid grid-cols-[auto_1fr] items-start gap-x-6 gap-y-1">
              <div>
                <p
                  data-testid="cf-card-reserve-coverage-current"
                  className="font-serif text-[42px] leading-none tracking-tight text-club-green-900 tabular-nums"
                >
                  {cf.reserveCoverage.currentPctLabel}
                </p>
                <p className="mt-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/65">
                  Current Coverage
                </p>
              </div>
              <div className="flex flex-col gap-1 text-[13px] text-club-green-900/85">
                <p>
                  <span className="text-club-green-800/65">FAC Benchmark: </span>
                  <span className="font-medium">60%+</span>
                </p>
                <p>
                  <span className="text-club-green-800/65">3-Year Goal: </span>
                  <span className="font-medium">75%</span>
                </p>
                <p>
                  <span className="text-club-green-800/65">Reserve Balance: </span>
                  <span className="font-medium tabular-nums">{cf.reserveCoverage.reserveBalanceLabel.replace("Reserve Balance: ", "")}</span>
                </p>
              </div>
            </div>
            {/* Progress ribbon — gradient green → darker green to
                evoke the Saguaro fill. The ribbon spans full width;
                tick markers below align by % position. */}
            <div className="mt-5">
              <div
                data-testid="cf-card-reserve-coverage-bar"
                className="relative h-2 w-full overflow-hidden rounded-sm bg-[#d4e0ec]/70"
              >
                <div
                  data-testid="cf-card-reserve-coverage-bar-fill"
                  className="h-full rounded-sm"
                  style={{
                    width: `${reservePctFill}%`,
                    background:
                      "linear-gradient(90deg, #3f7042 0%, #2c5c47 70%, #1f3621 100%)",
                  }}
                />
              </div>
              <div
                data-testid="cf-card-reserve-coverage-markers"
                className="relative mt-2 h-4 w-full text-[10px] text-club-green-800/70"
              >
                {cf.reserveCoverage.markers.map((m, i) => (
                  <span
                    key={m.label}
                    data-testid={`cf-card-reserve-coverage-marker-${i}`}
                    className="absolute -translate-x-1/2 whitespace-nowrap"
                    style={{ left: `${m.pct * 100}%` }}
                  >
                    {m.label}
                  </span>
                ))}
              </div>
            </div>
          </article>

          {/* Card 2 — Reserve Adequacy Detail rows. */}
          <article
            data-testid="cf-card-reserve-adequacy"
            className="rounded-md border border-club-sand/60 bg-club-cream/40 px-5 py-5"
          >
            <h3
              data-testid="cf-card-reserve-adequacy-eyebrow"
              className="uppercase tracking-[0.18em] text-[10.5px] text-[#4a6280]"
            >
              Reserve Adequacy Detail
            </h3>
            <dl
              data-testid="cf-card-reserve-adequacy-list"
              className="mt-4 space-y-2.5"
            >
              {cf.reserveAdequacy.map((row) => (
                <div
                  key={row.key}
                  data-testid={`cf-card-reserve-adequacy-${row.key}`}
                  data-tone={row.tone}
                  className="flex items-baseline justify-between gap-3 border-b border-club-sand/30 pb-2 last:border-b-0"
                >
                  <dt className="text-[13px] text-club-green-900/85">{row.label}</dt>
                  <dd className={`text-right text-[13px] tabular-nums ${capitalAdequacyToneClass(row.tone)}`}>
                    {row.valueLabel}
                    {row.checkmark ? <span className="ml-1.5">✓</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </article>

          {/* Card 3 — Capital Stress Test commentary. */}
          <article
            data-testid="cf-card-stress-test"
            className="rounded-md border border-[#d8b89a]/55 bg-[#f2e6d8]/45 px-5 py-5"
          >
            <h3
              data-testid="cf-card-stress-test-eyebrow"
              className="uppercase tracking-[0.18em] text-[10.5px] text-[#a06b3f]"
            >
              {cf.stressTest.eyebrow}
            </h3>
            <p
              data-testid="cf-card-stress-test-body"
              className="mt-3 text-[13px] leading-relaxed text-club-green-900/90"
            >
              {cf.stressTest.body}
            </p>
          </article>
        </div>
      </div>

      {/* Bottom padding spacer — reference attribution removed
          2026-06-15. The mt-12 preserves the section's visual
          breathing room before the next chapter ornament. */}
      <div aria-hidden="true" className="mt-12" />
    </div>
  );
}

// ============================================================================
// Chapter VI — Capital Project Tracker
// ============================================================================
// Saguaro-style nine-column project ledger. Section bands group
// projects by stage (Active Replacements / Active Improvements /
// Planning); a strong pale-blue Total band closes the table; a
// green-tinted exception report card + bullet project notes block
// follow. Period labels (statement header, exception eyebrow,
// next-board-meeting reference) flow from ReportingPeriod.

import type {
  CapitalProjectRow,
  CapitalProjectStatus,
} from "@/lib/reporting/capital-project-tracker";

/** Restrained brand-palette pill colours for the 5 status tones. */
function capitalProjectStatusPillClass(tone: CapitalProjectStatus): string {
  switch (tone) {
    case "on-track":    return "border-club-green-700/40 bg-club-green-700/10 text-club-green-700";
    case "pre-install": return "border-[#a08850]/45 bg-[#a08850]/12 text-[#8a6d3a]";
    case "planning":    return "border-[#4a6280]/45 bg-[#4a6280]/12 text-[#4a6280]";
    case "at-risk":     return "border-[#b08a4a]/55 bg-[#b08a4a]/15 text-[#8a6d3a]";
    case "over-budget": return "border-[#8b3520]/45 bg-[#8b3520]/10 text-[#8b3520]";
  }
}

function formatCapitalProjectValue(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "—";
  const abs = Math.abs(Math.round(value));
  const str = abs.toLocaleString("en-US");
  return value < 0 ? `(${str})` : str;
}

function formatCapitalProjectPercent(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}

/** Tone class for the variance cell. */
function capitalProjectVarianceClass(value: number | null): string {
  if (value === null || value === 0) return "text-club-green-900/55";
  return value > 0 ? "text-[#3f7042] font-medium" : "text-[#8b3520] font-medium";
}

const CAPITAL_PROJECT_GRID =
  // Status column bumped from 5.8rem → 7.5rem 2026-06-15 so the
  // longest pill labels ("PRE-INSTALL" / "OVER BUDGET") render on
  // a single line at the project-tracker typography (text-[9.5px]
  // uppercase + tracking-[0.18em]).
  "minmax(0, 1.4fr) 5.2rem 5.2rem 5.2rem 5.6rem 5rem 4rem 5.4rem 7.5rem";
const CAPITAL_PROJECT_GRID_GAP = "0.6rem";

function CapitalProjectRowRender({ row }: { row: CapitalProjectRow }) {
  switch (row.kind) {
    case "section-band": {
      return (
        <div
          data-testid={`cpt-row-${row.key}`}
          className="px-4 py-2 uppercase tracking-[0.18em] text-[10.5px] text-[#4a6280] bg-[#d4e0ec]/55 border-y border-[#bcd0e2]/50"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.label}
        </div>
      );
    }
    case "commentary": {
      return (
        <div
          data-testid={`cpt-row-${row.key}`}
          data-kind="commentary"
          className="px-6 py-2 italic text-[12.5px] leading-snug text-club-green-900/70 bg-club-cream/40"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.text}
        </div>
      );
    }
    case "total": {
      if (!row.values) return null;
      return (
        <div
          data-testid={`cpt-row-${row.key}`}
          data-kind="total"
          className="grid items-center px-4 py-2.5 bg-[#d4e0ec]/70 border-y border-[#bcd0e2] font-serif"
          style={{ gridTemplateColumns: CAPITAL_PROJECT_GRID, columnGap: CAPITAL_PROJECT_GRID_GAP }}
        >
          <span className="font-semibold text-[13.5px] text-club-green-900">{row.label}</span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900 font-semibold">
            {formatCapitalProjectValue(row.values.authorized)}
          </span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900 font-semibold">
            {formatCapitalProjectValue(row.values.contracted)}
          </span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900 font-semibold">
            {formatCapitalProjectValue(row.values.spentYtd)}
          </span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900 font-semibold">
            {formatCapitalProjectValue(row.values.projectedFinal)}
          </span>
          <span className={`text-right tabular-nums text-[13px] font-semibold ${capitalProjectVarianceClass(row.values.variance)}`}>
            {formatCapitalProjectValue(row.values.variance)}
          </span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900/55">—</span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900/55">—</span>
          <span />
        </div>
      );
    }
    case "project":
    default: {
      if (!row.values) return null;
      const v = row.values;
      return (
        <div
          data-testid={`cpt-row-${row.key}`}
          data-kind="project"
          className="grid items-center px-4 py-1.5 bg-club-cream/20 border-b border-club-sand/25"
          style={{ gridTemplateColumns: CAPITAL_PROJECT_GRID, columnGap: CAPITAL_PROJECT_GRID_GAP }}
        >
          <span className="text-[13px] text-club-green-900">{row.label}</span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900">
            {formatCapitalProjectValue(v.authorized)}
          </span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900">
            {formatCapitalProjectValue(v.contracted)}
          </span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900">
            {formatCapitalProjectValue(v.spentYtd)}
          </span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900">
            {row.projectedFinalLabel ?? formatCapitalProjectValue(v.projectedFinal)}
          </span>
          <span className={`text-right tabular-nums text-[13px] ${capitalProjectVarianceClass(v.variance)}`}>
            {formatCapitalProjectValue(v.variance)}
          </span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900">
            {formatCapitalProjectPercent(v.percentDone)}
          </span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900">
            {v.estCompleteLabel}
          </span>
          <span className="flex items-center justify-end">
            {row.status ? (
              <span
                data-testid={`cpt-row-${row.key}-status`}
                data-tone={row.status.tone}
                // `whitespace-nowrap` prevents the pill text from
                // wrapping at narrow widths — required for the
                // longer labels ("PRE-INSTALL" / "OVER BUDGET") to
                // render on a single line. `px-2` gives a touch
                // more horizontal breathing room than the prior
                // `px-1.5`. The grid's Status column (7.5rem) sits
                // wide enough to fit every standard label.
                className={`inline-flex items-center whitespace-nowrap rounded-sm border px-2 py-0.5 text-[9.5px] uppercase tracking-[0.18em] ${capitalProjectStatusPillClass(row.status.tone)}`}
              >
                {row.status.label}
              </span>
            ) : null}
          </span>
        </div>
      );
    }
  }
}

function CapitalProjectTrackerPanel({
  pkg,
}: {
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
}) {
  const cpt = pkg.capitalProjectTracker;
  return (
    <div data-testid="capital-projects" className="font-serif">
      <header className="flex flex-col gap-4 border-b border-club-sand/60 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <p
            data-testid="cpt-eyebrow"
            className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
          >
            {cpt.eyebrow}
          </p>
          <h2
            data-testid="cpt-title"
            className="font-serif text-[34px] leading-[1.05] tracking-tight text-club-green-900"
          >
            {cpt.title}
          </h2>
          <p
            data-testid="cpt-period"
            className="uppercase tracking-[0.22em] text-[10.5px] text-club-green-800/65"
          >
            {cpt.periodLabel}
          </p>
          <p
            data-testid="cpt-intro"
            className="mt-3 max-w-[560px] italic text-[14.5px] leading-relaxed text-club-green-900/85"
          >
            {cpt.introNote}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <p
            data-testid="cpt-statement-number"
            className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65"
          >
            {cpt.statementNumber}
          </p>
          <span
            data-testid="cpt-document-chip"
            className="inline-flex items-center rounded-md border border-club-gold/40 bg-club-cream px-2.5 py-1 uppercase tracking-[0.18em] text-[10px] text-club-gold-700"
          >
            {cpt.documentChip}
          </span>
          <p
            data-testid="cpt-prepared-for"
            className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65"
          >
            {cpt.preparedFor}
          </p>
        </div>
      </header>

      {/* Project table. */}
      <div
        data-testid="cpt-table"
        className="mt-6 overflow-hidden rounded-md border border-club-sand/60"
      >
        <div
          data-testid="cpt-column-headers"
          className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/60 bg-[#e8dfc8]/40 border-y border-club-sand/40"
          style={{ gridTemplateColumns: CAPITAL_PROJECT_GRID, columnGap: CAPITAL_PROJECT_GRID_GAP }}
        >
          <span className="text-left">{cpt.columnHeaders.project}</span>
          <span className="text-right">{cpt.columnHeaders.authorized}</span>
          <span className="text-right">{cpt.columnHeaders.contracted}</span>
          <span className="text-right">{cpt.columnHeaders.spentYtd}</span>
          <span className="text-right">{cpt.columnHeaders.projectedFinal}</span>
          <span className="text-right">{cpt.columnHeaders.variance}</span>
          <span className="text-right">{cpt.columnHeaders.percentDone}</span>
          <span className="text-right">{cpt.columnHeaders.estComplete}</span>
          <span className="text-right">{cpt.columnHeaders.status}</span>
        </div>
        {cpt.rows.map((row) => (
          <CapitalProjectRowRender key={row.key} row={row} />
        ))}
      </div>

      {/* Exception report — green-tinted card. */}
      <article
        data-testid="cpt-exception-report"
        className="mt-5 rounded-md border border-club-green-700/25 bg-club-green-700/8 px-5 py-4"
      >
        <h3
          data-testid="cpt-exception-report-eyebrow"
          className="uppercase tracking-[0.22em] text-[10.5px] text-club-green-700/85"
        >
          {cpt.exceptionReport.eyebrow}
        </h3>
        <p
          data-testid="cpt-exception-report-body"
          className="mt-3 text-[13.5px] leading-relaxed text-club-green-900/90"
        >
          {cpt.exceptionReport.body}
        </p>
      </article>

      {/* Project Notes — bullet-style with ▶ markers. */}
      <div
        data-testid="cpt-project-notes"
        className="mt-7"
      >
        <h3
          data-testid="cpt-project-notes-eyebrow"
          className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
        >
          Project Notes
        </h3>
        <ul
          data-testid="cpt-project-notes-list"
          className="mt-4 space-y-3 font-serif text-[13.5px] leading-relaxed text-club-green-900/90"
        >
          {cpt.projectNotes.map((note, idx) => (
            <li
              key={idx}
              data-testid={`cpt-project-note-${idx}`}
              className="flex items-start gap-3"
            >
              <span
                aria-hidden="true"
                className="mt-1 inline-block shrink-0 text-[11px] leading-none text-[#8b3520]"
              >
                &#9654;
              </span>
              <p className="flex-1">{note.text}</p>
            </li>
          ))}
        </ul>
      </div>

      {/* Bottom padding spacer — no reference attribution. */}
      <div aria-hidden="true" className="mt-12" />
    </div>
  );
}

// ============================================================================
// Chapter VII — Statement of Financial Position (Balance Sheet)
// ============================================================================
// Vertical layout — Assets table → Liabilities & Members' Equity
// table → Stewardship Ratios card → Balance Sheet Notes block.
// Period labels (header + per-table Current/Comparative columns)
// flow from ReportingPeriod via the service.

import type {
  SoFPRow,
  SoFPRatioRow,
  SoFPRatioTone,
  SoFPBalanceSheetNote,
} from "@/lib/reporting/statement-of-financial-position";
import { SoFPFsGroupExpandable } from "./SoFPFsGroupExpandable";

function formatBalanceSheetValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "—";
  const abs = Math.abs(Math.round(value));
  const str = abs.toLocaleString("en-US");
  return value < 0 ? `(${str})` : str;
}

function balanceSheetValueClass(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return "text-club-green-900/55";
  return value < 0 ? "text-[#8b3520]" : "text-club-green-900";
}

const SOFP_GRID = "minmax(0, 1fr) 8rem 8rem";
const SOFP_GRID_GAP = "1.2rem";

function SoFPRowRender({ row }: { row: SoFPRow }) {
  switch (row.kind) {
    // v15.14 — FS-Group summary row. Renders like the historical
    // "detail" row (same 3-column grid, same numeric alignment) but
    // when `row.accounts` is populated AND `showAccountDetail` is
    // true at the parent, the client-island toggle exposes the
    // underlying accounts nested beneath. Board / member / PDF
    // payloads never include `row.accounts`, so this path is
    // safe from any accidental account leak.
    case "fs-group": {
      const hasAccounts = row.accounts !== undefined && row.accounts.length > 0;
      // When no expandable account detail exists, render the
      // summary row exactly like a detail row so PDF + Board views
      // look identical to their v15.13 predecessor. Only the admin
      // view with drill-down permission ever sees the disclosure
      // affordance.
      if (!hasAccounts) {
        return (
          <div
            data-testid={`sofp-row-${row.key}`}
            data-kind="fs-group"
            data-fs-group-key={row.fsGroupKey ?? ""}
            className="grid items-center px-4 py-1.5 bg-club-cream/20 border-b border-club-sand/25"
            style={{ gridTemplateColumns: SOFP_GRID, columnGap: SOFP_GRID_GAP }}
          >
            <span className="text-[13px] text-club-green-900">{row.label}</span>
            <span className={`text-right tabular-nums text-[13px] ${balanceSheetValueClass(row.current)}`}>
              {formatBalanceSheetValue(row.current)}
            </span>
            <span className={`text-right tabular-nums text-[13px] ${balanceSheetValueClass(row.comparative)}`}>
              {formatBalanceSheetValue(row.comparative)}
            </span>
          </div>
        );
      }
      return <SoFPFsGroupExpandable row={row} />;
    }
    // v15.14 — Unmapped Balance Sheet Accounts band. Only rendered
    // when the reporting service was authorized. Renders as a
    // section band followed by the underlying-account lines. Board
    // / member / PDF views never hit this branch because the
    // unmapped accounts are folded into a neutral "Other" summary
    // row by the parent renderer.
    case "unmapped-band": {
      return (
        <div
          data-testid={`sofp-row-${row.key}`}
          data-kind="unmapped-band"
          className="px-4 py-2 uppercase tracking-[0.18em] text-[10.5px] text-[#8b3520] bg-[#f7ecec] border-y border-[#e5c4c4]"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.label}
        </div>
      );
    }
    case "section-band-operating": {
      return (
        <div
          data-testid={`sofp-row-${row.key}`}
          className="px-4 py-2 uppercase tracking-[0.18em] text-[10.5px] text-[#a08850] bg-[#e8dfc8]/70 border-y border-club-sand/40"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.label}
        </div>
      );
    }
    case "section-band-capital": {
      return (
        <div
          data-testid={`sofp-row-${row.key}`}
          className="px-4 py-2 uppercase tracking-[0.18em] text-[10.5px] text-[#4a6280] bg-[#d4e0ec]/55 border-y border-[#bcd0e2]/50"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.label}
        </div>
      );
    }
    case "subtotal": {
      return (
        <div
          data-testid={`sofp-row-${row.key}`}
          data-kind="subtotal"
          className="grid items-center px-4 py-2 bg-[#e8dfc8]/65 border-y border-club-sand/55 font-serif italic"
          style={{ gridTemplateColumns: SOFP_GRID, columnGap: SOFP_GRID_GAP }}
        >
          <span className="font-semibold text-[13px] text-club-green-900">{row.label}</span>
          <span className={`text-right tabular-nums text-[13px] font-semibold ${balanceSheetValueClass(row.current)}`}>
            {formatBalanceSheetValue(row.current)}
          </span>
          <span className={`text-right tabular-nums text-[13px] font-semibold ${balanceSheetValueClass(row.comparative)}`}>
            {formatBalanceSheetValue(row.comparative)}
          </span>
        </div>
      );
    }
    case "total-mid": {
      return (
        <div
          data-testid={`sofp-row-${row.key}`}
          data-kind="total-mid"
          className="grid items-center px-4 py-2.5 bg-[#e8dfc8]/80 border-y border-club-sand font-serif"
          style={{ gridTemplateColumns: SOFP_GRID, columnGap: SOFP_GRID_GAP }}
        >
          <span className="font-semibold text-[13.5px] text-club-green-900">{row.label}</span>
          <span className={`text-right tabular-nums text-[13.5px] font-semibold ${balanceSheetValueClass(row.current)}`}>
            {formatBalanceSheetValue(row.current)}
          </span>
          <span className={`text-right tabular-nums text-[13.5px] font-semibold ${balanceSheetValueClass(row.comparative)}`}>
            {formatBalanceSheetValue(row.comparative)}
          </span>
        </div>
      );
    }
    case "total": {
      return (
        <div
          data-testid={`sofp-row-${row.key}`}
          data-kind="total"
          className="grid items-center px-4 py-3 bg-[#e0d4b5]/85 border-y border-club-sand font-serif"
          style={{ gridTemplateColumns: SOFP_GRID, columnGap: SOFP_GRID_GAP }}
        >
          <span className="font-semibold text-[14px] text-club-green-900">{row.label}</span>
          <span className={`text-right tabular-nums text-[14px] font-semibold ${balanceSheetValueClass(row.current)}`}>
            {formatBalanceSheetValue(row.current)}
          </span>
          <span className={`text-right tabular-nums text-[14px] font-semibold ${balanceSheetValueClass(row.comparative)}`}>
            {formatBalanceSheetValue(row.comparative)}
          </span>
        </div>
      );
    }
    case "detail":
    default: {
      return (
        <div
          data-testid={`sofp-row-${row.key}`}
          data-kind="detail"
          className="grid items-center px-4 py-1.5 bg-club-cream/20 border-b border-club-sand/25"
          style={{ gridTemplateColumns: SOFP_GRID, columnGap: SOFP_GRID_GAP }}
        >
          <span className="text-[13px] text-club-green-900">{row.label}</span>
          <span className={`text-right tabular-nums text-[13px] ${balanceSheetValueClass(row.current)}`}>
            {formatBalanceSheetValue(row.current)}
          </span>
          <span className={`text-right tabular-nums text-[13px] ${balanceSheetValueClass(row.comparative)}`}>
            {formatBalanceSheetValue(row.comparative)}
          </span>
        </div>
      );
    }
  }
}

function sofpRatioBarFillClass(tone: SoFPRatioTone): string {
  switch (tone) {
    case "favorable": return "bg-[#3f7042]";
    case "risk":      return "bg-[#8b3520]";
    case "capital":   return "bg-[#3a5a78]";
  }
}

function sofpRatioCheckmarkClass(tone: SoFPRatioTone): string {
  switch (tone) {
    case "favorable": return "text-[#3f7042]";
    case "risk":      return "text-[#8b3520]";
    case "capital":   return "text-[#3a5a78]";
  }
}

function SoFPRatioBarRow({ row }: { row: SoFPRatioRow }) {
  return (
    <div
      data-testid={`sofp-ratio-${row.key}`}
      data-tone={row.tone}
      className="grid items-center gap-x-3 py-1.5"
      style={{ gridTemplateColumns: "minmax(0, 11rem) minmax(0, 1fr) 3.5rem 3.5rem 1rem" }}
    >
      <span className="text-[12.5px] text-club-green-800/85">{row.label}</span>
      <div className="relative h-1.5 w-full rounded-sm bg-[#d4e0ec]/45">
        <div
          data-testid={`sofp-ratio-${row.key}-fill`}
          className={`h-full rounded-sm ${sofpRatioBarFillClass(row.tone)}`}
          style={{ width: `${row.barFillPct * 100}%` }}
        />
        <div
          data-testid={`sofp-ratio-${row.key}-target-marker`}
          aria-hidden="true"
          className="absolute top-0 h-full w-px bg-club-green-900/60"
          style={{ left: `${row.barTargetPct * 100}%` }}
        />
      </div>
      <span className="text-right text-[12.5px] tabular-nums font-medium text-club-green-900">
        {row.actualLabel}
      </span>
      <span className="text-right text-[12.5px] tabular-nums text-club-green-800/75">
        {row.targetLabel}
      </span>
      <span
        aria-hidden="true"
        data-testid={`sofp-ratio-${row.key}-pass-glyph`}
        className={`text-center text-[12px] ${row.passesTarget ? sofpRatioCheckmarkClass(row.tone) : "text-[#8b3520]"}`}
      >
        {row.passesTarget ? "✓" : "↗"}
      </span>
    </div>
  );
}

function StatementOfFinancialPositionPanel({
  pkg,
}: {
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
}) {
  const sofp = pkg.statementOfFinancialPositionV2;
  return (
    <div data-testid="financial-position" className="font-serif">
      <header className="flex flex-col gap-4 border-b border-club-sand/60 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <p data-testid="sofp-eyebrow" className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]">
            {sofp.eyebrow}
          </p>
          <h2 data-testid="sofp-title" className="font-serif text-[34px] leading-[1.05] tracking-tight text-club-green-900">
            {sofp.title}
          </h2>
          <p data-testid="sofp-period" className="uppercase tracking-[0.22em] text-[10.5px] text-club-green-800/65">
            {sofp.periodLabel}
          </p>
          <p data-testid="sofp-intro" className="mt-3 max-w-[560px] italic text-[14.5px] leading-relaxed text-club-green-900/85">
            {sofp.introNote}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <p data-testid="sofp-statement-number" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {sofp.statementNumber}
          </p>
          <span
            data-testid="sofp-document-chip"
            className="inline-flex items-center rounded-md border border-club-gold/40 bg-club-cream px-2.5 py-1 uppercase tracking-[0.18em] text-[10px] text-club-gold-700"
          >
            {sofp.documentChip}
          </span>
          <p data-testid="sofp-prepared-for" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {sofp.preparedFor}
          </p>
        </div>
      </header>

      {/* v15.16 — Reconciliation banner. The Statement of Financial
          Position must always balance: Total Assets = Total
          Liabilities + Members' Equity. When it does not, the
          renderer surfaces this prominent banner and the publish
          path refuses to freeze the payload into
          `packagePayloadJson`. The banner is visible to admins,
          board viewers, and PDF captures so out-of-balance
          statements can never quietly ship. */}
      {sofp.reconciliation && !sofp.reconciliation.balances ? (
        <div
          data-testid="sofp-out-of-balance-banner"
          role="alert"
          className="mt-6 rounded-md border border-[#8b3520] bg-[#f7ecec] px-5 py-4 text-club-green-900"
        >
          <p className="font-serif font-semibold text-[15px] text-[#8b3520]">
            Statement of Financial Position does not reconcile
          </p>
          <p className="mt-2 font-serif text-[13px] leading-relaxed">
            Total Assets{" "}
            <span className="tabular-nums font-semibold">
              {formatBalanceSheetValue(sofp.reconciliation.totalAssetsCurrent)}
            </span>{" "}
            does not equal Total Liabilities + Members&rsquo; Equity{" "}
            <span className="tabular-nums font-semibold">
              {formatBalanceSheetValue(sofp.reconciliation.totalLiabilitiesAndEquityCurrent)}
            </span>
            . Difference:{" "}
            <span className="tabular-nums font-semibold text-[#8b3520]">
              {formatBalanceSheetValue(sofp.reconciliation.difference ?? 0)}
            </span>
            .
          </p>
          <p className="mt-2 font-serif text-[12px] italic text-club-green-800/85">
            Review the Chart of Accounts classifications for accounts appearing in the unmapped band, verify the Trial Balance reconciles, and rebuild the projection. Publication is blocked until the difference is within $1.
          </p>
        </div>
      ) : null}

      {/* Assets table. */}
      <div
        data-testid="sofp-assets-table"
        className="mt-6 overflow-hidden rounded-md border border-club-sand/60"
      >
        <div
          data-testid="sofp-assets-column-headers"
          className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/60 bg-[#e8dfc8]/40 border-y border-club-sand/40"
          style={{ gridTemplateColumns: SOFP_GRID, columnGap: SOFP_GRID_GAP }}
        >
          <span className="text-left">{sofp.assetsColumnHeaders.category}</span>
          <span className="text-right">{sofp.assetsColumnHeaders.current}</span>
          <span className="text-right">{sofp.assetsColumnHeaders.comparative}</span>
        </div>
        {sofp.assetsRows.map((row) => (
          <SoFPRowRender key={row.key} row={row} />
        ))}
      </div>

      {/* Liabilities & Members' Equity table. */}
      <div
        data-testid="sofp-liabilities-table"
        className="mt-6 overflow-hidden rounded-md border border-club-sand/60"
      >
        <div
          data-testid="sofp-liabilities-column-headers"
          className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/60 bg-[#e8dfc8]/40 border-y border-club-sand/40"
          style={{ gridTemplateColumns: SOFP_GRID, columnGap: SOFP_GRID_GAP }}
        >
          <span className="text-left">{sofp.liabilitiesColumnHeaders.category}</span>
          <span className="text-right">{sofp.liabilitiesColumnHeaders.current}</span>
          <span className="text-right">{sofp.liabilitiesColumnHeaders.comparative}</span>
        </div>
        {sofp.liabilitiesEquityRows.map((row) => (
          <SoFPRowRender key={row.key} row={row} />
        ))}
      </div>

      {/* v15.14 — Unmapped Balance Sheet Accounts band.
          Only rendered when there are unmapped accounts AND the
          reporting service was authorized to surface them per-
          account (`sofp.showAccountDetail === true`). Board / member
          / PDF payloads either omit the band entirely (no unmapped
          accounts) or receive a summarised Other/Unclassified row
          inside their own aggregation pass. */}
      {sofp.showAccountDetail && sofp.unmappedAccounts.length > 0 ? (
        <div
          data-testid="sofp-unmapped-band"
          className="mt-6 overflow-hidden rounded-md border border-[#e5c4c4]/70"
        >
          <div
            className="px-4 py-2 uppercase tracking-[0.18em] text-[10.5px] text-[#8b3520] bg-[#f7ecec] border-b border-[#e5c4c4]/70"
          >
            Unmapped Balance Sheet Accounts — Requires COA Mapping
          </div>
          {sofp.unmappedAccounts.map((account) => (
            <div
              key={account.accountCode}
              data-testid={`sofp-unmapped-${account.accountCode}`}
              className="grid items-center px-4 py-1.5 bg-club-cream/30 border-b border-[#e5c4c4]/40"
              style={{ gridTemplateColumns: SOFP_GRID, columnGap: SOFP_GRID_GAP }}
            >
              <span className="text-[12.5px] text-club-green-900/90">
                <span className="mr-2 tabular-nums text-club-green-800/60">{account.accountCode}</span>
                {account.accountName}
                <span className="ml-2 uppercase tracking-[0.14em] text-[9.5px] text-[#8b3520]/70">
                  · {account.inferredSide === "assets" ? "Asset" : account.inferredSide === "liabilities-equity" ? "Liability / Equity" : "Unclassified"}
                </span>
              </span>
              <span className={`text-right tabular-nums text-[12.5px] ${balanceSheetValueClass(account.current)}`}>
                {formatBalanceSheetValue(account.current)}
              </span>
              <span className={`text-right tabular-nums text-[12.5px] ${balanceSheetValueClass(account.comparative)}`}>
                {formatBalanceSheetValue(account.comparative)}
              </span>
            </div>
          ))}
          <div className="px-4 py-2 text-[11.5px] italic text-[#8b3520]/85 bg-[#f7ecec]/60 border-t border-[#e5c4c4]/60">
            Assign each account to a Financial Statement Group in <a className="underline" href="/app/admin/coa">Chart of Accounts</a> to remove it from this band.
          </div>
        </div>
      ) : null}

      {/* Stewardship Ratios card. */}
      <article
        data-testid="sofp-stewardship-ratios"
        className="mt-6 rounded-md border border-club-sand/60 bg-club-cream/40 px-5 py-5"
      >
        <h3
          data-testid="sofp-stewardship-ratios-eyebrow"
          className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
        >
          {sofp.stewardshipRatios.eyebrow}
        </h3>
        <div className="mt-4">
          {sofp.stewardshipRatios.rows.map((row) => (
            <SoFPRatioBarRow key={row.key} row={row} />
          ))}
        </div>
      </article>

      {/* Balance Sheet Notes block. */}
      <div
        data-testid="sofp-balance-sheet-notes"
        className="mt-6"
      >
        <h3
          data-testid="sofp-balance-sheet-notes-eyebrow"
          className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
        >
          {sofp.balanceSheetNotes.eyebrow}
        </h3>
        <ol
          data-testid="sofp-balance-sheet-notes-list"
          className="mt-4 space-y-3 font-serif text-[13px] leading-relaxed text-club-green-900/90"
        >
          {sofp.balanceSheetNotes.notes.map((note: SoFPBalanceSheetNote) => (
            <li
              key={note.number}
              data-testid={`sofp-balance-sheet-note-${note.number}`}
              className="grid grid-cols-[1.4rem_minmax(0,1fr)] gap-x-2"
            >
              <span className="text-right tabular-nums text-[12px] text-club-green-800/65">
                {note.number}
              </span>
              <p className="flex-1">{note.body}</p>
            </li>
          ))}
        </ol>
      </div>

      {/* Bottom padding spacer — no reference attribution. */}
      <div aria-hidden="true" className="mt-12" />
    </div>
  );
}

// ============================================================================
// Chapter VIII — Accounts Receivable Aging
// ============================================================================
// 4 top KPI summary cards → 7-column AR aging table with status
// pills → 5-column membership activity table → reactive collection
// notes bullets. Period labels flow from ReportingPeriod via the
// service.

import type {
  ARAgingRow,
  ARAgingStatus,
  ARKpiCard,
  MembershipActivityRow,
} from "@/lib/reporting/accounts-receivable-aging";

function arAgingStatusPillClass(tone: ARAgingStatus): string {
  switch (tone) {
    case "current":          return "border-club-green-700/40 bg-club-green-700/10 text-club-green-700";
    case "watch":            return "border-[#b08a4a]/55 bg-[#b08a4a]/15 text-[#8a6d3a]";
    case "collection":       return "border-[#8b3520]/45 bg-[#8b3520]/10 text-[#8b3520]";
    case "suspended":        return "border-[#4a6280]/45 bg-[#4a6280]/12 text-[#4a6280]";
    case "write-off-review": return "border-[#8b3520]/45 bg-[#8b3520]/10 text-[#8b3520]";
  }
}

function arKpiToneClass(tone: ARKpiCard["tone"]): string {
  switch (tone) {
    case "favorable": return "text-[#3f7042]";
    case "risk":      return "text-[#8b3520]";
    case "empty":     return "text-club-green-900/55";
    case "neutral":
    default:          return "text-club-green-900";
  }
}

function arMembershipChangeClass(tone: MembershipActivityRow["changeTone"]): string {
  switch (tone) {
    case "favorable": return "text-[#3f7042] font-medium";
    case "risk":      return "text-[#8b3520] font-medium";
    case "neutral":
    default:          return "text-club-green-900";
  }
}

function formatARValue(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "—";
  const abs = Math.abs(Math.round(value));
  return abs.toLocaleString("en-US");
}

const AR_AGING_GRID =
  // Status column at 7rem so CURRENT / WATCH / COLLECTION /
  // SUSPENDED / WRITE-OFF REVIEW all render on a single line.
  "minmax(0, 1.5fr) 6.4rem 5.8rem 5.8rem 5.4rem 6.4rem 7rem";
const AR_AGING_GRID_GAP = "0.8rem";

const AR_MEMBERSHIP_GRID =
  "minmax(0, 1.5fr) 5.5rem 5.5rem 5rem 7rem";
const AR_MEMBERSHIP_GRID_GAP = "0.8rem";

function ARAgingRowRender({ row }: { row: ARAgingRow }) {
  switch (row.kind) {
    case "section-band": {
      return (
        <div
          data-testid={`ara-row-${row.key}`}
          className="px-4 py-2 uppercase tracking-[0.18em] text-[10.5px] text-[#a08850] bg-[#e8dfc8]/70 border-y border-club-sand/40"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.label}
        </div>
      );
    }
    case "total": {
      if (!row.values) return null;
      return (
        <div
          data-testid={`ara-row-${row.key}`}
          data-kind="total"
          className="grid items-center px-4 py-3 bg-[#e0d4b5]/85 border-y border-club-sand font-serif"
          style={{ gridTemplateColumns: AR_AGING_GRID, columnGap: AR_AGING_GRID_GAP }}
        >
          <span className="font-semibold text-[14px] text-club-green-900">{row.label}</span>
          <span className="text-right tabular-nums text-[14px] font-semibold text-club-green-900">{formatARValue(row.values.current)}</span>
          <span className="text-right tabular-nums text-[14px] font-semibold text-club-green-900">{formatARValue(row.values.days31to60)}</span>
          <span className="text-right tabular-nums text-[14px] font-semibold text-club-green-900/55">{formatARValue(row.values.days61to90)}</span>
          <span className="text-right tabular-nums text-[14px] font-semibold text-club-green-900/55">{formatARValue(row.values.over90)}</span>
          <span className="text-right tabular-nums text-[14px] font-semibold text-club-green-900">{formatARValue(row.values.totalBalance)}</span>
          <span />
        </div>
      );
    }
    case "category":
    default: {
      if (!row.values) return null;
      return (
        <div
          data-testid={`ara-row-${row.key}`}
          data-kind="category"
          className="grid items-center px-4 py-1.5 bg-club-cream/20 border-b border-club-sand/25"
          style={{ gridTemplateColumns: AR_AGING_GRID, columnGap: AR_AGING_GRID_GAP }}
        >
          <span className="text-[13px] text-club-green-900">{row.label}</span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900">{formatARValue(row.values.current)}</span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900">{formatARValue(row.values.days31to60)}</span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900/55">{formatARValue(row.values.days61to90)}</span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900/55">{formatARValue(row.values.over90)}</span>
          <span className="text-right tabular-nums text-[13px] text-club-green-900">{formatARValue(row.values.totalBalance)}</span>
          <span className="flex items-center justify-end">
            {row.status ? (
              <span
                data-testid={`ara-row-${row.key}-status`}
                data-tone={row.status.tone}
                className={`inline-flex items-center whitespace-nowrap rounded-sm border px-2 py-0.5 text-[9.5px] uppercase tracking-[0.18em] ${arAgingStatusPillClass(row.status.tone)}`}
              >
                {row.status.label}
              </span>
            ) : null}
          </span>
        </div>
      );
    }
  }
}

function ARMembershipRowRender({ row }: { row: MembershipActivityRow }) {
  const isEmphasized = row.kind === "total";
  const isNetChange  = row.kind === "net-change";
  return (
    <div
      data-testid={`ara-membership-row-${row.key}`}
      data-kind={row.kind}
      className={`grid items-center px-4 py-1.5 ${
        isEmphasized
          ? "bg-[#e0d4b5]/85 border-y border-club-sand font-serif py-3"
          : "bg-club-cream/20 border-b border-club-sand/25"
      }`}
      style={{ gridTemplateColumns: AR_MEMBERSHIP_GRID, columnGap: AR_MEMBERSHIP_GRID_GAP }}
    >
      <span className={`text-[${isEmphasized ? 14 : 13}px] text-club-green-900 ${isEmphasized ? "font-semibold" : ""}`}>
        {row.label}
      </span>
      <span className={`text-right tabular-nums text-[${isEmphasized ? 14 : 13}px] ${isEmphasized ? "font-semibold text-club-green-900" : isNetChange ? "text-[#3f7042] font-medium" : "text-club-green-900"}`}>
        {row.currentLabel}
      </span>
      <span className={`text-right tabular-nums text-[${isEmphasized ? 14 : 13}px] ${isEmphasized ? "font-semibold text-club-green-900" : isNetChange ? "text-[#3f7042] font-medium" : "text-club-green-900"}`}>
        {row.comparativeLabel}
      </span>
      <span className={`text-right tabular-nums text-[${isEmphasized ? 14 : 13}px] ${arMembershipChangeClass(row.changeTone)}`}>
        {row.changeLabel}
      </span>
      <span className={`text-right tabular-nums text-[${isEmphasized ? 14 : 13}px] ${isEmphasized ? "font-semibold text-club-green-900" : "text-club-green-900"}`}>
        {row.annualForecastLabel}
      </span>
    </div>
  );
}

function AccountsReceivableAgingPanel({
  pkg,
}: {
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
}) {
  const ara = pkg.accountsReceivableAging;
  return (
    <div data-testid="ar-aging" className="font-serif">
      {/* Header chrome. */}
      <header className="flex flex-col gap-4 border-b border-club-sand/60 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <p data-testid="ara-eyebrow" className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]">
            {ara.eyebrow}
          </p>
          <h2 data-testid="ara-title" className="font-serif text-[34px] leading-[1.05] tracking-tight text-club-green-900">
            {ara.title}
          </h2>
          <p data-testid="ara-period" className="uppercase tracking-[0.22em] text-[10.5px] text-club-green-800/65">
            {ara.periodLabel}
          </p>
          <p data-testid="ara-intro" className="mt-3 max-w-[560px] italic text-[14.5px] leading-relaxed text-club-green-900/85">
            {ara.introNote}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <p data-testid="ara-statement-number" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {ara.statementNumber}
          </p>
          <span
            data-testid="ara-document-chip"
            className="inline-flex items-center rounded-md border border-club-gold/40 bg-club-cream px-2.5 py-1 uppercase tracking-[0.18em] text-[10px] text-club-gold-700"
          >
            {ara.documentChip}
          </span>
          <p data-testid="ara-prepared-for" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {ara.preparedFor}
          </p>
        </div>
      </header>

      {/* 4 KPI summary cards. */}
      <div
        data-testid="ara-kpi-cards"
        className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        {ara.kpiCards.map((card) => (
          <article
            key={card.key}
            data-testid={`ara-kpi-${card.key}`}
            className="rounded-md border border-club-sand/55 bg-club-cream/50 px-5 py-4 text-center"
          >
            <p className={`font-serif text-[26px] leading-none tabular-nums ${arKpiToneClass(card.tone)}`}>
              {card.valueLabel}
            </p>
            <p className="mt-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/70">
              {card.label}
            </p>
          </article>
        ))}
      </div>

      {/* AR Aging table. */}
      <div
        data-testid="ara-aging-table"
        className="mt-6 overflow-hidden rounded-md border border-club-sand/60"
      >
        <div
          data-testid="ara-aging-column-headers"
          className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/60 bg-[#e8dfc8]/40 border-y border-club-sand/40"
          style={{ gridTemplateColumns: AR_AGING_GRID, columnGap: AR_AGING_GRID_GAP }}
        >
          <span className="text-left">{ara.agingColumnHeaders.category}</span>
          <span className="text-right">{ara.agingColumnHeaders.current}</span>
          <span className="text-right">{ara.agingColumnHeaders.days31to60}</span>
          <span className="text-right">{ara.agingColumnHeaders.days61to90}</span>
          <span className="text-right">{ara.agingColumnHeaders.over90}</span>
          <span className="text-right">{ara.agingColumnHeaders.totalBalance}</span>
          <span className="text-right">{ara.agingColumnHeaders.status}</span>
        </div>
        {ara.agingRows.map((row) => (
          <ARAgingRowRender key={row.key} row={row} />
        ))}
      </div>

      {/* Membership Activity table. */}
      <div
        data-testid="ara-membership-table"
        className="mt-6 overflow-hidden rounded-md border border-club-sand/60"
      >
        <div
          data-testid="ara-membership-column-headers"
          className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/60 bg-[#e8dfc8]/40 border-y border-club-sand/40"
          style={{ gridTemplateColumns: AR_MEMBERSHIP_GRID, columnGap: AR_MEMBERSHIP_GRID_GAP }}
        >
          <span className="text-left">{ara.membershipColumnHeaders.activity}</span>
          <span className="text-right">{ara.membershipColumnHeaders.current}</span>
          <span className="text-right">{ara.membershipColumnHeaders.comparative}</span>
          <span className="text-right">{ara.membershipColumnHeaders.change}</span>
          <span className="text-right">{ara.membershipColumnHeaders.annualForecast}</span>
        </div>
        {ara.membershipRows.map((row) => (
          <ARMembershipRowRender key={row.key} row={row} />
        ))}
      </div>

      {/* Collection Notes block. */}
      <div data-testid="ara-collection-notes" className="mt-7">
        <h3
          data-testid="ara-collection-notes-eyebrow"
          className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
        >
          {ara.collectionNotes.eyebrow}
        </h3>
        <ul
          data-testid="ara-collection-notes-list"
          className="mt-4 space-y-3 font-serif text-[13.5px] leading-relaxed text-club-green-900/90"
        >
          {ara.collectionNotes.notes.map((note, idx) => (
            <li
              key={idx}
              data-testid={`ara-collection-note-${idx}`}
              className="flex items-start gap-3"
            >
              <span
                aria-hidden="true"
                className="mt-1 inline-block shrink-0 text-[11px] leading-none text-[#8b3520]"
              >
                &#9654;
              </span>
              <p className="flex-1">{note.text}</p>
            </li>
          ))}
        </ul>
      </div>

      {/* Bottom padding spacer — no reference attribution. */}
      <div aria-hidden="true" className="mt-12" />
    </div>
  );
}

// ============================================================================
// 9 — Operating Statistics & Focus Areas
// ============================================================================
//
// Chapter IX — Saguaro-style operating-statistics surface. Owns the
// Operating Statistic table (6 columns: name + current period actual +
// prior-year same-period actual + change + budget + vs budget) with
// 4 section bands (Golf Operations / Food & Beverage / Member
// Engagement / Payroll & Labor) plus two Focus Area cards (Operating
// Focus + Capital Focus) that close the chapter. All data — including
// the metric-aware favourable/unfavourable tone classification — is
// pre-computed by the service; this panel renders pre-formatted
// strings only.

import type {
  OperatingStatRow,
  OperatingStatTone,
  FocusAreaCard,
} from "@/lib/reporting/operating-statistics";

// Status / change tone classes — restrained brand palette to match
// the AR Aging chapter's quiet treatment (no SaaS stoplight green).
function operatingStatToneClass(tone: OperatingStatTone): string {
  switch (tone) {
    case "favorable": return "text-[#3f7042]";
    case "risk":      return "text-[#8b3520]";
    case "neutral":   return "text-club-green-900";
  }
}

// 6-column grid: statistic name (flex) + 5 fixed right-aligned cols.
const OPERATING_STAT_GRID =
  "minmax(0, 1.5fr) 7rem 7rem 6rem 6rem 6.5rem";
const OPERATING_STAT_GRID_GAP = "0.8rem";

function OperatingStatRowRender({ row }: { row: OperatingStatRow }) {
  if (row.kind === "section-band") {
    return (
      <div
        data-testid={`os-row-${row.key}`}
        data-kind="section-band"
        className="px-4 py-2 uppercase tracking-[0.18em] text-[10.5px] text-[#a08850] bg-[#e8dfc8]/70 border-y border-club-sand/40"
        style={{ gridColumn: "1 / -1" }}
      >
        {row.label}
      </div>
    );
  }
  // stat row
  if (!row.values || !row.tones) return null;
  return (
    <div
      data-testid={`os-row-${row.key}`}
      data-kind="stat"
      className="grid items-center px-4 py-1.5 bg-club-cream/20 border-b border-club-sand/25"
      style={{ gridTemplateColumns: OPERATING_STAT_GRID, columnGap: OPERATING_STAT_GRID_GAP }}
    >
      <span className="text-[13px] text-club-green-900">{row.label}</span>
      <span className="text-right tabular-nums text-[13px] text-club-green-900">{row.values.currentActualLabel}</span>
      <span className="text-right tabular-nums text-[13px] text-club-green-900/70">{row.values.priorYearActualLabel}</span>
      <span
        data-testid={`os-row-${row.key}-change`}
        data-tone={row.tones.change}
        className={`text-right tabular-nums text-[13px] font-medium ${operatingStatToneClass(row.tones.change)}`}
      >
        {row.values.changeLabel}
      </span>
      <span className="text-right tabular-nums text-[13px] text-club-green-900/70">{row.values.budgetLabel}</span>
      <span
        data-testid={`os-row-${row.key}-vs-budget`}
        data-tone={row.tones.vsBudget}
        className={`text-right tabular-nums text-[13px] font-medium ${operatingStatToneClass(row.tones.vsBudget)}`}
      >
        {row.values.vsBudgetLabel}
      </span>
    </div>
  );
}

function focusCardClass(accent: FocusAreaCard["accent"]): string {
  if (accent === "rust") {
    // Operating Focus — warm/rust accent border on the standard cream.
    return "border-l-4 border-l-[#8b3520]/65 border border-club-sand/55 bg-club-cream/55";
  }
  // Capital Focus — slate/teal border on a pale-blue tint.
  return "border-l-4 border-l-[#4a6280]/65 border border-club-sand/55 bg-[#d4e0ec]/40";
}

function FocusCardRender({ card }: { card: FocusAreaCard }) {
  return (
    <article
      data-testid={`os-focus-${card.key}`}
      data-accent={card.accent}
      className={`rounded-md px-6 py-5 ${focusCardClass(card.accent)}`}
    >
      <p
        data-testid={`os-focus-${card.key}-eyebrow`}
        className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
      >
        {card.eyebrow}
      </p>
      <h3
        data-testid={`os-focus-${card.key}-title`}
        className="mt-1 font-serif text-[18px] leading-snug text-club-green-900"
      >
        {card.title}
      </h3>
      <div className="mt-4 space-y-3 font-serif text-[13.5px] leading-relaxed text-club-green-900/90">
        {card.paragraphs.map((p, idx) => (
          <p
            key={idx}
            data-testid={`os-focus-${card.key}-p${idx}`}
            className="flex flex-wrap gap-x-1.5"
          >
            <span className="font-semibold text-club-green-900">{p.leadIn}</span>
            <span className="flex-1">{p.body}</span>
          </p>
        ))}
      </div>
    </article>
  );
}

function OperatingStatisticsPanel({
  pkg,
}: {
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
}) {
  const os = pkg.operatingStatistics;
  return (
    <div data-testid="operating-statistics" className="font-serif">
      {/* Header chrome. */}
      <header className="flex flex-col gap-4 border-b border-club-sand/60 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <p data-testid="os-eyebrow" className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]">
            {os.eyebrow}
          </p>
          <h2 data-testid="os-title" className="font-serif text-[34px] leading-[1.05] tracking-tight text-club-green-900">
            {os.title}
          </h2>
          <p data-testid="os-period" className="uppercase tracking-[0.22em] text-[10.5px] text-club-green-800/65">
            {os.periodLabel}
          </p>
          <p data-testid="os-intro" className="mt-3 max-w-[620px] italic text-[14.5px] leading-relaxed text-club-green-900/85">
            {os.introNote}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <p data-testid="os-statement-number" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {os.statementNumber}
          </p>
          <span
            data-testid="os-document-chip"
            className="inline-flex items-center rounded-md border border-club-gold/40 bg-club-cream px-2.5 py-1 uppercase tracking-[0.18em] text-[10px] text-club-gold-700"
          >
            {os.documentChip}
          </span>
          <p data-testid="os-prepared-for" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {os.preparedFor}
          </p>
        </div>
      </header>

      {/* Operating Statistics table. */}
      <div
        data-testid="os-table"
        className="mt-6 overflow-hidden rounded-md border border-club-sand/60"
      >
        <div
          data-testid="os-column-headers"
          className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/60 bg-[#e8dfc8]/40 border-y border-club-sand/40"
          style={{ gridTemplateColumns: OPERATING_STAT_GRID, columnGap: OPERATING_STAT_GRID_GAP }}
        >
          <span className="text-left">{os.columnHeaders.statistic}</span>
          <span className="text-right">{os.columnHeaders.currentActual}</span>
          <span className="text-right">{os.columnHeaders.priorYearActual}</span>
          <span className="text-right">{os.columnHeaders.change}</span>
          <span className="text-right">{os.columnHeaders.budget}</span>
          <span className="text-right">{os.columnHeaders.vsBudget}</span>
        </div>
        {os.rows.map((row) => (
          <OperatingStatRowRender key={row.key} row={row} />
        ))}
      </div>

      {/* Focus Area cards — side-by-side at >= md, stack below. */}
      <div
        data-testid="os-focus-grid"
        className="mt-8 grid grid-cols-1 gap-5 md:grid-cols-2"
      >
        {os.focusCards.map((card) => (
          <FocusCardRender key={card.key} card={card} />
        ))}
      </div>

      {/* Bottom padding spacer — no reference attribution. */}
      <div aria-hidden="true" className="mt-12" />
    </div>
  );
}

// ============================================================================
// 10 — Departmental P&L Summary
// ============================================================================
//
// Chapter X — six-department P&L summary surface. Six dark-green
// department cards in a responsive grid (1 col / 2 cols / 3 cols),
// each with an optional header pill and a stack of label-value metric
// rows. Above the cards: a warm outlined management-document notice
// box. Below the cards: an arrow-bullet department-notes list. All
// data — pre-formatted values, pill labels, tone classification, and
// period-aware copy — is owned by the service; this panel renders
// pre-formatted strings only.

import type {
  DepartmentCard,
  DepartmentMetricRow,
  DepartmentalTone,
} from "@/lib/reporting/departmental-pl-summary";

function departmentalToneClass(tone: DepartmentalTone | undefined): string {
  switch (tone) {
    case "favorable": return "text-[#3f7042]";
    case "risk":      return "text-[#8b3520]";
    case "neutral":
    default:          return "text-club-green-900";
  }
}

function departmentPillClass(tone: DepartmentalTone): string {
  switch (tone) {
    case "favorable": return "border-[#3f7042]/45 bg-[#3f7042]/15 text-[#a6c39a]";
    case "risk":      return "border-[#8b3520]/55 bg-[#8b3520]/20 text-[#e5b4a4]";
    case "neutral":   return "border-club-cream/40 bg-club-cream/15 text-club-cream/85";
  }
}

function DepartmentMetricRowRender({ row }: { row: DepartmentMetricRow }) {
  return (
    <div
      data-testid={`dpl-row-${row.key}`}
      data-tone={row.tone ?? "neutral"}
      className="flex items-baseline justify-between px-5 py-2 border-b border-club-sand/25 last:border-b-0"
    >
      <span className="text-[13px] text-club-green-900/85">{row.label}</span>
      <span className={`text-right tabular-nums text-[13px] font-medium ${departmentalToneClass(row.tone)}`}>
        {row.value}
      </span>
    </div>
  );
}

function DepartmentCardRender({ card }: { card: DepartmentCard }) {
  return (
    <article
      data-testid={`dpl-card-${card.key}`}
      className="overflow-hidden rounded-md border border-club-sand/55 bg-club-cream/50"
    >
      <header className="flex items-center justify-between gap-3 bg-club-green-900 px-5 py-3">
        <h3
          data-testid={`dpl-card-${card.key}-name`}
          className="font-serif text-[15.5px] text-club-cream"
        >
          {card.name}
        </h3>
        {card.pill ? (
          <span
            data-testid={`dpl-card-${card.key}-pill`}
            data-tone={card.pill.tone}
            className={`inline-flex items-center whitespace-nowrap rounded-sm border px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${departmentPillClass(card.pill.tone)}`}
          >
            {card.pill.label}
          </span>
        ) : null}
      </header>
      <div className="font-serif">
        {card.rows.map((row) => (
          <DepartmentMetricRowRender key={row.key} row={row} />
        ))}
      </div>
    </article>
  );
}

function DepartmentalPLSummaryPanel({
  pkg,
}: {
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
}) {
  const dpl = pkg.departmentalPLSummary;
  return (
    <div data-testid="departmental-p-and-l" className="font-serif">
      {/* Header chrome. */}
      <header className="flex flex-col gap-4 border-b border-club-sand/60 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <p data-testid="dpl-eyebrow" className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]">
            {dpl.eyebrow}
          </p>
          <h2 data-testid="dpl-title" className="font-serif text-[34px] leading-[1.05] tracking-tight text-club-green-900">
            {dpl.title}
          </h2>
          <p data-testid="dpl-period" className="uppercase tracking-[0.22em] text-[10.5px] text-club-green-800/65">
            {dpl.periodLabel}
          </p>
          <p data-testid="dpl-intro" className="mt-3 max-w-[560px] italic text-[14.5px] leading-relaxed text-club-green-900/85">
            {dpl.introNote}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <p data-testid="dpl-statement-number" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {dpl.statementNumber}
          </p>
          <span
            data-testid="dpl-document-chip"
            className="inline-flex items-center rounded-md border border-club-gold/40 bg-club-cream px-2.5 py-1 uppercase tracking-[0.18em] text-[10px] text-club-gold-700"
          >
            {dpl.documentChip}
          </span>
          <p data-testid="dpl-prepared-for" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {dpl.preparedFor}
          </p>
        </div>
      </header>

      {/* Management-document notice — warm outlined box. */}
      <div
        data-testid="dpl-management-notice"
        className="mt-6 rounded-md border border-[#b08a4a]/50 bg-[#e8dfc8]/35 px-5 py-3.5"
      >
        <p className="text-[13.5px] leading-relaxed text-club-green-900/90">
          <span
            data-testid="dpl-management-notice-eyebrow"
            className="font-semibold uppercase tracking-[0.18em] text-[10.5px] text-[#8a6d3a]"
          >
            {dpl.managementNotice.eyebrow}
          </span>
          <span className="ml-2 text-club-green-900/85">— {dpl.managementNotice.body}</span>
        </p>
      </div>

      {/* 6 department cards — responsive grid: 1 / 2 / 3 cols. */}
      <div
        data-testid="dpl-card-grid"
        className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
      >
        {dpl.cards.map((card) => (
          <DepartmentCardRender key={card.key} card={card} />
        ))}
      </div>

      {/* Department notes — arrow bullets. */}
      <div data-testid="dpl-notes" className="mt-8">
        <h3
          data-testid="dpl-notes-eyebrow"
          className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
        >
          {dpl.notes.eyebrow}
        </h3>
        <ul
          data-testid="dpl-notes-list"
          className="mt-3 space-y-3 font-serif text-[13.5px] leading-relaxed text-club-green-900/90"
        >
          {dpl.notes.items.map((note, idx) => (
            <li
              key={idx}
              data-testid={`dpl-note-${idx}`}
              className="flex items-start gap-3"
            >
              <span
                aria-hidden="true"
                className="mt-1 inline-block shrink-0 text-[11px] leading-none text-[#8b3520]"
              >
                &#9654;
              </span>
              <p className="flex-1">{note.text}</p>
            </li>
          ))}
        </ul>
      </div>

      {/* Bottom padding spacer — no reference attribution. */}
      <div aria-hidden="true" className="mt-12" />
    </div>
  );
}

// ============================================================================
// 11 — Monthly Weather Summary
// ============================================================================
//
// Chapter XI — weather-adjusted utilization analysis. Owns 4 dark-
// green KPI cards (sunny days / rain days / avg high temp / avg wind
// speed), a weather-pattern donut, a rounds-by-condition bar chart,
// a notable weather events table with event pills, and 3 weather-
// utilization correlation cards (Golf / Racquet / Dining). Every
// icon in this chapter is a premium inline SVG glyph (no emoji,
// no SaaS-grade stoplight icons) so the surface reads as a board-
// report executive document, not a dashboard.

import type {
  WeatherKpiCard,
  WeatherEventRow,
  WeatherEventPillTone,
  WeatherCorrelationCard,
  WeatherIconKey,
} from "@/lib/reporting/monthly-weather-summary";
import { WeatherChartCards } from "./WeatherChartCards";

// --- Premium inline SVG icons ------------------------------------------
// Thin-line monochrome / duotone glyphs. The colour is inherited from
// the surrounding text (currentColor). No emoji.
function WeatherIcon({ icon, className }: { icon: WeatherIconKey; className?: string }) {
  const common = {
    "aria-hidden": "true" as const,
    "data-testid": `weather-icon-${icon}` as const,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: className ?? "h-7 w-7",
  };
  switch (icon) {
    case "sun":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2.5v2.5M12 19v2.5M2.5 12h2.5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
        </svg>
      );
    case "rain-cloud":
      return (
        <svg {...common}>
          <path d="M7 14.5a4 4 0 1 1 1.2-7.8 5.5 5.5 0 0 1 10.6 1.6 3.5 3.5 0 0 1-1.3 6.8H7Z" />
          <path d="M8.5 18l-.8 2.4M12 18l-.8 2.4M15.5 18l-.8 2.4" />
        </svg>
      );
    case "thermometer":
      return (
        <svg {...common}>
          <path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0Z" />
          <path d="M12 8v8.2" />
          <circle cx="12" cy="17.5" r="1.5" />
        </svg>
      );
    case "wind":
      return (
        <svg {...common}>
          <path d="M3 8h12a3 3 0 1 0-3-3" />
          <path d="M3 12h16a3 3 0 1 1-3 3" />
          <path d="M3 16h9" />
        </svg>
      );
    case "golf-flag":
      return (
        <svg {...common}>
          <path d="M6 21V4" />
          <path d="M6 4l10 2.5L6 9" />
          <ellipse cx="6" cy="21" rx="4" ry="1" />
        </svg>
      );
    case "tennis":
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="6" />
          <path d="M5.5 5.5C8 7.5 12 7.5 14.5 5.5M5.5 14.5C8 12.5 12 12.5 14.5 14.5M10 4v12M4 10h12" />
          <path d="M14.2 14.2l5 5" />
        </svg>
      );
    case "dining":
      return (
        <svg {...common}>
          <path d="M5 3v8a2 2 0 0 0 4 0V3" />
          <path d="M7 11v10" />
          <path d="M15 3c-1.5 0-3 1.5-3 4v5h3v9" />
        </svg>
      );
  }
}

// --- Event pill tone helper -------------------------------------------
function weatherEventPillClass(tone: WeatherEventPillTone): string {
  switch (tone) {
    case "heavy-rain":       return "border-[#4a6280]/55 bg-[#4a6280]/15 text-[#4a6280]";
    case "cold-frost":       return "border-[#4a6280]/55 bg-[#4a6280]/15 text-[#4a6280]";
    case "high-wind":        return "border-[#b08a4a]/55 bg-[#b08a4a]/15 text-[#8a6d3a]";
    case "prime-conditions": return "border-club-green-700/40 bg-club-green-700/10 text-club-green-700";
    case "course-impact":    return "border-[#8b3520]/45 bg-[#8b3520]/10 text-[#8b3520]";
  }
}

function eventImpactToneClass(tone: "favorable" | "risk" | "neutral"): string {
  switch (tone) {
    case "favorable": return "text-[#3f7042]";
    case "risk":      return "text-[#8b3520]";
    case "neutral":   return "text-club-green-900";
  }
}

// --- Correlation card accent helper -----------------------------------
function correlationCardClass(accent: WeatherCorrelationCard["accent"]): string {
  switch (accent) {
    case "green": return "border-l-4 border-l-[#3f7042]/65 border border-club-sand/55 bg-club-cream/55";
    case "slate": return "border-l-4 border-l-[#4a6280]/65 border border-club-sand/55 bg-[#d4e0ec]/40";
    case "rust":  return "border-l-4 border-l-[#8b3520]/65 border border-club-sand/55 bg-club-cream/55";
  }
}

function correlationIconColorClass(accent: WeatherCorrelationCard["accent"]): string {
  switch (accent) {
    case "green": return "text-[#3f7042]";
    case "slate": return "text-[#4a6280]";
    case "rust":  return "text-[#8b3520]";
  }
}

// The donut + bar chart components were extracted into the client
// island `./WeatherChartCards.tsx` to own hover state + tooltip
// rendering + the lift/outline interactive treatment. The panel
// below simply mounts that island in place of the prior static SVG.

// --- Event row renderer -----------------------------------------------
//
// Column widths are tuned so the widest event pill ("PRIME CONDITIONS"
// at ~9.5rem rendered) NEVER collides with the adjacent description
// text. Date is compact. Event is fixed at 11rem to leave breathing
// room for the pill + the 1rem column gap. Description is the only
// flexible column — wraps naturally inside its own track and the grid
// `minmax(0, 2fr)` prevents long lines from blowing the layout out.
const WEATHER_EVENTS_GRID =
  "5rem 11rem minmax(0, 2fr) 7rem 7rem 9rem";
const WEATHER_EVENTS_GRID_GAP = "1rem";

function WeatherEventRowRender({ row }: { row: WeatherEventRow }) {
  return (
    <div
      data-testid={`mws-event-row-${row.key}`}
      className="grid items-center px-4 py-2.5 bg-club-cream/20 border-b border-club-sand/25"
      style={{ gridTemplateColumns: WEATHER_EVENTS_GRID, columnGap: WEATHER_EVENTS_GRID_GAP }}
    >
      <span className="font-serif text-[13px] text-club-green-900">{row.dateLabel}</span>
      <span>
        <span
          data-testid={`mws-event-row-${row.key}-pill`}
          data-tone={row.pill.tone}
          className={`inline-flex items-center whitespace-nowrap rounded-sm border px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${weatherEventPillClass(row.pill.tone)}`}
        >
          {row.pill.label}
        </span>
      </span>
      <span className="font-serif text-[13px] text-club-green-900/85">{row.description}</span>
      <span
        data-testid={`mws-event-row-${row.key}-golf`}
        data-tone={row.golfImpactTone}
        className={`text-right tabular-nums text-[13px] font-medium ${eventImpactToneClass(row.golfImpactTone)}`}
      >
        {row.golfImpactLabel}
      </span>
      <span
        data-testid={`mws-event-row-${row.key}-fb`}
        data-tone={row.fbImpactTone}
        className={`text-right tabular-nums text-[13px] font-medium ${eventImpactToneClass(row.fbImpactTone)}`}
      >
        {row.fbImpactLabel}
      </span>
      <span className="font-serif text-[13px] text-club-green-900/85 text-right">{row.followUpLabel}</span>
    </div>
  );
}

// --- KPI card render --------------------------------------------------
// Uniform white/cream treatment — every KPI card renders the icon,
// value, and label in the same color, weight, and spacing regardless
// of the service-supplied `tone`. The `tone` field is retained on the
// service contract so a future founder-led variant (e.g. a "risk"
// accent for a 30-rain-day month) can opt in without re-engineering;
// today every card uses the Sunny Days treatment as the standard.
function WeatherKpiCardRender({ card }: { card: WeatherKpiCard }) {
  return (
    <article
      data-testid={`mws-kpi-${card.key}`}
      className="rounded-md bg-club-green-900 px-6 py-6 flex flex-col items-center text-center text-club-cream"
    >
      <WeatherIcon icon={card.icon} className="h-9 w-9 text-club-cream" />
      <p
        data-testid={`mws-kpi-${card.key}-value`}
        className="mt-3 font-serif text-[32px] leading-none tabular-nums text-club-cream"
      >
        {card.valueLabel}
      </p>
      <p
        data-testid={`mws-kpi-${card.key}-label`}
        className="mt-2 uppercase tracking-[0.22em] text-[10px] text-club-cream/75"
      >
        {card.label}
      </p>
    </article>
  );
}

// --- Correlation card render ------------------------------------------
function WeatherCorrelationCardRender({ card }: { card: WeatherCorrelationCard }) {
  return (
    <article
      data-testid={`mws-corr-${card.key}`}
      data-accent={card.accent}
      className={`rounded-md px-6 py-5 ${correlationCardClass(card.accent)}`}
    >
      <div className={`mb-3 ${correlationIconColorClass(card.accent)}`}>
        <WeatherIcon icon={card.icon} className="h-7 w-7" />
      </div>
      <h3
        data-testid={`mws-corr-${card.key}-title`}
        className="font-serif text-[17px] leading-snug text-club-green-900"
      >
        {card.title}
      </h3>
      <p
        data-testid={`mws-corr-${card.key}-narrative`}
        className="mt-3 font-serif text-[13px] leading-relaxed text-club-green-900/85"
      >
        {card.narrative}
      </p>
      <p
        data-testid={`mws-corr-${card.key}-datapoint`}
        className="mt-4 font-serif text-[11.5px] uppercase tracking-[0.18em] text-club-green-800/70"
      >
        <span>{card.dataPoint.label}</span>{" "}
        <span className="text-club-green-900">{card.dataPoint.value}</span>
      </p>
    </article>
  );
}

function MonthlyWeatherSummaryPanel({
  pkg,
}: {
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
}) {
  const mws = pkg.monthlyWeatherSummary;
  // 2026-06-19 — utilization-outcome KPI cards lifted from Experience
  // Stewardship (Rounds YTD, Course Utilization, Spend per Member,
  // Spend per Round). The weather narrative is the natural home for
  // them: weather drives rounds → rounds drive utilization →
  // utilization drives spend per round → spend per round drives
  // spend per member. Data bindings unchanged (same `pkg.operatingStats`
  // + `pkg.weatherUtilization` fields the Experience chapter used).
  const stats = pkg.operatingStats;
  const wx = pkg.weatherUtilization;
  return (
    <div data-testid="weather-and-utilization" className="font-serif">
      {/* Header chrome. */}
      <header className="flex flex-col gap-4 border-b border-club-sand/60 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <p data-testid="mws-eyebrow" className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]">
            {mws.eyebrow}
          </p>
          <h2 data-testid="mws-title" className="font-serif text-[34px] leading-[1.05] tracking-tight text-club-green-900">
            {mws.title}
          </h2>
          <p data-testid="mws-period" className="uppercase tracking-[0.22em] text-[10.5px] text-club-green-800/65">
            {mws.periodLabel}
          </p>
          <p data-testid="mws-intro" className="mt-3 max-w-[620px] italic text-[14.5px] leading-relaxed text-club-green-900/85">
            {mws.introNote}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <p data-testid="mws-statement-number" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {mws.statementNumber}
          </p>
          <span
            data-testid="mws-document-chip"
            className="inline-flex items-center rounded-md border border-club-gold/40 bg-club-cream px-2.5 py-1 uppercase tracking-[0.18em] text-[10px] text-club-gold-700"
          >
            {mws.documentChip}
          </span>
          <p data-testid="mws-prepared-for" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {mws.preparedFor}
          </p>
        </div>
      </header>

      {/* 4 weather KPI cards. */}
      <div
        data-testid="mws-kpi-grid"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {mws.kpiCards.map((card) => (
          <WeatherKpiCardRender key={card.key} card={card} />
        ))}
      </div>

      {/* Pattern donut + rounds bar chart — 2 cards side-by-side. The
          interactive hover + tooltip + lift/outline treatment lives
          in the `WeatherChartCards` client island. */}
      <WeatherChartCards pattern={mws.patternCard} rounds={mws.roundsCard} />

      {/* Notable weather events table. */}
      <div data-testid="mws-events-table" className="mt-8">
        <h3
          data-testid="mws-events-eyebrow"
          className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
        >
          {mws.eventsTable.eyebrow}
        </h3>
        <div className="mt-3 overflow-hidden rounded-md border border-club-sand/60">
          <div
            data-testid="mws-events-headers"
            className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/60 bg-[#e8dfc8]/40 border-y border-club-sand/40"
            style={{ gridTemplateColumns: WEATHER_EVENTS_GRID, columnGap: WEATHER_EVENTS_GRID_GAP }}
          >
            <span className="text-left">{mws.eventsTable.columnHeaders.date}</span>
            <span className="text-left">{mws.eventsTable.columnHeaders.event}</span>
            <span className="text-left">{mws.eventsTable.columnHeaders.description}</span>
            <span className="text-right">{mws.eventsTable.columnHeaders.golfImpact}</span>
            <span className="text-right">{mws.eventsTable.columnHeaders.fbImpact}</span>
            <span className="text-right">{mws.eventsTable.columnHeaders.followUp}</span>
          </div>
          {mws.eventsTable.rows.map((row) => (
            <WeatherEventRowRender key={row.key} row={row} />
          ))}
        </div>
      </div>

      {/* Weather-utilization correlation summary — 3 cards. */}
      <div data-testid="mws-correlation" className="mt-8">
        <h3
          data-testid="mws-correlation-eyebrow"
          className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
        >
          {mws.correlationSummary.eyebrow}
        </h3>
        <div
          data-testid="mws-correlation-grid"
          className="mt-3 grid grid-cols-1 gap-5 md:grid-cols-3"
        >
          {mws.correlationSummary.cards.map((card) => (
            <WeatherCorrelationCardRender key={card.key} card={card} />
          ))}
        </div>
      </div>

      {/* Utilization-outcome KPI row — lifted from Experience
          Stewardship 2026-06-19. The four cards close out the
          chapter's utilization narrative: rounds played, course
          utilization %, spend per member, spend per round. Layout
          mirrors the other 4-up KPI rows in the package: 1-up
          mobile, 2-up tablet, 4-up desktop. */}
      <div data-testid="mws-utilization-extension" className="mt-8">
        <h3
          data-testid="mws-utilization-extension-eyebrow"
          className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
        >
          Utilization outcomes · activity through spend
        </h3>
        <div
          data-testid="mws-utilization-extension-grid"
          className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <OperatingHeadlineTile
            testId="weather-rounds-ytd"
            label="Rounds YTD"
            value={stats.rounds.ytd.toLocaleString()}
            context="Total course rounds played YTD (member + guest)."
            sub={`${stats.rounds.varPct} vs plan · ${stats.rounds.guestSharePct} guest share`}
            tone="green"
          />
          <OperatingHeadlineTile
            testId="weather-course-utilization"
            label="Course utilization"
            value={wx.courseUtilizationPct}
            context="Share of tee-time inventory used during open hours YTD."
            sub="70% Pillar 5 target · 4.1pp above"
            tone="green"
          />
          <OperatingHeadlineTile
            testId="weather-spend-per-member"
            label="Spend per member"
            value={stats.derived.spendPerMember}
            context="Annualized F&B + cart spend per active member."
            sub="franchise engagement read"
            tone="neutral"
          />
          <OperatingHeadlineTile
            testId="weather-spend-per-round"
            label="Spend per round"
            value={stats.derived.spendPerRound}
            context="F&B + cart spend captured per round played."
            sub="ancillary revenue per round"
            tone="neutral"
          />
        </div>
      </div>

      {/* Bottom padding spacer — no reference attribution. */}
      <div aria-hidden="true" className="mt-12" />
    </div>
  );
}

// ============================================================================
// 12 — Departmental Payroll Analysis
// ============================================================================
//
// Chapter XII — premium executive surface. 4 KPI cards across the
// top, a 2×2 chart grid (YTD Actual vs Budget grouped bars / YTD
// Variance bars / Payroll Distribution donut / Wages vs Taxes &
// Benefits stacked bars), and a detailed MTD/YTD summary table with
// a dark-green Club Total band. Interactive chart hover lives in
// the `PayrollChartCards` client island.

import type {
  DepartmentalPayrollAnalysis,
  PayrollKpiCard,
  PayrollDepartmentRow,
  PayrollVarianceTone,
  PayrollKpiTreatment,
} from "@/lib/reporting/departmental-payroll-analysis";
import { PayrollChartCards } from "./PayrollChartCards";

function payrollKpiCardClass(treatment: PayrollKpiTreatment): string {
  switch (treatment) {
    case "primary":   return "rounded-md bg-club-green-900 px-6 py-6 text-center text-club-cream";
    case "favorable": return "rounded-md border border-[#3f7042]/30 bg-[#3f7042]/8 px-6 py-6 text-center";
    case "neutral":   return "rounded-md border border-club-sand/55 bg-club-cream/60 px-6 py-6 text-center";
    case "info":      return "rounded-md border border-[#7d96b0]/40 bg-[#d4e0ec]/35 px-6 py-6 text-center";
  }
}

function payrollKpiValueClass(treatment: PayrollKpiTreatment, valueTone: PayrollVarianceTone | undefined): string {
  if (treatment === "primary") return "text-club-cream";
  switch (valueTone) {
    case "favorable": return "text-[#3f7042]";
    case "risk":      return "text-[#8b3520]";
    case "neutral":
    default:          return "text-club-green-900";
  }
}

function payrollKpiLabelClass(treatment: PayrollKpiTreatment): string {
  return treatment === "primary"
    ? "uppercase tracking-[0.22em] text-[10px] text-club-cream/75"
    : "uppercase tracking-[0.22em] text-[10px] text-club-green-800/70";
}

function payrollKpiSubClass(treatment: PayrollKpiTreatment): string {
  return treatment === "primary"
    ? "mt-2 text-[11.5px] text-club-cream/75"
    : "mt-2 text-[11.5px] text-club-green-900/70";
}

function PayrollKpiCardRender({ card }: { card: PayrollKpiCard }) {
  return (
    <article
      data-testid={`dpa-kpi-${card.key}`}
      className={payrollKpiCardClass(card.treatment)}
    >
      <p
        data-testid={`dpa-kpi-${card.key}-value`}
        className={`font-serif text-[32px] leading-none tabular-nums ${payrollKpiValueClass(card.treatment, card.valueTone)}`}
      >
        {card.valueLabel}
      </p>
      <p
        data-testid={`dpa-kpi-${card.key}-label`}
        className={`mt-2 ${payrollKpiLabelClass(card.treatment)}`}
      >
        {card.label}
      </p>
      {card.subLabel ? (
        <p
          data-testid={`dpa-kpi-${card.key}-sub`}
          className={payrollKpiSubClass(card.treatment)}
        >
          {card.subLabel}
        </p>
      ) : null}
    </article>
  );
}

function dpaVarianceToneClass(tone: PayrollVarianceTone): string {
  switch (tone) {
    case "favorable": return "text-[#3f7042]";
    case "risk":      return "text-[#8b3520]";
    case "neutral":   return "text-club-green-900";
  }
}

// Table grid template — Department / 6 numeric columns.
const PAYROLL_TABLE_GRID =
  "minmax(0, 1.5fr) 7.5rem 7.5rem 7.5rem 8rem 8rem 8rem";
const PAYROLL_TABLE_GRID_GAP = "1rem";

function PayrollTableRowRender({ row }: { row: PayrollDepartmentRow }) {
  const isTotal = row.kind === "total";
  const wrapperClass = isTotal
    ? "grid items-center px-4 py-3 bg-club-green-900 border-y border-club-green-900"
    : "grid items-center px-4 py-2 bg-club-cream/20 border-b border-club-sand/25";
  const labelClass = isTotal
    ? "uppercase tracking-[0.18em] text-[12px] font-semibold text-club-cream"
    : "font-serif text-[13px] text-club-green-900";
  const cellBase = isTotal
    ? "text-right tabular-nums text-[13px] font-semibold text-club-cream"
    : "text-right tabular-nums text-[13px] text-club-green-900";
  const variancePalette = (tone: PayrollVarianceTone) =>
    isTotal
      ? (tone === "favorable" ? "text-[#a6c39a]" : tone === "risk" ? "text-[#e5b4a4]" : "text-club-cream")
      : dpaVarianceToneClass(tone);
  return (
    <div
      data-testid={`dpa-row-${row.key}`}
      data-kind={row.kind}
      className={wrapperClass}
      style={{ gridTemplateColumns: PAYROLL_TABLE_GRID, columnGap: PAYROLL_TABLE_GRID_GAP }}
    >
      <span className={labelClass}>{row.label}</span>
      <span className={cellBase}>{row.labels.mtdActual}</span>
      <span className={cellBase}>{row.labels.mtdBudget}</span>
      <span
        data-testid={`dpa-row-${row.key}-mtd-var`}
        data-tone={row.tones.mtdVariance}
        className={`${cellBase} font-medium ${variancePalette(row.tones.mtdVariance)}`}
      >
        {row.labels.mtdVariance}
      </span>
      <span className={cellBase}>{row.labels.ytdActual}</span>
      <span className={cellBase}>{row.labels.ytdBudget}</span>
      <span
        data-testid={`dpa-row-${row.key}-ytd-var`}
        data-tone={row.tones.ytdVariance}
        className={`${cellBase} font-medium ${variancePalette(row.tones.ytdVariance)}`}
      >
        {row.labels.ytdVariance}
      </span>
    </div>
  );
}

function DepartmentalPayrollAnalysisPanel({
  pkg,
}: {
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
}) {
  const dpa = pkg.departmentalPayrollAnalysis;
  return (
    <div data-testid="payroll-analysis" className="font-serif">
      {/* Header chrome. */}
      <header className="flex flex-col gap-4 border-b border-club-sand/60 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <p data-testid="dpa-eyebrow" className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]">
            {dpa.eyebrow}
          </p>
          <h2 data-testid="dpa-title" className="font-serif text-[34px] leading-[1.05] tracking-tight text-club-green-900">
            {dpa.title}
          </h2>
          <p data-testid="dpa-period" className="uppercase tracking-[0.22em] text-[10.5px] text-club-green-800/65">
            {dpa.periodLabel}
          </p>
          <p data-testid="dpa-intro" className="mt-3 max-w-[620px] italic text-[14.5px] leading-relaxed text-club-green-900/85">
            {dpa.introNote}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <p data-testid="dpa-statement-number" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {dpa.statementNumber}
          </p>
          <span
            data-testid="dpa-document-chip"
            className="inline-flex items-center rounded-md border border-club-gold/40 bg-club-cream px-2.5 py-1 uppercase tracking-[0.18em] text-[10px] text-club-gold-700"
          >
            {dpa.documentChip}
          </span>
          <p data-testid="dpa-prepared-for" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {dpa.preparedFor}
          </p>
        </div>
      </header>

      {/* 4 KPI cards across the top. */}
      <div
        data-testid="dpa-kpi-grid"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {dpa.kpiCards.map((c) => (
          <PayrollKpiCardRender key={c.key} card={c} />
        ))}
      </div>

      {/* 2×2 chart grid (interactive client island). */}
      <PayrollChartCards charts={dpa.charts} />

      {/* Detailed summary table. */}
      <div data-testid="dpa-table" className="mt-8">
        <h3
          data-testid="dpa-table-eyebrow"
          className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
        >
          {dpa.table.eyebrow}
        </h3>
        <div className="mt-3 overflow-hidden rounded-md border border-club-sand/60">
          <div
            data-testid="dpa-table-headers"
            className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/60 bg-[#e8dfc8]/40 border-y border-club-sand/40"
            style={{ gridTemplateColumns: PAYROLL_TABLE_GRID, columnGap: PAYROLL_TABLE_GRID_GAP }}
          >
            <span className="text-left">{dpa.table.columnHeaders.department}</span>
            <span className="text-right">{dpa.table.columnHeaders.mtdActual}</span>
            <span className="text-right">{dpa.table.columnHeaders.mtdBudget}</span>
            <span className="text-right">{dpa.table.columnHeaders.mtdVariance}</span>
            <span className="text-right">{dpa.table.columnHeaders.ytdActual}</span>
            <span className="text-right">{dpa.table.columnHeaders.ytdBudget}</span>
            <span className="text-right">{dpa.table.columnHeaders.ytdVariance}</span>
          </div>
          {dpa.table.rows.map((row) => (
            <PayrollTableRowRender key={row.key} row={row} />
          ))}
          <PayrollTableRowRender row={dpa.table.total} />
        </div>
      </div>

      {/* Bottom padding spacer — no reference attribution. */}
      <div aria-hidden="true" className="mt-12" />
    </div>
  );
}

// ============================================================================
// 13 — Food & Beverage Statistics
// ============================================================================
//
// Chapter XIII — F&B performance dashboard. 4 KPI cards across the
// top + a 2×2 interactive chart grid (Monthly Revenue vs Cost /
// Revenue by Category donut / Monthly Cover Counts / Food Cost % by
// Month line) hosted in the `FoodBeverageChartCards` client island.
// All chart data flows from the reporting service; React renders
// pre-formatted strings.

import type {
  FoodBeverageStatistics,
  FbKpiCard,
  FbKpiTreatment,
} from "@/lib/reporting/food-beverage-statistics";
import { FoodBeverageChartCards } from "./FoodBeverageChartCards";

function fbKpiCardClass(treatment: FbKpiTreatment): string {
  switch (treatment) {
    case "primary":   return "rounded-md bg-club-green-900 px-6 py-6 text-center text-club-cream";
    case "favorable": return "rounded-md border border-[#3f7042]/30 bg-[#3f7042]/8 px-6 py-6 text-center";
    case "neutral":   return "rounded-md border border-club-sand/55 bg-club-cream/60 px-6 py-6 text-center";
    case "watch":     return "rounded-md border border-[#c79e8c]/55 bg-[#c79e8c]/18 px-6 py-6 text-center";
  }
}

function fbKpiValueClass(treatment: FbKpiTreatment): string {
  switch (treatment) {
    case "primary":   return "text-club-cream";
    case "favorable": return "text-[#3f7042]";
    case "watch":     return "text-[#8b3520]";
    case "neutral":
    default:          return "text-club-green-900";
  }
}

function fbKpiLabelClass(treatment: FbKpiTreatment): string {
  return treatment === "primary"
    ? "uppercase tracking-[0.22em] text-[10px] text-club-cream/75"
    : "uppercase tracking-[0.22em] text-[10px] text-club-green-800/70";
}

function fbKpiSubClass(treatment: FbKpiTreatment): string {
  return treatment === "primary"
    ? "mt-2 text-[11.5px] text-club-cream/75"
    : "mt-2 text-[11.5px] text-club-green-900/70";
}

function FbKpiCardRender({ card }: { card: FbKpiCard }) {
  return (
    <article
      data-testid={`fbs-kpi-${card.key}`}
      className={fbKpiCardClass(card.treatment)}
    >
      <p
        data-testid={`fbs-kpi-${card.key}-value`}
        className={`font-serif text-[32px] leading-none tabular-nums ${fbKpiValueClass(card.treatment)}`}
      >
        {card.valueLabel}
      </p>
      <p
        data-testid={`fbs-kpi-${card.key}-label`}
        className={`mt-2 ${fbKpiLabelClass(card.treatment)}`}
      >
        {card.label}
      </p>
      {card.subLabel ? (
        <p
          data-testid={`fbs-kpi-${card.key}-sub`}
          className={fbKpiSubClass(card.treatment)}
        >
          {card.subLabel}
        </p>
      ) : null}
    </article>
  );
}

function FoodBeverageStatisticsPanel({
  pkg,
}: {
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
}) {
  const fbs = pkg.foodBeverageStatistics;
  return (
    <div data-testid="f-and-b-statistics" className="font-serif">
      {/* Header chrome. */}
      <header className="flex flex-col gap-4 border-b border-club-sand/60 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <p data-testid="fbs-eyebrow" className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]">
            {fbs.eyebrow}
          </p>
          <h2 data-testid="fbs-title" className="font-serif text-[34px] leading-[1.05] tracking-tight text-club-green-900">
            {fbs.title}
          </h2>
          <p data-testid="fbs-period" className="uppercase tracking-[0.22em] text-[10.5px] text-club-green-800/65">
            {fbs.periodLabel}
          </p>
          <p data-testid="fbs-intro" className="mt-3 max-w-[620px] italic text-[14.5px] leading-relaxed text-club-green-900/85">
            {fbs.introNote}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <p data-testid="fbs-statement-number" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {fbs.statementNumber}
          </p>
          <span
            data-testid="fbs-document-chip"
            className="inline-flex items-center rounded-md border border-club-gold/40 bg-club-cream px-2.5 py-1 uppercase tracking-[0.18em] text-[10px] text-club-gold-700"
          >
            {fbs.documentChip}
          </span>
          <p data-testid="fbs-prepared-for" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {fbs.preparedFor}
          </p>
        </div>
      </header>

      {/* 4 KPI cards. */}
      <div
        data-testid="fbs-kpi-grid"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {fbs.kpiCards.map((c) => (
          <FbKpiCardRender key={c.key} card={c} />
        ))}
      </div>

      {/* Secondary KPI row — aligned column-for-column to the primary
          row above. Same grid + breakpoints + gap so the cards read
          as a continuation of the first row. */}
      <div
        data-testid="fbs-kpi-grid-secondary"
        className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {fbs.secondaryKpiCards.map((c) => (
          <FbKpiCardRender key={c.key} card={c} />
        ))}
      </div>

      {/* 2×2 chart grid (interactive client island). */}
      <FoodBeverageChartCards charts={fbs.charts} />

      {/* Bottom padding spacer — no reference attribution. */}
      <div aria-hidden="true" className="mt-12" />
    </div>
  );
}

// ============================================================================
// 14 — Inventory Analysis
// ============================================================================
//
// Chapter XIV — final chapter of the Operations & Analytics group.
// 4 KPI cards + 2-up chart grid (Inventory Turnover by Category bars
// vs prior year + F&B Inventory Balances monthly multi-line) +
// Inventory Management Flags & Action Items table. Interactive
// charts live in the `InventoryChartCards` client island.

import type {
  InventoryAnalysis,
  InventoryKpiCard,
  InventoryKpiTreatment,
  InventoryActionPriority,
  InventoryActionRow,
} from "@/lib/reporting/inventory-analysis";
import { InventoryChartCards } from "./InventoryChartCards";

function inventoryKpiCardClass(treatment: InventoryKpiTreatment): string {
  switch (treatment) {
    case "primary":   return "rounded-md bg-club-green-900 px-6 py-6 text-center text-club-cream";
    case "favorable": return "rounded-md border border-[#3f7042]/30 bg-[#3f7042]/8 px-6 py-6 text-center";
    case "neutral":   return "rounded-md border border-club-sand/55 bg-club-cream/60 px-6 py-6 text-center";
    case "watch":     return "rounded-md border border-[#c79e8c]/55 bg-[#c79e8c]/18 px-6 py-6 text-center";
  }
}

function inventoryKpiValueClass(treatment: InventoryKpiTreatment): string {
  switch (treatment) {
    case "primary":   return "text-club-cream";
    case "favorable": return "text-[#3f7042]";
    case "watch":     return "text-[#8b3520]";
    case "neutral":
    default:          return "text-club-green-900";
  }
}

function inventoryKpiLabelClass(treatment: InventoryKpiTreatment): string {
  return treatment === "primary"
    ? "uppercase tracking-[0.22em] text-[10px] text-club-cream/75"
    : "uppercase tracking-[0.22em] text-[10px] text-club-green-800/70";
}

function inventoryKpiSubClass(treatment: InventoryKpiTreatment): string {
  return treatment === "primary"
    ? "mt-2 text-[11.5px] text-club-cream/75"
    : "mt-2 text-[11.5px] text-club-green-900/70";
}

function InventoryKpiCardRender({ card }: { card: InventoryKpiCard }) {
  return (
    <article
      data-testid={`inv-kpi-${card.key}`}
      className={inventoryKpiCardClass(card.treatment)}
    >
      <p
        data-testid={`inv-kpi-${card.key}-value`}
        className={`font-serif text-[32px] leading-none tabular-nums ${inventoryKpiValueClass(card.treatment)}`}
      >
        {card.valueLabel}
      </p>
      <p
        data-testid={`inv-kpi-${card.key}-label`}
        className={`mt-2 ${inventoryKpiLabelClass(card.treatment)}`}
      >
        {card.label}
      </p>
      {card.subLabel ? (
        <p
          data-testid={`inv-kpi-${card.key}-sub`}
          className={inventoryKpiSubClass(card.treatment)}
        >
          {card.subLabel}
        </p>
      ) : null}
    </article>
  );
}

// Priority pill render — never wraps mid-pill (whitespace-nowrap).
function inventoryPriorityPillClass(priority: InventoryActionPriority): string {
  switch (priority) {
    case "action":   return "border-[#8b3520]/45 bg-[#8b3520]/10 text-[#8b3520]";
    case "watch":    return "border-[#b08a4a]/55 bg-[#b08a4a]/15 text-[#8a6d3a]";
    case "positive": return "border-club-green-700/40 bg-club-green-700/10 text-club-green-700";
  }
}

// Action table grid template — Priority / Category / Observation /
// Action Required / Timeline. Priority + Category + Timeline are
// fixed widths; Observation + Action Required flex.
const INVENTORY_ACTION_GRID =
  "5.5rem 8rem minmax(0, 3fr) minmax(0, 1.6fr) 7rem";
const INVENTORY_ACTION_GRID_GAP = "1rem";

function InventoryActionRowRender({ row }: { row: InventoryActionRow }) {
  return (
    <div
      data-testid={`inv-action-row-${row.key}`}
      className="grid items-start px-4 py-3 bg-club-cream/20 border-b border-club-sand/25"
      style={{ gridTemplateColumns: INVENTORY_ACTION_GRID, columnGap: INVENTORY_ACTION_GRID_GAP }}
    >
      <span>
        <span
          data-testid={`inv-action-row-${row.key}-pill`}
          data-priority={row.priority}
          className={`inline-flex items-center whitespace-nowrap rounded-sm border px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${inventoryPriorityPillClass(row.priority)}`}
        >
          {row.priority}
        </span>
      </span>
      <span className="font-serif text-[13px] font-medium text-club-green-900">{row.category}</span>
      <span className="font-serif text-[13px] text-club-green-900/85">{row.observation}</span>
      <span className="font-serif text-[13px] text-club-green-900/85">{row.actionRequired}</span>
      <span className="font-serif text-[13px] text-club-green-900/85 text-right whitespace-nowrap">{row.timeline}</span>
    </div>
  );
}

function InventoryAnalysisPanel({
  pkg,
}: {
  pkg: Awaited<ReturnType<typeof getMonthlyReportingPackage>>;
}) {
  const inv = pkg.inventoryAnalysis;
  return (
    <div data-testid="inventory-analysis" className="font-serif">
      {/* Header chrome. */}
      <header className="flex flex-col gap-4 border-b border-club-sand/60 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <p data-testid="inv-eyebrow" className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]">
            {inv.eyebrow}
          </p>
          <h2 data-testid="inv-title" className="font-serif text-[34px] leading-[1.05] tracking-tight text-club-green-900">
            {inv.title}
          </h2>
          <p data-testid="inv-period" className="uppercase tracking-[0.22em] text-[10.5px] text-club-green-800/65">
            {inv.periodLabel}
          </p>
          <p data-testid="inv-intro" className="mt-3 max-w-[620px] italic text-[14.5px] leading-relaxed text-club-green-900/85">
            {inv.introNote}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <p data-testid="inv-statement-number" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {inv.statementNumber}
          </p>
          <span
            data-testid="inv-document-chip"
            className="inline-flex items-center rounded-md border border-club-gold/40 bg-club-cream px-2.5 py-1 uppercase tracking-[0.18em] text-[10px] text-club-gold-700"
          >
            {inv.documentChip}
          </span>
          <p data-testid="inv-prepared-for" className="uppercase tracking-[0.22em] text-[10px] text-club-green-800/65">
            {inv.preparedFor}
          </p>
        </div>
      </header>

      {/* 4 KPI cards. */}
      <div
        data-testid="inv-kpi-grid"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {inv.kpiCards.map((c) => (
          <InventoryKpiCardRender key={c.key} card={c} />
        ))}
      </div>

      {/* 2-up chart grid (interactive client island). */}
      <InventoryChartCards charts={inv.charts} />

      {/* Inventory Management Flags & Action Items table. */}
      <div data-testid="inv-action-table" className="mt-8">
        <h3
          data-testid="inv-action-eyebrow"
          className="uppercase tracking-[0.22em] text-[10.5px] text-[#a08850]"
        >
          {inv.actionTable.eyebrow}
        </h3>
        <div className="mt-3 overflow-hidden rounded-md border border-club-sand/60">
          <div
            data-testid="inv-action-headers"
            className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/60 bg-[#e8dfc8]/40 border-y border-club-sand/40"
            style={{ gridTemplateColumns: INVENTORY_ACTION_GRID, columnGap: INVENTORY_ACTION_GRID_GAP }}
          >
            <span className="text-left">{inv.actionTable.columnHeaders.priority}</span>
            <span className="text-left">{inv.actionTable.columnHeaders.category}</span>
            <span className="text-left">{inv.actionTable.columnHeaders.observation}</span>
            <span className="text-left">{inv.actionTable.columnHeaders.actionRequired}</span>
            <span className="text-right">{inv.actionTable.columnHeaders.timeline}</span>
          </div>
          {inv.actionTable.rows.map((row) => (
            <InventoryActionRowRender key={row.key} row={row} />
          ))}
        </div>
      </div>

      {/* Bottom padding spacer — no reference attribution. */}
      <div aria-hidden="true" className="mt-12" />
    </div>
  );
}


// Legacy `CapitalProjectsCard` was deleted 2026-06-17 along with the
// monthly package's duplicate "Capital / Projects" section. The
// canonical Capital Projects surface is now the chapter VI Capital
// Project Tracker (`CapitalProjectTrackerPanel`).


function OperatingHeadlineTile({
  testId, label, value, sub, tone, context,
}: { testId: string; label: string; value: string; sub: string; tone: KpiTone; context?: string }) {
  // Four-pillar KPI card:
  //   1. Number       — text-4xl serif tabular-nums (hero, dominant)
  //   2. Interpretation — text-[13px] /85 prose under the number
  //   3. Benchmark    — `sub` line (e.g. "+6.0 % vs plan") promoted
  //                     to text-sm tone-coloured under a hairline
  //   4. Status       — encoded by tone (dot in corner + tone-coloured
  //                     benchmark text + data-tone attribute)
  return (
    <article
      data-testid={testId}
      data-tone={tone}
      className="flex flex-col rounded-lg bg-white p-5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75">{label}</div>
        <span
          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dotForTone(tone)}`}
          aria-hidden="true"
        />
      </div>

      {/* Pillar 1 — Number (hero, dominant). */}
      <div className="mt-3 font-serif text-4xl leading-none tracking-tight tabular-nums text-club-green-900">
        {value}
      </div>

      {/* Pillar 2 — Interpretation. One-sentence "what this is".
          Optional; primitives without an inline context still render. */}
      {context && (
        <p className="mt-3 text-[13px] leading-relaxed text-club-green-900/85">
          {context}
        </p>
      )}

      {/* Pillars 3 + 4 — Benchmark / Status. Bumped from text-[11px]
          to text-sm font-medium so the verdict reads as the peer of
          the number, not as its footnote. A hairline rule opens the
          comparator strip so it reads as a distinct register. */}
      <div className="mt-3 border-t border-club-sand/70 pt-3">
        <div className={`text-sm font-medium ${toneHeadlineClass(tone)}`}>
          {sub}
        </div>
      </div>
    </article>
  );
}


function MembershipCategoryMix({
  mix, total,
}: {
  mix: ReadonlyArray<{ key: string; name: string; count: number; duesRate: string; netYTD: number; sharePct: string }>;
  total: number;
}) {
  return (
    <div data-testid="membership-category-mix" className="mt-10">
      <div className="border-b border-club-sand pb-2">
        <h3 className="font-serif text-2xl tracking-tight text-club-green-900">
          Membership category mix
        </h3>
        <p className="mt-1 text-[11px] uppercase tracking-[0.22em] text-club-green-800/65">
          Counts at period close · share of active · YTD net change per category
        </p>
      </div>
      <table className="mt-3 w-full text-[13px]">
        <thead>
          <tr className="text-club-green-800/65">
            <th className="py-2 text-left  text-[10px] font-medium uppercase tracking-[0.14em]">Category</th>
            <th className="py-2 text-right text-[10px] font-medium uppercase tracking-[0.14em]">Members</th>
            <th className="py-2 text-right text-[10px] font-medium uppercase tracking-[0.14em]">Share</th>
            <th className="py-2 text-right text-[10px] font-medium uppercase tracking-[0.14em]">Dues</th>
            <th className="py-2 text-right text-[10px] font-medium uppercase tracking-[0.14em]">Net YTD</th>
          </tr>
        </thead>
        <tbody>
          {mix.map((row) => {
            const netTone: KpiTone = row.netYTD > 0 ? "green" : row.netYTD < 0 ? "amber" : "neutral";
            const netLabel = row.netYTD > 0 ? `+${row.netYTD}` : String(row.netYTD);
            return (
              <tr key={row.key} className="border-t border-club-sand/60" data-testid={`membership-category-${row.key}`}>
                <td className="py-2.5 text-club-green-900">{row.name}</td>
                <td className="py-2.5 text-right font-mono tabular-nums text-club-green-900">{row.count.toLocaleString()}</td>
                <td className="py-2.5 text-right font-mono tabular-nums text-club-green-800/75">{row.sharePct}</td>
                <td className="py-2.5 text-right font-mono tabular-nums text-club-green-800/75">{row.duesRate}</td>
                <td className={`py-2.5 text-right font-mono tabular-nums font-medium ${toneHeadlineClass(netTone)}`}>{netLabel}</td>
              </tr>
            );
          })}
          <tr className="border-t border-club-sand">
            <td className="py-2.5 text-[11px] uppercase tracking-[0.14em] text-club-green-800/75">Total active</td>
            <td className="py-2.5 text-right font-mono tabular-nums font-medium text-club-green-900">{total.toLocaleString()}</td>
            <td className="py-2.5 text-right font-mono tabular-nums text-club-green-800/75">100.0%</td>
            <td className="py-2.5"></td>
            <td className="py-2.5"></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MembershipWaitlist({
  waitlist,
}: {
  waitlist: {
    depth: number;
    conversionPct: string;
    targetDepth: number;
    aging: ReadonlyArray<{ band: string; count: number; sharePct: string }>;
  };
}) {
  const shortfall = waitlist.depth - waitlist.targetDepth;
  return (
    <div data-testid="membership-waitlist" className="mt-10">
      <div className="border-b border-club-sand pb-2">
        <h3 className="font-serif text-2xl tracking-tight text-club-green-900">
          Waitlist depth &amp; aging
        </h3>
        <p className="mt-1 text-[11px] uppercase tracking-[0.22em] text-club-green-800/65">
          Approved applicants holding waitlist positions · time since application
        </p>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Headline tile + LRP target read */}
        <div className="rounded-lg bg-white p-6" data-testid="membership-waitlist-summary">
          <div className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75">Waitlist depth</div>
          <div className="mt-3 font-serif text-4xl leading-none tracking-tight tabular-nums text-club-green-900">
            {waitlist.depth.toLocaleString()}
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-club-green-900/85">
            Conversion rate {waitlist.conversionPct} on the trailing-3-month window.
          </p>
          <div className="mt-3 border-t border-club-sand/70 pt-3">
            <div className={`text-sm font-medium ${toneHeadlineClass(shortfall < 0 ? "amber" : "green")}`}>
              LRP target {waitlist.targetDepth}-deep · {shortfall >= 0 ? `+${shortfall}` : shortfall} vs target
            </div>
          </div>
        </div>
        {/* Aging table */}
        <div className="rounded-lg bg-white p-6" data-testid="membership-waitlist-aging">
          <div className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75">
            Waitlist aging
          </div>
          <table className="mt-3 w-full text-[13px]">
            <tbody>
              {waitlist.aging.map((row) => (
                <tr key={row.band} className="border-t border-club-sand/60 first:border-t-0">
                  <td className="py-2 text-club-green-900">{row.band}</td>
                  <td className="py-2 text-right font-mono tabular-nums text-club-green-900">{row.count}</td>
                  <td className="py-2 text-right font-mono tabular-nums text-club-green-800/75">{row.sharePct}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MembershipTenureDistribution({
  distribution, averageYears,
}: {
  distribution: ReadonlyArray<{ band: string; count: number; sharePct: string }>;
  averageYears: string;
}) {
  return (
    <div data-testid="membership-tenure-distribution" className="mt-10">
      <div className="border-b border-club-sand pb-2">
        <h3 className="font-serif text-2xl tracking-tight text-club-green-900">
          Tenure distribution
        </h3>
        <p className="mt-1 text-[11px] uppercase tracking-[0.22em] text-club-green-800/65">
          Years of continuous membership · average {averageYears} · long-tenure share anchors governance stability
        </p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {distribution.map((band) => (
          <div
            key={band.band}
            data-testid={`membership-tenure-${band.band.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}
            className="rounded-md border border-club-sand/70 bg-club-cream/40 px-4 py-3"
          >
            <div className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75">
              {band.band}
            </div>
            <div className="mt-1.5 font-serif text-2xl leading-none tracking-tight tabular-nums text-club-green-900">
              {band.count.toLocaleString()}
            </div>
            <div className="mt-2 text-xs font-medium text-club-green-800/75">
              {band.sharePct} of active
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Shared atoms
// ============================================================================

// Section heading — chapter-level title atom.
//
// Squint-test pass: chapter title bumped to text-5xl (48 px) so the
// Executive Headline wins the reader's eye BEFORE the KPI grid below
// it. Previous text-3xl was being out-shouted by the at-a-glance
// hero numbers; text-5xl puts the chapter title at the same visual
// tier as the loudest KPI on the page, and the title's top-of-chapter
// position seals the hierarchy: Club Name (cover) → Executive
// Headline (this) → KPI Values (below).
function SectionHeading({
  eyebrow, title, rightChip, pillarLabel,
}: { eyebrow: string; title: string; rightChip?: React.ReactNode; pillarLabel?: string }) {
  // Right-side metadata stack — print-TOC convention adapted from the
  // Saguaro reference (test-results/cmp-saguaro-p11.png). When a
  // chapter declares its pillar via `pillarLabel`, we render a quiet
  // gold-ringed paper-on-paper chip in the upper right; if the chapter
  // also carries a data-source rightChip, the two stack vertically
  // (pillar identity above, data-source state below). Empty pillarLabel
  // + empty rightChip keeps the right column fully empty as before.
  const hasRightStack = Boolean(pillarLabel) || Boolean(rightChip);
  return (
    <div className="flex items-end justify-between gap-6">
      <div>
        <div className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75">
          {eyebrow}
        </div>
        <h2 className="mt-3 font-serif text-5xl leading-[1.05] tracking-tight text-club-green-900">
          {title}
        </h2>
      </div>
      {hasRightStack && (
        <div className="flex flex-col items-end gap-2">
          {pillarLabel && <PillarChip label={pillarLabel} />}
          {rightChip}
        </div>
      )}
    </div>
  );
}

// Chapter navigation tile — small ivory card that names a sub-section
// of the chapter and gives a one-line context. Mirrors the Saguaro
// p03 "in-chapter TOC strip" structurally (4 tiles in a row sitting
// directly above the chart cards). Three editorial layers:
//   1. Smallcaps page-range eyebrow ("Pages 1–2")
//   2. Editorial-case title ("Visual Summary")
//   3. One-line body summary
// Quiet visual treatment: 1 px border, club-cream background, no
// icons, no chrome, no decorative shadows.
function ChapterNavCard({ eyebrow, label, detail }: {
  eyebrow: string;
  label: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border border-club-green-800/12 bg-club-cream px-4 py-3.5">
      <div className="text-[9px] font-medium uppercase tracking-[0.20em] text-club-gold-700/85">
        {eyebrow}
      </div>
      <div className="mt-1 font-serif text-[15px] leading-tight text-club-green-900">
        {label}
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-club-green-800/70">
        {detail}
      </p>
    </div>
  );
}

// Visual-summary chip — same shape and ring as the existing
// DataSourceChip (cream background, 1 px club-sand ring, 10 px
// smallcaps tracked label) but carries the editorial caption
// "Visual Summary" instead of the demo/live data badge. Used in
// chapter II's section heading per the founder's masthead copy
// direction. No new chip element — same chip shell as elsewhere in
// the package.
function VisualSummaryChip() {
  return (
    <span
      data-testid="visual-summary-chip"
      className="inline-flex items-center rounded-full bg-club-cream px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-club-green-800 ring-1 ring-club-sand"
    >
      Visual Summary
    </span>
  );
}

// Pillar identity chip — print-TOC marker. Paper-on-paper (cream bg)
// with a gold-700 ring + gold-700 smallcaps label. Mirrors Saguaro's
// right-aligned section-type pill while honoring the Executive
// Reporting Theme's "no pastel chip backgrounds" rule. Carries the
// framework pillar citation as a visual marker; not interactive.
function PillarChip({ label }: { label: string }) {
  return (
    <span
      data-testid="pillar-chip"
      data-pillar-label={label}
      className="inline-flex items-center rounded-full bg-club-cream px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-club-gold-700 ring-1 ring-club-gold-700/40"
    >
      {label}
    </span>
  );
}

// Step / At-a-Glance KPI tile — premium board-document treatment.
// Anatomy (top → bottom):
//   - metric title in smallcaps + a small tone dot in the corner
//   - HERO number (font-serif text-5xl, tabular-nums) — visually dominant
//   - plain-English context paragraph
//   - hairline rule
//   - comparator label + value, with tone-coloured variance line
//
// Cards no longer wear an outer card-on-cream "padded admin tile"
// look — they sit on cream parchment with restrained ivory borders
// and let the number do the visual work.
function KpiCardView({ kpi }: {
  kpi: {
    key: string;
    label: string;
    value: string;
    context?: string;
    comparison?: { label: string; value: string; variance?: string };
    tone?: KpiTone;
  };
}) {
  const tone = kpi.tone ?? "neutral";
  return (
    <article
      data-testid={`exec-kpi-${kpi.key}`}
      data-tone={tone}
      className="flex flex-col rounded-lg bg-white p-7"
    >
      {/* Title row — metric name + a discreet tone dot */}
      <div className="flex items-start justify-between gap-3">
        <div
          data-testid={`exec-kpi-${kpi.key}-label`}
          className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75"
        >
          {kpi.label}
        </div>
        <span
          data-testid={`exec-kpi-${kpi.key}-tone`}
          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dotForTone(tone)}`}
          aria-hidden="true"
        />
      </div>

      {/* L1c Headline KPI — text-5xl (48 px). Rebalanced down from
          text-6xl so the chapter Executive Headline above (now
          text-5xl) wins the eye first. The KPI tile is still the
          dominant element WITHIN its card, but the chapter title
          dominates the chapter. */}
      <div
        data-testid={`exec-kpi-${kpi.key}-value`}
        className="mt-6 font-serif text-5xl leading-none tracking-tight tabular-nums text-club-green-900"
      >
        {kpi.value}
      </div>

      {/* L5 prose — Interpretation (1 of 4 pillars). The "what is this
          number" sentence sits directly under the hero so the reader
          gets the metric's meaning before the comparator. */}
      {kpi.context && (
        <p
          data-testid={`exec-kpi-${kpi.key}-context`}
          className="mt-4 text-[14px] leading-relaxed text-club-green-900/85"
        >
          {kpi.context}
        </p>
      )}

      {/* Comparator strip — Benchmark + Status (2 of 4 pillars).
          KPI four-pillar redesign: benchmark label bumped to text-xs
          (was text-[10px] caption tier); benchmark value bumped to
          text-base font-mono (was text-sm — 3 : 1 hero : comparator
          ratio shrunk so the reference number reads as a number, not
          as fine print); variance / status bumped to text-sm
          font-medium (was text-[11px]) so the verdict reads as the
          peer of the hero number, not as a footnote. */}
      {kpi.comparison && (
        <div
          data-testid={`exec-kpi-${kpi.key}-comparison`}
          className="mt-6 border-t border-club-sand/70 pt-4"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs uppercase tracking-[0.22em] text-club-green-800/75">
              {kpi.comparison.label}
            </span>
            <span className="font-mono text-base tabular-nums text-club-green-900">
              {kpi.comparison.value}
            </span>
          </div>
          {kpi.comparison.variance && (
            <div
              data-testid={`exec-kpi-${kpi.key}-variance`}
              className={`mt-1.5 text-sm font-medium ${toneHeadlineClass(tone)}`}
            >
              {kpi.comparison.variance}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// Step / Executive commentary — one per major section. Renders the
// four questions the Finance Chair would otherwise ask in the meeting
// (what happened / what it means / what needs attention / board
// decision). Demo source is labelled honestly; the "Board decision
// required" slot always prints something so the question is always
// answered.
function ExecutiveCommentary({
  block,
  sectionTestId,
}: {
  block: {
    dataSource: "live" | "demo";
    consideration: BoardConsideration;
    whatHappened: string;
    whatItMeans: string;
    whatNeedsAttention: string;
    boardDecision?: string;
  };
  sectionTestId: string;
}) {
  const rows = [
    { label: "What happened",        body: block.whatHappened,         key: "happened"  },
    { label: "What it means",        body: block.whatItMeans,           key: "means"     },
    { label: "What needs attention", body: block.whatNeedsAttention,    key: "attention" },
    { label: "Board decision required", body: block.boardDecision ?? "None this month.", key: "decision" },
  ];
  return (
    <aside
      data-testid={`${sectionTestId}-commentary`}
      data-source={block.dataSource}
      className="mt-8 overflow-hidden rounded-lg border border-club-sand bg-white"
    >
      <div className="flex">
        {/* Gold left accent — editorial signal */}
        <div className="w-1 shrink-0 bg-club-gold/65" aria-hidden="true" />
        <div className="flex-1 p-6">
          <div className="flex items-baseline justify-between gap-3 border-b border-club-sand pb-3">
            <span
              data-testid={`${sectionTestId}-commentary-eyebrow`}
              className="text-[11px] uppercase tracking-[0.22em] font-medium text-club-green-900"
            >
              Executive Commentary
            </span>
            {/* Honest source label. Renders for every state so a
                future flip to live/partial drops in without component
                changes; the test stays attached to the demo-state id. */}
            <span data-testid={`${sectionTestId}-commentary-demo`}>
              <DataSourceChip source={block.dataSource} variant="commentary" />
            </span>
          </div>

          {/* Board Consideration — structured governance signal at the
              top of the commentary block. Four-state cascade defined
              in docs/executive-narrative-style-guide.md; the chip gives
              the Finance Chair the at-a-glance governance posture
              before reading the four labeled rows below. */}
          <div
            data-testid={`${sectionTestId}-commentary-consideration`}
            className="mt-4 flex items-baseline gap-3"
          >
            <span className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/65">
              Board consideration
            </span>
            <BoardConsiderationChip consideration={block.consideration} />
          </div>

          <dl className="mt-5 space-y-5">
            {rows.map((row) => (
              <div
                key={row.key}
                data-testid={`${sectionTestId}-commentary-${row.key}`}
              >
                <dt className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/65">
                  {row.label}
                </dt>
                <dd className="mt-1.5 max-w-[760px] text-[13.5px] leading-relaxed text-club-green-900/85">
                  {row.body}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </aside>
  );
}

// Step / Board-readable financial statement.
//
// Anatomy (top → bottom):
//   1. Header  — eyebrow + serif title + Demo/Live chip
//   2. Summary cards (2–4) — hero numbers with a small comparator
//   3. Key variance rows — the 3–5 line items that moved
//   4. Plain-English notes — the controller's paragraph
//   5. Detail table (subordinated) — the full line-by-line statement
//
// The detail table is always visible but visually subordinated by
// a hairline divider and a smallcaps "Full statement detail" eyebrow,
// so directors get the headline first.
type BoardStatementSummaryProps = {
  key: string;
  label: string;
  value: string;
  /** One-sentence interpretation — the second pillar of the
   *  four-pillar KPI card. Optional; cards without it still render. */
  context?: string;
  comparison?: { label: string; value: string; variance?: string };
  tone?: KpiTone;
};

type BoardStatementVarianceProps = {
  key: string;
  label: string;
  current: string;
  variance: string;
  note?: string;
  tone: KpiTone;
};

function BoardStatement({
  title, eyebrow, dataSource, summaryCards, keyVariances, notes, details, testId, consideration,
}: {
  title: string;
  eyebrow?: string;
  dataSource: "live" | "demo";
  summaryCards: ReadonlyArray<BoardStatementSummaryProps>;
  keyVariances: ReadonlyArray<BoardStatementVarianceProps>;
  notes: string;
  details: React.ReactNode;
  testId: string;
  /** Per-statement Board Consideration — the governance posture of
   *  this specific statement, rendered in the header alongside the
   *  data-source chip. */
  consideration: BoardConsideration;
}) {
  return (
    <article data-testid={testId} className="rounded-lg bg-white p-7">
      {/* Header — quiet eyebrow + serif title + Board Consideration chip
          + honest data-source chip. The outer card-border is gone; the
          statement sits on cream parchment, which lets several
          statements stack in one chapter without reading as a series
          of "admin panels". */}
      <div className="flex items-baseline justify-between gap-4 border-b border-club-sand pb-3">
        <div>
          {eyebrow && (
            <div className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75">
              {eyebrow}
            </div>
          )}
          <h3 className="mt-1 font-serif text-2xl tracking-tight text-club-green-900">{title}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span data-testid={`${testId}-consideration`}>
            <BoardConsiderationChip consideration={consideration} />
          </span>
          {dataSource === "demo" ? <DemoChip /> : <LiveChip />}
        </div>
      </div>

      {/* Summary cards */}
      <div
        data-testid={`${testId}-summary`}
        className={`mt-5 grid grid-cols-1 gap-3 ${summaryCards.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-4"}`}
      >
        {summaryCards.map((c) => (
          <BoardSummaryCard key={c.key} card={c} testId={`${testId}-summary-${c.key}`} />
        ))}
      </div>

      {/* Key variance rows — L2 eyebrow at /75, variance label sheds
          font-medium (the tone-coloured class carries the signal). */}
      <div data-testid={`${testId}-variances`} className="mt-7">
        <div className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75 border-b border-club-sand pb-2">
          Key variances this period
        </div>
        <ul className="divide-y divide-club-sand/70">
          {keyVariances.map((v) => (
            <li
              key={v.key}
              data-testid={`${testId}-variance-${v.key}`}
              data-tone={v.tone}
              className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-4 gap-y-1 py-2 text-[13px]"
            >
              <span className="text-club-green-900/85">{v.label}</span>
              <span className="font-mono tabular-nums text-club-green-900">{v.current}</span>
              <span className={toneHeadlineClass(v.tone)}>{v.variance}</span>
              {v.note ? (
                <span className="text-[11px] text-club-green-800/65">{v.note}</span>
              ) : (
                <span className="text-[11px] text-transparent" aria-hidden="true">—</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Plain-English notes */}
      <p
        data-testid={`${testId}-notes`}
        className="mt-6 max-w-[760px] text-[13.5px] leading-relaxed text-club-green-900/85"
      >
        {notes}
      </p>

      {/* Detail table — subordinated under hairline. L2 eyebrow at
          spec /75 opacity. */}
      <div className="mt-6 border-t border-club-sand pt-4">
        <div className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75 pb-2">
          Full statement detail
        </div>
        <div data-testid={`${testId}-detail`} className="overflow-x-auto">
          {details}
        </div>
      </div>
    </article>
  );
}

function BoardSummaryCard({
  card, testId,
}: { card: BoardStatementSummaryProps; testId: string }) {
  const tone = card.tone ?? "neutral";
  // Four-pillar KPI card. The board-statement context is the densest
  // on the page (four cards stacked horizontally inside each
  // statement), so pillars are scaled to fit:
  //   1. Number          — text-3xl serif tabular-nums (L1d tier)
  //   2. Interpretation  — text-[12px] /85 prose, one sentence
  //   3. Benchmark       — comparator label on its own line above the
  //                        value (was inline-with-label); value bumped
  //                        from text-[10px] to text-sm font-mono
  //   4. Status          — variance bumped from text-[11px] to text-sm
  //                        font-medium, tone-coloured
  return (
    <div
      data-testid={testId}
      data-tone={tone}
      className="rounded-md border border-club-sand/70 bg-club-cream/40 p-4"
    >
      <div className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75">
        {card.label}
      </div>
      {/* Pillar 1 — Number. */}
      <div className="mt-2 font-serif text-3xl leading-none tracking-tight tabular-nums text-club-green-900">
        {card.value}
      </div>
      {/* Pillar 2 — Interpretation. One-sentence "what is this line".
          Optional; cards without an inline context still render. */}
      {card.context && (
        <p className="mt-2 text-[12px] leading-relaxed text-club-green-900/85">
          {card.context}
        </p>
      )}
      {/* Pillars 3 + 4 — Benchmark / Status. Comparator label sits on
          its own row above the value so the reference number reads as
          a number, not as continuation of the label. */}
      {card.comparison && (
        <div className="mt-3 border-t border-club-sand/70 pt-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75">
              {card.comparison.label}
            </span>
            <span className="font-mono text-sm tabular-nums text-club-green-900">
              {card.comparison.value}
            </span>
          </div>
          {card.comparison.variance && (
            <div className={`mt-1 text-sm font-medium ${toneHeadlineClass(tone)}`}>
              {card.comparison.variance}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Detail-table atoms — extracted from the old StatementCard / ArAgingCard.
function StatementDetailTable({ lines }: { lines: ReadonlyArray<StatementLine> }) {
  return (
    <table className="w-full text-xs">
      <thead className="text-club-green-800/65">
        <tr>
          <th className="px-1 py-2 text-left font-medium uppercase tracking-[0.14em]">Line</th>
          <th className="px-1 py-2 text-right font-medium uppercase tracking-[0.14em]">Current</th>
          <th className="px-1 py-2 text-right font-medium uppercase tracking-[0.14em]">Budget</th>
          <th className="px-1 py-2 text-right font-medium uppercase tracking-[0.14em]">Var.</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line, idx) => (
          <tr
            key={`${line.label}-${idx}`}
            className={line.isTotal ? "border-t border-club-sand bg-club-cream/40 font-semibold" : ""}
          >
            <td
              className="px-1 py-1.5 text-club-green-900"
              style={{ paddingLeft: line.indent ? `${4 + line.indent * 12}px` : undefined }}
            >
              {line.label}
            </td>
            <td className="px-1 py-1.5 text-right font-mono tabular-nums text-club-green-900">{line.current}</td>
            <td className="px-1 py-1.5 text-right font-mono tabular-nums text-club-green-800/70">{line.budget ?? ""}</td>
            <td className="px-1 py-1.5 text-right font-mono tabular-nums text-club-green-800/70">{line.variance ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ArAgingDetailTable({
  buckets,
}: { buckets: ReadonlyArray<{ label: string; amount: string; share: string }> }) {
  return (
    <table className="w-full text-xs">
      <thead className="text-club-green-800/65">
        <tr>
          <th className="py-2 text-left font-medium uppercase tracking-[0.14em]">Bucket</th>
          <th className="py-2 text-right font-medium uppercase tracking-[0.14em]">Amount</th>
          <th className="py-2 text-right font-medium uppercase tracking-[0.14em]">Share</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((b) => (
          <tr key={b.label} className="border-t border-club-sand/50">
            <td className="py-1.5 text-club-green-900">{b.label}</td>
            <td className="py-1.5 text-right font-mono tabular-nums text-club-green-900">{b.amount}</td>
            <td className="py-1.5 text-right font-mono tabular-nums text-club-green-800/65">{b.share}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SparkCard({
  title, series, stroke, unitSuffix, className,
}: { title: string; series: ReadonlyArray<{ label: string; value: number }>; stroke: string; unitSuffix?: string; className?: string }) {
  // Tiny SVG sparkline. Values in series can be any unit; the sparkline
  // is normalized to a 0..100 range for display.
  const W = 320, H = 80, padX = 6, padY = 8;
  const values = series.map((s) => s.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const path = series
    .map((p, i) => {
      const x = padX + (i / Math.max(1, series.length - 1)) * (W - padX * 2);
      const y = padY + (1 - (p.value - min) / span) * (H - padY * 2);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const last = series[series.length - 1];
  return (
    <div className={`rounded-lg bg-white p-5 ${className ?? ""}`}>
      <div className="flex items-center justify-between">
        {/* L2 sparkline title — consolidated tracking + opacity. */}
        <div className="text-[11px] uppercase tracking-[0.22em] text-club-green-800/75">
          {title}
        </div>
        {last && (
          <div className="font-mono text-xs tabular-nums text-club-green-900/85">
            {last.label}: {last.value.toFixed(2)}{unitSuffix ?? ""}
          </div>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 h-20 w-full">
        <path d={path} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-club-green-800/55">
        {series.map((p, i) => (
          (i === 0 || i === series.length - 1 || i === Math.floor(series.length / 2)) ? (
            <span key={p.label}>{p.label}</span>
          ) : <span key={p.label} className="invisible">{p.label}</span>
        ))}
      </div>
    </div>
  );
}

function ToneChip({ tone, label }: { tone: KpiTone; label: string }) {
  // Executive Reporting Theme — paper-on-paper chip.
  // Color audit C1 + H1 + M1 + M2 close-out: every chip background is
  // cream, every ring is sand, and the tone is carried entirely by the
  // text color. See docs/monthly-reporting-color-audit.md for the
  // pastel-warning-chip silhouette this replaces.
  const klass = {
    green:   "bg-club-cream text-club-green-800 ring-1 ring-club-sand",
    amber:   "bg-club-cream text-amber-700 ring-1 ring-club-sand",
    red:     "bg-club-cream text-red-700 ring-1 ring-club-sand",
    neutral: "bg-club-cream text-club-green-800/80 ring-1 ring-club-sand",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${klass}`}>{label}</span>;
}

// Step / polish — unified data-source chip. Three states:
//   - "live"    — value comes from a wired production source (green)
//   - "partial" — section is mostly live but at least one input is
//                 still demo / placeholder (gold)
//   - "demo"    — entire section is placeholder pending data wiring (amber)
// All three render to the same shape so the package reads as one
// consistent design language; the colour carries the signal.
function DataSourceChip({
  source,
  variant,
}: {
  source: "live" | "partial" | "demo";
  /** Override the default label ("Live data" / "Demo data" / "Partial").
   *  Used by ExecutiveCommentary to render "Demo commentary" without
   *  forking the chip shape. */
  variant?: "data" | "commentary";
}) {
  const label = (variant ?? "data") === "commentary"
    ? source === "live" ? "Live commentary" : source === "partial" ? "Partial commentary" : "Demo commentary"
    : source === "live" ? "Live data" : source === "partial" ? "Partial data" : "Demo data";
  // Executive Reporting Theme — paper-on-paper chip.
  // Color audit C1 close-out: all three states now sit on cream paper
  // with a club-sand ring; the tone is carried by the text color only.
  // The partial state uses club-gold-700 (#6b5028) — the AA-compliant
  // text variant of club-gold — to satisfy WCAG AA on cream where the
  // ornamental club-gold base (#b08a4a) measures 2.9:1 and fails.
  const classes = source === "live"
    ? "bg-club-cream text-club-green-800 ring-club-sand"
    : source === "partial"
      ? "bg-club-cream text-club-gold-700 ring-club-gold/40"
      : "bg-club-cream text-amber-700 ring-club-sand";
  return (
    <span
      data-testid="data-source-chip"
      data-source={source}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] ring-1 ${classes}`}
    >
      {label}
    </span>
  );
}

// Back-compat shims for the existing call sites. New code should
// use <DataSourceChip source="..." /> directly.
function DemoChip() { return <DataSourceChip source="demo" />; }
function LiveChip() { return <DataSourceChip source="live" />; }

// Board Consideration chip — the four-state governance signal carried
// by every major narrative on the page.
//
//   - no-action        : favorable / acknowledged              (green)
//   - monitor          : within policy, trend tracked          (neutral)
//   - committee-review : committee will review and report back (gold)
//   - board-decision   : Board approval or motion required     (amber)
//
// Defined in docs/executive-narrative-style-guide.md and exposed in
// the data model as `BoardConsideration` (lib/reporting/monthly-package.ts).
// The chip is paper-on-paper per the color philosophy — background is
// always cream, ring is sand or restrained gold, tone carried by text.
function BoardConsiderationChip({ consideration }: { consideration: BoardConsideration }) {
  const { label, classes } = {
    "no-action": {
      label: "No action required",
      classes: "bg-club-cream text-club-green-800 ring-club-sand",
    },
    "monitor": {
      label: "Monitor",
      classes: "bg-club-cream text-club-green-800/80 ring-club-sand",
    },
    "committee-review": {
      label: "Committee review recommended",
      classes: "bg-club-cream text-club-gold-700 ring-club-gold/40",
    },
    "board-decision": {
      label: "Board decision required",
      classes: "bg-club-cream text-amber-700 ring-club-sand",
    },
  }[consideration];
  return (
    <span
      data-testid="board-consideration-chip"
      data-consideration={consideration}
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] ring-1 ${classes}`}
    >
      {label}
    </span>
  );
}

// Chapter ornament — the Aldus-leaf glyph centered on full-width
// gold hair-rules, used between chapters as a printed-document
// section break.
//
// 2026-06-14 redesign: hair-rules upgraded from fixed `w-20` (80 px)
// to `flex-1` so the decoration spans the full report canvas width
// at every viewport. The glyph upgraded from `text-lg` (18 px) to
// `text-2xl` (24 px) so it carries enough visual weight to anchor
// the centered position on the longer rule. Rule opacity nudged
// from `/30` to `/35` and gold tint from `/65` to `/70` so the
// transition reads as a deliberate chapter break rather than an
// orphaned decoration. Visual weight now matches the chapter eyebrow
// + display title beneath, giving the package the chapter-break
// rhythm a Deloitte/KPMG board pack would carry. The Aldus glyph
// (also used beneath the cover's "prepared for" block) is retained
// so the heritage motif stays consistent across the whole package
// — a bare hairline would orphan the cover usage and read SaaS.
//
// Decorative only — aria-hidden so screen readers do not announce
// the glyph; the chapter rail + section headings already announce
// the section change semantically.
function ChapterOrnament() {
  return (
    <div
      data-testid="chapter-ornament"
      aria-hidden="true"
      className="mt-16 flex items-center justify-center gap-6 text-club-gold/70"
    >
      <span className="h-px flex-1 bg-club-gold/35" />
      <span className="font-serif text-2xl leading-none">&#10086;</span>
      <span className="h-px flex-1 bg-club-gold/35" />
    </div>
  );
}

function dotForTone(tone: KpiTone): string {
  // Executive Reporting Theme — desaturated status dots.
  // Color audit C2 + C3 close-out: stoplight saturation collapses to
  // the desaturated step per spec; the admin-stone neutral moves to
  // club-sand so every dot comes from the club palette.
  return tone === "green" ? "bg-club-green-700"
    : tone === "amber" ? "bg-amber-700"
    : tone === "red" ? "bg-red-700"
    : "bg-club-sand";
}

function toneHeadlineClass(tone: KpiTone): string {
  // POSITIVE green case uses club-green-600 (#2f5832) — visibly
  // distinct from body copy (club-green-800/900) so the chair scans
  // "On Plan / Strong Position / Executing" as healthy at a glance.
  // Still in the deep, restrained club-green family — never crosses
  // into SaaS emerald-500 territory. The dot stays at club-green-700
  // so dot + text harmonize as a single positive signal.
  return tone === "green" ? "text-club-green-600"
    : tone === "amber" ? "text-amber-700"
    : tone === "red" ? "text-red-700"
    : "text-club-green-900";
}

// Briefing-card-only variant of toneHeadlineClass. The positive case
// bumps from club-green-600 (#2f5832) to club-green-500 (#3f7042) so
// the conclusions ("On Plan / Strong Position / Executing") read
// UNAMBIGUOUSLY as green at the 26-30 px serif size, rather than as
// near-black. -500 is still inside the deep-forest club-green family
// (it's the palette step just brighter than -600) so the result feels
// like a recognised "fairway green" rather than SaaS emerald or
// dashboard success-toast green. Amber + red tiers are unchanged
// because they already read clearly. Used only by the three Executive
// Briefing cards on the cover; the Chair's Dashboard pillar tiles +
// other surfaces continue to use the original `toneHeadlineClass`.
function toneBriefingHeadlineClass(tone: KpiTone): string {
  return tone === "green" ? "text-club-green-500"
    : tone === "amber" ? "text-amber-700"
    : tone === "red" ? "text-red-700"
    : "text-club-green-900";
}

