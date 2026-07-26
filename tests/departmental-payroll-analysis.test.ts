// Departmental Payroll Analysis service tests — shape + reactive
// tones + period sensitivity.

import { describe, it, expect } from "vitest";

import { buildSilverSpringsDepartmentalPayrollAnalysis } from "@/lib/reporting/departmental-payroll-analysis";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
const MAR_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 2, 31)));
const SILVER_SPRINGS = "Silver Springs Golf & Country Club";

describe("buildSilverSpringsDepartmentalPayrollAnalysis — service contract", () => {
  it("ships the Saguaro header chrome — period derived from ReportingPeriod (no Q1/March hardcodes for May)", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpa.eyebrow).toBe("Silver Springs Golf & Country Club · Payroll & Compensation");
    expect(dpa.title).toBe("Departmental Payroll Analysis");
    expect(dpa.periodLabel).toMatch(/May 2026/);
    expect(dpa.periodLabel).not.toMatch(/\bQ1\b/);
    expect(dpa.periodLabel).not.toMatch(/\bMarch\b/);
    expect(dpa.statementNumber).toBe("Statement 12 of 14");
    expect(dpa.documentChip).toBe("Payroll & Compensation");
    expect(dpa.preparedFor).toBe("Management & Finance Committee");
    expect(dpa.introNote).toMatch(/Wages and taxes & benefits by department/);
  });

  it("4 KPI cards in canonical order with correct treatments", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpa.kpiCards).toHaveLength(4);
    expect(dpa.kpiCards.map((k) => k.key)).toEqual([
      "ytd-total-payroll",
      "ytd-variance",
      "current-month-payroll",
      "payroll-to-revenue",
    ]);
    expect(dpa.kpiCards[0].treatment).toBe("primary");
    expect(dpa.kpiCards[1].treatment).toBe("favorable");
    expect(dpa.kpiCards[2].treatment).toBe("neutral");
    expect(dpa.kpiCards[3].treatment).toBe("info");
  });

  it("KPI 1 (YTD Total Payroll) reads $3.428M — sum of all 7 department YTD actuals", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const total = dpa.kpiCards.find((k) => k.key === "ytd-total-payroll")!;
    expect(total.valueLabel).toBe("$3.428M");
    expect(total.label).toBe("YTD Total Payroll");
    expect(total.subLabel).toMatch(/All departments/);
  });

  it("KPI 2 (YTD Variance) is favourable +$43.7K with the right tone + sub", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const v = dpa.kpiCards.find((k) => k.key === "ytd-variance")!;
    expect(v.valueLabel).toBe("$43.7K");
    expect(v.label).toBe("YTD Favorable Variance");
    expect(v.valueTone).toBe("favorable");
    expect(v.subLabel).toMatch(/vs\. YTD budget of \$3\.472M/);
  });

  it("KPI 3 ('Current Month Payroll') label flows from period.monthLong (May → 'May Payroll', NOT 'March')", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const m = dpa.kpiCards.find((k) => k.key === "current-month-payroll")!;
    expect(m.label).toBe("May Payroll");
    expect(m.label).not.toMatch(/March/);
    expect(m.valueLabel).toBe("$1.143M");
    expect(m.subLabel).toMatch(/\$14\.1K favorable to month budget/);
  });

  it("KPI 4 (Payroll-to-Revenue) renders as a percentage with the budget benchmark", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const ratio = dpa.kpiCards.find((k) => k.key === "payroll-to-revenue")!;
    expect(ratio.valueLabel).toMatch(/^59\.\d%$/);
    expect(ratio.subLabel).toBe("Club-wide · Budget 58.2%");
  });

  it("7 department rows + Club Total in canonical Saguaro order", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpa.table.rows.map((r) => r.key)).toEqual([
      "golf-ops", "gcm", "fb", "admin", "grounds", "security", "other",
    ]);
    expect(dpa.table.total.key).toBe("club-total");
    expect(dpa.table.total.kind).toBe("total");
    expect(dpa.table.total.label).toBe("Club Total");
  });

  it("Table column headers use period.monthShort for MTD columns (May → 'May Actual'), YTD columns stable", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpa.table.columnHeaders.mtdActual).toBe("May Actual");
    expect(dpa.table.columnHeaders.mtdBudget).toBe("May Budget");
    expect(dpa.table.columnHeaders.mtdVariance).toBe("May Variance");
    expect(dpa.table.columnHeaders.ytdActual).toBe("YTD Actual");
    expect(dpa.table.columnHeaders.ytdBudget).toBe("YTD Budget");
    expect(dpa.table.columnHeaders.ytdVariance).toBe("YTD Variance");
  });

  it("Golf Operations row — Saguaro seed values render with favorable variance tones (MTD + YTD)", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const gops = dpa.table.rows.find((r) => r.key === "golf-ops")!;
    expect(gops.labels.mtdActual).toBe("$152,508");
    expect(gops.labels.mtdBudget).toBe("$157,909");
    expect(gops.labels.mtdVariance).toBe("$5,401");
    expect(gops.tones.mtdVariance).toBe("favorable");
    expect(gops.labels.ytdActual).toBe("$451,248");
    expect(gops.labels.ytdBudget).toBe("$468,900");
    expect(gops.labels.ytdVariance).toBe("$17,652");
    expect(gops.tones.ytdVariance).toBe("favorable");
  });

  it("Golf Course Maintenance row — UNFAVORABLE MTD + YTD render with parens + risk tone", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const gcm = dpa.table.rows.find((r) => r.key === "gcm")!;
    expect(gcm.labels.mtdVariance).toBe("($12,760)");
    expect(gcm.tones.mtdVariance).toBe("risk");
    expect(gcm.labels.ytdVariance).toBe("($28,400)");
    expect(gcm.tones.ytdVariance).toBe("risk");
  });

  it("Club Total row reads $1,142,690 MTD / $3,428,000 YTD with favorable totals", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const t = dpa.table.total;
    expect(t.labels.mtdActual).toBe("$1,142,690");
    expect(t.labels.mtdBudget).toBe("$1,156,789");
    expect(t.labels.mtdVariance).toMatch(/Fav\./);
    expect(t.labels.ytdActual).toBe("$3,428,000");
    expect(t.labels.ytdBudget).toBe("$3,471,700");
    expect(t.labels.ytdVariance).toBe("$43,700 Fav.");
    expect(t.tones.ytdVariance).toBe("favorable");
  });

  it("Chart datasets are derived from the same rows (no separate computation)", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpa.charts.byDepartment).toHaveLength(7);
    const gops = dpa.charts.byDepartment.find((d) => d.key === "golf-ops")!;
    expect(gops.ytdActual).toBe(451_248);
    expect(gops.ytdBudget).toBe(468_900);
    expect(gops.ytdVariance).toBe(17_652);
    expect(gops.ytdVarianceTone).toBe("favorable");
    // Wages + taxes & benefits split sums to YTD actual.
    expect(gops.wages + gops.taxesBenefits).toBe(gops.ytdActual);
  });

  it("Donut shares (7 slices) sum to 1.0 and use brand-palette fills (no hex randomness)", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpa.charts.donutSlices).toHaveLength(7);
    const totalShare = dpa.charts.donutSlices.reduce((s, x) => s + x.share, 0);
    expect(totalShare).toBeCloseTo(1, 5);
    for (const s of dpa.charts.donutSlices) {
      expect(s.fillHex).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("Variance callout names the WORST (GCM −$28.4K) + BEST (F&B +$18.2K) lines explicitly", () => {
    // Founder rule 2026-07-05 v15.8 — variance callout moved
    // from `charts.varianceCallout` to `charts.callouts.variance`
    // (one callout per chart now).
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const c = dpa.charts.callouts.variance.text;
    expect(c).toMatch(/Golf Course Maintenance.*largest unfavorable variance/i);
    expect(c).toMatch(/-\$28\.4K/);
    expect(c).toMatch(/Food & Beverage.*\$18\.2K/);
  });

  // v15.8 — every chart in the Payroll grid has an executive
  // commentary that is generated dynamically from the report data.
  it("v15.8 — service emits an executive callout for EVERY chart in the grid", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const callouts = dpa.charts.callouts;
    // All four callouts present + non-empty.
    expect(callouts.breakdown.text.length).toBeGreaterThan(60);
    expect(callouts.variance.text.length).toBeGreaterThan(60);
    expect(callouts.distribution.text.length).toBeGreaterThan(60);
    expect(callouts.wagesVsTaxes.text.length).toBeGreaterThan(60);
  });

  it("v15.8 — Breakdown callout summarises the LARGEST YTD spend + net budget variance", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const c = dpa.charts.callouts.breakdown.text;
    // GCM is the largest YTD spend in the seed.
    expect(c).toMatch(/Golf Course Maintenance.*largest YTD payroll spend/i);
    // Names the payroll-to-revenue KPI so the reader sees the top-line ratio.
    expect(c).toMatch(/payroll-to-revenue/i);
  });

  it("v15.8 — Distribution callout names the LARGEST cost centre + top-3 share", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const c = dpa.charts.callouts.distribution.text;
    // Largest single cost centre + numeric share, and top-three
    // aggregate share, so the reader gets the concentration story.
    expect(c).toMatch(/largest single cost centre/i);
    expect(c).toMatch(/top three departments/i);
  });

  it("v15.8 — Wages vs Taxes callout summarises the comp mix + industry-typical range", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const c = dpa.charts.callouts.wagesVsTaxes.text;
    expect(c).toMatch(/wages/i);
    expect(c).toMatch(/taxes\s*&\s*benefits/i);
    // Names the industry-typical band so the reader can judge health.
    expect(c).toMatch(/15\s*–\s*22/);
  });

  it("v15.8 — every chart title carries a chip label for the dark-green header's gold pill", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpa.charts.titles.byDeptActualVsBudget.chipLabel.length).toBeGreaterThan(0);
    expect(dpa.charts.titles.ytdVariance.chipLabel.length).toBeGreaterThan(0);
    expect(dpa.charts.titles.payrollDistribution.chipLabel.length).toBeGreaterThan(0);
    expect(dpa.charts.titles.wagesVsTaxes.chipLabel.length).toBeGreaterThan(0);
  });

  it("Chart titles include 'YTD Payroll by Department' + 'YTD Variance by Department' + 'Payroll Distribution' + 'Wages vs\\. Taxes'", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpa.charts.titles.byDeptActualVsBudget.title).toBe("YTD Payroll by Department");
    expect(dpa.charts.titles.byDeptActualVsBudget.subtitle).toMatch(/May 2026/);
    expect(dpa.charts.titles.ytdVariance.title).toBe("YTD Variance by Department");
    expect(dpa.charts.titles.payrollDistribution.title).toMatch(/Where Does the Dollar Go/);
    expect(dpa.charts.titles.wagesVsTaxes.title).toBe("Wages vs. Taxes & Benefits Split");
  });

  it("Table eyebrow uses the period label (May 2026, NOT Q1)", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(dpa.table.eyebrow).toBe("Departmental Payroll Summary — May 2026");
  });

  it("no reference-attribution footer text (Saguaro / Financially Astute / hypothetical)", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const surface = JSON.stringify(dpa);
    expect(surface).not.toMatch(/Saguaro/i);
    expect(surface).not.toMatch(/Financially Astute/i);
    expect(surface).not.toMatch(/Hypothetical Illustration/i);
    expect(surface).not.toMatch(/financiallyastuteclubs/);
  });

  it("REGRESSION: March 2026 period flips MTD column headers + KPI 3 label + table eyebrow", () => {
    const dpa = buildSilverSpringsDepartmentalPayrollAnalysis({ clubName: SILVER_SPRINGS, period: MAR_2026 });
    expect(dpa.table.columnHeaders.mtdActual).toBe("Mar Actual");
    expect(dpa.table.columnHeaders.mtdBudget).toBe("Mar Budget");
    expect(dpa.table.columnHeaders.mtdVariance).toBe("Mar Variance");
    const m = dpa.kpiCards.find((k) => k.key === "current-month-payroll")!;
    expect(m.label).toBe("March Payroll");
    expect(dpa.table.eyebrow).toBe("Departmental Payroll Summary — March 2026");
  });
});
