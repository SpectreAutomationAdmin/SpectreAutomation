// Board Attention Engine — unit tests.
//
// Pure-function module: no DB, no fixtures, no setup. Each test is a
// direct assertion against the engine's public surface.

import { describe, it, expect } from "vitest";
import {
  evaluateRule,
  evaluateMetric,
  rollupChapter,
  rollupDashboard,
  worstOf,
  countFlagged,
  labelFor,
  kpiToneFor,
  DEFAULT_THRESHOLDS,
  type Attention,
  type ThresholdRule,
} from "@/lib/reporting/attention";

describe("evaluateRule — higher-better", () => {
  const rule: ThresholdRule = { kind: "higher-better", greenAt: 80, redAt: 70 };
  it("returns GREEN when value ≥ greenAt", () => {
    expect(evaluateRule(rule, 80)).toBe("green");
    expect(evaluateRule(rule, 95)).toBe("green");
  });
  it("returns RED when value ≤ redAt", () => {
    expect(evaluateRule(rule, 70)).toBe("red");
    expect(evaluateRule(rule, 50)).toBe("red");
  });
  it("returns YELLOW in the middle band", () => {
    expect(evaluateRule(rule, 75)).toBe("yellow");
    expect(evaluateRule(rule, 79)).toBe("yellow");
  });
});

describe("evaluateRule — lower-better", () => {
  const rule: ThresholdRule = { kind: "lower-better", greenAt: 6, redAt: 9 };
  it("returns GREEN when value ≤ greenAt", () => {
    expect(evaluateRule(rule, 6)).toBe("green");
    expect(evaluateRule(rule, 3)).toBe("green");
  });
  it("returns RED when value ≥ redAt", () => {
    expect(evaluateRule(rule, 9)).toBe("red");
    expect(evaluateRule(rule, 12)).toBe("red");
  });
  it("returns YELLOW between greenAt and redAt", () => {
    expect(evaluateRule(rule, 7)).toBe("yellow");
    expect(evaluateRule(rule, 8.5)).toBe("yellow");
  });
});

describe("evaluateRule — band-bounded", () => {
  const rule: ThresholdRule = { kind: "band-bounded", min: 38, max: 44, tolerance: 2 };
  it("returns GREEN inside the band", () => {
    expect(evaluateRule(rule, 38)).toBe("green");
    expect(evaluateRule(rule, 41)).toBe("green");
    expect(evaluateRule(rule, 44)).toBe("green");
  });
  it("returns YELLOW within tolerance of the edge", () => {
    expect(evaluateRule(rule, 37)).toBe("yellow");  // below min, within tolerance
    expect(evaluateRule(rule, 45)).toBe("yellow");  // above max, within tolerance
  });
  it("returns RED outside the band + tolerance", () => {
    expect(evaluateRule(rule, 35)).toBe("red");
    expect(evaluateRule(rule, 50)).toBe("red");
  });
});

describe("evaluateRule — vs-benchmark", () => {
  const rule: ThresholdRule = { kind: "vs-benchmark", greenAtPct: 0, redAtPct: -10 };
  it("returns GREEN at or above benchmark", () => {
    expect(evaluateRule(rule, 0)).toBe("green");
    expect(evaluateRule(rule, 6.5)).toBe("green");
  });
  it("returns RED at or below redAtPct", () => {
    expect(evaluateRule(rule, -10)).toBe("red");
    expect(evaluateRule(rule, -15)).toBe("red");
  });
  it("returns YELLOW between greenAtPct and redAtPct", () => {
    expect(evaluateRule(rule, -1.4)).toBe("yellow");
    expect(evaluateRule(rule, -5)).toBe("yellow");
  });
});

describe("evaluateMetric — uses DEFAULT_THRESHOLDS", () => {
  it("Revenue +3.7% above plan → GREEN", () => {
    expect(evaluateMetric("operations.revenue", 3.7)).toBe("green");
  });
  it("AR Current 78.4% (target ≥ 80%) → YELLOW", () => {
    expect(evaluateMetric("financial.ar-current", 78.4)).toBe("yellow");
  });
  it("Working Capital $4.71M (floor $3.50M) → GREEN", () => {
    expect(evaluateMetric("financial.working-capital", 4.71)).toBe("green");
  });
  it("Covers -1.4% (cover softness) → YELLOW", () => {
    expect(evaluateMetric("experience.covers", -1.4)).toBe("yellow");
  });
  it("Attrition 5.7% TTM (peer 6%) → GREEN", () => {
    expect(evaluateMetric("membership.attrition-ttm", 5.7)).toBe("green");
  });
});

describe("evaluateMetric — threshold override", () => {
  it("uses overrides when provided", () => {
    const overrides = {
      "test.metric": { kind: "higher-better", greenAt: 100, redAt: 80 } as ThresholdRule,
    };
    expect(evaluateMetric("test.metric", 100, overrides)).toBe("green");
    expect(evaluateMetric("test.metric", 90, overrides)).toBe("yellow");
    expect(evaluateMetric("test.metric", 80, overrides)).toBe("red");
  });
  it("defaults to GREEN for missing metric key (defensive fallback)", () => {
    // Console warning is expected in dev; we don't assert on it here.
    expect(evaluateMetric("nonexistent.metric", 999)).toBe("green");
  });
});

describe("worstOf + rollupChapter + rollupDashboard", () => {
  it("worstOf empty array → green", () => {
    expect(worstOf([])).toBe("green");
  });
  it("worstOf all green → green", () => {
    expect(worstOf(["green", "green", "green"])).toBe("green");
  });
  it("worstOf any yellow → yellow", () => {
    expect(worstOf(["green", "yellow", "green"])).toBe("yellow");
  });
  it("worstOf any red → red (even with yellow + green)", () => {
    expect(worstOf(["green", "yellow", "red"])).toBe("red");
  });
  it("rollupChapter is alias for worstOf", () => {
    expect(rollupChapter(["yellow", "green"])).toBe("yellow");
  });
  it("rollupDashboard rolls across chapters", () => {
    expect(rollupDashboard(["green", "green", "yellow", "green", "green"])).toBe("yellow");
  });
});

describe("countFlagged", () => {
  it("counts non-green attentions", () => {
    expect(countFlagged(["green", "yellow", "green", "red", "yellow"])).toBe(3);
    expect(countFlagged(["green", "green", "green"])).toBe(0);
    expect(countFlagged([])).toBe(0);
  });
});

describe("labelFor — pillar-specific vocabulary", () => {
  it("Operations: On Plan / Watch / Off Plan", () => {
    expect(labelFor("operations", "green")).toBe("On Plan");
    expect(labelFor("operations", "yellow")).toBe("Watch");
    expect(labelFor("operations", "red")).toBe("Off Plan");
  });
  it("Financial: Strong Position / Stable / Concern", () => {
    expect(labelFor("financial", "green")).toBe("Strong Position");
    expect(labelFor("financial", "yellow")).toBe("Stable");
    expect(labelFor("financial", "red")).toBe("Concern");
  });
  it("Capital: Executing / Watch / Delayed", () => {
    expect(labelFor("capital", "green")).toBe("Executing");
    expect(labelFor("capital", "yellow")).toBe("Monitor");
    expect(labelFor("capital", "red")).toBe("Delayed");
  });
  it("Membership: Healthy / Watch / At Risk", () => {
    expect(labelFor("membership", "green")).toBe("Healthy");
    expect(labelFor("membership", "yellow")).toBe("Watch");
    expect(labelFor("membership", "red")).toBe("At Risk");
  });
  it("Experience: Healthy / Watch / Concern", () => {
    expect(labelFor("experience", "green")).toBe("Healthy");
    expect(labelFor("experience", "yellow")).toBe("Watch");
    expect(labelFor("experience", "red")).toBe("Concern");
  });
});

describe("kpiToneFor", () => {
  it("yellow maps to amber (legacy palette token)", () => {
    expect(kpiToneFor("yellow")).toBe("amber");
  });
  it("green and red pass through", () => {
    expect(kpiToneFor("green")).toBe("green");
    expect(kpiToneFor("red")).toBe("red");
  });
});

describe("DEFAULT_THRESHOLDS coverage", () => {
  // The 20 metric keys the engine drives across the 5 pillar panels.
  const REQUIRED_KEYS = [
    // Operations
    "operations.revenue", "operations.noi", "operations.payroll-ratio", "operations.dues-to-revenue",
    // Financial
    "financial.working-capital", "financial.current-ratio", "financial.reserve-coverage", "financial.ar-current",
    // Capital
    "capital.capital-spend-pct", "capital.projects-active", "capital.projects-delayed", "capital.reserve-contributions-pct",
    // Membership
    "membership.member-count-vs-target-pct", "membership.waitlist", "membership.new-members-vs-target-pct", "membership.attrition-ttm",
    // Experience
    "experience.rounds", "experience.covers", "experience.average-check", "experience.fb-subsidy",
  ];
  it.each(REQUIRED_KEYS)("DEFAULT_THRESHOLDS carries %s", (key) => {
    expect(DEFAULT_THRESHOLDS[key], `missing threshold for ${key}`).toBeDefined();
  });
});
