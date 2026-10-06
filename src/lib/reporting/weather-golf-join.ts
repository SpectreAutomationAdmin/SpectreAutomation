// GOLF-HIST-1 (2026-10-05) — Weather × Golf join resolver.
//
// Joins canonical Historical Weather (Open-Meteo, per-day
// classification) with canonical Historical Golf Activity (the
// `GolfActivityDay` table) on local calendar date, then aggregates
// into:
//
//   - Average Daily Rounds by Weather Condition (bar chart)
//   - Best / Worst condition by average rounds per day
//   - Period Average Rounds (weighted; real zero days participate
//     per the GOLF-HIST-1 directive)
//   - Rain-rounds Pearson correlation (reuses the EXISTING approved
//     formula from `monthly-weather-summary.ts`)
//
// Semantics:
//   - A day's weather condition comes from
//     `MonthlyWeatherObservation.dailyClassifications` (Open-Meteo
//     per-day classifier). Weather cache rows written before the
//     GOLF-HIST-1 extension may lack this field; in that case the
//     resolver returns `dailyClassificationsAvailable: false` and
//     the join cards fall back to UNAVAILABLE sentinels.
//   - Only days where BOTH weather classification AND Golf Activity
//     row are available participate in the aggregates. Real-zero
//     golf days DO participate (per directive); missing golf dates
//     DO NOT.

import { fetchObservation, resolveClubLocation, type ClubLike } from "@/lib/reporting/weather";
import type { MonthlyWeatherObservation } from "@/lib/reporting/weather";
import {
  resolveGolfActivity,
  type GolfActivitySummary,
  type GolfActivityDayView,
} from "@/lib/reporting/golf-activity-resolver";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";

export type WeatherCondition = "sunny" | "partly-cloudy" | "rain" | "high-wind";

export type WeatherGolfJoinDay = {
  dateISO: string;
  condition: WeatherCondition;
  totalRounds: number;
  memberRounds: number;
  guestRounds: number;
};

export type WeatherGolfByCondition = {
  [K in WeatherCondition]: {
    daysObserved: number;
    totalRounds: number;
    averageRoundsPerDay: number;
  };
};

export type WeatherGolfJoin = {
  periodStart: Date;
  periodEnd: Date;
  joined: WeatherGolfJoinDay[];
  byCondition: WeatherGolfByCondition;
  periodTotalRounds: number;
  periodDaysWithGolfData: number;
  periodAverageRoundsPerDay: number | null;
  bestCondition: WeatherCondition | null;
  worstCondition: WeatherCondition | null;
  rainRoundsCorrelation: number | null;
  // Availability signals — Section XI consults these to decide
  // between LIVE and UNAVAILABLE presentations.
  golfDataAvailable: boolean;
  golfDataSource: string | null;
  dailyClassificationsAvailable: boolean;
  weatherLocationLabel: string;
};

export type ResolveWeatherGolfJoinInput = {
  clubId: string;
  club: ClubLike;
  period: ReportingPeriod;
};

export async function resolveWeatherGolfJoin(
  input: ResolveWeatherGolfJoinInput,
): Promise<WeatherGolfJoin> {
  const { clubId, club, period } = input;
  const periodStart = new Date(Date.UTC(period.year, period.month - 1, 1));
  const periodEnd   = new Date(Date.UTC(period.year, period.month,     0));
  // Build the location independently so we can carry it into the
  // "no data" branch for a stable `weatherLocationLabel`.
  const resolvedLocation = resolveClubLocation(club);

  // -- 1. Golf side. -------------------------------------------------
  const golf = await resolveGolfActivity({ clubId, periodStart, periodEnd });

  // Short-circuit when golf data is absent.
  if (!golf.dataAvailable) {
    return emptyJoin({
      periodStart,
      periodEnd,
      locationLabel: resolvedLocation.label,
      golfDataAvailable: false,
      golfDataSource: null,
      dailyClassificationsAvailable: false,
    });
  }

  // -- 2. Weather side (reuses WEATHER-HIST-1 cache + fetch). --------
  const { location, observation } = await fetchObservation({
    club,
    clubId,
    period: { year: period.year, month: period.month, monthShort: period.monthShort },
  });

  const classifications = observation.dailyClassifications ?? [];
  if (classifications.length === 0) {
    // Cache row predates the GOLF-HIST-1 extension OR provider
    // returned no per-day data. Report the gap so Section XI falls
    // back to UNAVAILABLE sentinels on the join cards.
    return emptyJoin({
      periodStart,
      periodEnd,
      locationLabel: location.label,
      golfDataAvailable: true,
      golfDataSource: majoritySource(golf),
      dailyClassificationsAvailable: false,
    });
  }

  // -- 3. Join by local calendar date. -------------------------------
  const classByDate = new Map<string, WeatherCondition>(
    classifications.map((c) => [c.dateISO, c.condition]),
  );
  const joined: WeatherGolfJoinDay[] = [];
  for (const d of golf.days) {
    const cond = classByDate.get(d.dateISO);
    if (!cond) continue; // weather missing for this date
    joined.push({
      dateISO: d.dateISO,
      condition: cond,
      totalRounds: d.totalRounds,
      memberRounds: d.memberRounds,
      guestRounds: d.guestRounds,
    });
  }

  // -- 4. Aggregate by condition. -----------------------------------
  const byCondition = emptyByCondition();
  for (const j of joined) {
    const bucket = byCondition[j.condition];
    bucket.daysObserved += 1;
    bucket.totalRounds  += j.totalRounds;
  }
  for (const k of (Object.keys(byCondition) as WeatherCondition[])) {
    const b = byCondition[k];
    b.averageRoundsPerDay = b.daysObserved > 0 ? b.totalRounds / b.daysObserved : 0;
  }

  // Best / Worst — only among conditions that actually occurred.
  const occurring = (Object.keys(byCondition) as WeatherCondition[]).filter(
    (k) => byCondition[k].daysObserved > 0,
  );
  let bestCondition: WeatherCondition | null = null;
  let worstCondition: WeatherCondition | null = null;
  if (occurring.length > 0) {
    bestCondition  = occurring.reduce((a, b) =>
      byCondition[a].averageRoundsPerDay >= byCondition[b].averageRoundsPerDay ? a : b,
    );
    worstCondition = occurring.reduce((a, b) =>
      byCondition[a].averageRoundsPerDay <= byCondition[b].averageRoundsPerDay ? a : b,
    );
  }

  // Period aggregates.
  const periodTotalRounds = joined.reduce((s, j) => s + j.totalRounds, 0);
  const periodDaysWithGolfData = joined.length;
  const periodAverageRoundsPerDay = periodDaysWithGolfData > 0
    ? periodTotalRounds / periodDaysWithGolfData
    : null;

  // Rain-rounds Pearson correlation (same formula shape used by the
  // approved seed in monthly-weather-summary.ts).
  const rainRoundsCorrelation = computeRainRoundsCorrelation(byCondition);

  return {
    periodStart,
    periodEnd,
    joined,
    byCondition,
    periodTotalRounds,
    periodDaysWithGolfData,
    periodAverageRoundsPerDay,
    bestCondition,
    worstCondition,
    rainRoundsCorrelation,
    golfDataAvailable: true,
    golfDataSource: majoritySource(golf),
    dailyClassificationsAvailable: true,
    weatherLocationLabel: location.label,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyByCondition(): WeatherGolfByCondition {
  return {
    "sunny":         { daysObserved: 0, totalRounds: 0, averageRoundsPerDay: 0 },
    "partly-cloudy": { daysObserved: 0, totalRounds: 0, averageRoundsPerDay: 0 },
    "rain":          { daysObserved: 0, totalRounds: 0, averageRoundsPerDay: 0 },
    "high-wind":     { daysObserved: 0, totalRounds: 0, averageRoundsPerDay: 0 },
  };
}

function emptyJoin(opts: {
  periodStart: Date;
  periodEnd: Date;
  locationLabel: string;
  golfDataAvailable: boolean;
  golfDataSource: string | null;
  dailyClassificationsAvailable: boolean;
}): WeatherGolfJoin {
  return {
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    joined: [],
    byCondition: emptyByCondition(),
    periodTotalRounds: 0,
    periodDaysWithGolfData: 0,
    periodAverageRoundsPerDay: null,
    bestCondition: null,
    worstCondition: null,
    rainRoundsCorrelation: null,
    golfDataAvailable: opts.golfDataAvailable,
    golfDataSource: opts.golfDataSource,
    dailyClassificationsAvailable: opts.dailyClassificationsAvailable,
    weatherLocationLabel: opts.locationLabel,
  };
}

function majoritySource(golf: GolfActivitySummary): string | null {
  if (!golf.sourceSystems.length) return null;
  if (golf.sourceSystems.length === 1) return golf.sourceSystems[0];
  // Multiple sources in a period — pick the one with the most days.
  const tally = new Map<string, number>();
  for (const d of golf.days) tally.set(d.sourceSystem, (tally.get(d.sourceSystem) ?? 0) + 1);
  let best: string | null = null, bestCount = -1;
  for (const [k, v] of tally) if (v > bestCount) { best = k; bestCount = v; }
  return best;
}

/**
 * Pearson-ish correlation between the condition day-count vector and
 * the condition avg-rounds-per-day vector, inverted so RAIN
 * correlates negatively with rounds. Bounded to [-1, +1].
 *
 * This is the SAME formula shape as `rainRoundsCorrelation` in
 * `src/lib/reporting/monthly-weather-summary.ts` (the approved
 * Section XI seed) — kept identical so the live metric is directly
 * comparable to the seed presentation. Null when either variance is
 * zero (insufficient variation in the period).
 */
function computeRainRoundsCorrelation(byCondition: WeatherGolfByCondition): number | null {
  const dayCounts = [
    byCondition["sunny"].daysObserved,
    byCondition["partly-cloudy"].daysObserved,
    byCondition["high-wind"].daysObserved,
    byCondition["rain"].daysObserved,
  ];
  const rounds = [
    byCondition["sunny"].averageRoundsPerDay,
    byCondition["partly-cloudy"].averageRoundsPerDay,
    byCondition["high-wind"].averageRoundsPerDay,
    byCondition["rain"].averageRoundsPerDay,
  ];
  const n = dayCounts.length;
  const meanD = dayCounts.reduce((s, x) => s + x, 0) / n;
  const meanR = rounds.reduce((s, x) => s + x, 0) / n;
  let num = 0, sumD2 = 0, sumR2 = 0;
  for (let i = 0; i < n; i++) {
    const dd = dayCounts[i] - meanD;
    const dr = rounds[i] - meanR;
    num += dd * dr;
    sumD2 += dd * dd;
    sumR2 += dr * dr;
  }
  if (sumD2 === 0 || sumR2 === 0) return null;
  const r = num / Math.sqrt(sumD2 * sumR2);
  return Math.max(-1, Math.min(1, -r));
}
