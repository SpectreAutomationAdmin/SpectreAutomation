// RAG rule engine — per-rule threshold unit tests + scenario tests
// proving the Dashboard Notes narrative is derived from the rule
// results (no "red KPI / green narrative" contradiction is reachable).

import { describe, it, expect } from "vitest";

import {
  RAG_THRESHOLDS,
  buildRagDashboardNarrative,
  classifyArCurrentRate,
  classifyCapitalIncome,
  classifyDebtServiceCoverage,
  classifyDuesToRevenue,
  classifyNetToGrossPpe,
  classifyNoiVariance,
  classifyOperatingRevenueVariance,
  classifyReserveCoverage,
  ruleResultsToKpiTones,
  worstStatus,
  type RagRuleResult,
} from "@/lib/reporting/rag-rule-engine";

// ---------------------------------------------------------------------------
// Per-rule threshold tests — one band per rule + edges + degenerate
// inputs.
// ---------------------------------------------------------------------------

describe("RAG rule — operating-revenue-variance", () => {
  const budget = 14_100_000;
  it("≥ −1 % → green", () => {
    // exactly at the threshold
    const atEdge = classifyOperatingRevenueVariance({ actual: budget * 0.99, budget });
    expect(atEdge.status).toBe("green");
    // above plan
    const above = classifyOperatingRevenueVariance({ actual: budget * 1.05, budget });
    expect(above.status).toBe("green");
  });
  it("−5 % to −1 % → amber", () => {
    const insideAmber = classifyOperatingRevenueVariance({ actual: budget * 0.97, budget });
    expect(insideAmber.status).toBe("amber");
    const justBelowGreen = classifyOperatingRevenueVariance({
      actual: budget * 0.989, // ~−1.1 %
      budget,
    });
    expect(justBelowGreen.status).toBe("amber");
  });
  it("< −5 % → red", () => {
    const red = classifyOperatingRevenueVariance({ actual: budget * 0.90, budget });
    expect(red.status).toBe("red");
  });
  it("zero / negative budget → amber neutral with 'unavailable' explanation", () => {
    const neutral = classifyOperatingRevenueVariance({ actual: 100, budget: 0 });
    expect(neutral.status).toBe("amber");
    expect(neutral.explanation).toMatch(/unavailable/);
  });
});

describe("RAG rule — noi-variance", () => {
  it("≥ budget → green (cushion is symmetric below only)", () => {
    expect(classifyNoiVariance({ actual: 100_000, budget: 0 }).status).toBe("green");
    expect(classifyNoiVariance({ actual: 0, budget: 0 }).status).toBe("green");
  });
  it("within $50K cushion below → amber", () => {
    expect(classifyNoiVariance({ actual: -45_000, budget: 0 }).status).toBe("amber");
  });
  it("beyond $50K cushion → red", () => {
    expect(classifyNoiVariance({ actual: -200_000, budget: 0 }).status).toBe("red");
  });
  it("cushion scales with budget magnitude (5 %)", () => {
    // 5 % of $1M = $50K → at the floor.
    expect(classifyNoiVariance({ actual: 950_000, budget: 1_000_000 }).status).toBe("amber");
    expect(classifyNoiVariance({ actual: 800_000, budget: 1_000_000 }).status).toBe("red");
  });
});

describe("RAG rule — capital-income", () => {
  const budget = 6_030_000;
  it("≥ −5 % → green", () => {
    expect(classifyCapitalIncome({ actual: budget, budget }).status).toBe("green");
    expect(classifyCapitalIncome({ actual: budget * 0.97, budget }).status).toBe("green");
  });
  it("−10 % to −5 % → amber", () => {
    expect(classifyCapitalIncome({ actual: budget * 0.92, budget }).status).toBe("amber");
  });
  it("< −10 % → red", () => {
    expect(classifyCapitalIncome({ actual: budget * 0.70, budget }).status).toBe("red");
  });
  it("zero budget → amber neutral", () => {
    expect(classifyCapitalIncome({ actual: 1_000_000, budget: 0 }).status).toBe("amber");
  });
});

describe("RAG rule — reserve-coverage", () => {
  const floor = 1.25;
  it("≥ policy floor → green", () => {
    expect(classifyReserveCoverage({ ratio: floor, policyFloor: floor }).status).toBe("green");
    expect(classifyReserveCoverage({ ratio: 1.42, policyFloor: floor }).status).toBe("green");
  });
  it("within 5 % of floor → amber", () => {
    expect(classifyReserveCoverage({ ratio: 1.20, policyFloor: floor }).status).toBe("amber");
    expect(classifyReserveCoverage({ ratio: floor * 0.95, policyFloor: floor }).status).toBe("amber");
  });
  it("below 95 % of floor → red", () => {
    expect(classifyReserveCoverage({ ratio: 1.00, policyFloor: floor }).status).toBe("red");
  });
  it("zero policy floor → amber neutral", () => {
    expect(classifyReserveCoverage({ ratio: 1.42, policyFloor: 0 }).status).toBe("amber");
  });
});

describe("RAG rule — dues-to-revenue", () => {
  const revenue = 15_000_000;
  it("≥ 60 % → green", () => {
    expect(classifyDuesToRevenue({ duesRevenue: revenue * 0.60, totalRevenue: revenue }).status).toBe("green");
    expect(classifyDuesToRevenue({ duesRevenue: revenue * 0.70, totalRevenue: revenue }).status).toBe("green");
  });
  it("55–60 % → amber", () => {
    expect(classifyDuesToRevenue({ duesRevenue: revenue * 0.58, totalRevenue: revenue }).status).toBe("amber");
    expect(classifyDuesToRevenue({ duesRevenue: revenue * 0.55, totalRevenue: revenue }).status).toBe("amber");
  });
  it("< 55 % → red", () => {
    expect(classifyDuesToRevenue({ duesRevenue: revenue * 0.45, totalRevenue: revenue }).status).toBe("red");
  });
  it("zero revenue → amber neutral", () => {
    expect(classifyDuesToRevenue({ duesRevenue: 100_000, totalRevenue: 0 }).status).toBe("amber");
  });
});

describe("RAG rule — debt-service-coverage", () => {
  it("≥ 1.25x → green", () => {
    expect(classifyDebtServiceCoverage({ operatingCashFlow: 1_300_000, annualDebtService: 1_000_000 }).status).toBe("green");
  });
  it("1.00–1.25x → amber", () => {
    expect(classifyDebtServiceCoverage({ operatingCashFlow: 1_100_000, annualDebtService: 1_000_000 }).status).toBe("amber");
    expect(classifyDebtServiceCoverage({ operatingCashFlow: 1_000_000, annualDebtService: 1_000_000 }).status).toBe("amber");
  });
  it("< 1.00x → red", () => {
    expect(classifyDebtServiceCoverage({ operatingCashFlow: 800_000, annualDebtService: 1_000_000 }).status).toBe("red");
  });
  it("no debt service → green with 'n/a' explanation", () => {
    const noDebt = classifyDebtServiceCoverage({ operatingCashFlow: 0, annualDebtService: 0 });
    expect(noDebt.status).toBe("green");
    expect(noDebt.valueLabel).toMatch(/no debt service/);
  });
});

describe("RAG rule — net-to-gross-ppe", () => {
  it("≥ 50 % → green", () => {
    expect(classifyNetToGrossPpe({ netPpe: 13_000_000, grossPpe: 25_000_000 }).status).toBe("green");
  });
  it("40–50 % → amber", () => {
    expect(classifyNetToGrossPpe({ netPpe: 10_000_000, grossPpe: 25_000_000 }).status).toBe("amber");
    expect(classifyNetToGrossPpe({ netPpe: 12_500_000, grossPpe: 25_000_000 }).status).toBe("green"); // exactly 50%
  });
  it("< 40 % → red", () => {
    expect(classifyNetToGrossPpe({ netPpe: 8_000_000, grossPpe: 25_000_000 }).status).toBe("red");
  });
  it("zero gross → amber neutral", () => {
    expect(classifyNetToGrossPpe({ netPpe: 0, grossPpe: 0 }).status).toBe("amber");
  });
});

describe("RAG rule — ar-current-rate", () => {
  it("≥ 80 % → green", () => {
    expect(classifyArCurrentRate({ currentBucket: 850_000, totalAR: 1_000_000 }).status).toBe("green");
    expect(classifyArCurrentRate({ currentBucket: 800_000, totalAR: 1_000_000 }).status).toBe("green");
  });
  it("70–80 % → amber", () => {
    expect(classifyArCurrentRate({ currentBucket: 750_000, totalAR: 1_000_000 }).status).toBe("amber");
    expect(classifyArCurrentRate({ currentBucket: 700_000, totalAR: 1_000_000 }).status).toBe("amber");
  });
  it("< 70 % → red", () => {
    expect(classifyArCurrentRate({ currentBucket: 600_000, totalAR: 1_000_000 }).status).toBe("red");
  });
  it("zero AR → green with 'no AR' explanation", () => {
    const noAr = classifyArCurrentRate({ currentBucket: 0, totalAR: 0 });
    expect(noAr.status).toBe("green");
    expect(noAr.valueLabel).toMatch(/no AR/);
  });
});

// ---------------------------------------------------------------------------
// Threshold constants are surfaced publicly so policy changes are
// one-line edits.
// ---------------------------------------------------------------------------

describe("RAG rule — threshold policy is centralised + exposed", () => {
  it("RAG_THRESHOLDS exports every rule's bands", () => {
    expect(RAG_THRESHOLDS.operatingRevenueVariance).toBeDefined();
    expect(RAG_THRESHOLDS.noiVariance).toBeDefined();
    expect(RAG_THRESHOLDS.capitalIncome).toBeDefined();
    expect(RAG_THRESHOLDS.reserveCoverage).toBeDefined();
    expect(RAG_THRESHOLDS.duesToRevenue).toBeDefined();
    expect(RAG_THRESHOLDS.debtServiceCoverage).toBeDefined();
    expect(RAG_THRESHOLDS.netToGrossPpe).toBeDefined();
    expect(RAG_THRESHOLDS.arCurrentRate).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// worstStatus + scenario tests — multiple rules combined
// ---------------------------------------------------------------------------

describe("RAG rule — worstStatus across multiple rules", () => {
  it("any red → red", () => {
    expect(worstStatus([greenResult(), redResult()])).toBe("red");
    expect(worstStatus([redResult(), greenResult(), amberResult()])).toBe("red");
  });
  it("any amber but no red → amber", () => {
    expect(worstStatus([greenResult(), amberResult()])).toBe("amber");
  });
  it("all green → green", () => {
    expect(worstStatus([greenResult(), greenResult()])).toBe("green");
  });
  it("empty results → green (vacuous truth)", () => {
    expect(worstStatus([])).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// Dashboard narrative — derived from rule results; cannot contradict
// ---------------------------------------------------------------------------

describe("RAG rule — buildRagDashboardNarrative", () => {
  function healthyDataset(): RagRuleResult[] {
    return [
      classifyOperatingRevenueVariance({ actual: 15_300_000, budget: 15_000_000 }),
      classifyNoiVariance({ actual: 1_000_000, budget: 800_000 }),
      classifyCapitalIncome({ actual: 2_100_000, budget: 2_000_000 }),
      classifyReserveCoverage({ ratio: 1.42, policyFloor: 1.25 }),
      classifyDuesToRevenue({ duesRevenue: 10_500_000, totalRevenue: 15_000_000 }),
      classifyDebtServiceCoverage({ operatingCashFlow: 1_500_000, annualDebtService: 1_000_000 }),
      classifyNetToGrossPpe({ netPpe: 14_000_000, grossPpe: 25_000_000 }),
      classifyArCurrentRate({ currentBucket: 850_000, totalAR: 1_000_000 }),
    ];
  }

  function mixedDataset(): RagRuleResult[] {
    return [
      // Revenue +2% — green
      classifyOperatingRevenueVariance({ actual: 15_300_000, budget: 15_000_000 }),
      // NOI on plan — green
      classifyNoiVariance({ actual: 50_000, budget: 0 }),
      // Capital income materially down — RED
      classifyCapitalIncome({ actual: 1_500_000, budget: 2_000_000 }),
      // Reserve coverage at floor − 3% — AMBER
      classifyReserveCoverage({ ratio: 1.21, policyFloor: 1.25 }),
      // Dues-to-revenue 65% — green
      classifyDuesToRevenue({ duesRevenue: 9_750_000, totalRevenue: 15_000_000 }),
      // Debt service 1.05x — AMBER
      classifyDebtServiceCoverage({ operatingCashFlow: 1_050_000, annualDebtService: 1_000_000 }),
      // PP&E 32% — RED
      classifyNetToGrossPpe({ netPpe: 8_000_000, grossPpe: 25_000_000 }),
      // AR 78% — AMBER
      classifyArCurrentRate({ currentBucket: 780_000, totalAR: 1_000_000 }),
    ];
  }

  function offPlanDataset(): RagRuleResult[] {
    return [
      // Revenue −8% — RED
      classifyOperatingRevenueVariance({ actual: 13_800_000, budget: 15_000_000 }),
      // NOI well below plan — RED
      classifyNoiVariance({ actual: -300_000, budget: 0 }),
      // Capital income materially down — RED
      classifyCapitalIncome({ actual: 1_400_000, budget: 2_000_000 }),
      // Reserve below 95% of floor — RED
      classifyReserveCoverage({ ratio: 1.00, policyFloor: 1.25 }),
      classifyDuesToRevenue({ duesRevenue: 8_400_000, totalRevenue: 15_000_000 }), // 56% — AMBER
      classifyDebtServiceCoverage({ operatingCashFlow: 800_000, annualDebtService: 1_000_000 }), // RED
      classifyNetToGrossPpe({ netPpe: 8_000_000, grossPpe: 25_000_000 }), // RED
      classifyArCurrentRate({ currentBucket: 600_000, totalAR: 1_000_000 }), // RED
    ];
  }

  it("HEALTHY dataset → narrative opens 'All N metrics are within policy thresholds' and closes 'No Board action'", () => {
    const narrative = buildRagDashboardNarrative(healthyDataset());
    expect(narrative).toMatch(/All 8 monitored metrics are within policy thresholds/);
    expect(narrative).toMatch(/No Board action is required this period/);
    // CANNOT contain words like "outside policy" or "Board attention" — there's no red.
    expect(narrative).not.toMatch(/outside policy/);
    expect(narrative).not.toMatch(/Board attention is required/);
  });

  it("MIXED dataset (2 red, 3 amber) → narrative names every red rule + closes 'Board attention required'", () => {
    const results = mixedDataset();
    const narrative = buildRagDashboardNarrative(results);
    // Both red rules named explicitly.
    expect(narrative).toMatch(/Capital Income vs Budget/);
    expect(narrative).toMatch(/Net-to-Gross PP&E Ratio/);
    // Both red rules' explanations included.
    for (const red of results.filter((r) => r.status === "red")) {
      expect(narrative).toContain(red.explanation);
    }
    // Closing action statement reflects worst tone (red present).
    expect(narrative).toMatch(/Board attention is required this period/);
    expect(narrative).not.toMatch(/No Board action is required/);
  });

  it("OFF-PLAN dataset (7 reds) → narrative classifies all 7 and demands Board attention", () => {
    const results = offPlanDataset();
    const narrative = buildRagDashboardNarrative(results);
    expect(narrative).toMatch(/Board attention is required/);
    // Every red rule is named.
    for (const red of results.filter((r) => r.status === "red")) {
      expect(narrative).toContain(red.label);
    }
    // None of the green-state phrases appear.
    expect(narrative).not.toMatch(/within policy thresholds/);
  });

  it("CONTRADICTION GUARD — when any rule is RED, the narrative cannot contain 'within policy' or 'No Board action'", () => {
    // Flip one rule from healthy to red; the narrative must change tone.
    const healthy = healthyDataset();
    const flipped = healthy.map((r, i) =>
      i === 0 ? classifyOperatingRevenueVariance({ actual: 13_500_000, budget: 15_000_000 }) : r,
    );
    const narrative = buildRagDashboardNarrative(flipped);
    expect(narrative).not.toMatch(/within policy thresholds/);
    expect(narrative).not.toMatch(/No Board action/);
    expect(narrative).toMatch(/Board attention/);
  });

  it("FLIP RULE — narrative changes when a single rule transitions green → red", () => {
    const before = healthyDataset();
    const after = before.map((r, i) =>
      i === 3 // reserve coverage
        ? classifyReserveCoverage({ ratio: 1.00, policyFloor: 1.25 })
        : r,
    );
    const beforeNarrative = buildRagDashboardNarrative(before);
    const afterNarrative = buildRagDashboardNarrative(after);
    expect(beforeNarrative).not.toBe(afterNarrative);
    expect(afterNarrative).toContain("Capital Reserve Coverage");
    expect(afterNarrative).toMatch(/Board attention is required/);
  });

  it("EMPTY input → safe fallback message; no claim of policy compliance", () => {
    const narrative = buildRagDashboardNarrative([]);
    expect(narrative).toMatch(/No stewardship metrics have been evaluated/);
    expect(narrative).not.toMatch(/within policy thresholds/);
    expect(narrative).not.toMatch(/Board action/);
  });
});

// ---------------------------------------------------------------------------
// Adapter — rule results → KPI tones (for existing dashboard notes)
// ---------------------------------------------------------------------------

describe("RAG rule — ruleResultsToKpiTones adapter", () => {
  it("maps each result to {key, name, tone} matching the legacy KpiTone shape", () => {
    const results: RagRuleResult[] = [
      classifyOperatingRevenueVariance({ actual: 15_300_000, budget: 15_000_000 }),
      classifyCapitalIncome({ actual: 1_500_000, budget: 2_000_000 }),
    ];
    const tones = ruleResultsToKpiTones(results);
    expect(tones).toHaveLength(2);
    expect(tones[0]).toEqual({
      key: "operating-revenue-variance",
      name: "Operating Revenue Variance",
      tone: "green",
    });
    expect(tones[1]).toEqual({
      key: "capital-income",
      name: "Capital Income vs Budget",
      tone: "red",
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function greenResult(): RagRuleResult {
  return classifyOperatingRevenueVariance({ actual: 15_000_000, budget: 15_000_000 });
}
function amberResult(): RagRuleResult {
  return classifyOperatingRevenueVariance({ actual: 14_500_000, budget: 15_000_000 });
}
function redResult(): RagRuleResult {
  return classifyOperatingRevenueVariance({ actual: 13_500_000, budget: 15_000_000 });
}
