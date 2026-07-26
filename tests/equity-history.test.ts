import { describe, it, expect, beforeAll } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getEquityHistory, computeCagrBps } from "@/lib/reporting/equity-history";
import { formatEquityDashboard } from "@/lib/reporting/monthly-package";
import { resetDb } from "./util/db";

// Tests for the Equity Value Over Time reporting data service.
// Establishes that:
//   - the chart's data comes from accounting records (FiscalYear.closingEquity
//     for closed years, the live balance sheet for the current open FY) —
//     NOT from disconnected fixture arrays inside the React component
//   - benchmark series are PROJECTIONS from the first-year actual base
//     using configurable CAGR assumptions on ClubProfile, not stored points
//   - tenant scope is respected — every read is filtered by clubId
//   - CAGR math is correct
//   - the per-year provenance record names where each point came from

describe("equity-history reporting service", () => {
  let clubAId: string;
  let clubBId: string;

  beforeAll(async () => {
    await resetDb();

    // Club A — 8 closed historical FYs + a 9th OPEN current FY, both with
    // closingEquity set so the service can resolve every point.
    const a = await prisma.club.create({
      data: { name: "Equity Test Club A", slug: "eq-a" },
    });
    clubAId = a.id;
    await prisma.clubProfile.create({
      data: {
        clubId: a.id,
        equityBenchmarkBestCagrBps: 550,
        equityBenchmarkMinCagrBps: 350,
      },
    });
    // Series: $18.83M (FY2018) → $31.00M (FY2025) over 7 YoY periods.
    // Compound CAGR = 7.38 % → matches Saguaro p03's published 7.4 %
    // actual line. These are the eight COMPLETED fiscal years a May
    // 2026 reporting package draws on (`endDate < asOf` filter).
    const seeded = [
      { year: 2018, value: 18_830_000 },
      { year: 2019, value: 19_950_000 },
      { year: 2020, value: 21_500_000 },
      { year: 2021, value: 23_050_000 },
      { year: 2022, value: 24_800_000 },
      { year: 2023, value: 26_850_000 },
      { year: 2024, value: 28_900_000 },
      { year: 2025, value: 31_000_000 },
    ];
    for (const { year, value } of seeded) {
      const startDate = new Date(Date.UTC(year, 0, 1));
      const endDate = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
      await prisma.fiscalYear.create({
        data: {
          clubId: a.id, label: `FY${year}`, startDate, endDate, status: "CLOSED",
          closingEquity: new Prisma.Decimal(value),
        },
      });
    }

    // Club B — separate tenant with NO fiscal years, used to prove the
    // service is clubId-scoped and doesn't leak across tenants.
    const b = await prisma.club.create({
      data: { name: "Equity Test Club B", slug: "eq-b" },
    });
    clubBId = b.id;
  });

  describe("CAGR math (pure)", () => {
    it("returns 0 for non-positive base or zero years", () => {
      expect(computeCagrBps(0n, 100n, 5)).toBe(0);
      expect(computeCagrBps(100n, 100n, 0)).toBe(0);
    });

    it("computes compound annual growth in basis points", () => {
      // $1.00 → $1.06 over 1 year = exactly 6.00% = 600 bps
      expect(computeCagrBps(100n, 106n, 1)).toBe(600);
      // $100 → $200 over 7 years compounds at ~10.41 % = ~1041 bps
      expect(computeCagrBps(10_000n, 20_000n, 7)).toBe(1041);
    });
  });

  describe("equity history for a club with 8 closed FYs", () => {
    let result: Awaited<ReturnType<typeof getEquityHistory>>;

    beforeAll(async () => {
      result = await getEquityHistory(clubAId, {
        asOf: new Date(Date.UTC(2026, 4, 31)),
        yearsBack: 8,
      });
    });

    it("returns 8 historical year-end points", () => {
      expect(result.series).toHaveLength(8);
    });

    it("returns the last 8 COMPLETED fiscal years (FY2018 → FY2025) ordered oldest first", () => {
      const labels = result.series.map((p) => p.fiscalYear);
      expect(labels[0]).toBe("FY2018");
      expect(labels[labels.length - 1]).toBe("FY2025");
    });

    it("actual club equity comes from the accounting record, not a hardcoded array", () => {
      // First year actual matches the seeded FiscalYear.closingEquity
      // ($18,830,000 == 1,883,000,000 cents).
      expect(result.series[0].clubEquityCents).toBe(1_883_000_000n);
      // Last year actual is $31,000,000.
      expect(result.series[7].clubEquityCents).toBe(3_100_000_000n);
    });

    it("benchmark series are PROJECTIONS from the first-year actual base, not stored points", () => {
      // The benchmark lines must START at the same value as the actual
      // line in year 0 — that's what makes them comparable trajectories.
      expect(result.series[0].bestInClassBenchmarkCents).toBe(result.series[0].clubEquityCents);
      expect(result.series[0].minimumRequiredBenchmarkCents).toBe(result.series[0].clubEquityCents);

      // And they must diverge upward at the configured CAGRs (5.5 % best,
      // 3.5 % min) so the last year's projection is materially different
      // from the first year's base.
      const base = Number(result.series[0].clubEquityCents);
      const lastBest = Number(result.series[7].bestInClassBenchmarkCents);
      const lastMin = Number(result.series[7].minimumRequiredBenchmarkCents);
      expect(lastBest / base).toBeCloseTo(Math.pow(1.055, 7), 4);
      expect(lastMin / base).toBeCloseTo(Math.pow(1.035, 7), 4);
    });

    it("benchmark CAGRs come from ClubProfile, not from defaults baked into the chart", () => {
      expect(result.bestInClassCagrBps).toBe(550);
      expect(result.minimumRequiredCagrBps).toBe(350);
    });

    it("actual CAGR is computed from the actual GL-sourced series — Saguaro-aligned 7.4 %", () => {
      // $18.83M → $31.00M over 7 years compounds at ~7.38 % = ~738 bps.
      // pct() rounds to 1 decimal → displays as "7.4 %".
      expect(result.actualCagrBps).toBeGreaterThanOrEqual(735);
      expect(result.actualCagrBps).toBeLessThanOrEqual(745);
    });

    it("formatEquityDashboard renders the four KPI tile labels Saguaro p03 ships with", () => {
      // The four KPI strings the React tile reads from
      // pkg.stewardshipDashboard.equity must come from this formatter,
      // not from any literal in the React tree. These four assertions
      // pin the strings the founder named in the task spec.
      const display = formatEquityDashboard(result);
      expect(display.actualCagrLabel).toBe("7.4%");
      expect(display.bestInClassCagrLabel).toBe("5.5%");
      expect(display.minimumRequiredCagrLabel).toBe("3.5%");
      expect(display.currentValueLabel).toBe("$31.0M");
    });

    it("formatEquityDashboard interpretation matches the founder's requested Silver Springs sentence", () => {
      // With actual 7.4 % > best-in-class 5.5 % > min 3.5 %, the
      // generated commentary must be the exact Saguaro-aligned
      // sentence the founder spec'd, using calendar year "2018"
      // (NOT "FY2018") and with NO pillar reference.
      const display = formatEquityDashboard(result);
      expect(display.interpretation).toBe(
        "Compounded annual equity growth of **7.4%** since 2018 exceeds both " +
        "the **5.5%** best-in-class benchmark and the **3.5%** minimum required " +
        "to outpace asset inflation. Clubs growing equity at less than **3.5%** " +
        "annually are falling behind replacement cost increases.",
      );
      // Negative assertions for the requirements the founder named:
      // calendar year, no pillars, no FY label.
      expect(display.interpretation).not.toMatch(/FY\d{4}/);
      expect(display.interpretation.toLowerCase()).not.toContain("pillar");
    });

    it("benchmark projections compound at the configured CAGRs (5.5 % / 3.5 %) from the first-year base", () => {
      // Each benchmark series point at year i should equal
      // base × (1 + cagr)^i. Year 7 best-in-class: 18.83M × 1.055^7
      //   = 18.83 × 1.4546 = $27.39M
      // Year 7 min-required: 18.83M × 1.035^7
      //   = 18.83 × 1.2722 = $23.96M
      const base = Number(result.series[0].clubEquityCents) / 100; // $
      const lastBestUSD = Number(result.series[7].bestInClassBenchmarkCents) / 100;
      const lastMinUSD = Number(result.series[7].minimumRequiredBenchmarkCents) / 100;
      expect(lastBestUSD).toBeCloseTo(base * Math.pow(1.055, 7), 0);
      expect(lastMinUSD).toBeCloseTo(base * Math.pow(1.035, 7), 0);
    });

    it("changing seeded accounting balances changes the chart output (#7 from the founder's spec)", async () => {
      // Update Club A's FY2025 closingEquity by +$5M and re-read.
      // The CAGR + current-equity readout must move accordingly,
      // proving the chart is wired to the accounting record.
      await prisma.fiscalYear.update({
        where: { clubId_label: { clubId: clubAId, label: "FY2025" } },
        data: { closingEquity: new Prisma.Decimal(36_000_000) },
      });
      const r2 = await getEquityHistory(clubAId, {
        asOf: new Date(Date.UTC(2026, 4, 31)),
        yearsBack: 8,
      });
      expect(r2.currentEquityCents).toBe(3_600_000_000n);
      expect(r2.actualCagrBps).toBeGreaterThan(745); // moved off the 738 baseline
      // Restore for any downstream tests that read this state.
      await prisma.fiscalYear.update({
        where: { clubId_label: { clubId: clubAId, label: "FY2025" } },
        data: { closingEquity: new Prisma.Decimal(31_000_000) },
      });
    });

    it("currentEquityCents matches the last point of the series", () => {
      expect(result.currentEquityCents).toBe(result.series[7].clubEquityCents);
    });

    it("source provenance is recorded per year — closed-fy when a snapshot exists; live-bs for an open year with no snapshot", () => {
      expect(result.source.perYear).toHaveLength(8);
      // Test club seeded EVERY year (including FY2026 OPEN) with a
      // closingEquity snapshot, so every year resolves to "closed-fy".
      // This matches the demo-tenant pattern: accounting data is seeded
      // through FiscalYear.closingEquity, not invented in the chart.
      for (const entry of result.source.perYear) {
        expect(entry.origin).toBe("closed-fy");
      }
    });

    it("a fiscal year that ENDED but has no closingEquity snapshot falls back to the live balance sheet", async () => {
      // The Monthly Reporting Package's `endDate < asOf` window only
      // admits COMPLETED fiscal years, so the live-BS branch fires
      // only for a year whose endDate has passed but whose closing
      // engine hasn't yet written `closingEquity`. Construct that
      // exact scenario.
      const c = await prisma.club.create({
        data: { name: "Equity Test Club C", slug: "eq-c" },
      });
      await prisma.fiscalYear.create({
        data: {
          clubId: c.id,
          label: "FY2025",
          startDate: new Date(Date.UTC(2025, 0, 1)),
          endDate: new Date(Date.UTC(2025, 11, 31, 23, 59, 59, 999)),
          status: "OPEN",
          // closingEquity intentionally null — closing not yet booked.
        },
      });
      const r = await getEquityHistory(c.id, {
        asOf: new Date(Date.UTC(2026, 4, 31)),
        yearsBack: 1,
      });
      expect(r.source.perYear).toHaveLength(1);
      expect(r.source.perYear[0].origin).toBe("live-bs");
    });
  });

  // ── Y-axis rounding rule ────────────────────────────────────────
  // Validates the founder's rule:
  //   yAxisMin = floor(first plotted equity / $5M) × $5M
  //   yAxisMax = ceil (highest plotted value / $5M) × $5M
  describe("y-axis rounding rules", () => {
    it.each([
      { firstM: 19,   highestM: 32.18, expectedMin: 15, expectedMax: 35 },
      { firstM: 21.4, highestM: 32.18, expectedMin: 20, expectedMax: 35 },
      { firstM: 25.0, highestM: 32.18, expectedMin: 25, expectedMax: 35 },
      { firstM: 29.8, highestM: 38.20, expectedMin: 25, expectedMax: 40 },
    ])("first $$firstM M → yAxisMin $$expectedMin M; highest $$highestM M → yAxisMax $$expectedMax M",
      async ({ firstM, highestM, expectedMin, expectedMax }) => {
        // Build a minimal EquityHistory by hand so we don't have to
        // re-seed Prisma for every parameter set. We're testing the
        // formatter, not the GL read.
        const fakeHistory = {
          currentEquityCents: BigInt(Math.round(highestM * 1_000_000 * 100)),
          actualCagrBps: 738,
          bestInClassCagrBps: 550,
          minimumRequiredCagrBps: 350,
          series: [
            // The actual series points the formatter inspects: first
            // (drives yAxisMin) and last (drives currentEquity). For
            // the highest test we set the best-in-class endpoint to
            // the user-provided highest value.
            { fiscalYear: "FY2018", clubEquityCents: BigInt(Math.round(firstM * 1_000_000 * 100)),
              bestInClassBenchmarkCents: BigInt(Math.round(firstM * 1_000_000 * 100)),
              minimumRequiredBenchmarkCents: BigInt(Math.round(firstM * 1_000_000 * 100)) },
            { fiscalYear: "FY2025", clubEquityCents: BigInt(Math.round(firstM * 1_000_000 * 100)),
              bestInClassBenchmarkCents: BigInt(Math.round(highestM * 1_000_000 * 100)),
              minimumRequiredBenchmarkCents: BigInt(Math.round(firstM * 1_000_000 * 100)) },
          ],
          source: { perYear: [] },
        };
        const display = formatEquityDashboard(fakeHistory);
        expect(display.yAxisMin).toBe(expectedMin);
        expect(display.yAxisMax).toBe(expectedMax);
        // yAxisTicks is always (max − min) / 5 → clean $5M intervals.
        expect(display.yAxisTicks).toBe((expectedMax - expectedMin) / 5);
      },
    );
  });

  // ── X-axis year-window rollover ─────────────────────────────────
  describe("x-axis year-window rollover", () => {
    let clubDId: string;

    beforeAll(async () => {
      // Club D: 9 closed fiscal years (FY2018 through FY2026) so the
      // 8-year window can demonstrably ROLL FORWARD when asOf moves
      // past the FY2026 endDate.
      const d = await prisma.club.create({
        data: { name: "Equity Test Club D", slug: "eq-d" },
      });
      clubDId = d.id;
      await prisma.clubProfile.create({
        data: {
          clubId: d.id,
          equityBenchmarkBestCagrBps: 550,
          equityBenchmarkMinCagrBps: 350,
        },
      });
      // Nine years of closing equity, simple linear ramp.
      for (let year = 2018; year <= 2026; year++) {
        await prisma.fiscalYear.create({
          data: {
            clubId: d.id, label: `FY${year}`,
            startDate: new Date(Date.UTC(year, 0, 1)),
            endDate: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
            status: "CLOSED",
            closingEquity: new Prisma.Decimal(15_000_000 + (year - 2018) * 2_000_000),
          },
        });
      }
    });

    it("May 2026 reporting (asOf 2026-05-31) shows the last 8 COMPLETED FYs: FY2018 → FY2025", async () => {
      const r = await getEquityHistory(clubDId, {
        asOf: new Date(Date.UTC(2026, 4, 31)),
        yearsBack: 8,
      });
      const labels = r.series.map((p) => p.fiscalYear);
      expect(labels).toEqual([
        "FY2018", "FY2019", "FY2020", "FY2021",
        "FY2022", "FY2023", "FY2024", "FY2025",
      ]);
    });

    it("January 2027 reporting (asOf 2027-01-15) rolls the window forward by one year: FY2019 → FY2026", async () => {
      // FY2026 ends 2026-12-31, which IS < 2027-01-15, so it now
      // qualifies as a completed fiscal year and joins the result set;
      // FY2018 drops off the back.
      const r = await getEquityHistory(clubDId, {
        asOf: new Date(Date.UTC(2027, 0, 15)),
        yearsBack: 8,
      });
      const labels = r.series.map((p) => p.fiscalYear);
      expect(labels).toEqual([
        "FY2019", "FY2020", "FY2021", "FY2022",
        "FY2023", "FY2024", "FY2025", "FY2026",
      ]);
    });

    it("formatEquityDashboard emits FY-ending years on the x-axis (no -1 shift)", () => {
      // The fyShort helper inside the formatter must return the FY
      // label's ending year directly (e.g. "FY2025" → "2025"), NOT
      // the prior calendar year. This is the user's display rule.
      const fakeHistory = {
        currentEquityCents: 3_100_000_000n,
        actualCagrBps: 738,
        bestInClassCagrBps: 550,
        minimumRequiredCagrBps: 350,
        series: [
          { fiscalYear: "FY2018", clubEquityCents: 1_883_000_000n,
            bestInClassBenchmarkCents: 1_883_000_000n,
            minimumRequiredBenchmarkCents: 1_883_000_000n },
          { fiscalYear: "FY2025", clubEquityCents: 3_100_000_000n,
            bestInClassBenchmarkCents: 2_739_000_000n,
            minimumRequiredBenchmarkCents: 2_396_000_000n },
        ],
        source: { perYear: [] },
      };
      const display = formatEquityDashboard(fakeHistory);
      expect(display.series[0].label).toBe("2018");
      expect(display.series[1].label).toBe("2025");
    });
  });

  describe("tenant isolation", () => {
    it("returns no equity data for a tenant without fiscal years (no cross-club leakage)", async () => {
      const result = await getEquityHistory(clubBId, {
        asOf: new Date(Date.UTC(2026, 4, 31)),
        yearsBack: 8,
      });
      expect(result.series).toHaveLength(0);
      expect(result.currentEquityCents).toBe(0n);
    });

    it("returns no equity data for a completely unknown club id", async () => {
      const result = await getEquityHistory("not-a-real-club", {
        asOf: new Date(Date.UTC(2026, 4, 31)),
        yearsBack: 8,
      });
      expect(result.series).toHaveLength(0);
    });
  });
});
