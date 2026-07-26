import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { getOperatingResults } from "@/lib/reporting/operating-results";
import { formatOperatingDashboard } from "@/lib/reporting/monthly-package";
import { ensureFiscalYear } from "@/lib/accounting/periods";
import { resetDb } from "./util/db";

// Tests for the Operating Results — 12-Month Rolling Trend reporting
// service. Establishes that:
//   - the card's data comes from accounting records (FiscalPeriod
//     columns closingNoi / closingRevenue / budgetNoi) — NOT from
//     disconnected fixture arrays inside the React component
//   - tenant scope is respected — every read is filtered by clubId
//   - the displayed KPI labels are CALCULATED from those columns (the
//     NOI % tile is `(ytdNoi / ytdRevenue) × 100`, not a literal)
//   - changing the seeded values changes the output (proof the chain
//     is live, not a cached fixture)

describe("operating-results reporting service", () => {
  let clubAId: string;
  let clubBId: string;
  /** Reporting period — May 31, 2026 00:00 UTC. The service filter is
   *  `endDate < asOf`, so the May 2026 FiscalPeriod (whose endDate is
   *  May 31, 2026 23:59:59.999) is EXCLUDED; the trailing 12 window
   *  ends April 2026. */
  const asOf = new Date(Date.UTC(2026, 4, 31));

  beforeAll(async () => {
    await resetDb();

    // Two clubs so we can prove tenant isolation alongside the value
    // assertions.
    const a = await prisma.club.create({
      data: { name: "Operating Test Club A", slug: "op-a" },
    });
    clubAId = a.id;
    const b = await prisma.club.create({
      data: { name: "Operating Test Club B", slug: "op-b" },
    });
    clubBId = b.id;

    // Both clubs need 36 months of FiscalPeriod rows (FY2024, FY2025,
    // FY2026) so the trailing-12 + prior-year-overlay windows are
    // populated.
    for (const id of [clubAId, clubBId]) {
      await ensureFiscalYear(id, { startYear: 2024, startMonth: 1 });
      await ensureFiscalYear(id, { startYear: 2025, startMonth: 1 });
      await ensureFiscalYear(id, { startYear: 2026, startMonth: 1 });
    }

    // Club A — May 2025 – Apr 2026 → NOI $45K, Revenue $15.0M, Budget $0
    //          May 2024 – Apr 2025 → NOI ($193K)  (the founder target)
    const A_RESULTS = [
      // Prior-year window
      { year: 2024, month: 1,  noi: -80_000,  revenue:   600_000, budget: -60_000 },
      { year: 2024, month: 2,  noi: -60_000,  revenue:   580_000, budget: -40_000 },
      { year: 2024, month: 3,  noi: -25_000,  revenue:   750_000, budget: -10_000 },
      { year: 2024, month: 4,  noi:   5_000,  revenue: 1_350_000, budget:  20_000 },
      { year: 2024, month: 5,  noi:  50_000,  revenue: 1_600_000, budget:  60_000 },
      { year: 2024, month: 6,  noi:  70_000,  revenue: 1_700_000, budget:  85_000 },
      { year: 2024, month: 7,  noi: -85_000,  revenue: 1_550_000, budget: -20_000 },
      { year: 2024, month: 8,  noi: -68_000,  revenue: 1_450_000, budget: -10_000 },
      { year: 2024, month: 9,  noi: -25_000,  revenue: 1_350_000, budget:  15_000 },
      { year: 2024, month: 10, noi:  20_000,  revenue: 1_400_000, budget:  40_000 },
      { year: 2024, month: 11, noi:  35_000,  revenue: 1_200_000, budget:  55_000 },
      { year: 2024, month: 12, noi:  10_000,  revenue:   850_000, budget:  30_000 },
      { year: 2025, month: 1,  noi: -98_000,  revenue:   650_000, budget: -55_000 },
      { year: 2025, month: 2,  noi: -75_000,  revenue:   620_000, budget: -30_000 },
      { year: 2025, month: 3,  noi: -32_000,  revenue:   780_000, budget:  -5_000 },
      { year: 2025, month: 4,  noi:   5_000,  revenue: 1_400_000, budget:  20_000 },
      // Current trailing-12 window — Saguaro reference pattern
      // (must mirror prisma/seed.ts MONTHLY_RESULTS for the same window).
      { year: 2025, month: 5,  noi:  60_000,  revenue: 1_700_000, budget:  50_000 },
      { year: 2025, month: 6,  noi:  70_000,  revenue: 1_750_000, budget:  55_000 },
      { year: 2025, month: 7,  noi: -55_000,  revenue: 1_550_000, budget: -45_000 },
      { year: 2025, month: 8,  noi: -40_000,  revenue: 1_450_000, budget: -35_000 },
      { year: 2025, month: 9,  noi:  25_000,  revenue: 1_380_000, budget:  20_000 },
      { year: 2025, month: 10, noi:  30_000,  revenue: 1_450_000, budget:  25_000 },
      { year: 2025, month: 11, noi:  20_000,  revenue: 1_280_000, budget:  15_000 },
      { year: 2025, month: 12, noi:  15_000,  revenue:   880_000, budget:  10_000 },
      { year: 2026, month: 1,  noi: -50_000,  revenue:   690_000, budget: -45_000 },
      { year: 2026, month: 2,  noi: -40_000,  revenue:   620_000, budget: -35_000 },
      { year: 2026, month: 3,  noi:   5_000,  revenue:   800_000, budget:       0 },
      { year: 2026, month: 4,  noi:   5_000,  revenue: 1_450_000, budget: -15_000 },
    ];
    for (const r of A_RESULTS) {
      const label = `FY${r.year}-M${String(r.month).padStart(2, "0")}`;
      await prisma.fiscalPeriod.updateMany({
        where: { clubId: clubAId, label },
        data: {
          closingNoi: r.noi,
          closingRevenue: r.revenue,
          budgetNoi: r.budget,
        },
      });
    }

    // Club B — completely different numbers to verify tenant isolation.
    // Skip Apr 2025 etc; simpler synthetic shape.
    const B_RESULTS = [
      { year: 2025, month: 5,  noi: 100_000, revenue: 2_000_000, budget: 100_000 },
      { year: 2025, month: 6,  noi: 100_000, revenue: 2_000_000, budget: 100_000 },
    ];
    for (const r of B_RESULTS) {
      const label = `FY${r.year}-M${String(r.month).padStart(2, "0")}`;
      await prisma.fiscalPeriod.updateMany({
        where: { clubId: clubBId, label },
        data: {
          closingNoi: r.noi,
          closingRevenue: r.revenue,
          budgetNoi: r.budget,
        },
      });
    }
  });

  it("reads ClubA's monthly NOI / revenue / budget from FiscalPeriod columns", async () => {
    const r = await getOperatingResults(clubAId, asOf);
    expect(r.months.length).toBe(12);
    // Window is May 2025 → Apr 2026.
    expect(r.months[0].monthLabel).toBe("May");
    expect(r.months[11].monthLabel).toBe("Apr");
    // Spot-check Jul 2025 NOI (summer dip, −$55K in the Saguaro pattern).
    expect(r.months.find((m) => m.monthLabel === "Jul")?.noi).toBe(-55_000);
    // Spot-check May 2025 NOI (strong season opener).
    expect(r.months.find((m) => m.monthLabel === "May")?.noi).toBe(60_000);
  });

  it("rolls up trailing-12 totals from accounting columns (NOT a hardcoded YTD)", async () => {
    const r = await getOperatingResults(clubAId, asOf);
    // Sums proven in the seed comment block — let the test re-derive.
    expect(r.ytdNoi).toBe(45_000);
    expect(r.ytdRevenue).toBe(15_000_000);
    expect(r.ytdBudgetNoi).toBe(0);
    expect(r.priorYearNoi).toBe(-193_000);
  });

  it("formatOperatingDashboard produces the founder's target KPI labels: $45K / 0.3% / $0 / ($193K)", async () => {
    const r = await getOperatingResults(clubAId, asOf);
    const d = formatOperatingDashboard(r, { periodLabel: "Year-end" });
    expect(d.ytdNoiLabel).toBe("$45K");
    // NOI %: (45,000 / 15,000,000) × 100 = 0.30, formatter pins to .toFixed(1) → "0.3%"
    expect(d.noiPctRevenueLabel).toBe("0.3%");
    expect(d.budgetGoalLabel).toBe("$0");
    expect(d.priorYearLabel).toBe("($193K)");
  });

  it("formatOperatingDashboard emits monthly chart series mirrored from accounting columns", async () => {
    const r = await getOperatingResults(clubAId, asOf);
    const d = formatOperatingDashboard(r, { periodLabel: "Year-end" });
    expect(d.series.length).toBe(12);
    // First chart bar (May 2025) is the SAME value the FiscalPeriod
    // carried, scaled dollars → $K (here: $60,000 → 60 on chart).
    expect(d.series[0].label).toBe("May");
    expect(d.series[0].value).toBe(60);
    // Last bar (Apr 2026): seeded at $5,000 → chart 5.
    expect(d.series[11].label).toBe("Apr");
    expect(d.series[11].value).toBe(5);
    // Budget series mirrors budget column (May 2025 budgeted $50K → 50).
    expect(d.budget[0].value).toBe(50);
    // Prior-year series carries the matched 12 months' actual NOI.
    expect(d.priorYear.length).toBe(12);
  });

  it("formatOperatingDashboard emits a priorYearYtd CUMULATIVE series whose last point equals the Prior Year KPI", async () => {
    const r = await getOperatingResults(clubAId, asOf);
    const d = formatOperatingDashboard(r, { periodLabel: "Year-end" });
    expect(d.priorYearYtd.length).toBe(12);
    // Step-by-step running sum of priorYear → priorYearYtd.
    let running = 0;
    for (let i = 0; i < 12; i++) {
      running += d.priorYear[i].value;
      expect(d.priorYearYtd[i].value).toBe(running);
      expect(d.priorYearYtd[i].label).toBe(d.priorYear[i].label);
    }
    // Endpoint reconciles to the Prior Year KPI tile.
    expect(d.priorYearYtd[11].value).toBe(-193);  // matches "($193K)" KPI
    expect(d.priorYearLabel).toBe("($193K)");
  });

  it("RECONCILIATION: chart series sums to the YTD NOI / Budget / Prior Year KPI values", async () => {
    const r = await getOperatingResults(clubAId, asOf);
    const d = formatOperatingDashboard(r, { periodLabel: "Year-end" });
    // The bars sum to the YTD NOI KPI value.
    const actualSum = d.series.reduce((s, p) => s + p.value, 0);
    expect(actualSum).toBe(45);
    expect(d.ytdNoiLabel).toBe("$45K");
    // The budget bars sum to the Budget Goal KPI value.
    const budgetSum = d.budget.reduce((s, p) => s + p.value, 0);
    expect(budgetSum).toBe(0);
    expect(d.budgetGoalLabel).toBe("$0");
    // The prior-year monthly values sum to the Prior Year KPI.
    const priorMonthlySum = d.priorYear.reduce((s, p) => s + p.value, 0);
    expect(priorMonthlySum).toBe(-193);
    // AND the cumulative line's endpoint equals that same value (this
    // is the VISUAL anchor the chart now exposes to the eye).
    expect(d.priorYearYtd[11].value).toBe(priorMonthlySum);
    expect(d.priorYearLabel).toBe("($193K)");
  });

  it("tenant isolation: Club A's data does NOT bleed into Club B", async () => {
    const ra = await getOperatingResults(clubAId, asOf);
    const rb = await getOperatingResults(clubBId, asOf);
    // Club A's NOI = $45K; Club B's totally different.
    expect(ra.ytdNoi).toBe(45_000);
    expect(rb.ytdNoi).not.toBe(45_000);
    // Club B saw NO seeded data for Jul 2025 → its Jul 2025 NOI is null.
    expect(rb.months.find((m) => m.monthLabel === "Jul")?.noi).toBeNull();
  });

  it("Rule 9: changing the seeded operating data changes the formatter output", async () => {
    // Bump Apr 2026 NOI from the seeded $5K to $10K (+ $5K delta) —
    // YTD must rise from $45K to $50K.
    await prisma.fiscalPeriod.updateMany({
      where: { clubId: clubAId, label: "FY2026-M04" },
      data: { closingNoi: 10_000 },
    });
    const r = await getOperatingResults(clubAId, asOf);
    const d = formatOperatingDashboard(r, { periodLabel: "Year-end" });
    expect(r.ytdNoi).toBe(50_000);
    expect(d.ytdNoiLabel).toBe("$50K");

    // Restore so subsequent tests in this suite (if any are added)
    // still see the founder's target values.
    await prisma.fiscalPeriod.updateMany({
      where: { clubId: clubAId, label: "FY2026-M04" },
      data: { closingNoi: 5_000 },
    });
  });
});
