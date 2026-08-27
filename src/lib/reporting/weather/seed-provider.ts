// Seed weather provider — the default data source for the Monthly
// Weather Summary chapter when no external provider is configured.
//
// Calibrated for Silver Springs Golf & Country Club at the NW Calgary
// location. May reads as a spring shoulder month (warming up,
// occasional rain, some windy days) — NEVER desert / Scottsdale
// assumptions. Service uses the same shape every concrete provider
// returns so the panel never sees the data source.

import type {
  CurrentWeatherCondition,
  CurrentWeatherObservation,
  MonthlyWeatherObservation,
  NormalisedWeatherEvent,
  WeatherLocation,
  WeatherProvider,
} from "./types";

/** Day-count distribution for a single month. Sums to the actual
 *  day count of the month. */
type MonthDayCounts = {
  daysSunny: number;
  daysPartlyCloudy: number;
  daysRain: number;
  daysHighWind: number;
};

/** Climate facets for a single month. */
type MonthClimate = {
  avgHighTempF: number;
  avgWindMph: number;
};

/** Distribution + climate calibrated by month for NW Calgary
 *  (1-indexed: 1 = January, 12 = December). Numbers are realistic
 *  for the Bow River valley — not desert, not the East Coast, not
 *  the UK. */
const NW_CALGARY_BY_MONTH: Record<number, MonthDayCounts & MonthClimate> = {
  1:  { daysSunny: 10, daysPartlyCloudy: 11, daysRain: 6,  daysHighWind: 4, avgHighTempF: 30, avgWindMph: 13 },
  2:  { daysSunny: 11, daysPartlyCloudy: 10, daysRain: 5,  daysHighWind: 2, avgHighTempF: 34, avgWindMph: 12 },
  3:  { daysSunny: 14, daysPartlyCloudy: 9,  daysRain: 6,  daysHighWind: 2, avgHighTempF: 42, avgWindMph: 13 },
  4:  { daysSunny: 15, daysPartlyCloudy: 8,  daysRain: 5,  daysHighWind: 2, avgHighTempF: 54, avgWindMph: 13 },
  5:  { daysSunny: 17, daysPartlyCloudy: 7,  daysRain: 5,  daysHighWind: 2, avgHighTempF: 65, avgWindMph: 11 },
  6:  { daysSunny: 16, daysPartlyCloudy: 8,  daysRain: 5,  daysHighWind: 1, avgHighTempF: 72, avgWindMph: 10 },
  7:  { daysSunny: 19, daysPartlyCloudy: 8,  daysRain: 3,  daysHighWind: 1, avgHighTempF: 79, avgWindMph: 10 },
  8:  { daysSunny: 19, daysPartlyCloudy: 8,  daysRain: 3,  daysHighWind: 1, avgHighTempF: 77, avgWindMph: 10 },
  9:  { daysSunny: 17, daysPartlyCloudy: 8,  daysRain: 3,  daysHighWind: 2, avgHighTempF: 67, avgWindMph: 11 },
  10: { daysSunny: 16, daysPartlyCloudy: 9,  daysRain: 4,  daysHighWind: 2, avgHighTempF: 55, avgWindMph: 11 },
  11: { daysSunny: 12, daysPartlyCloudy: 10, daysRain: 6,  daysHighWind: 2, avgHighTempF: 39, avgWindMph: 12 },
  12: { daysSunny: 11, daysPartlyCloudy: 10, daysRain: 7,  daysHighWind: 3, avgHighTempF: 30, avgWindMph: 13 },
};

/** Average daily rounds played by weather condition for a typical
 *  Silver Springs day. Numbers will be replaced by live tee-sheet
 *  data once the integration lands. */
const AVG_ROUNDS_BY_CONDITION = {
  sunny:        142,
  partlyCloudy: 118,
  highWind:      64,
  rain:          28,
} as const;

function daysInMonthForPeriod(year: number, month: number): number {
  // Last day of the month — month is 1-indexed; passing day 0 of the
  // next month yields the last day of the current month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildNotableEvents(monthShort: string): ReadonlyArray<NormalisedWeatherEvent> {
  // Calgary-plausible May-shape events. Date labels flow from the
  // provided `monthShort` so a re-rolled period continues to read
  // correctly without per-period seed authoring.
  return [
    {
      key: "cold-frost-early",
      dateLabel: `${monthShort} 3`,
      kind: "cold-frost",
      pillLabel: "Cold / Frost",
      description: "Overnight low 28°F. Morning frost delay until 9:15 AM.",
      golfImpactLabel: "Tee sheet delayed 1.5 hrs",
      golfImpactTone: "risk",
      fbImpactLabel: "+12% breakfast covers",
      fbImpactTone: "favorable",
      followUpLabel: "Frost protocol confirmed",
    },
    {
      key: "heavy-rain-mid",
      dateLabel: `${monthShort} 11–12`,
      kind: "heavy-rain",
      pillLabel: "Heavy Rain",
      description: "1.4\" rain over 2 days. NE winds 14–18 mph. Cart paths only restriction.",
      golfImpactLabel: "−62% rounds vs. avg",
      golfImpactTone: "risk",
      fbImpactLabel: "+22% dining covers",
      fbImpactTone: "favorable",
      followUpLabel: "Drainage walk-through",
    },
    {
      key: "prime-stretch-late",
      dateLabel: `${monthShort} 18–24`,
      kind: "prime-conditions",
      pillLabel: "Prime Conditions",
      description: "7-day stretch of ideal spring conditions. 64–72°F, winds under 8 mph, dry.",
      golfImpactLabel: `+28% vs. ${monthShort} avg`,
      golfImpactTone: "favorable",
      fbImpactLabel: `+18% vs. ${monthShort} avg`,
      fbImpactTone: "favorable",
      followUpLabel: "Peak staffing aligned",
    },
    {
      key: "high-wind-end",
      dateLabel: `${monthShort} 29`,
      kind: "high-wind",
      pillLabel: "High Wind",
      description: "Sustained winds 24 mph, gusts to 36 mph. Cart restriction issued.",
      golfImpactLabel: "−54% rounds vs. avg",
      golfImpactTone: "risk",
      fbImpactLabel: "+9% dining covers",
      fbImpactTone: "favorable",
      followUpLabel: "No action required",
    },
  ];
}

/** Returns the seed-provider monthly observation for any month, with
 *  the day distribution scaled to the actual day count of that month
 *  so the donut always sums correctly. */
function buildSeedObservation(input: {
  location: WeatherLocation;
  period: { year: number; month: number; monthShort: string };
}): MonthlyWeatherObservation {
  const { year, month, monthShort } = input.period;
  const climate = NW_CALGARY_BY_MONTH[month] ?? NW_CALGARY_BY_MONTH[5];
  const actualDayCount = daysInMonthForPeriod(year, month);
  // Re-balance day counts to the actual month length (rounding
  // residues land on the sunny bucket — the dominant condition).
  const baseTotal = climate.daysSunny + climate.daysPartlyCloudy + climate.daysRain + climate.daysHighWind;
  const scale = actualDayCount / baseTotal;
  let scaledSunny  = Math.round(climate.daysSunny * scale);
  const scaledPartly = Math.round(climate.daysPartlyCloudy * scale);
  const scaledRain   = Math.round(climate.daysRain * scale);
  const scaledWind   = Math.round(climate.daysHighWind * scale);
  const scaledTotal  = scaledSunny + scaledPartly + scaledRain + scaledWind;
  scaledSunny += actualDayCount - scaledTotal;

  return {
    yearMonth: `${year}-${String(month).padStart(2, "0")}`,
    daysSunny: scaledSunny,
    daysPartlyCloudy: scaledPartly,
    daysRain: scaledRain,
    daysHighWind: scaledWind,
    avgHighTempF: climate.avgHighTempF,
    avgWindMph: climate.avgWindMph,
    avgRoundsSunny:        AVG_ROUNDS_BY_CONDITION.sunny,
    avgRoundsPartlyCloudy: AVG_ROUNDS_BY_CONDITION.partlyCloudy,
    avgRoundsHighWind:     AVG_ROUNDS_BY_CONDITION.highWind,
    avgRoundsRain:         AVG_ROUNDS_BY_CONDITION.rain,
    notableEvents: buildNotableEvents(monthShort),
    provenance: {
      source: "seed-nw-calgary",
      precision: "seed",
      attribution: "Seeded NW Calgary climate model — replaced by live provider once tee-sheet + Open-Meteo integration ships.",
      queriedLatitude: input.location.latitude ?? undefined,
      queriedLongitude: input.location.longitude ?? undefined,
    },
  };
}

/**
 * Deterministic seed for `fetchCurrent`. Chooses a plausible
 * condition + temperature for the current server month so the
 * portal weather pill is never empty when the primary provider
 * is unreachable. Callers see the same shape as the live provider.
 */
function buildSeedCurrent(location: WeatherLocation): CurrentWeatherObservation {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const climate = NW_CALGARY_BY_MONTH[month] ?? NW_CALGARY_BY_MONTH[5];
  // Prefer the tenant's presentation unit. Climate seeds are in °F;
  // convert to °C when the club is metric so consumers don't have
  // to branch.
  const temperatureF = climate.avgHighTempF;
  const temperature =
    location.temperatureUnit === "C"
      ? Math.round(((temperatureF - 32) * 5) / 9)
      : temperatureF;
  const hour = now.getUTCHours();
  const isDay = hour >= 12 && hour < 26; // Loose UTC-based day/night for the seed
  // Pick a plausible condition proportional to the month's day counts.
  const total = climate.daysSunny + climate.daysPartlyCloudy + climate.daysRain + climate.daysHighWind;
  const dayOfMonth = now.getUTCDate();
  const pick = ((dayOfMonth * 7) % total) + 1;
  let condition: CurrentWeatherCondition;
  if (pick <= climate.daysSunny) condition = "clear";
  else if (pick <= climate.daysSunny + climate.daysPartlyCloudy) condition = "partly-cloudy";
  else if (pick <= climate.daysSunny + climate.daysPartlyCloudy + climate.daysRain) condition = "rain";
  else condition = "cloudy";
  return {
    observedAt: now.toISOString(),
    temperature,
    temperatureUnit: location.temperatureUnit,
    condition,
    isDay,
    windMph: climate.avgWindMph,
    locationLabel: location.city,
    provenance: {
      source: "seed-current",
      precision: "seed",
      attribution:
        "Seeded current conditions — used when the live Open-Meteo provider is unreachable.",
      queriedLatitude: location.latitude ?? undefined,
      queriedLongitude: location.longitude ?? undefined,
    },
  };
}

export const seedWeatherProvider: WeatherProvider = {
  id: "seed",
  async fetchMonthly(input) {
    return buildSeedObservation(input);
  },
  async fetchCurrent(input) {
    return buildSeedCurrent(input.location);
  },
};
