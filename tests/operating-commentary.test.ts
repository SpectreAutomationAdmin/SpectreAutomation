import { describe, it, expect } from "vitest";
import {
  buildOperatingCommentary,
  classifyOperatingCommentary,
  type OperatingCommentaryInput,
} from "@/lib/reporting/operating-commentary";

// Unit tests for the Operating Results commentary generator.
// Verifies:
//   - five classification branches fire on the right inputs
//   - the Silver Springs case produces the founder's exact requested
//     sentence
//   - corridor formatting uses U+2212 minus and explicit "+" on
//     positives (board-report typography)
//   - no "pillar" / SaaS references in any branch
//   - the generator responds to every input the founder named
//     (NOI / revenue / budget / prior year / corridor)

const SILVER_SPRINGS: OperatingCommentaryInput = {
  // Current Silver Springs accounting-fed values — trailing 12 ending
  // April 2026.
  ytdNoiDollars: 45_000,
  ytdRevenueDollars: 15_000_000,
  ytdBudgetNoiDollars: 0,
  priorYearNoiDollars: -193_000,
  corridorPct: { lower: -2.8, upper: 3.3 },
  periodLabel: "Year-end",
};

describe("classifyOperatingCommentary", () => {
  it("classifies Silver Springs (current $45K inside corridor, prior was $193K deficit) as inside-recovered", () => {
    expect(classifyOperatingCommentary(SILVER_SPRINGS)).toBe("inside-recovered");
  });

  it("classifies above-corridor when NOI % > upper bound", () => {
    const above = { ...SILVER_SPRINGS, ytdNoiDollars: 765_000 }; // 5.1% > +3.3
    expect(classifyOperatingCommentary(above)).toBe("above-corridor");
  });

  it("classifies below-corridor when NOI % < lower bound", () => {
    const below = { ...SILVER_SPRINGS, ytdNoiDollars: -600_000 }; // -4.0% < -2.8
    expect(classifyOperatingCommentary(below)).toBe("below-corridor");
  });

  it("classifies inside-prior-positive when current is inside and prior was non-negative", () => {
    const steady = { ...SILVER_SPRINGS, priorYearNoiDollars: 80_000 };
    expect(classifyOperatingCommentary(steady)).toBe("inside-prior-positive");
  });

  it("classifies inside-still-recovering when current is inside corridor but NOT positive and prior was deficit", () => {
    const stillRecovering = {
      ...SILVER_SPRINGS,
      ytdNoiDollars: -200_000, // -1.3% — inside corridor (-2.8..3.3) but negative
      priorYearNoiDollars: -500_000,
    };
    expect(classifyOperatingCommentary(stillRecovering)).toBe("inside-still-recovering");
  });
});

describe("buildOperatingCommentary", () => {
  it("produces the founder's EXACT requested sentence for the Silver Springs Year-end case", () => {
    const out = buildOperatingCommentary(SILVER_SPRINGS);
    expect(out).toBe(
      "Year-end NOI of **$45K (0.3%)** sits squarely in the ClubBenchmarking break-even zone of " +
      "−2.8% to +3.3%. Prior year's **($193K)** deficit has been recovered. Consistent " +
      "performance in this zone confirms dues are properly sized against the operating footprint.",
    );
  });

  it("uses U+2212 minus sign (not ASCII hyphen) and explicit '+' on the upper bound", () => {
    const out = buildOperatingCommentary(SILVER_SPRINGS);
    expect(out).toContain("−2.8%");  // U+2212 MINUS SIGN
    expect(out).toContain("+3.3%");
    // The corridor block must NOT use the hyphen-minus form.
    expect(out).not.toContain("-2.8%");
  });

  it("above-corridor sentence has the surplus-redirection framing", () => {
    const above = { ...SILVER_SPRINGS, ytdNoiDollars: 765_000 };
    const out = buildOperatingCommentary(above);
    expect(out).toContain("sits above the ClubBenchmarking");
    expect(out).toContain("capital reserves");
  });

  it("below-corridor sentence has the Finance-Committee review framing", () => {
    const below = { ...SILVER_SPRINGS, ytdNoiDollars: -600_000 };
    const out = buildOperatingCommentary(below);
    expect(out).toContain("sits below the ClubBenchmarking");
    expect(out).toContain("Finance Committee");
  });

  it("inside-prior-positive sentence frames as second consecutive on-policy year", () => {
    const steady = { ...SILVER_SPRINGS, priorYearNoiDollars: 80_000 };
    const out = buildOperatingCommentary(steady);
    expect(out).toContain("second consecutive year");
    expect(out).not.toContain("deficit has been recovered");
  });

  it("inside-still-recovering sentence names the deficit AND says it has not been fully recovered", () => {
    const stillRecovering = {
      ...SILVER_SPRINGS,
      ytdNoiDollars: -200_000,
      priorYearNoiDollars: -500_000,
    };
    const out = buildOperatingCommentary(stillRecovering);
    expect(out).toContain("has not been fully recovered");
    expect(out).toContain("Finance Committee should monitor");
    // The prior year deficit is named explicitly.
    expect(out).toContain("($500K)");
  });

  it("never references pillars in any branch", () => {
    const inputs: OperatingCommentaryInput[] = [
      SILVER_SPRINGS,                                                               // inside-recovered
      { ...SILVER_SPRINGS, ytdNoiDollars: 765_000 },                                // above
      { ...SILVER_SPRINGS, ytdNoiDollars: -600_000 },                               // below
      { ...SILVER_SPRINGS, priorYearNoiDollars: 80_000 },                           // inside-prior-positive
      { ...SILVER_SPRINGS, ytdNoiDollars: -200_000, priorYearNoiDollars: -500_000 }, // inside-still-recovering
    ];
    for (const i of inputs) {
      expect(buildOperatingCommentary(i).toLowerCase()).not.toContain("pillar");
    }
  });

  it("never references SaaS vocabulary in any branch", () => {
    const inputs: OperatingCommentaryInput[] = [
      SILVER_SPRINGS,
      { ...SILVER_SPRINGS, ytdNoiDollars: 765_000 },
      { ...SILVER_SPRINGS, ytdNoiDollars: -600_000 },
    ];
    for (const i of inputs) {
      const text = buildOperatingCommentary(i).toLowerCase();
      expect(text).not.toMatch(/dau|mau|nps|churn|funnel|conversion rate/);
    }
  });

  it("commentary changes when NOI changes", () => {
    const a = buildOperatingCommentary({ ...SILVER_SPRINGS, ytdNoiDollars: 45_000 });
    const b = buildOperatingCommentary({ ...SILVER_SPRINGS, ytdNoiDollars: 100_000 });
    expect(a).not.toBe(b);
    expect(a).toContain("$45K");
    expect(b).toContain("$100K");
  });

  it("commentary changes when revenue changes (drives the % term)", () => {
    // 45,000 / 15,000,000 * 100 = 0.30 → "0.3%"
    // 45,000 /  5,000,000 * 100 = 0.90 → "0.9%"
    // (Picked values that produce clean .toFixed(1) outputs without
    // relying on float rounding at half-tenth boundaries.)
    const a = buildOperatingCommentary({ ...SILVER_SPRINGS, ytdRevenueDollars: 15_000_000 });
    const b = buildOperatingCommentary({ ...SILVER_SPRINGS, ytdRevenueDollars:  5_000_000 });
    expect(a).not.toBe(b);
    expect(a).toContain("0.3%");
    expect(b).toContain("0.9%");
  });

  it("commentary changes when prior-year result changes (crosses the deficit/no-deficit boundary)", () => {
    const deficitPrior = buildOperatingCommentary({ ...SILVER_SPRINGS, priorYearNoiDollars: -193_000 });
    const positivePrior = buildOperatingCommentary({ ...SILVER_SPRINGS, priorYearNoiDollars: 80_000 });
    expect(deficitPrior).not.toBe(positivePrior);
    expect(deficitPrior).toContain("deficit has been recovered");
    expect(positivePrior).toContain("second consecutive year");
  });

  it("commentary changes when the break-even zone bounds change", () => {
    const wider = buildOperatingCommentary({
      ...SILVER_SPRINGS,
      corridorPct: { lower: -5.0, upper: 5.0 },
    });
    const tighter = buildOperatingCommentary({
      ...SILVER_SPRINGS,
      corridorPct: { lower: -1.0, upper: 1.0 },
    });
    expect(wider).not.toBe(tighter);
    expect(wider).toContain("−5.0% to +5.0%");
    expect(tighter).toContain("−1.0% to +1.0%");
  });

  it("bolds both the YTD NOI tile AND the prior-year tile value via **…** markers", () => {
    const out = buildOperatingCommentary(SILVER_SPRINGS);
    expect(out).toMatch(/\*\*\$45K \(0\.3%\)\*\*/);
    expect(out).toMatch(/\*\*\(\$193K\)\*\*/);
  });
});
