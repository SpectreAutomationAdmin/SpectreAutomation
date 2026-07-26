// Departmental P&L Summary service tests — shape + tone + period
// sensitivity (no Q1/March/January hardcodes; period-aware copy in
// metric values + notes).

import { describe, it, expect } from "vitest";

import { buildSilverSpringsDepartmentalPLSummary } from "@/lib/reporting/departmental-pl-summary";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
const SILVER_SPRINGS = "Silver Springs Golf & Country Club";

describe("buildSilverSpringsDepartmentalPLSummary — service contract", () => {
  it("ships the Saguaro header chrome — period derived from ReportingPeriod (no Q1/March hardcodes)", () => {
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpl.eyebrow).toBe("Silver Springs Golf & Country Club · Departmental Detail");
    expect(dpl.title).toBe("Departmental P&L Summary");
    expect(dpl.periodLabel).toBe("May 2026 · For the period ended May 31, 2026 · Year to Date");
    expect(dpl.periodLabel).not.toMatch(/\bQ1\b/);
    expect(dpl.periodLabel).not.toMatch(/\bMarch\b/);
    expect(dpl.statementNumber).toBe("Statement 08 of 14");
    expect(dpl.documentChip).toBe("Departmental Detail");
    expect(dpl.preparedFor).toBe("Management Level");
    expect(dpl.introNote).toMatch(/How each department is performing/);
  });

  it("ships the management-document notice with the documented copy", () => {
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpl.managementNotice.eyebrow).toBe("Management Document");
    expect(dpl.managementNotice.body).toMatch(/department-level detail for GM/);
    expect(dpl.managementNotice.body).toMatch(/board receives the combined statement/);
    expect(dpl.managementNotice.body).toMatch(/board-level resource decisions/);
  });

  it("renders 6 department cards in canonical order", () => {
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpl.cards).toHaveLength(6);
    expect(dpl.cards.map((c) => c.key)).toEqual([
      "food-beverage",
      "golf-operations",
      "fitness-center",
      "racquet-operations",
      "aquatics-pool",
      "ga-administration",
    ]);
    expect(dpl.cards.map((c) => c.name)).toEqual([
      "Food & Beverage",
      "Golf Operations",
      "Fitness Center",
      "Racquet Operations",
      "Aquatics & Pool",
      "G&A & Administration",
    ]);
  });

  it("each department card carries a header pill with the documented tone", () => {
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const pillByKey = Object.fromEntries(dpl.cards.map((c) => [c.key, c.pill]));
    expect(pillByKey["food-beverage"]).toEqual({ label: "+$22K YTD", tone: "favorable" });
    expect(pillByKey["golf-operations"]).toEqual({ label: "−$30K YTD", tone: "risk" });
    expect(pillByKey["fitness-center"]).toEqual({ label: "−$10K YTD", tone: "risk" });
    expect(pillByKey["racquet-operations"]).toEqual({ label: "+9% vs. PY", tone: "favorable" });
    expect(pillByKey["aquatics-pool"]).toEqual({ label: "+$4K YTD", tone: "favorable" });
    expect(pillByKey["ga-administration"]).toEqual({ label: "−$30K YTD", tone: "risk" });
  });

  it("Food & Beverage carries the 6 documented metric rows", () => {
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const fb = dpl.cards.find((c) => c.key === "food-beverage")!;
    expect(fb.rows.map((r) => r.key)).toEqual([
      "revenue-ytd",
      "vs-budget",
      "food-cost-pct-ytd",
      "bev-cost-pct-ytd",
      "net-result-vs-budget",
      "ytd-covers",
    ]);
    expect(fb.rows.find((r) => r.key === "revenue-ytd")!.value).toBe("$732,493");
    expect(fb.rows.find((r) => r.key === "vs-budget")!.value).toBe("+$61,730");
    expect(fb.rows.find((r) => r.key === "vs-budget")!.tone).toBe("favorable");
    expect(fb.rows.find((r) => r.key === "ytd-covers")!.value).toBe("12,390");
  });

  it("Golf Operations Member-Rounds-vs-PY value flows from period.monthLong (May → '(May)', NOT '(March)')", () => {
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const golf = dpl.cards.find((c) => c.key === "golf-operations")!;
    const memberRounds = golf.rows.find((r) => r.key === "member-rounds-vs-py")!;
    expect(memberRounds.value).toBe("+30% (May)");
    expect(memberRounds.value).not.toMatch(/\(March\)/);
    expect(memberRounds.tone).toBe("favorable");
  });

  it("Fitness Center Expect Resolution flows from period.nextYearQuarterLabel (May 2026 → Q3 2026, NOT Q2 2026)", () => {
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const fit = dpl.cards.find((c) => c.key === "fitness-center")!;
    const resolution = fit.rows.find((r) => r.key === "expect-resolution")!;
    expect(resolution.value).toBe("Q3 2026");
    expect(resolution.value).not.toMatch(/\bQ2\b/);
  });

  it("Aquatics & Pool Seasonal Outlook flows from period.nextYearQuarterLabel (May 2026 → 'Q3 2026 peak season')", () => {
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const aqua = dpl.cards.find((c) => c.key === "aquatics-pool")!;
    const outlook = aqua.rows.find((r) => r.key === "seasonal-outlook")!;
    expect(outlook.value).toBe("Q3 2026 peak season");
  });

  it("G&A & Administration carries the 6 documented metric rows with correct risk tones", () => {
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const ga = dpl.cards.find((c) => c.key === "ga-administration")!;
    expect(ga.rows.map((r) => r.key)).toEqual([
      "expense-vs-budget",
      "board-approved-bonus",
      "longevity-recognition",
      "legal-professional-fees",
      "structural-concern",
      "payroll-vs-py",
    ]);
    expect(ga.rows.find((r) => r.key === "expense-vs-budget")!.tone).toBe("risk");
    expect(ga.rows.find((r) => r.key === "legal-professional-fees")!.tone).toBe("risk");
    expect(ga.rows.find((r) => r.key === "payroll-vs-py")!.tone).toBe("risk");
    // Neutral chrome metrics.
    expect(ga.rows.find((r) => r.key === "board-approved-bonus")!.value).toBe("Included");
    expect(ga.rows.find((r) => r.key === "structural-concern")!.value).toBe("No — authorized");
  });

  it("renders 2 department notes with arrow-bullet copy", () => {
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpl.notes.eyebrow).toBe("Department Notes");
    expect(dpl.notes.items).toHaveLength(2);
    expect(dpl.notes.items[0].text).toMatch(/Course Maintenance expenses are \$7\.5K unfavorable/);
    expect(dpl.notes.items[1].text).toMatch(/Facilities and Maintenance is \$12\.6K favorable/);
  });

  it("Facilities & Maintenance note quotes the period's CURRENT quarter (May 2026 → Q2 2026, NOT a hardcoded Q1)", () => {
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const facilitiesNote = dpl.notes.items[1].text;
    expect(facilitiesNote).toMatch(/in Q2 2026 relative to budget/);
    expect(facilitiesNote).not.toMatch(/\bin Q1\b/);
  });

  it("no reference-attribution footer text (Saguaro / Financially Astute / hypothetical)", () => {
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const surface = JSON.stringify(dpl);
    expect(surface).not.toMatch(/Saguaro/i);
    expect(surface).not.toMatch(/Financially Astute/i);
    expect(surface).not.toMatch(/Hypothetical Illustration/i);
    expect(surface).not.toMatch(/financiallyastuteclubs/);
  });

  it("REGRESSION: March 2026 period flips Member-Rounds-vs-PY → '+30% (March)' + Fitness Resolution → Q2 2026 + Facilities note → Q1 2026", () => {
    const MAR_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 2, 31)));
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: MAR_2026 });
    expect(dpl.periodLabel).toMatch(/March 2026/);

    const golf = dpl.cards.find((c) => c.key === "golf-operations")!;
    expect(golf.rows.find((r) => r.key === "member-rounds-vs-py")!.value).toBe("+30% (March)");

    const fit = dpl.cards.find((c) => c.key === "fitness-center")!;
    expect(fit.rows.find((r) => r.key === "expect-resolution")!.value).toBe("Q2 2026");

    const aqua = dpl.cards.find((c) => c.key === "aquatics-pool")!;
    expect(aqua.rows.find((r) => r.key === "seasonal-outlook")!.value).toBe("Q2 2026 peak season");

    expect(dpl.notes.items[1].text).toMatch(/in Q1 2026 relative to budget/);
  });

  it("REGRESSION: Dec 2027 → Member-Rounds '(December)' + Fitness Resolution Q1 2028 (Q4 → next-year-Q1 wrap)", () => {
    const DEC_2027 = buildReportingPeriod(new Date(Date.UTC(2027, 11, 31)));
    const dpl = buildSilverSpringsDepartmentalPLSummary({ clubName: SILVER_SPRINGS, period: DEC_2027 });

    const golf = dpl.cards.find((c) => c.key === "golf-operations")!;
    expect(golf.rows.find((r) => r.key === "member-rounds-vs-py")!.value).toBe("+30% (December)");

    const fit = dpl.cards.find((c) => c.key === "fitness-center")!;
    expect(fit.rows.find((r) => r.key === "expect-resolution")!.value).toBe("Q1 2028");

    const aqua = dpl.cards.find((c) => c.key === "aquatics-pool")!;
    expect(aqua.rows.find((r) => r.key === "seasonal-outlook")!.value).toBe("Q1 2028 peak season");

    expect(dpl.notes.items[1].text).toMatch(/in Q4 2027 relative to budget/);
  });
});
