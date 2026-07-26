// Monthly Weather Summary service tests — shape + Calgary-appropriate
// seed + premium-icon contract + period sensitivity.

import { describe, it, expect } from "vitest";

import { buildSilverSpringsMonthlyWeatherSummary } from "@/lib/reporting/monthly-weather-summary";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
const SILVER_SPRINGS = "Silver Springs Golf & Country Club";

describe("buildSilverSpringsMonthlyWeatherSummary — service contract", () => {
  it("ships the Saguaro header chrome — period derived from ReportingPeriod (no Q1/March hardcodes)", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(mws.eyebrow).toBe("Silver Springs Golf & Country Club · Weather & Utilization");
    expect(mws.title).toBe("Monthly Weather Summary");
    expect(mws.periodLabel).toBe("May 2026 · For the period ended May 31, 2026 · Year to Date");
    expect(mws.periodLabel).not.toMatch(/\bQ1\b/);
    expect(mws.periodLabel).not.toMatch(/\bMarch\b/);
    expect(mws.statementNumber).toBe("Statement 11 of 14");
    expect(mws.documentChip).toBe("Weather & Utilization");
    expect(mws.preparedFor).toBe("Operations & GM Level");
    expect(mws.introNote).toMatch(/Weather-adjusted utilization analysis/);
    expect(mws.introNote).toMatch(/golf, racquet, and dining/);
  });

  it("4 KPI cards in canonical order with month-aware labels (May → 'Sunny Days May', NOT 'Q1')", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(mws.kpiCards).toHaveLength(4);
    expect(mws.kpiCards[0].key).toBe("sunny-days");
    expect(mws.kpiCards[0].label).toBe("Sunny Days May");
    expect(mws.kpiCards[1].key).toBe("rain-days");
    expect(mws.kpiCards[1].label).toBe("Rain Days May");
    expect(mws.kpiCards[2].key).toBe("avg-high-temp");
    // Silver Springs (Alberta, Canada) renders °C per its
    // resolved location.temperatureUnit. 65°F → 18°C.
    expect(mws.kpiCards[2].valueLabel).toBe("18°C");
    expect(mws.kpiCards[3].key).toBe("avg-wind-speed");
    expect(mws.kpiCards[3].valueLabel).toBe("11 mph");
  });

  it("every KPI card carries a premium SVG icon key (sun / rain-cloud / thermometer / wind) — never an emoji", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(mws.kpiCards.map((c) => c.icon)).toEqual([
      "sun",
      "rain-cloud",
      "thermometer",
      "wind",
    ]);
    // None of the icon keys should contain emoji bytes / cheap glyphs.
    for (const c of mws.kpiCards) {
      expect(c.icon, `KPI icon "${c.icon}" must be a vector-icon key`).toMatch(/^[a-z-]+$/);
    }
  });

  it("pattern donut renders Calgary-plausible distribution that sums to a realistic 31-day total", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(mws.patternCard.slices.map((s) => s.key)).toEqual([
      "sunny-clear", "partly-cloudy", "rain-storms", "high-wind",
    ]);
    const total = mws.patternCard.slices.reduce((s, x) => s + x.days, 0);
    expect(total).toBe(mws.patternCard.totalDays);
    // May Calgary is plausible — not desert (Scottsdale would have
    // 25+ sunny days), not winter — 17 sunny, 7 partly cloudy,
    // 5 rain, 2 high wind = 31 days.
    expect(mws.patternCard.totalDays).toBe(31);
    expect(mws.patternCard.slices[0].days).toBe(17);
  });

  it("pattern subtitle reads '{month} {year} · NW Calgary, Alberta' — coordinate-precision location, NOT Scottsdale / Arizona / Q1", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    // Coordinate-precision label — Silver Springs is fingerprinted
    // to its NW Calgary neighborhood, not generic "Calgary".
    expect(mws.patternCard.subtitle).toBe("May 2026 · NW Calgary, Alberta");
    expect(mws.patternCard.subtitle).not.toMatch(/Scottsdale/);
    expect(mws.patternCard.subtitle).not.toMatch(/Arizona/);
    expect(mws.patternCard.subtitle).not.toMatch(/\bQ1\b/);
    expect(mws.patternCard.title).toMatch(/^May Weather Pattern$/);
    // Resolved location surfaces coordinates so future export
    // pipelines + audits can prove the data source.
    expect(mws.location.latitude).toBeCloseTo(51.1078, 2);
    expect(mws.location.longitude).toBeCloseTo(-114.1815, 2);
    expect(mws.location.city).toBe("Calgary");
    expect(mws.location.region).toBe("Alberta");
  });

  it("rounds bar chart has 4 bars in declining order with brand-palette fills", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(mws.roundsCard.bars).toHaveLength(4);
    expect(mws.roundsCard.bars.map((b) => b.key)).toEqual([
      "sunny-clear", "partly-cloudy", "high-wind", "rain-storm",
    ]);
    const values = mws.roundsCard.bars.map((b) => b.averageRounds);
    // Sunny > partly > high wind > rain (strict).
    expect(values[0]).toBeGreaterThan(values[1]);
    expect(values[1]).toBeGreaterThan(values[2]);
    expect(values[2]).toBeGreaterThan(values[3]);
    // Brand-palette fills, not chart-library defaults.
    for (const b of mws.roundsCard.bars) {
      expect(b.fillHex).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("rounds insight references Calgary (the seed location) — NOT Scottsdale", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(mws.roundsCard.insight).toMatch(/Calgary days/);
    expect(mws.roundsCard.insight).not.toMatch(/Scottsdale/);
    // Insight quotes the actual seed numbers; rain decline is 80%.
    expect(mws.roundsCard.insight).toMatch(/142 rounds/);
    expect(mws.roundsCard.insight).toMatch(/Rain days drop to 28/);
    expect(mws.roundsCard.insight).toMatch(/80% decline/);
  });

  it("events table — 4 rows with period-aware date labels (May, NOT March)", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(mws.eventsTable.rows).toHaveLength(4);
    for (const row of mws.eventsTable.rows) {
      expect(row.dateLabel, `event "${row.key}" must use period.monthShort`).toMatch(/^May\b/);
      expect(row.dateLabel).not.toMatch(/^Jan|^Mar|^Feb/);
    }
  });

  it("event pills cover the documented tone set (heavy-rain, cold-frost, high-wind, prime-conditions)", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const tones = mws.eventsTable.rows.map((r) => r.pill.tone);
    expect(tones).toContain("heavy-rain");
    expect(tones).toContain("cold-frost");
    expect(tones).toContain("high-wind");
    expect(tones).toContain("prime-conditions");
  });

  it("event impact tones are pre-classified — heavy rain golf = risk, F&B = favorable; prime conditions both favorable", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const heavyRain = mws.eventsTable.rows.find((r) => r.key === "heavy-rain-mid")!;
    expect(heavyRain.golfImpactTone).toBe("risk");
    expect(heavyRain.fbImpactTone).toBe("favorable");
    const prime = mws.eventsTable.rows.find((r) => r.key === "prime-stretch-late")!;
    expect(prime.golfImpactTone).toBe("favorable");
    expect(prime.fbImpactTone).toBe("favorable");
    const highWind = mws.eventsTable.rows.find((r) => r.key === "high-wind-end")!;
    expect(highWind.golfImpactTone).toBe("risk");
  });

  it("3 correlation cards (golf-rounds / tennis-racquet / dining-fb) with documented accent palette + SVG icons", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(mws.correlationSummary.cards).toHaveLength(3);
    expect(mws.correlationSummary.cards.map((c) => c.key)).toEqual([
      "golf-rounds", "tennis-racquet", "dining-fb",
    ]);
    expect(mws.correlationSummary.cards[0].accent).toBe("green");
    expect(mws.correlationSummary.cards[1].accent).toBe("slate");
    expect(mws.correlationSummary.cards[2].accent).toBe("rust");
    // SVG-icon keys, not emoji.
    expect(mws.correlationSummary.cards.map((c) => c.icon)).toEqual([
      "golf-flag", "tennis", "dining",
    ]);
  });

  it("Golf correlation narrative references Calgary (NOT Scottsdale / desert)", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const golf = mws.correlationSummary.cards[0];
    expect(golf.narrative).toMatch(/Calgary/);
    expect(golf.narrative).not.toMatch(/Scottsdale/);
    expect(golf.narrative).not.toMatch(/Desert Southwest/);
    expect(golf.dataPoint.label).toMatch(/Weather correlation/);
    expect(golf.dataPoint.value).toMatch(/rain vs\. rounds/);
  });

  it("Racquet correlation card playable-days line quotes period.monthLong + actual rain/wind day counts (not Q1)", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const racquet = mws.correlationSummary.cards[1];
    expect(racquet.title).toBe("Racquet & Court Utilization");
    // Period month appears in the narrative.
    expect(racquet.narrative).toMatch(/May carried/);
    expect(racquet.narrative).not.toMatch(/\bQ1\b/);
    // Day counts from the observation surface verbatim.
    expect(racquet.narrative).toMatch(/2 high-wind day\(s\)/);
    expect(racquet.narrative).toMatch(/5 rain day\(s\)/);
    // Playable days = total - rain - high wind = 31 - 5 - 2 = 24, of 31.
    expect(racquet.dataPoint.label).toBe("Playable days: 24 of 31");
  });

  it("no reference-attribution footer text (Saguaro / Financially Astute / hypothetical / Scottsdale)", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const surface = JSON.stringify(mws);
    expect(surface).not.toMatch(/Saguaro/i);
    expect(surface).not.toMatch(/Financially Astute/i);
    expect(surface).not.toMatch(/Hypothetical Illustration/i);
    expect(surface).not.toMatch(/financiallyastuteclubs/);
    expect(surface, "no Scottsdale leak").not.toMatch(/Scottsdale/i);
    expect(surface, "no Arizona leak").not.toMatch(/Arizona/i);
  });

  it("REGRESSION: March 2026 period flips KPI labels + pattern subtitle + every event date to March", async () => {
    const MAR_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 2, 31)));
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAR_2026 });
    expect(mws.periodLabel).toMatch(/March 2026/);
    expect(mws.kpiCards[0].label).toBe("Sunny Days Mar");
    expect(mws.kpiCards[1].label).toBe("Rain Days Mar");
    expect(mws.patternCard.title).toBe("March Weather Pattern");
    expect(mws.patternCard.subtitle).toBe("March 2026 · NW Calgary, Alberta");
    for (const row of mws.eventsTable.rows) {
      expect(row.dateLabel).toMatch(/^Mar\b/);
    }
    // Racquet narrative quotes the new month.
    expect(mws.correlationSummary.cards[1].narrative).toMatch(/March carried/);
  });

  it("Canadian club (Alberta) — Avg High Temp renders in °C, NOT °F", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({
      clubName: SILVER_SPRINGS,
      period: MAY_2026,
      club: { name: SILVER_SPRINGS, slug: "silver-springs", region: "Alberta", address: "1 Fairway Lane, Calgary, AB" },
    });
    const temp = mws.kpiCards.find((c) => c.key === "avg-high-temp")!;
    expect(temp.valueLabel).toMatch(/°C$/);
    expect(temp.valueLabel).not.toMatch(/°F/);
    // 65 °F seed → round((65-32)*5/9) = 18 °C.
    expect(temp.valueLabel).toBe("18°C");
    expect(mws.location.temperatureUnit).toBe("C");
  });

  it("American club (Florida) — Avg High Temp renders in °F", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({
      clubName: "Palm Harbor Country Club",
      period: MAY_2026,
      // Unknown club → city-precision fallback. Florida → °F.
      club: { name: "Palm Harbor Country Club", region: "Florida", address: "12 Bayshore Drive, Naples, FL" },
    });
    const temp = mws.kpiCards.find((c) => c.key === "avg-high-temp")!;
    expect(temp.valueLabel).toMatch(/°F$/);
    expect(temp.valueLabel).not.toMatch(/°C/);
    expect(mws.location.temperatureUnit).toBe("F");
  });

  it("Canadian-province postal codes (AB / BC / ON / QC) all resolve to °C", async () => {
    for (const region of ["AB", "BC", "ON", "QC", "SK", "MB", "NB", "NS", "NL", "PE", "YT", "NU", "NT"]) {
      const mws = await buildSilverSpringsMonthlyWeatherSummary({
        clubName: `Some Club in ${region}`,
        period: MAY_2026,
        club: { name: `Some Club in ${region}`, region, address: `1 Fairway, City, ${region}` },
      });
      expect(mws.location.temperatureUnit, `${region} should resolve to °C`).toBe("C");
      expect(mws.kpiCards.find((c) => c.key === "avg-high-temp")!.valueLabel).toMatch(/°C$/);
    }
  });

  it("Dynamic correlation narrative — Golf card surfaces the actual rain-decline + high-wind-reduction numbers + computed correlation", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const golf = mws.correlationSummary.cards[0];
    expect(golf.key).toBe("golf-rounds");
    // Specific numbers from the seed observation flow into the prose.
    expect(golf.narrative).toMatch(/142 rounds\/day/);
    expect(golf.narrative).toMatch(/rain days dropped to 28/);
    expect(golf.narrative).toMatch(/80% decline/);
    expect(golf.narrative).toMatch(/cut rounds by 55%/);
    // Correlation coefficient is computed (range [-1, +1]), formatted
    // to two decimals on the data point line.
    expect(golf.dataPoint.label).toBe("Weather correlation:");
    expect(golf.dataPoint.value).toMatch(/^-?\d\.\d{2} \(rain vs\. rounds\)$/);
  });

  it("Dynamic correlation narrative — Dining card quotes the heaviest rain F&B lift + average indoor-shift lift", async () => {
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const dining = mws.correlationSummary.cards[2];
    expect(dining.title).toBe("Dining & F&B");
    // The seed has a heavy-rain event with "+22% dining covers" — that
    // string is surfaced as the heaviest-lift quote.
    expect(dining.narrative).toMatch(/\+22% dining covers/);
    expect(dining.narrative).toMatch(/5 rain day\(s\) and 2 high-wind day\(s\)/);
    // Average lift is computed across favourable F&B impacts on
    // indoor-shift events (heavy-rain + cold-frost + high-wind).
    expect(dining.dataPoint.label).toBe("Indoor-shift F&B lift:");
    expect(dining.dataPoint.value).toMatch(/avg \+\d+% vs\. sunny days/);
  });

  it("Dynamic correlation narrative — adapts when the period observation changes (Dec 2027 reads with December counts + same shape)", async () => {
    const DEC_2027 = buildReportingPeriod(new Date(Date.UTC(2027, 11, 31)));
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: DEC_2027 });
    const golf = mws.correlationSummary.cards[0];
    expect(golf.narrative).toMatch(/Strong negative correlation/);
    expect(golf.narrative).toMatch(/December 2027/);
    // Day counts re-balanced to the actual 31-day month.
    const racquet = mws.correlationSummary.cards[1];
    expect(racquet.narrative).toMatch(/December carried/);
    expect(racquet.narrative).not.toMatch(/\bMay\b/);
  });

  it("REGRESSION: Dec 2027 — KPI + pattern + event dates flip to December (NOT a year-boundary failure)", async () => {
    const DEC_2027 = buildReportingPeriod(new Date(Date.UTC(2027, 11, 31)));
    const mws = await buildSilverSpringsMonthlyWeatherSummary({ clubName: SILVER_SPRINGS, period: DEC_2027 });
    expect(mws.kpiCards[0].label).toBe("Sunny Days Dec");
    expect(mws.patternCard.subtitle).toBe("December 2027 · NW Calgary, Alberta");
    for (const row of mws.eventsTable.rows) {
      expect(row.dateLabel).toMatch(/^Dec\b/);
    }
  });
});
