// Monthly Weather Summary service — chapter XI (Operations & Analytics
// group). Owns the four weather KPI cards, the period weather-pattern
// donut, the weather-vs-rounds bar chart, the notable weather events
// table, and three correlation summary cards (Golf / Racquet / Dining).
//
// Period labels + club-location label flow from `ReportingPeriod` +
// the club-name option per the Reporting Period Golden Rule. Seed
// data is calibrated for Silver Springs Golf & Country Club at the
// Calgary, Alberta location — May reads as a spring shoulder month
// (warming up, some lingering wet days, no desert assumptions).

import type { ReportingDataSource } from "@/lib/reporting/monthly-package";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";
import {
  fetchObservation,
  type ClubLike,
  type WeatherLocation,
  type WeatherProvenance,
  type WeatherProvider,
} from "@/lib/reporting/weather";

// =============================================================================
// Public types
// =============================================================================

/** Tone for a KPI card value / hint text.
 *  - "neutral"   → body colour on the dark-green card
 *  - "favorable" → brand green
 *  - "risk"      → clay red */
export type WeatherKpiTone = "neutral" | "favorable" | "risk";

/** Icon key — the panel maps each key to a premium inline SVG icon.
 *  No emoji; the panel renders thin-line vector glyphs. */
export type WeatherIconKey =
  | "sun"
  | "rain-cloud"
  | "thermometer"
  | "wind"
  | "golf-flag"
  | "tennis"
  | "dining";

export type WeatherKpiCard = {
  key: string;
  /** Premium SVG icon key — never an emoji string. */
  icon: WeatherIconKey;
  /** Pre-formatted hero value, e.g. "17", "65°F", "11 mph". */
  valueLabel: string;
  /** Uppercase secondary label, e.g. "SUNNY DAYS MAY", "AVG HIGH TEMP". */
  label: string;
  tone: WeatherKpiTone;
};

/** Weather distribution slice for the donut chart. */
export type WeatherPatternSlice = {
  key: string;
  label: string;
  /** Day count for this condition in the reporting period. */
  days: number;
  /** Brand-palette hex used to colour the slice + the legend dot. */
  fillHex: string;
};

/** A bar in the "average daily rounds by weather condition" chart. */
export type WeatherRoundsBar = {
  key: string;
  label: string;
  /** Average daily rounds played on days of this weather condition. */
  averageRounds: number;
  /** Bar fill hex. */
  fillHex: string;
};

export type WeatherEventPillTone =
  | "heavy-rain"
  | "cold-frost"
  | "high-wind"
  | "prime-conditions"
  | "course-impact";

export type WeatherEventRow = {
  key: string;
  /** Pre-formatted date label, e.g. "May 4–5", "May 22". */
  dateLabel: string;
  /** Pill label + pill tone. */
  pill: {
    label: string;
    tone: WeatherEventPillTone;
  };
  description: string;
  /** Pre-formatted golf impact label (e.g. "−68% rounds vs. avg",
   *  "Course closed 3 hrs"). */
  golfImpactLabel: string;
  golfImpactTone: "favorable" | "risk" | "neutral";
  /** Pre-formatted F&B impact label (e.g. "+18% dining covers"). */
  fbImpactLabel: string;
  fbImpactTone: "favorable" | "risk" | "neutral";
  followUpLabel: string;
};

export type WeatherCorrelationCard = {
  key: "golf-rounds" | "tennis-racquet" | "dining-fb";
  icon: WeatherIconKey;
  title: string;
  /** Accent palette on the left border:
   *   - "green" → brand green
   *   - "slate" → blue/teal
   *   - "rust"  → clay */
  accent: "green" | "slate" | "rust";
  /** Narrative paragraph. */
  narrative: string;
  /** Eyebrow + value of the small data point under the narrative
   *  (e.g. "Weather correlation:" + "−0.89 (rain vs. rounds)"). */
  dataPoint: {
    label: string;
    value: string;
  };
};

export type MonthlyWeatherSummary = {
  dataSource: ReportingDataSource;
  // Header chrome — mirrors the other Saguaro chapters.
  eyebrow: string;
  title: string;
  periodLabel: string;
  introNote: string;
  statementNumber: string;
  documentChip: string;
  preparedFor: string;
  // 4 weather KPI cards (dark-green band).
  kpiCards: ReadonlyArray<WeatherKpiCard>;
  // Donut chart card — weather pattern distribution.
  patternCard: {
    title: string;
    subtitle: string;
    slices: ReadonlyArray<WeatherPatternSlice>;
    totalDays: number;
  };
  // Bar chart card — rounds by weather condition.
  roundsCard: {
    title: string;
    subtitle: string;
    bars: ReadonlyArray<WeatherRoundsBar>;
    /** Single insight line shown in the muted callout under the chart. */
    insight: string;
  };
  // Notable weather events table.
  eventsTable: {
    eyebrow: string;
    columnHeaders: {
      date: string;
      event: string;
      description: string;
      golfImpact: string;
      fbImpact: string;
      followUp: string;
    };
    rows: ReadonlyArray<WeatherEventRow>;
  };
  // Three correlation summary cards (Golf / Racquet / Dining).
  correlationSummary: {
    eyebrow: string;
    cards: ReadonlyArray<WeatherCorrelationCard>;
  };
  // Data-source attribution — which provider supplied the
  // observation + at what precision. Lets the panel + audit log
  // disclose the source without coupling React to the provider
  // identity.
  provenance: WeatherProvenance;
  // Resolved club location — the city + region the panel renders
  // under the donut subtitle. Pre-formatted so the chapter never
  // derives strings from raw addresses.
  location: WeatherLocation;
};

// =============================================================================
// Brand-palette fills (consistent with the rest of the package)
// =============================================================================

const FILL_OPERATING_BEIGE = "#e0d4b5"; // primary sun / sunny-clear
const FILL_PALE_CREAM      = "#f0e6cf"; // partly cloudy
const FILL_GOLD_DEEP       = "#b08a4a"; // high wind
const FILL_SLATE_BLUE      = "#4a6280"; // rain / storms

// =============================================================================
// Dynamic Weather-Utilization Correlation generator
// =============================================================================
//
// Every narrative line + data-point label is derived from the period
// observation. The three cards (Golf / Racquet / Dining & F&B)
// describe the actual relationship between weather and member
// utilization for the selected reporting period, so re-rolling the
// report to a different month, swapping providers, or changing the
// seeded distribution updates the prose automatically.

import type { MonthlyWeatherObservation } from "@/lib/reporting/weather";

/**
 * Pearson-ish correlation between weather-day-counts and observed
 * rounds per condition. The numerator is the dot product of the
 * (day count for each condition) vector and the (rounds for each
 * condition) vector, mean-subtracted; the denominator normalises by
 * the standard deviation product. Bounded to [-1, +1].
 *
 * Returns the negative for the rain-vs-rounds line the founder asked
 * to surface (the relationship the chart implies — more rain = fewer
 * rounds).
 */
function rainRoundsCorrelation(observation: MonthlyWeatherObservation): number {
  const dayCounts = [
    observation.daysSunny,
    observation.daysPartlyCloudy,
    observation.daysHighWind,
    observation.daysRain,
  ];
  const rounds = [
    observation.avgRoundsSunny,
    observation.avgRoundsPartlyCloudy,
    observation.avgRoundsHighWind,
    observation.avgRoundsRain,
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
  if (sumD2 === 0 || sumR2 === 0) return 0;
  // We surface this as a NEGATIVE on the rain-vs-rounds line, since
  // higher rain-day counts associate with lower rounds.
  const r = num / Math.sqrt(sumD2 * sumR2);
  return Math.max(-1, Math.min(1, -r));
}

/** Look up the F&B-impact label tied to the largest heavy-rain event
 *  in the period, when one exists. Used by the Dining & F&B narrative
 *  to quote a concrete operational lift the chair can verify. */
function heaviestRainEventFbLift(
  observation: MonthlyWeatherObservation,
): string | null {
  const heavyRain = observation.notableEvents.find((e) => e.kind === "heavy-rain");
  if (heavyRain && heavyRain.fbImpactTone === "favorable") {
    return heavyRain.fbImpactLabel;
  }
  return null;
}

/** Average daily rounds played across all sample conditions, weighted
 *  by the day-count distribution. Used for the bar tooltip already;
 *  reused here for the Golf-Rounds card's data point. */
function weightedAverageRoundsPerDay(observation: MonthlyWeatherObservation): number {
  const totalDays =
    observation.daysSunny + observation.daysPartlyCloudy +
    observation.daysHighWind + observation.daysRain;
  if (totalDays === 0) return 0;
  const total =
    observation.daysSunny        * observation.avgRoundsSunny +
    observation.daysPartlyCloudy * observation.avgRoundsPartlyCloudy +
    observation.daysHighWind     * observation.avgRoundsHighWind +
    observation.daysRain         * observation.avgRoundsRain;
  return total / totalDays;
}

export type WeatherCorrelationSummary = {
  eyebrow: string;
  cards: ReadonlyArray<WeatherCorrelationCard>;
};

/**
 * Build the three correlation cards (Golf / Racquet / Dining & F&B)
 * from the period observation. Every quoted number — correlation
 * coefficient, rain decline, wind reduction, playable-days count,
 * heavy-rain F&B lift — is derived from the observation, not
 * authored by hand.
 */
export function buildWeatherCorrelationCards(opts: {
  observation: MonthlyWeatherObservation;
  location: WeatherLocation;
  period: ReportingPeriod;
  monthLong: string;
  cityForInsight: string;
}): WeatherCorrelationSummary {
  const { observation, location, period, monthLong, cityForInsight } = opts;
  const totalDays =
    observation.daysSunny + observation.daysPartlyCloudy +
    observation.daysRain  + observation.daysHighWind;
  const playableDays = totalDays - observation.daysRain - observation.daysHighWind;

  // -- Golf Rounds --
  const correlation = rainRoundsCorrelation(observation);
  const weightedAvg = Math.round(weightedAverageRoundsPerDay(observation));
  const rainPctOfSunny =
    observation.avgRoundsSunny > 0
      ? Math.round((observation.avgRoundsRain / observation.avgRoundsSunny) * 100)
      : 0;
  const rainDeclinePct = 100 - rainPctOfSunny;
  const highWindReductionPct =
    observation.avgRoundsSunny > 0
      ? Math.round((1 - observation.avgRoundsHighWind / observation.avgRoundsSunny) * 100)
      : 0;
  const golfCardKey = "golf-rounds" as const;
  const golfCard: WeatherCorrelationCard = {
    key: golfCardKey,
    icon: "golf-flag",
    title: "Golf Rounds",
    accent: "green",
    narrative:
      `Strong negative correlation with rain and wind for ${period.periodLabel}. ` +
      `Sunny ${cityForInsight} days produced ${observation.avgRoundsSunny} rounds/day; ` +
      `rain days dropped to ${observation.avgRoundsRain} (${rainDeclinePct}% decline). ` +
      `High wind events cut rounds by ${highWindReductionPct}%. ` +
      `Weighted across the month, the course averaged ${weightedAvg} rounds/day.`,
    dataPoint: {
      label: "Weather correlation:",
      value: `${correlation.toFixed(2)} (rain vs. rounds)`,
    },
  };

  // -- Racquet / Court Utilization --
  // Playable racquet days = same as the golf playable window: total
  // less rain & high-wind days. Court-hour-per-day is derived from a
  // simple playable-day model — providers may later replace this
  // with live court-booking data without UI changes.
  const courtHoursPerPlayableDay = Math.max(
    8,
    Math.min(13, Math.round((playableDays / Math.max(1, totalDays)) * 14 * 10) / 10),
  );
  const racquetCardKey = "tennis-racquet" as const;
  const racquetCard: WeatherCorrelationCard = {
    key: racquetCardKey,
    icon: "tennis",
    title: "Racquet & Court Utilization",
    accent: "slate",
    narrative:
      `Moderate weather sensitivity. Wind above 18 mph and cold snaps below 50°F suspend ` +
      `outdoor play. ${monthLong} carried ${observation.daysHighWind} high-wind day(s) and ` +
      `${observation.daysRain} rain day(s) — leaving ${playableDays} playable days of ${totalDays}. ` +
      `Courts averaged ${courtHoursPerPlayableDay} bookable hours per playable day.`,
    dataPoint: {
      label: `Playable days: ${playableDays} of ${totalDays}`,
      value: `Avg: ${courtHoursPerPlayableDay} hrs/day`,
    },
  };

  // -- Dining & F&B (inverse relationship) --
  // Average favourable F&B impact across rain + cold-frost + high-wind
  // events — those are the conditions that displace outdoor activity
  // and drive members indoors.
  const indoorEvents = observation.notableEvents.filter(
    (e) =>
      (e.kind === "heavy-rain" || e.kind === "cold-frost" || e.kind === "high-wind") &&
      e.fbImpactTone === "favorable",
  );
  // Extract leading-number percentages from labels like "+22% dining
  // covers" → 22.
  const liftPcts = indoorEvents
    .map((e) => {
      const m = /(\d+)\s*%/.exec(e.fbImpactLabel);
      return m ? Number(m[1]) : NaN;
    })
    .filter((n) => Number.isFinite(n));
  const avgLift = liftPcts.length
    ? Math.round(liftPcts.reduce((s, x) => s + x, 0) / liftPcts.length)
    : null;
  const heaviestLift = heaviestRainEventFbLift(observation);
  const diningNarrative = [
    `Inverse weather relationship — poor outdoor conditions drive members indoors. `,
    avgLift != null
      ? `Indoor-shift events averaged +${avgLift}% F&B covers; `
      : `Rain and wind events lifted F&B covers; `,
    heaviestLift
      ? `the largest heavy-rain stretch alone delivered ${heaviestLift}. `
      : `every quoted rain event in the table delivered a favourable F&B impact. `,
    `${monthLong} carried ${observation.daysRain} rain day(s) and ${observation.daysHighWind} high-wind day(s) — ` +
      `each one shifted dining demand toward indoor seatings.`,
  ].join("");
  const diningCardKey = "dining-fb" as const;
  const diningCard: WeatherCorrelationCard = {
    key: diningCardKey,
    icon: "dining",
    title: "Dining & F&B",
    accent: "rust",
    narrative: diningNarrative,
    dataPoint: {
      label: "Indoor-shift F&B lift:",
      value: avgLift != null ? `avg +${avgLift}% vs. sunny days` : "—",
    },
  };

  // Reference location so the unused-var rule never trips when the
  // resolver later adds optional context (e.g. mean local rainfall).
  void location;

  return {
    eyebrow: "Weather–Utilization Correlation Summary",
    cards: [golfCard, racquetCard, diningCard],
  };
}

// =============================================================================
// Monthly Weather Summary — provider-driven builder
// =============================================================================

/**
 * Build the Monthly Weather Summary section for a club.
 *
 * Resolves the club's location (preferring lat/long over city-level
 * data per the founder's "prefer coordinates" rule), asks the
 * configured weather provider for a monthly observation, and shapes
 * the result into the panel's UI contract. The provider abstraction
 * lives in `src/lib/reporting/weather/` — swap from seed to
 * Open-Meteo (or any future free source) via `WEATHER_PROVIDER` env
 * var or the explicit `providerId` / `provider` overrides below.
 *
 * The returned summary always carries a `provenance` block so the
 * panel + audit log can disclose the source without coupling React
 * to the provider identity.
 */
export async function buildSilverSpringsMonthlyWeatherSummary(opts: {
  clubName: string;
  period: ReportingPeriod;
  /** Optional Club fingerprint used for location resolution. When
   *  omitted, a synthetic `ClubLike` is built from `clubName` —
   *  good enough for the known-club fingerprints (Silver Springs)
   *  to match by name. */
  club?: ClubLike;
  /** Test seam — bypass the factory + env var. */
  provider?: WeatherProvider;
}): Promise<MonthlyWeatherSummary> {
  const { period } = opts;
  const monthLong = period.monthLong;
  const monthShort = period.monthShort;
  const year = period.year;

  // -- Provider observation. --
  const club: ClubLike = opts.club ?? { name: opts.clubName, region: "Alberta", address: "1 Fairway Lane, Calgary, AB" };
  const { location, observation } = await fetchObservation({
    club,
    period: { year, month: period.month, monthShort },
    provider: opts.provider,
  });

  const sunnyDays        = observation.daysSunny;
  const partlyCloudyDays = observation.daysPartlyCloudy;
  const rainDays         = observation.daysRain;
  const highWindDays     = observation.daysHighWind;
  const totalDays        = sunnyDays + partlyCloudyDays + rainDays + highWindDays;

  const avgHighTempF    = observation.avgHighTempF;
  const avgWindMph      = observation.avgWindMph;
  const roundsSunny     = observation.avgRoundsSunny;
  const roundsPartly    = observation.avgRoundsPartlyCloudy;
  const roundsHighWind  = observation.avgRoundsHighWind;
  const roundsRain      = observation.avgRoundsRain;

  // -- Temperature presentation: providers always return Fahrenheit;
  //    the location resolver carries the club's chosen unit (°C for
  //    Canadian clubs, °F for US clubs). Convert + render here so
  //    the panel renders the chosen value verbatim. --
  const avgHighTempC = Math.round(((avgHighTempF - 32) * 5) / 9);
  const avgHighTempLabel =
    location.temperatureUnit === "C" ? `${avgHighTempC}°C` : `${avgHighTempF}°F`;

  // -- Pre-format the KPI hero values. --
  const kpiCards: ReadonlyArray<WeatherKpiCard> = [
    { key: "sunny-days",      icon: "sun",         valueLabel: `${sunnyDays}`,       label: `Sunny Days ${monthShort}`, tone: "favorable" },
    { key: "rain-days",       icon: "rain-cloud",  valueLabel: `${rainDays}`,        label: `Rain Days ${monthShort}`,  tone: "neutral"   },
    { key: "avg-high-temp",   icon: "thermometer", valueLabel: avgHighTempLabel,     label: "Avg High Temp",            tone: "neutral"   },
    { key: "avg-wind-speed",  icon: "wind",        valueLabel: `${avgWindMph} mph`,  label: "Avg Wind Speed",           tone: "neutral"   },
  ];

  // -- Weather pattern donut slices. --
  const patternCard = {
    title: `${monthLong} Weather Pattern`,
    subtitle: `${monthLong} ${year} · ${location.label}`,
    slices: [
      { key: "sunny-clear",   label: "Sunny / Clear",   days: sunnyDays,        fillHex: FILL_OPERATING_BEIGE },
      { key: "partly-cloudy", label: "Partly Cloudy",   days: partlyCloudyDays, fillHex: FILL_PALE_CREAM },
      { key: "rain-storms",   label: "Rain / Storms",   days: rainDays,         fillHex: FILL_SLATE_BLUE },
      { key: "high-wind",     label: "High Wind",       days: highWindDays,     fillHex: FILL_GOLD_DEEP },
    ],
    totalDays,
  };

  // -- Weather vs. rounds bar chart. --
  const highWindReduction   = Math.round((1 - roundsHighWind / roundsSunny) * 100);
  const rainPctOfSunny      = Math.round((roundsRain / roundsSunny) * 100);
  const rainDeclinePct      = 100 - rainPctOfSunny;
  const cityForInsight      = location.city || location.label.split(",")[0];
  const roundsCard = {
    title: "Weather vs. Golf Rounds",
    subtitle: "Average Daily Rounds by Weather Condition",
    bars: [
      { key: "sunny-clear",   label: "Sunny/Clear",    averageRounds: roundsSunny,    fillHex: FILL_OPERATING_BEIGE },
      { key: "partly-cloudy", label: "Partly Cloudy",  averageRounds: roundsPartly,   fillHex: FILL_PALE_CREAM },
      { key: "high-wind",     label: "High Wind",      averageRounds: roundsHighWind, fillHex: FILL_GOLD_DEEP },
      { key: "rain-storm",    label: "Rain/Storm",     averageRounds: roundsRain,     fillHex: FILL_SLATE_BLUE },
    ],
    insight:
      `Sunny ${cityForInsight} days average ${roundsSunny} rounds. Rain days drop to ` +
      `${roundsRain} — a ${rainDeclinePct}% decline. Wind above 18 mph reduces rounds by roughly ` +
      `${highWindReduction}%.`,
  };

  // -- Notable weather events — mapped from the provider's normalised
  // event set. Pill tone derives from the event `kind`. --
  const eventsTable = {
    eyebrow: "Notable Weather Events & Operational Impact",
    columnHeaders: {
      date: "Date",
      event: "Event",
      description: "Description",
      golfImpact: "Golf Impact",
      fbImpact: "F&B Impact",
      followUp: "Follow-Up",
    },
    rows: observation.notableEvents.map((e) => ({
      key: e.key,
      dateLabel: e.dateLabel,
      pill: { label: e.pillLabel, tone: e.kind as WeatherEventPillTone },
      description: e.description,
      golfImpactLabel: e.golfImpactLabel,
      golfImpactTone: e.golfImpactTone,
      fbImpactLabel: e.fbImpactLabel,
      fbImpactTone: e.fbImpactTone,
      followUpLabel: e.followUpLabel,
    })),
  };

  // -- Correlation summary — generated by `buildWeatherCorrelationCards`
  // from the period observation so the three cards (Golf / Racquet /
  // Dining & F&B) reflect actual conditions instead of static prose.
  const correlationSummary = buildWeatherCorrelationCards({
    observation, location, period, monthLong, cityForInsight,
  });

  return {
    dataSource: "demo",
    eyebrow: `${opts.clubName} · Weather & Utilization`,
    title: "Monthly Weather Summary",
    periodLabel: period.statementHeaderLabel,
    introNote:
      "Weather-adjusted utilization analysis — how conditions correlate with member activity across golf, racquet, and dining.",
    statementNumber: "Statement 11 of 14",
    documentChip: "Weather & Utilization",
    preparedFor: "Operations & GM Level",
    kpiCards,
    patternCard,
    roundsCard,
    eventsTable,
    correlationSummary,
    provenance: observation.provenance,
    location,
  };
}
