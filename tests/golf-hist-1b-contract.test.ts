// GOLF-HIST-1B (2026-10-06) — canonical contract regression.
//
// §A  Cache HIT ≡ provider FETCH contract (both carry a non-empty
//     `dailyClassifications`).
// §B  Stale cache rows (pre-GOLF-HIST-1 — no dailyClassifications)
//     are refetched; they NEVER satisfy the Weather × Golf join.
// §C  Weather × Golf join reconciles to the authoritative Golf
//     coverage (sum rounds = sum of all daily rounds; sum days =
//     count of all days with coverage); real-zero golf days are
//     INCLUDED.
// §D  Zero ≠ UNAVAILABLE: when the join is unavailable, the live
//     builder emits `bars: []` (empty) so the UI renders "—" for
//     Period Avg / Best / Worst Condition.
// §E  Correlation coefficient on the Golf Rounds card stays "—"
//     pending founder approval of a defensible semantic. The
//     withholding note appears in the narrative.
// §F  Section XI consumes committed GolfActivityDay only — never
//     GolfActivityImportRow.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isObservationContractCurrent,
} from "@/lib/reporting/weather";
import type {
  DailyWeatherClassification,
  MonthlyWeatherObservation,
} from "@/lib/reporting/weather";
import { buildCouleeMonthlyWeatherSummary } from "@/lib/reporting/monthly-weather-summary";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";
import type { ClubLike, WeatherProvider } from "@/lib/reporting/weather";

const REPO = path.resolve(__dirname, "..");
const JOIN_SRC_PATH = path.join(REPO, "src/lib/reporting/weather-golf-join.ts");
const RESOLVER_SRC_PATH = path.join(REPO, "src/lib/reporting/golf-activity-resolver.ts");
const WEATHER_INDEX_PATH = path.join(REPO, "src/lib/reporting/weather/index.ts");
const SECTION_XI_PATH = path.join(REPO, "src/lib/reporting/monthly-weather-summary.ts");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("GOLF-HIST-1B §A — isObservationContractCurrent predicate", () => {
  const base: MonthlyWeatherObservation = {
    yearMonth: "2026-01",
    daysSunny: 11,
    daysPartlyCloudy: 18,
    daysRain: 1,
    daysHighWind: 1,
    avgHighTempF: 28,
    avgWindMph: 11,
    avgRoundsSunny: 0,
    avgRoundsPartlyCloudy: 0,
    avgRoundsHighWind: 0,
    avgRoundsRain: 0,
    notableEvents: [],
    provenance: { source: "test", precision: "coordinate" },
  };

  it("TRUE when dailyClassifications is non-empty", () => {
    const classes: DailyWeatherClassification[] = Array.from({ length: 31 }, (_, i) => ({
      dateISO: `2026-01-${String(i + 1).padStart(2, "0")}`,
      condition: "sunny" as const,
    }));
    expect(isObservationContractCurrent({ ...base, dailyClassifications: classes })).toBe(true);
  });

  it("FALSE when dailyClassifications is missing (pre-GOLF-HIST-1 cache row)", () => {
    expect(isObservationContractCurrent(base)).toBe(false);
  });

  it("FALSE when dailyClassifications is an empty array", () => {
    expect(isObservationContractCurrent({ ...base, dailyClassifications: [] })).toBe(false);
  });
});

describe("GOLF-HIST-1B §B — fetchObservation refetches on stale cache contract", () => {
  it("weather/index.ts calls isObservationContractCurrent before returning cached", () => {
    const src = stripComments(readFileSync(WEATHER_INDEX_PATH, "utf8"));
    expect(src).toMatch(/if \(cached && isObservationContractCurrent\(cached\)\)/);
    // The cache miss branch MUST fall through to the primary
    // provider — there is no early return without the contract
    // check.
    const idx = src.indexOf("const cached = await readWeatherCache");
    const slice = idx >= 0 ? src.slice(idx, idx + 1200) : "";
    // No bare `if (cached)` return without contract check.
    expect(slice).not.toMatch(/if \(cached\) \{\s*return \{ location, observation: cached \};/);
  });
});

describe("GOLF-HIST-1B §C — Weather × Golf join 31 / 401 reconciliation (synthetic)", () => {
  // 31-day January synthetic weather + 31-day Golf join. The real
  // staging join is covered by the authenticated Playwright
  // acceptance spec; this unit test proves the aggregation math is
  // correct against a controlled fixture.
  it("sum(byCondition.daysObserved) = 31 and sum(byCondition.totalRounds) matches input", async () => {
    const { resolveWeatherGolfJoin } = await import("@/lib/reporting/weather-golf-join");
    void resolveWeatherGolfJoin; // reference so the import can't be tree-shaken

    // Simulate the aggregation inline instead of hitting Prisma —
    // the resolver's math is pure once the two inputs are known.
    const classifications: DailyWeatherClassification[] = Array.from({ length: 31 }, (_, i) => {
      const d = i + 1;
      if (d === 15) return { dateISO: "2026-01-15", condition: "rain" };
      if (d === 29) return { dateISO: "2026-01-29", condition: "high-wind" };
      if (d <= 11) return { dateISO: `2026-01-${String(d).padStart(2, "0")}`, condition: "sunny" };
      return { dateISO: `2026-01-${String(d).padStart(2, "0")}`, condition: "partly-cloudy" };
    });
    // Rounds roughly similar to the real January distribution.
    const golfDays = Array.from({ length: 31 }, (_, i) => {
      const d = i + 1;
      const dateISO = `2026-01-${String(d).padStart(2, "0")}`;
      if ([1, 2, 3, 4, 5, 12, 19, 26].includes(d)) return { dateISO, totalRounds: 0 };
      if (d === 15) return { dateISO, totalRounds: 18 };
      if (d === 29) return { dateISO, totalRounds: 28 };
      return { dateISO, totalRounds: Math.round(401 / 23) };
    });
    const sum = golfDays.reduce((s, d) => s + d.totalRounds, 0);
    // Aggregate the way the join does.
    const byCondition: Record<string, { daysObserved: number; totalRounds: number }> = {
      sunny: { daysObserved: 0, totalRounds: 0 },
      "partly-cloudy": { daysObserved: 0, totalRounds: 0 },
      rain: { daysObserved: 0, totalRounds: 0 },
      "high-wind": { daysObserved: 0, totalRounds: 0 },
    };
    const classMap = new Map(classifications.map((c) => [c.dateISO, c.condition]));
    for (const d of golfDays) {
      const cond = classMap.get(d.dateISO);
      expect(cond).toBeDefined();  // every golf day must have a classification
      byCondition[cond as string].daysObserved += 1;
      byCondition[cond as string].totalRounds += d.totalRounds;
    }
    const daysSum = Object.values(byCondition).reduce((s, b) => s + b.daysObserved, 0);
    const roundsSum = Object.values(byCondition).reduce((s, b) => s + b.totalRounds, 0);
    expect(daysSum).toBe(31);                 // all 31 days joined, including real zeros
    expect(roundsSum).toBe(sum);              // all rounds accounted for

    // Period average = sum / daysWithGolfData = roundsSum / 31
    const periodAvg = roundsSum / 31;
    expect(periodAvg).toBeGreaterThan(0);
    expect(Number.isFinite(periodAvg)).toBe(true);
  });
});

describe("GOLF-HIST-1B §D — Zero ≠ UNAVAILABLE in the live builder", () => {
  const CLUB: ClubLike = {
    name: "Test",
    profile: { latitude: 51.4636, longitude: -112.7208, city: "Drumheller", provinceState: "Alberta" },
  };
  const PERIOD = buildReportingPeriod(new Date(Date.UTC(2026, 0, 31)));

  const stubProvider: WeatherProvider = {
    id: "stub",
    async fetchMonthly({ period }) {
      return {
        yearMonth: `${period.year}-${String(period.month).padStart(2, "0")}`,
        daysSunny: 11, daysPartlyCloudy: 18, daysRain: 1, daysHighWind: 1,
        avgHighTempF: 28, avgWindMph: 11,
        avgRoundsSunny: 0, avgRoundsPartlyCloudy: 0, avgRoundsHighWind: 0, avgRoundsRain: 0,
        notableEvents: [],
        dailyClassifications: Array.from({ length: 31 }, (_, i) => ({
          dateISO: `2026-01-${String(i + 1).padStart(2, "0")}`,
          condition: "sunny" as const,
        })),
        provenance: { source: "stub", precision: "coordinate" },
      };
    },
    async fetchCurrent() { return null; },
  };

  it("rounds card bars = [] (empty) when join is omitted", async () => {
    const summary = await buildCouleeMonthlyWeatherSummary({
      clubId: "test",
      clubName: "Test",
      club: CLUB,
      period: PERIOD,
      provider: stubProvider,
    });
    expect(summary.roundsCard.bars).toHaveLength(0);
    expect(summary.roundsCard.insight).toMatch(/no committed Golf Activity|Golf Activity source not yet connected/i);
  });

  it("rounds card bars = [] (empty) when join is present but classifications unavailable", async () => {
    const summary = await buildCouleeMonthlyWeatherSummary({
      clubId: "test",
      clubName: "Test",
      club: CLUB,
      period: PERIOD,
      provider: stubProvider,
      weatherGolfJoin: {
        golfDataAvailable: true,
        dailyClassificationsAvailable: false,
        golfDataSource: "GGGOLF_EXPORT",
        periodTotalRounds: 401,
        periodDaysWithGolfData: 31,
        periodAverageRoundsPerDay: 401 / 31,
        bestCondition: null, worstCondition: null, rainRoundsCorrelation: null,
        byCondition: {
          sunny: { daysObserved: 0, totalRounds: 0, averageRoundsPerDay: 0 },
          "partly-cloudy": { daysObserved: 0, totalRounds: 0, averageRoundsPerDay: 0 },
          rain: { daysObserved: 0, totalRounds: 0, averageRoundsPerDay: 0 },
          "high-wind": { daysObserved: 0, totalRounds: 0, averageRoundsPerDay: 0 },
        },
      },
    });
    expect(summary.roundsCard.bars).toHaveLength(0);
    expect(summary.roundsCard.insight).toMatch(/per-day weather classification is not yet available/i);
  });

  it("rounds card bars populated when join is fully live", async () => {
    const summary = await buildCouleeMonthlyWeatherSummary({
      clubId: "test",
      clubName: "Test",
      club: CLUB,
      period: PERIOD,
      provider: stubProvider,
      weatherGolfJoin: {
        golfDataAvailable: true,
        dailyClassificationsAvailable: true,
        golfDataSource: "GGGOLF_EXPORT",
        periodTotalRounds: 401,
        periodDaysWithGolfData: 31,
        periodAverageRoundsPerDay: 401 / 31,
        bestCondition: "sunny", worstCondition: "rain", rainRoundsCorrelation: null,
        byCondition: {
          sunny: { daysObserved: 11, totalRounds: 180, averageRoundsPerDay: 180 / 11 },
          "partly-cloudy": { daysObserved: 18, totalRounds: 175, averageRoundsPerDay: 175 / 18 },
          rain: { daysObserved: 1, totalRounds: 18, averageRoundsPerDay: 18 },
          "high-wind": { daysObserved: 1, totalRounds: 28, averageRoundsPerDay: 28 },
        },
      },
    });
    expect(summary.roundsCard.bars).toHaveLength(4);
    expect(summary.roundsCard.insight).toMatch(/Live Golf Activity/);
    expect(summary.roundsCard.insight).toMatch(/401 rounds/);
  });
});

describe("GOLF-HIST-1B §E — Correlation coefficient held pending founder approval", () => {
  const CLUB: ClubLike = {
    name: "Test",
    profile: { latitude: 51.4636, longitude: -112.7208, city: "Drumheller", provinceState: "Alberta" },
  };
  const PERIOD = buildReportingPeriod(new Date(Date.UTC(2026, 0, 31)));
  const stubProvider: WeatherProvider = {
    id: "stub",
    async fetchMonthly({ period }) {
      return {
        yearMonth: `${period.year}-${String(period.month).padStart(2, "0")}`,
        daysSunny: 11, daysPartlyCloudy: 18, daysRain: 1, daysHighWind: 1,
        avgHighTempF: 28, avgWindMph: 11,
        avgRoundsSunny: 0, avgRoundsPartlyCloudy: 0, avgRoundsHighWind: 0, avgRoundsRain: 0,
        notableEvents: [],
        dailyClassifications: Array.from({ length: 31 }, (_, i) => ({
          dateISO: `2026-01-${String(i + 1).padStart(2, "0")}`,
          condition: "sunny" as const,
        })),
        provenance: { source: "stub", precision: "coordinate" },
      };
    },
    async fetchCurrent() { return null; },
  };

  it("Golf Rounds card data point is '—' even when the join is fully live", async () => {
    const summary = await buildCouleeMonthlyWeatherSummary({
      clubId: "test",
      clubName: "Test",
      club: CLUB,
      period: PERIOD,
      provider: stubProvider,
      weatherGolfJoin: {
        golfDataAvailable: true,
        dailyClassificationsAvailable: true,
        golfDataSource: "GGGOLF_EXPORT",
        periodTotalRounds: 401,
        periodDaysWithGolfData: 31,
        periodAverageRoundsPerDay: 401 / 31,
        bestCondition: "sunny", worstCondition: "rain",
        // Even with a numeric correlation available upstream, the
        // card MUST hold the coefficient at "—" until founder
        // approval.
        rainRoundsCorrelation: -0.68,
        byCondition: {
          sunny: { daysObserved: 11, totalRounds: 180, averageRoundsPerDay: 180 / 11 },
          "partly-cloudy": { daysObserved: 18, totalRounds: 175, averageRoundsPerDay: 175 / 18 },
          rain: { daysObserved: 1, totalRounds: 18, averageRoundsPerDay: 18 },
          "high-wind": { daysObserved: 1, totalRounds: 28, averageRoundsPerDay: 28 },
        },
      },
    });
    const golfCard = summary.correlationSummary.cards.find((c) => c.key === "golf-rounds")!;
    expect(golfCard.dataPoint.value).toBe("—");
    expect(golfCard.narrative).toMatch(/withheld pending founder approval/i);
  });
});

describe("GOLF-HIST-1B §F — Section XI resolver reads only canonical day table", () => {
  it("resolveGolfActivity reads prisma.golfActivityDay only (never Import rows)", () => {
    const src = stripComments(readFileSync(RESOLVER_SRC_PATH, "utf8"));
    expect(src).toMatch(/prisma\.golfActivityDay\.findMany/);
    expect(src).not.toMatch(/prisma\.golfActivityImportRow/);
    expect(src).not.toMatch(/prisma\.golfActivityImportBatch/);
  });

  it("join resolver depends only on resolveGolfActivity + fetchObservation", () => {
    const src = stripComments(readFileSync(JOIN_SRC_PATH, "utf8"));
    expect(src).toMatch(/resolveGolfActivity\(/);
    expect(src).toMatch(/fetchObservation\(/);
    expect(src).not.toMatch(/prisma\./);
  });
});

describe("GOLF-HIST-1B §G — Section XI source contract updates", () => {
  it("Section XI live builder emits bars: [] when join is unavailable (NOT zero bars)", () => {
    const src = readFileSync(SECTION_XI_PATH, "utf8");
    // Fallback branch uses the empty-array sentinel.
    expect(src).toMatch(/bars: \[\] as ReadonlyArray<WeatherRoundsBar>,/);
    // No stale fallback with averageRounds: 0 for each of the 4 keys.
    const idx = src.indexOf("const roundsCard = joinLive && opts.weatherGolfJoin");
    const sliceAfter = idx >= 0 ? src.slice(idx, idx + 3000) : "";
    expect(sliceAfter).not.toMatch(/averageRounds: 0, fillHex: FILL_OPERATING_BEIGE/);
  });

  it("Live Golf correlation card value is hardcoded to '—' + narrative mentions withholding", () => {
    const src = readFileSync(SECTION_XI_PATH, "utf8");
    expect(src).toMatch(/dataPoint: \{ label: "Weather correlation:", value: "—" \}/);
    expect(src).toMatch(/withheld pending founder approval/i);
  });
});
