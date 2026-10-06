// GOLF-HIST-1 (2026-10-05) — Weather × Golf join behaviour.
//
// Exercises the Section XI live builder's acceptance of the join
// output structure. No Prisma, no network.

import { describe, expect, it } from "vitest";

import {
  buildCouleeMonthlyWeatherSummary,
} from "@/lib/reporting/monthly-weather-summary";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";
import type { ClubLike, WeatherProvider } from "@/lib/reporting/weather";

// --- Minimal stub Weather provider so the builder doesn't contact
//     Open-Meteo / the seed. Returns a deterministic January
//     observation with 10 sunny + 10 partly-cloudy + 6 rain + 5
//     wind days.
const stubProvider: WeatherProvider = {
  id: "stub-weather",
  async fetchMonthly({ period }) {
    return {
      yearMonth: `${period.year}-${String(period.month).padStart(2, "0")}`,
      daysSunny: 10,
      daysPartlyCloudy: 10,
      daysRain: 6,
      daysHighWind: 5,
      avgHighTempF: 28,
      avgWindMph: 11,
      avgRoundsSunny: 0,       // ignored by live join path
      avgRoundsPartlyCloudy: 0,
      avgRoundsHighWind: 0,
      avgRoundsRain: 0,
      notableEvents: [],
      provenance: { source: "stub", precision: "coordinate" },
    };
  },
  async fetchCurrent() { return null; },
};

const CLUB: ClubLike = {
  name: "Test Club",
  profile: {
    latitude: 51.4636,
    longitude: -112.7208,
    city: "Drumheller",
    provinceState: "Alberta",
  },
};

const PERIOD = buildReportingPeriod(new Date(Date.UTC(2026, 0, 31)));

describe("GOLF-HIST-1 §1 — live-join activates the rounds-by-weather bars", () => {
  it("passes LIVE averageRounds to the chart when join is supplied + available", async () => {
    const summary = await buildCouleeMonthlyWeatherSummary({
      clubId: "club-test",
      clubName: "Test Club",
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
        bestCondition: "sunny",
        worstCondition: "rain",
        rainRoundsCorrelation: -0.68,
        byCondition: {
          "sunny":         { daysObserved: 10, totalRounds: 170, averageRoundsPerDay: 17 },
          "partly-cloudy": { daysObserved: 10, totalRounds: 150, averageRoundsPerDay: 15 },
          "rain":          { daysObserved:  6, totalRounds:  48, averageRoundsPerDay:  8 },
          "high-wind":     { daysObserved:  5, totalRounds:  33, averageRoundsPerDay:  6.6 },
        },
      },
    });

    const bars = summary.roundsCard.bars;
    const sunny = bars.find((b) => b.key === "sunny-clear")!;
    const partly = bars.find((b) => b.key === "partly-cloudy")!;
    const windy = bars.find((b) => b.key === "high-wind")!;
    const rain = bars.find((b) => b.key === "rain-storm")!;
    expect(sunny.averageRounds).toBe(17);
    expect(partly.averageRounds).toBe(15);
    expect(windy.averageRounds).toBe(7);  // round(6.6)
    expect(rain.averageRounds).toBe(8);

    expect(summary.roundsCard.insight).toMatch(/Live Golf Activity/);
    expect(summary.roundsCard.insight).toMatch(/401 rounds/);
    expect(summary.roundsCard.insight).toMatch(/31 day/);

    // Golf correlation card is LIVE.
    const golf = summary.correlationSummary.cards.find((c) => c.key === "golf-rounds")!;
    expect(golf.narrative).toMatch(/Live Weather × Golf join/);
    expect(golf.dataPoint.value).toMatch(/-0\.68/);
  });

  it("falls back to UNAVAILABLE sentinel when join is omitted", async () => {
    const summary = await buildCouleeMonthlyWeatherSummary({
      clubId: "club-test",
      clubName: "Test Club",
      club: CLUB,
      period: PERIOD,
      provider: stubProvider,
      // No weatherGolfJoin — simulates pre-import state.
    });
    for (const bar of summary.roundsCard.bars) {
      expect(bar.averageRounds).toBe(0);
    }
    expect(summary.roundsCard.insight).toMatch(/Golf Activity source not yet connected/i);
    const golf = summary.correlationSummary.cards.find((c) => c.key === "golf-rounds")!;
    expect(golf.narrative).toMatch(/Correlation analysis unavailable/);
    expect(golf.dataPoint.value).toBe("—");
  });

  it("falls back to UNAVAILABLE sentinel when golf data is available but classifications aren't", async () => {
    const summary = await buildCouleeMonthlyWeatherSummary({
      clubId: "club-test",
      clubName: "Test Club",
      club: CLUB,
      period: PERIOD,
      provider: stubProvider,
      weatherGolfJoin: {
        golfDataAvailable: true,
        dailyClassificationsAvailable: false,  // weather cache lacks per-day data
        golfDataSource: "GGGOLF_EXPORT",
        periodTotalRounds: 401,
        periodDaysWithGolfData: 31,
        periodAverageRoundsPerDay: 401 / 31,
        bestCondition: null,
        worstCondition: null,
        rainRoundsCorrelation: null,
        byCondition: {
          "sunny":         { daysObserved: 0, totalRounds: 0, averageRoundsPerDay: 0 },
          "partly-cloudy": { daysObserved: 0, totalRounds: 0, averageRoundsPerDay: 0 },
          "rain":          { daysObserved: 0, totalRounds: 0, averageRoundsPerDay: 0 },
          "high-wind":     { daysObserved: 0, totalRounds: 0, averageRoundsPerDay: 0 },
        },
      },
    });
    for (const bar of summary.roundsCard.bars) {
      expect(bar.averageRounds).toBe(0);
    }
    expect(summary.roundsCard.insight).toMatch(/per-day weather classification is not yet available/i);
  });
});

describe("GOLF-HIST-1 §2 — Racquet + Dining UNAVAILABLE regardless of golf state", () => {
  it("racquet + dining cards keep their UNAVAILABLE narratives in LIVE golf mode", async () => {
    const summary = await buildCouleeMonthlyWeatherSummary({
      clubId: "club-test",
      clubName: "Test Club",
      club: CLUB,
      period: PERIOD,
      provider: stubProvider,
      weatherGolfJoin: {
        golfDataAvailable: true,
        dailyClassificationsAvailable: true,
        golfDataSource: "GGGOLF_EXPORT",
        periodTotalRounds: 401,
        periodDaysWithGolfData: 31,
        periodAverageRoundsPerDay: 12.9,
        bestCondition: "sunny",
        worstCondition: "rain",
        rainRoundsCorrelation: -0.7,
        byCondition: {
          "sunny":         { daysObserved: 10, totalRounds: 170, averageRoundsPerDay: 17 },
          "partly-cloudy": { daysObserved: 10, totalRounds: 150, averageRoundsPerDay: 15 },
          "rain":          { daysObserved:  6, totalRounds:  48, averageRoundsPerDay:  8 },
          "high-wind":     { daysObserved:  5, totalRounds:  33, averageRoundsPerDay:  6.6 },
        },
      },
    });
    const racquet = summary.correlationSummary.cards.find((c) => c.key === "tennis-racquet")!;
    const dining  = summary.correlationSummary.cards.find((c) => c.key === "dining-fb")!;
    expect(racquet.narrative).toMatch(/Racquet booking source[\s\S]*?not yet connected/i);
    expect(dining.narrative).toMatch(/POS source not yet connected/i);
  });
});

describe("GOLF-HIST-1 §3 — dataSource remains 'live' regardless of golf availability", () => {
  it("Section XI emits dataSource:'live' even when golf is unavailable", async () => {
    const summary = await buildCouleeMonthlyWeatherSummary({
      clubId: "club-test",
      clubName: "Test Club",
      club: CLUB,
      period: PERIOD,
      provider: stubProvider,
    });
    expect(summary.dataSource).toBe("live");
  });
});
