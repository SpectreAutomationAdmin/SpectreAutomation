// Reactive CFO Commentary generator + service-shape tests for the
// chapter IV Statement of Activities. Per CLAUDE.md `Reactive
// Commentary for Financial Reporting — Mandatory`, the generator
// must branch on the underlying NOI / revenue / payroll / capital
// inputs so the prose changes when the data changes, and every
// figure quoted must reconcile to a number on the table above.

import { describe, it, expect } from "vitest";

import {
  buildCfoCommentary,
  buildSilverSpringsStatementOfActivities,
  type CfoCommentaryInputs,
} from "@/lib/reporting/statement-of-activities";
import {
  buildReportingPeriod,
} from "@/lib/reporting/reporting-period";

// Canonical demo period used by every test below — May 31, 2026
// UTC, matching the Silver Springs Monthly Reporting Package's
// default period. Period regression tests below override this to
// prove the section reacts to a different period.
const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
const SILVER_SPRINGS = "Silver Springs Golf & Country Club";

const BASE_INPUTS: CfoCommentaryInputs = {
  noiBudget:        253_591,
  noiActual:        253_460,
  noiVariance:      -131,
  noiVariancePct:   -0.001,
  revenueVariance:  64_637,
  payrollVariance:  -31_896,
  otherOpExpVariance: -91_423,
  memberRoundsYoyPct: 0.30,
  initiationFeesYtd: 480_000,
  initiationFeesAnnualForecast: 2_160_000,
  capitalDuesBudget: 480_000,
  capitalDuesActual: 480_000,
  periodLabel: "Q1 2026",
};

describe("buildCfoCommentary — reactive CFO bullets", () => {
  it("returns 4 bullets in the canonical order: operating verdict, golf context, capital, two-fund framing", () => {
    const out = buildCfoCommentary(BASE_INPUTS);
    expect(out.bullets).toHaveLength(4);
    expect(out.eyebrow).toMatch(/Q1 2026/);
    // Each bullet must be a multi-sentence paragraph ending in a period.
    for (const bullet of out.bullets) {
      const sentences = bullet.text.split(/\. /);
      expect(sentences.length, `each bullet must be multi-sentence`).toBeGreaterThanOrEqual(2);
      expect(bullet.text.trim().endsWith(".")).toBe(true);
    }
  });

  it("operating bullet — 'essentially on plan' when |NOI variance pct| < 1%", () => {
    const out = buildCfoCommentary(BASE_INPUTS);
    const op = out.bullets[0];
    expect(op.text).toMatch(/essentially on plan/);
    expect(op.text).toMatch(/-0\.1%/);
    expect(op.text).toMatch(/operating precisely as designed/);
  });

  it("operating bullet — escalates to 'unfavourable to plan' when NOI variance turns negative material", () => {
    const out = buildCfoCommentary({
      ...BASE_INPUTS,
      noiActual: 130_000,
      noiVariance: -123_591,
      noiVariancePct: -0.487,
    });
    const op = out.bullets[0];
    expect(op.text).toMatch(/running unfavourable to plan/);
    expect(op.text).toMatch(/-48\.7%/);
    expect(op.text).toMatch(/board should evaluate against authorised scope/);
  });

  it("operating bullet — names favourable revenue + payroll + other-opex drivers in $K context", () => {
    const out = buildCfoCommentary(BASE_INPUTS);
    const op = out.bullets[0];
    expect(op.text).toMatch(/\$65K favourable revenue variance/);
    expect(op.text).toMatch(/\$32K in payroll/);
    expect(op.text).toMatch(/\$91K in other operating expenses/);
  });

  it("golf bullet — names the member-rounds YoY percentage from the input", () => {
    const out = buildCfoCommentary(BASE_INPUTS);
    const golf = out.bullets[1];
    expect(golf.text).toMatch(/30% over prior year/);
    expect(golf.text).toMatch(/quality-of-experience outcome/);
  });

  it("golf bullet — reactive to a different rounds YoY input", () => {
    const out = buildCfoCommentary({ ...BASE_INPUTS, memberRoundsYoyPct: 0.18 });
    const golf = out.bullets[1];
    expect(golf.text).toMatch(/18% over prior year/);
  });

  it("capital bullet — 'on plan' when capital dues actual equals budget", () => {
    const out = buildCfoCommentary(BASE_INPUTS);
    const capital = out.bullets[2];
    expect(capital.text).toMatch(/Capital dues of \$480,000 are on plan/);
    expect(capital.text).toMatch(/most structurally important capital revenue source/);
  });

  it("capital bullet — tracking-against-plan language when capital dues actual ≠ budget", () => {
    const out = buildCfoCommentary({
      ...BASE_INPUTS,
      capitalDuesActual: 420_000,
    });
    const capital = out.bullets[2];
    expect(capital.text).toMatch(/Capital dues of \$420,000 are tracking against plan/);
  });

  it("capital bullet — 'slightly behind YTD budget' when initiation YTD < annual forecast", () => {
    const out = buildCfoCommentary(BASE_INPUTS);
    const capital = out.bullets[2];
    expect(capital.text).toMatch(/Initiation fees of \$480,000 are slightly behind YTD budget/);
  });

  it("capital bullet — 'ahead of YTD budget' when initiation YTD >= annual forecast pace", () => {
    const out = buildCfoCommentary({
      ...BASE_INPUTS,
      initiationFeesYtd: 2_500_000,
      initiationFeesAnnualForecast: 2_160_000,
    });
    const capital = out.bullets[2];
    expect(capital.text).toMatch(/ahead of YTD budget/);
  });

  it("two-fund framing bullet — constant board-report language", () => {
    const out = buildCfoCommentary(BASE_INPUTS);
    const framing = out.bullets[3];
    expect(framing.text).toMatch(/separates operating stewardship from capital stewardship/);
    expect(framing.text).toMatch(/living within its means/);
    expect(framing.text).toMatch(/funding its obligations to future members/);
  });

  it("input sensitivity — flipping any meaningful input changes the rendered prose", () => {
    const baseline = buildCfoCommentary(BASE_INPUTS);
    const baselineSig = baseline.bullets.map((b) => b.text).join("\n");

    const opFlip = buildCfoCommentary({ ...BASE_INPUTS, noiVariancePct: -0.15, noiVariance: -38_000 });
    expect(opFlip.bullets.map((b) => b.text).join("\n")).not.toBe(baselineSig);

    const golfFlip = buildCfoCommentary({ ...BASE_INPUTS, memberRoundsYoyPct: 0.08 });
    expect(golfFlip.bullets.map((b) => b.text).join("\n")).not.toBe(baselineSig);

    const capitalFlip = buildCfoCommentary({ ...BASE_INPUTS, capitalDuesActual: 420_000 });
    expect(capitalFlip.bullets.map((b) => b.text).join("\n")).not.toBe(baselineSig);
  });
});

describe("buildSilverSpringsStatementOfActivities — service contract", () => {
  it("ships the full Saguaro-style header chrome (eyebrow, title, period, intro, statement #, document chip, prepared-for) — period flows from ReportingPeriod", () => {
    const soa = buildSilverSpringsStatementOfActivities({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(soa.eyebrow).toMatch(/Silver Springs/);
    expect(soa.eyebrow).toMatch(/Financial Statement/);
    expect(soa.title).toBe("Statement of Activities — Two-Fund Format");
    // Period header MUST flow from ReportingPeriod.statementHeaderLabel —
    // no Q1 / March / quarter strings allowed.
    expect(soa.periodLabel).toBe("May 2026 · For the period ended May 31, 2026 · Year to Date");
    expect(soa.periodLabel).not.toMatch(/Q1/);
    expect(soa.periodLabel).not.toMatch(/March/);
    expect(soa.statementNumber).toMatch(/Statement 04 of 14/);
    expect(soa.documentChip).toBe("Financial Statement");
    expect(soa.preparedFor).toBe("Finance Committee");
    expect(soa.introNote).toMatch(/Operating revenues and expenses above the NOI line/);
  });

  it("ships all 8 column headers — current-month columns flow from ReportingPeriod", () => {
    const soa = buildSilverSpringsStatementOfActivities({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(soa.columnHeaders.category).toBe("Category");
    // Current-month headers MUST flow from ReportingPeriod.columnLabels.
    // For May 2026, that's "May Budget / May Actual / May Var".
    expect(soa.columnHeaders.currentBudget).toBe("May Budget");
    expect(soa.columnHeaders.currentActual).toBe("May Actual");
    expect(soa.columnHeaders.currentVariance).toBe("May Var");
    expect(soa.columnHeaders.ytdBudget).toBe("YTD Budget");
    expect(soa.columnHeaders.ytdActual).toBe("YTD Actual");
    expect(soa.columnHeaders.ytdVariance).toBe("YTD Var");
    expect(soa.columnHeaders.variancePct).toBe("% Var");
  });

  it("REGRESSION: Statement of Activities updates dynamically when the reporting period changes (Mar 2026 → all headers shift to Mar)", () => {
    // The Reporting Period Golden Rule says every section must be
    // active and responsive to the selected report period. This test
    // proves the Statement of Activities does: feed a different
    // period, and every period-derived field flips with it.
    const MAR_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 2, 31)));
    const soa = buildSilverSpringsStatementOfActivities({ clubName: SILVER_SPRINGS, period: MAR_2026 });
    expect(soa.periodLabel).toBe("March 2026 · For the period ended March 31, 2026 · Year to Date");
    expect(soa.columnHeaders.currentBudget).toBe("Mar Budget");
    expect(soa.columnHeaders.currentActual).toBe("Mar Actual");
    expect(soa.columnHeaders.currentVariance).toBe("Mar Var");
    expect(soa.cfoCommentary.eyebrow).toBe("CFO Commentary — March 2026");
    // YTD column labels stay constant by design (year-to-date is a
    // window descriptor, not a month label).
    expect(soa.columnHeaders.ytdBudget).toBe("YTD Budget");
    expect(soa.columnHeaders.ytdActual).toBe("YTD Actual");
    expect(soa.columnHeaders.ytdVariance).toBe("YTD Var");
  });

  it("REGRESSION: another period flip (Dec 2026) propagates verbatim to every period-derived field", () => {
    const DEC_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 11, 31)));
    const soa = buildSilverSpringsStatementOfActivities({ clubName: SILVER_SPRINGS, period: DEC_2026 });
    expect(soa.periodLabel).toBe("December 2026 · For the period ended December 31, 2026 · Year to Date");
    expect(soa.columnHeaders.currentBudget).toBe("Dec Budget");
    expect(soa.columnHeaders.currentActual).toBe("Dec Actual");
    expect(soa.columnHeaders.currentVariance).toBe("Dec Var");
    expect(soa.cfoCommentary.eyebrow).toBe("CFO Commentary — December 2026");
  });

  it("ships every operating section the founder named (Operating Revenue / Golf Ops / F&B / Amenities / Total Op Revenue / Operating Expenses + NOI band + Depreciation + NOI After)", () => {
    const soa = buildSilverSpringsStatementOfActivities({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const kinds = soa.operatingRows.map((r) => `${r.kind}:${r.key}`);
    expect(kinds).toContain("section-band:band-dues");
    expect(kinds).toContain("section-band:band-golf");
    expect(kinds).toContain("section-band:band-fnb");
    expect(kinds).toContain("section-band:band-amenities");
    expect(kinds).toContain("total:total-operating-revenue");
    expect(kinds).toContain("section-band:band-opex");
    expect(kinds).toContain("noi-band:noi-before-dep");
    expect(kinds).toContain("depreciation:depreciation");
    expect(kinds).toContain("noi-after:noi-after-dep");
  });

  it("ships the capital divider + capital subsections + Net Income (Loss) — Combined", () => {
    const soa = buildSilverSpringsStatementOfActivities({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const kinds = soa.capitalRows.map((r) => `${r.kind}:${r.key}`);
    expect(kinds).toContain("capital-divider:capital-divider");
    expect(kinds).toContain("capital-intro:capital-intro");
    expect(kinds).toContain("capital-band:band-initiation");
    expect(kinds).toContain("capital-band:band-capital-dues");
    expect(kinds).toContain("capital-band:band-investment");
    expect(kinds).toContain("capital-band:band-capital-expenses");
    expect(kinds).toContain("capital-total:total-capital");
    expect(kinds).toContain("net-combined:net-combined");
  });

  it("seeds the founder-named row values verbatim from the Saguaro reference", () => {
    const soa = buildSilverSpringsStatementOfActivities({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const guestFees = soa.operatingRows.find((r) => r.key === "golf-guest-fees")!;
    // YTD: actual 123,401 vs budget 168,750 → variance (45,349), -26.9%
    expect(guestFees.values!.ytdActual).toBe(123_401);
    expect(guestFees.values!.ytdBudget).toBe(168_750);
    expect(guestFees.values!.ytdVariance).toBe(-45_349);
    expect(guestFees.values!.variancePct).toBeCloseTo(-0.269, 2);

    const noi = soa.operatingRows.find((r) => r.key === "noi-before-dep")!;
    expect(noi.values!.ytdActual).toBe(253_460);
    expect(noi.values!.ytdBudget).toBe(253_591);

    const capitalDues = soa.capitalRows.find((r) => r.key === "capital-dues")!;
    expect(capitalDues.values!.ytdActual).toBe(480_000);
    expect(capitalDues.values!.ytdBudget).toBe(480_000);
    expect(capitalDues.chip?.label).toBe("On Plan");
    expect(capitalDues.chip?.tone).toBe("on-plan");
  });

  it("inline commentary rows render for the Saguaro reference's named lines", () => {
    const soa = buildSilverSpringsStatementOfActivities({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const commentaryKeys = [...soa.operatingRows, ...soa.capitalRows]
      .filter((r) => r.kind === "commentary")
      .map((r) => r.key);
    expect(commentaryKeys).toContain("golf-guest-fees-comment");
    expect(commentaryKeys).toContain("cogs-food-comment");
    expect(commentaryKeys).toContain("cogs-beverage-comment");
    expect(commentaryKeys).toContain("golf-other-exp-comment");
    expect(commentaryKeys).toContain("initiation-fees-comment");
    expect(commentaryKeys).toContain("capital-dues-comment");
  });

  it("CFO commentary is REACTIVE — scraped off the row dataset, not a hardcoded snippet", () => {
    const soa = buildSilverSpringsStatementOfActivities({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    // Operating bullet must quote the NOI actual & budget on the row above.
    const noi = soa.operatingRows.find((r) => r.key === "noi-before-dep")!.values!;
    expect(soa.cfoCommentary.bullets[0].text).toContain(`$${noi.ytdActual!.toLocaleString("en-US")}`);
    expect(soa.cfoCommentary.bullets[0].text).toContain(`$${noi.ytdBudget!.toLocaleString("en-US")}`);
    // Capital bullet must quote the capital dues actual.
    const capitalDues = soa.capitalRows.find((r) => r.key === "capital-dues")!.values!;
    expect(soa.cfoCommentary.bullets[2].text).toContain(`$${capitalDues.ytdActual!.toLocaleString("en-US")}`);
  });
});
